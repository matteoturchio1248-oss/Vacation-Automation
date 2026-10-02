import { cookies } from "next/headers";
import { database, ensureDatabase } from "./database";
import { randomToken, sha256 } from "./security";

export type SessionUser = {
  id: number;
  full_name: string;
  email: string;
  role: "employee" | "manager" | "admin" | "payroll_admin";
  status: "pending" | "active" | "on_leave" | "terminated" | "disabled" | "deleted";
  employment_type: "hourly" | "salaried";
  work_schedule: "full_time" | "part_time" | null;
  hire_date: string | null;
  termination_date: string | null;
  leave_start_date: string | null;
  leave_end_date: string | null;
  is_master_admin: number;
  department_id: number | null;
  department_name: string | null;
};

export async function createSession(userId: number) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7);
  await database().prepare("INSERT INTO sessions (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, tokenHash, expires.toISOString(), now.toISOString()).run();
  const jar = await cookies();
  jar.set("vacation_session", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires });
}

export async function clearSession() {
  const jar = await cookies();
  const token = jar.get("vacation_session")?.value;
  if (token) await database().prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  jar.delete("vacation_session");
}

export async function currentUser(): Promise<SessionUser | null> {
  await ensureDatabase();
  const token = (await cookies()).get("vacation_session")?.value;
  if (!token) return null;
  const now = new Date().toISOString();
  const row = await database().prepare(`SELECT u.id, u.full_name, u.email, u.role, u.status, u.employment_type, u.work_schedule,
    u.hire_date, u.termination_date, u.leave_start_date, u.leave_end_date, u.is_master_admin, u.department_id, d.name AS department_name
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN departments d ON d.id = u.department_id
    WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1`).bind(await sha256(token), now).first<SessionUser>();
  return row ?? null;
}

export async function requireActiveUser() {
  const user = await currentUser();
  if (!user || (user.status !== "active" && user.status !== "on_leave")) throw new Response("Unauthorized", { status: 401 });
  return user;
}
