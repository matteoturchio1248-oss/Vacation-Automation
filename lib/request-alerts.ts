import { database } from "./database";

export type RequestAlertPreferences = { inApp: boolean; email: boolean };

export async function requestAlertPreferences(userId: number): Promise<RequestAlertPreferences> {
  const row = await database().prepare("SELECT value FROM settings WHERE key = ?")
    .bind(`request_alerts_${userId}`).first<{ value: string }>();
  if (!row) return { inApp: true, email: true };
  try {
    const saved = JSON.parse(row.value) as Partial<RequestAlertPreferences>;
    return { inApp: saved.inApp !== false, email: saved.email !== false };
  } catch { return { inApp: true, email: true }; }
}

export async function newRequestRecipients(managerEmail?: string | null) {
  const db = database();
  const people = await db.prepare(`SELECT u.id, u.email, s.value AS preferences FROM users u
    LEFT JOIN settings s ON s.key = 'request_alerts_' || u.id
    WHERE u.status IN ('active', 'on_leave') AND u.has_portal_access = 1
      AND (u.role = 'admin' OR (u.role = 'manager' AND lower(u.email) = ?))`)
    .bind((managerEmail ?? "").trim().toLowerCase()).all<{ id: number; email: string; preferences: string | null }>();
  const optedOut = new Set<string>();
  const optedIn: string[] = [];
  for (const person of people.results) {
    let enabled = true;
    try { if (person.preferences) enabled = JSON.parse(person.preferences).email !== false; } catch { /* Keep the default for legacy malformed values. */ }
    const email = person.email.trim().toLowerCase();
    if (enabled) optedIn.push(email); else optedOut.add(email);
  }
  const extra = await db.prepare("SELECT value FROM settings WHERE key = 'approval_emails'").first<{ value: string }>();
  const recipients = ["hr@sweetsfromtheearth.com", ...optedIn, ...String(extra?.value ?? "").split(/[\s,;]+/)];
  return [...new Set(recipients.map((email) => email.trim().toLowerCase()))]
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !optedOut.has(email));
}
