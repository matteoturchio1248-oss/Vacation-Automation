import { database, ensureDatabase } from "./database";
import { approvalRecipients, retryQueuedNotifications, sendNotification } from "./notifications";
import { approvalRouteJoins } from "./approval-routing";

type PendingRequest = {
  id: number;
  employee_name: string;
  department_name: string;
  manager_email: string | null;
  start_date: string;
  end_date: string;
  total_days: string;
};

function escapeHtml(value: string | null | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

export async function runPendingReminders(origin: string) {
  await ensureDatabase();
  const db = database();
  const now = new Date().toISOString();
  const gate = await db.prepare(`INSERT INTO settings (key, value) VALUES ('last_reminder_sweep', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE datetime(settings.value) <= datetime('now', '-6 hours')`).bind(now).run();
  if (!gate.meta.changes) return { checked: false, sent: 0 };

  await retryQueuedNotifications();
  const reminderSettings = await db.prepare(`SELECT key, value FROM settings WHERE key IN
    ('personal_reminder_email', 'personal_reminder_enabled')`).all<{ key: string; value: string }>();
  const reminderConfig = Object.fromEntries(reminderSettings.results.map((row) => [row.key, row.value]));
  const digestDate = now.slice(0, 10);
  if (reminderConfig.personal_reminder_enabled === "true" && reminderConfig.personal_reminder_email) {
    const tasks = await db.prepare(`SELECT r.id, r.title, r.details, r.category, r.priority, r.due_date, e.full_name AS employee_name
      FROM personal_reminders r LEFT JOIN users e ON e.id = r.related_employee_id
      WHERE r.status = 'open' AND date(r.due_date) <= date('now')
        AND (r.last_notified_at IS NULL OR substr(r.last_notified_at, 1, 10) < ?)
      ORDER BY r.due_date, CASE r.priority WHEN 'high' THEN 0 ELSE 1 END, r.id`).bind(digestDate).all<{
        id: number; title: string; details: string | null; category: string; priority: string; due_date: string; employee_name: string | null;
      }>();
    if (tasks.results.length) {
      const items = tasks.results.map((task) => `<li><strong>${escapeHtml(task.title)}</strong>${task.employee_name ? ` — ${escapeHtml(task.employee_name)}` : ""}<br><small>Due ${escapeHtml(task.due_date)} · ${escapeHtml(task.category.replaceAll("_", " "))}${task.priority === "high" ? " · high priority" : ""}</small>${task.details ? `<br>${escapeHtml(task.details)}` : ""}</li>`).join("");
      const delivery = await sendNotification(null, [reminderConfig.personal_reminder_email],
        `${tasks.results.length} HR task${tasks.results.length === 1 ? "" : "s"} need your attention`,
        `<p>You have ${tasks.results.length} due or overdue task${tasks.results.length === 1 ? "" : "s"} in your HR portal.</p><ul>${items}</ul><p><a href="${origin}">Open Tasks &amp; Alerts</a></p>`);
      if (delivery.status === "sent") {
        await db.batch(tasks.results.map((task) => db.prepare("UPDATE personal_reminders SET last_notified_at = ? WHERE id = ?").bind(now, task.id)));
      }
    }
  }
  const due = await db.prepare(`SELECT vr.id, vr.start_date, vr.end_date, vr.total_days, e.full_name AS employee_name,
      d.name AS department_name, reminder_routing_approver.email AS manager_email
    FROM vacation_requests vr
    JOIN users e ON e.id = vr.employee_id
    JOIN departments d ON d.id = vr.department_id
    ${approvalRouteJoins("vr.employee_id", "vr.department_id", "reminder_routing")}
    WHERE vr.status = 'pending'
      AND datetime(vr.created_at) <= datetime('now', '-2 days')
      AND (vr.last_reminder_at IS NULL OR datetime(vr.last_reminder_at) <= datetime('now', '-2 days'))
    ORDER BY vr.created_at`).all<PendingRequest>();

  let sent = 0;
  for (const item of due.results) {
    const result = await sendNotification(item.id, await approvalRecipients(item.manager_email),
      `Reminder: vacation request from ${item.employee_name} needs review`,
      `<p>A vacation request from <strong>${item.employee_name}</strong> is still awaiting a decision.</p><p>${item.start_date} to ${item.end_date} (${item.total_days} days) · ${item.department_name}</p><p><a href="${origin}">Review the pending request</a></p>`);
    if (result.status === "sent") {
      await db.prepare("UPDATE vacation_requests SET last_reminder_at = ?, reminder_count = reminder_count + 1, updated_at = ? WHERE id = ? AND status = 'pending'")
        .bind(now, now, item.id).run();
      sent += 1;
    }
  }
  return { checked: true, due: due.results.length, sent };
}
