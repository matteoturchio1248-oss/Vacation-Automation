type RuntimeEnv = {
  DB?: D1Database;
  RESEND_API_KEY?: string;
  NOTIFICATION_FROM_EMAIL?: string;
  GMAIL_RELAY_URL?: string;
  GMAIL_RELAY_SECRET?: string;
  BOOTSTRAP_SECRET?: string;
  JOBS_SECRET?: string;
  APP_ORIGIN?: string;
};

declare global {
  var __VACATION_PORTAL_ENV__: RuntimeEnv | undefined;
}

export function runtimeEnv() {
  return globalThis.__VACATION_PORTAL_ENV__ ?? {};
}

export function database() {
  const db = runtimeEnv().DB;
  if (!db) throw new Error("Database binding is unavailable.");
  return db;
}

// Production schema is applied by the checked-in Drizzle migrations at deploy time.
// Share initialization within an isolate so concurrent requests do not repeat seeds.
const initialization = new WeakMap<D1Database, Promise<void>>();

export function ensureDatabase() {
  const db = database();
  const existing = initialization.get(db);
  if (existing) return existing;
  const pending = initializeDefaults(db).catch((error) => {
    initialization.delete(db);
    throw error;
  });
  initialization.set(db, pending);
  return pending;
}

async function initializeDefaults(db: D1Database) {
  const now = new Date().toISOString();
  const departments = ["Gluten Free Production", "Nut Free Production", "Tutti", "Sanitation", "Warehouse", "Office", "Sales", "Customer Service", "Finance", "R&D", "Quality Assurance"];
  const settings: Array<[string, string]> = [
    ["company_name", "Sweets from the Earth"], ["approval_emails", ""],
    ["personal_reminder_email", ""], ["personal_reminder_enabled", "false"],
    ["gmail_relay_url", ""], ["gmail_relay_secret", ""],
  ];
  await db.batch([
    ...departments.map((name) => db.prepare("INSERT OR IGNORE INTO departments (name, active, created_at) VALUES (?, 1, ?)").bind(name, now)),
    ...settings.map(([key, value]) => db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(key, value)),
    db.prepare("INSERT INTO settings (key, value) VALUES ('hr_email', 'hr@sweetsfromtheearth.com') ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    db.prepare("UPDATE users SET employment_type = 'salaried' WHERE employment_type = 'office'"),
    db.prepare("UPDATE users SET is_master_admin = 1 WHERE id = (SELECT id FROM users WHERE role = 'admin' AND status != 'deleted' ORDER BY id LIMIT 1) AND NOT EXISTS (SELECT 1 FROM users WHERE is_master_admin = 1 AND status != 'deleted')"),
  ]);
}
