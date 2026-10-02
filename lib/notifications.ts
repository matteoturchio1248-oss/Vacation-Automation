import { database, runtimeEnv } from "./database";

export const PRIMARY_HR_EMAIL = "hr@sweetsfromtheearth.com";
export const APPROVAL_EMAIL_DOMAIN = "sweetsfromtheearth.com";
export const DEFAULT_FROM_EMAIL = `SFTE Vacation Requests <${PRIMARY_HR_EMAIL}>`;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function isApprovalEmail(value: string) {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.endsWith(`@${APPROVAL_EMAIL_DOMAIN}`);
}

export function parseApprovalEmails(value: string | null | undefined) {
  return [...new Set(String(value ?? "").split(/[\s,;]+/).map(normalizeEmail).filter(Boolean))];
}

export async function approvalRecipients(managerEmail?: string | null) {
  const db = database();
  const [admins, saved] = await Promise.all([
    db.prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active' AND has_portal_access = 1").all<{ email: string }>(),
    db.prepare("SELECT value FROM settings WHERE key = 'approval_emails'").first<{ value: string }>(),
  ]);
  return [...new Set([
    PRIMARY_HR_EMAIL,
    ...admins.results.map((row) => normalizeEmail(row.email)),
    ...parseApprovalEmails(saved?.value),
    normalizeEmail(managerEmail ?? ""),
  ].filter(isApprovalEmail))];
}

type DeliveryResult = { status: "queued" | "sent" | "failed"; detail: string; attempted: boolean };

async function emailDeliveryConfig() {
  const config = runtimeEnv();
  if (config.GMAIL_RELAY_URL?.trim() && config.GMAIL_RELAY_SECRET?.trim()) {
    return { provider: "gmail" as const, url: config.GMAIL_RELAY_URL.trim(), secret: config.GMAIL_RELAY_SECRET.trim() };
  }
  const saved = await database().prepare("SELECT key, value FROM settings WHERE key IN ('gmail_relay_url', 'gmail_relay_secret')")
    .all<{ key: string; value: string }>();
  const values = Object.fromEntries(saved.results.map((row) => [row.key, row.value.trim()]));
  if (values.gmail_relay_url && values.gmail_relay_secret) {
    return { provider: "gmail" as const, url: values.gmail_relay_url, secret: values.gmail_relay_secret };
  }
  if (config.RESEND_API_KEY?.trim()) return { provider: "resend" as const };
  return { provider: null };
}

export async function emailDeliveryProvider() {
  return (await emailDeliveryConfig()).provider;
}

async function deliver(recipients: string[], subject: string, html: string): Promise<DeliveryResult> {
  const config = runtimeEnv();
  const delivery = await emailDeliveryConfig();
  if (!delivery.provider) return { status: "queued", detail: "Waiting for the email-service connection.", attempted: false };
  try {
    if (delivery.provider === "gmail") {
      const response = await fetch(delivery.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: delivery.secret,
          to: recipients,
          subject,
          html,
        }),
      });
      const providerDetail = (await response.text()).slice(0, 500);
      if (!response.ok || !providerDetail.includes('"ok":true')) {
        throw new Error(`Gmail relay rejected the message${providerDetail ? `: ${providerDetail}` : ""}`);
      }
      return { status: "sent", detail: "Email sent through Gmail.", attempted: true };
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: config.NOTIFICATION_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL,
        to: recipients,
        subject,
        html,
      }),
    });
    if (!response.ok) {
      const providerDetail = (await response.text()).slice(0, 500);
      throw new Error(`Email provider returned ${response.status}${providerDetail ? `: ${providerDetail}` : ""}`);
    }
    return { status: "sent", detail: "Email sent.", attempted: true };
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : "Email delivery failed.", attempted: true };
  }
}

export async function sendNotification(requestId: number | null, recipients: string[], subject: string, html: string) {
  const cleanRecipients = [...new Set(recipients.map(normalizeEmail).filter(Boolean))];
  if (!cleanRecipients.length) return { status: "failed" as const, detail: "No notification recipients were available." };
  const result = await deliver(cleanRecipients, subject, html);
  const now = new Date().toISOString();
  await database().prepare(`INSERT INTO notification_log
    (request_id, recipients, subject, status, detail, html_body, attempt_count, last_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(requestId, cleanRecipients.join(", "), subject, result.status, result.detail, html,
      result.attempted ? 1 : 0, result.attempted ? now : null, now).run();
  return { status: result.status, detail: result.detail };
}

// Record the email durably before acknowledging a save. Provider latency must
// not delay vacation approvals, employee changes or reminder creation.
export async function queueNotification(requestId: number | null, recipients: string[], subject: string, html: string, onSent?: () => Promise<void>) {
  const cleanRecipients = [...new Set(recipients.map(normalizeEmail).filter(Boolean))];
  if (!cleanRecipients.length) return { status: "failed" as const, detail: "No notification recipients were available." };
  const db = database();
  const now = new Date().toISOString();
  const queued = await db.prepare(`INSERT INTO notification_log
    (request_id, recipients, subject, status, detail, html_body, attempt_count, last_attempt_at, created_at)
    VALUES (?, ?, ?, 'queued', 'Queued for email delivery.', ?, 0, ?, ?) RETURNING id`)
    .bind(requestId, cleanRecipients.join(", "), subject, html, now, now).first<{ id: number }>();
  if (!queued) throw new Error("Unable to queue the notification.");
  const { waitUntil } = await import("cloudflare:workers");
  waitUntil((async () => {
    const result = await deliver(cleanRecipients, subject, html);
    await db.prepare(`UPDATE notification_log SET status = ?, detail = ?, attempt_count = ?, last_attempt_at = ? WHERE id = ?`)
      .bind(result.status, result.detail, result.attempted ? 1 : 0, result.attempted ? new Date().toISOString() : null, queued.id).run();
    if (result.status === "sent" && onSent) await onSent();
  })().catch((error) => console.error("Background notification delivery failed", error)));
  return { status: "queued" as const, detail: "Email is queued for delivery. Check Settings for delivery status." };
}

export async function retryQueuedNotifications() {
  if (!await emailDeliveryProvider()) return { retried: 0, sent: 0 };
  const pending = await database().prepare(`SELECT id, recipients, subject, html_body
    FROM notification_log
    WHERE status IN ('queued', 'failed') AND html_body IS NOT NULL AND attempt_count < 5
      AND (last_attempt_at IS NULL OR datetime(last_attempt_at) <= datetime('now', '-15 minutes'))
    ORDER BY created_at LIMIT 20`).all<{ id: number; recipients: string; subject: string; html_body: string }>();
  let sent = 0;
  for (const item of pending.results) {
    const result = await deliver(parseApprovalEmails(item.recipients), item.subject, item.html_body);
    await database().prepare(`UPDATE notification_log SET status = ?, detail = ?, attempt_count = attempt_count + ?,
      last_attempt_at = ? WHERE id = ?`).bind(result.status, result.detail, result.attempted ? 1 : 0,
        result.attempted ? new Date().toISOString() : null, item.id).run();
    if (result.status === "sent") sent += 1;
  }
  return { retried: pending.results.length, sent };
}
