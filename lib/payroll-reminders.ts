import { database, ensureDatabase } from "./database";
import { queueNotification } from "./notifications";

export async function payrollRecipients() {
  const rows = await database().prepare(`SELECT u.email, s.value AS preferences FROM users u
    LEFT JOIN settings s ON s.key = 'request_alerts_' || u.id WHERE u.role = 'payroll_admin'
    AND u.status IN ('active', 'on_leave') AND u.has_portal_access = 1 ORDER BY u.id`)
    .all<{ email: string; preferences: string | null }>();
  return [...new Set(rows.results.filter((row) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) return false;
    try { return !row.preferences || JSON.parse(row.preferences).email !== false; } catch { return true; }
  }).map((row) => row.email.trim().toLowerCase()))];
}

function escape(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export async function payrollDigestStatus() {
  await ensureDatabase();
  const [pending, recipients, lastRun] = await Promise.all([
    database().prepare(`SELECT COUNT(*) AS count FROM vacation_requests vr JOIN users u ON u.id = vr.employee_id
      WHERE vr.status = 'approved' AND COALESCE(vr.employment_type_snapshot, u.employment_type) = 'hourly'
      AND vr.vacation_pay_requested = 1 AND vr.payroll_processed = 0 AND vr.hr_finalized = 0`).first<{ count: number }>(),
    payrollRecipients(),
    database().prepare("SELECT value FROM settings WHERE key = 'payroll_digest_last_run'").first<{ value: string }>(),
  ]);
  return { pendingPayouts: Number(pending?.count ?? 0), recipientCount: recipients.length, lastRun: lastRun ? JSON.parse(lastRun.value) : null };
}

export async function runPayrollDigest(origin: string) {
  await ensureDatabase();
  const db = database();
  const pending = await db.prepare(`SELECT vr.id, vr.start_date, vr.end_date, vr.vacation_pay_amount_cents,
    u.full_name, d.name AS department_name FROM vacation_requests vr JOIN users u ON u.id = vr.employee_id
    JOIN departments d ON d.id = vr.department_id WHERE vr.status = 'approved'
    AND COALESCE(vr.employment_type_snapshot, u.employment_type) = 'hourly' AND vr.vacation_pay_requested = 1
    AND vr.payroll_processed = 0 AND vr.hr_finalized = 0 ORDER BY vr.decided_at, vr.id`).all<Record<string, unknown>>();
  const recipients = await payrollRecipients();
  const now = new Date().toISOString();
  let queued = 0;
  let skipped = 0;
  if (pending.results.length) {
    const rows = pending.results.map((record) => `<tr><td>#${record.id}</td><td>${escape(record.full_name)}</td><td>${escape(record.department_name)}</td><td>${escape(record.start_date)} – ${escape(record.end_date)}</td><td>$${(Number(record.vacation_pay_amount_cents) / 100).toFixed(2)}</td></tr>`).join("");
    for (const recipient of recipients) {
      const key = `payroll_digest_last_queued_${recipient}`;
      // Claim atomically before queueing: concurrent runs cannot send duplicates.
      const claim = await db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE datetime(settings.value) <= datetime(?, '-5 days')`)
        .bind(key, now, now).run();
      if (!claim.meta.changes) { skipped += 1; continue; }
      try {
        await queueNotification(null, [recipient], `Payroll: ${pending.results.length} vacation payment${pending.results.length === 1 ? "" : "s"} outstanding`,
          `<h2>Outstanding approved vacation pay</h2><p>Hourly vacation approved by a manager and awaiting its payroll record. This summary is sent at most once every five days.</p><table cellpadding="8" border="1"><tr><th>Request</th><th>Employee</th><th>Department</th><th>Dates</th><th>Requested pay</th></tr>${rows}</table><p><a href="${escape(origin)}">Open Payroll's pending queue</a></p>`);
        queued += 1;
      } catch (error) {
        await db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").bind(key, now).run();
        throw error;
      }
    }
  }
  const result = { checkedAt: now, pendingPayouts: pending.results.length, recipientCount: recipients.length, queued, skipped };
  await db.prepare("INSERT INTO settings (key, value) VALUES ('payroll_digest_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(result)).run();
  return result;
}
