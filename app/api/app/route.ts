import { database, ensureDatabase, runtimeEnv } from "../../../lib/database";
import { secretMatches } from "../../../lib/service-access";
import { approvalRecipients, emailDeliveryProvider, isApprovalEmail, parseApprovalEmails, PRIMARY_HR_EMAIL, queueNotification as sendNotification, sendNotification as sendImmediateNotification } from "../../../lib/notifications";
import { newRequestRecipients, requestAlertPreferences } from "../../../lib/request-alerts";
import { clearSession, createSession, currentUser, requireActiveUser } from "../../../lib/session";
import { hashPassword, passwordIsStrong, verifyPassword } from "../../../lib/security";
import { payrollRecipients } from "../../../lib/payroll-reminders";
import { approvalRouteJoins, loadApprovalMap, resolveApproval, saveApprovalMap } from "../../../lib/approval-routing";

export const dynamic = "force-dynamic";

type Payload = Record<string, unknown>;

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function cleanEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function cleanText(value: unknown, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function asId(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function dateOffset(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function internalRecordEmail() {
  return `employee-record-${crypto.randomUUID()}@internal.invalid`;
}

async function masterAdminId() {
  const row = await database().prepare("SELECT id FROM users WHERE is_master_admin = 1 AND status = 'active' ORDER BY id LIMIT 1").first<{ id: number }>();
  return row?.id ?? null;
}

type WorkflowType = "onboarding" | "return_to_work" | "probation_review" | "document_expiry" | "offboarding";
type WorkflowTaskSeed = { title: string; details: string; offset: number; branchLabel?: string; status?: "pending" | "skipped" };

function workflowDefinition(type: WorkflowType, employee: { full_name: string; work_schedule?: string | null }) {
  const schedule = employee.work_schedule;
  const definitions: Record<WorkflowType, { title: string; tasks: WorkflowTaskSeed[] }> = {
    onboarding: {
      title: `Onboarding — ${employee.full_name}`,
      tasks: [
        { title: "Confirm employee profile and employment details", details: "Verify department, manager, hourly/salaried classification and full-time/part-time schedule.", offset: 0 },
        schedule === "full_time"
          ? { title: "Enroll employee in benefits", details: "Send enrollment material and record the effective date.", offset: 3, branchLabel: "Full-time: benefits" }
          : schedule === "part_time"
            ? { title: "Benefits step skipped", details: "Employee is recorded as part-time; confirm whether any exception applies.", offset: 0, branchLabel: "Part-time: skip benefits", status: "skipped" }
            : { title: "Confirm benefits eligibility", details: "Work schedule is not set. Confirm full-time or part-time status before completing this step.", offset: 2, branchLabel: "Schedule not set" },
        { title: schedule === "part_time" ? "Assign basic required training" : "Assign full onboarding training", details: "Assign health and safety, accessibility, harassment, GMP and role-specific training as applicable.", offset: 1 },
        { title: "Confirm training completion", details: "Record completed training and follow up on anything outstanding.", offset: 14 },
        { title: "Complete 30-day check-in", details: "Confirm the employee has the tools, training and support required for the role.", offset: 30 },
      ],
    },
    return_to_work: {
      title: `Return to work — ${employee.full_name}`,
      tasks: [
        { title: "Review return-to-work information", details: "Confirm restrictions, documentation and any accommodation questions requiring review.", offset: -3 },
        { title: "Confirm return date and schedule", details: "Notify the employee and manager of the confirmed plan.", offset: 0 },
        { title: "Prepare workplace supports", details: "Arrange modified duties, schedule or equipment when applicable.", offset: 0 },
        { title: "Complete first-day check-in", details: "Confirm the return is proceeding as planned and note any concerns.", offset: 1 },
        { title: "Close return-to-work follow-up", details: "Complete the final check-in and retain the administrative record.", offset: 7 },
      ],
    },
    probation_review: {
      title: `Probation review — ${employee.full_name}`,
      tasks: [
        { title: "Request manager feedback", details: "Send the review prompts and collect examples.", offset: -14 },
        { title: "Review attendance, training and performance notes", details: "Prepare the HR summary before the meeting.", offset: -7 },
        { title: "Complete probation review meeting", details: "Meet with the employee and record the outcome.", offset: 0 },
        { title: "Issue outcome documentation", details: "Provide the appropriate confirmation or next-step letter.", offset: 1 },
      ],
    },
    document_expiry: {
      title: `Document expiry — ${employee.full_name}`,
      tasks: [
        { title: "90-day expiry check", details: "Notify the employee and confirm the renewal plan.", offset: -90 },
        { title: "60-day expiry follow-up", details: "Request evidence that the renewal is in progress.", offset: -60 },
        { title: "30-day escalation", details: "Escalate any unresolved expiry risk and document the response.", offset: -30 },
        { title: "Verify renewed document", details: "Confirm validity and update the employee record.", offset: 0 },
      ],
    },
    offboarding: {
      title: `Offboarding — ${employee.full_name}`,
      tasks: [
        { title: "Confirm final working day and communication plan", details: "Confirm timing, manager responsibilities and employee communication.", offset: -3 },
        { title: "Disable access and recover company property", details: "Coordinate account access, keys, equipment and documents.", offset: 0 },
        { title: "Complete final payroll and ROE steps", details: "Confirm final wages, vacation amounts, benefits and ROE processing as applicable.", offset: 5 },
        { title: "Archive the employee file", details: "Close open workflows and retain records according to company requirements.", offset: 7 },
      ],
    },
  };
  return definitions[type];
}

async function createWorkflowRecord(type: WorkflowType, employee: { id: number; full_name: string; work_schedule?: string | null }, targetDate: string, ownerUserId: number, now: string) {
  const definition = workflowDefinition(type, employee);
  const created = await database().prepare(`INSERT INTO workflow_runs
    (workflow_type, employee_id, title, target_date, status, started_by, started_at) VALUES (?, ?, ?, ?, 'active', ?, ?) RETURNING id`)
    .bind(type, employee.id, definition.title, targetDate, ownerUserId, now).first<{ id: number }>();
  if (!created) throw new Error("Workflow could not be started.");
  const emailTasks: Array<{ title: string; dueDate: string; skipped: boolean }> = [];
  for (const [index, task] of definition.tasks.entries()) {
    const dueDate = dateOffset(targetDate, task.offset);
    emailTasks.push({ title: task.title, dueDate, skipped: task.status === "skipped" });
    const taskCreated = await database().prepare(`INSERT INTO workflow_tasks
      (run_id, title, details, branch_label, sort_order, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(created.id, task.title, task.details, task.branchLabel ?? null, index + 1, dueDate, task.status ?? "pending", now).first<{ id: number }>();
    if (taskCreated && task.status !== "skipped") {
      await database().prepare(`INSERT INTO personal_reminders
        (owner_user_id, related_employee_id, title, details, category, priority, due_date, status, source_type, source_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'workflow_task', ?, ?, ?, ?)`).bind(
          ownerUserId, employee.id, task.title, task.details,
          type === "document_expiry" ? "document" : type === "return_to_work" ? "return_to_work" : type === "probation_review" ? "review" : type === "onboarding" ? "training" : "custom",
          task.offset <= 0 ? "high" : "normal", dueDate, taskCreated.id, ownerUserId, now, now,
        ).run();
    }
  }
  return { runId: created.id, definition, emailTasks };
}

async function ensureReturnToWorkWorkflow(employee: { id: number; full_name: string; work_schedule?: string | null }, targetDate: string, ownerUserId: number, now: string) {
  const existing = await database().prepare("SELECT id FROM workflow_runs WHERE employee_id = ? AND workflow_type = 'return_to_work' AND status = 'active' ORDER BY id DESC LIMIT 1")
    .bind(employee.id).first<{ id: number }>();
  if (!existing) return { ...(await createWorkflowRecord("return_to_work", employee, targetDate, ownerUserId, now)), created: true };
  const definition = workflowDefinition("return_to_work", employee);
  await database().prepare("UPDATE workflow_runs SET title = ?, target_date = ? WHERE id = ?").bind(definition.title, targetDate, existing.id).run();
  const tasks = await database().prepare("SELECT id, sort_order, status FROM workflow_tasks WHERE run_id = ? ORDER BY sort_order").bind(existing.id).all<{ id: number; sort_order: number; status: string }>();
  for (const taskRow of tasks.results) {
    const task = definition.tasks[taskRow.sort_order - 1];
    if (!task || taskRow.status !== "pending") continue;
    const dueDate = dateOffset(targetDate, task.offset);
    await database().prepare("UPDATE workflow_tasks SET title = ?, details = ?, branch_label = ?, due_date = ? WHERE id = ?")
      .bind(task.title, task.details, task.branchLabel ?? null, dueDate, taskRow.id).run();
    await database().prepare("UPDATE personal_reminders SET title = ?, details = ?, due_date = ?, updated_at = ? WHERE owner_user_id = ? AND source_type = 'workflow_task' AND source_id = ?")
      .bind(task.title, task.details, dueDate, now, ownerUserId, taskRow.id).run();
  }
  return { runId: existing.id, definition, emailTasks: definition.tasks.map((task) => ({ title: task.title, dueDate: dateOffset(targetDate, task.offset), skipped: task.status === "skipped" })), created: false };
}

async function settingsMap() {
  const rows = await database().prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return Object.fromEntries(rows.results.map((row) => [row.key, row.value]));
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

async function personalReminderEmail() {
  const row = await database().prepare("SELECT value FROM settings WHERE key = 'personal_reminder_email'").first<{ value: string }>();
  const email = cleanEmail(row?.value);
  return validEmail(email) ? email : null;
}

async function emailReminder(reminderId: number, origin: string, prefix = "Reminder", immediate = false) {
  const recipient = await personalReminderEmail();
  if (!recipient) return { status: "not_configured", detail: "Save a personal reminder email in Settings." };
  const reminder = await database().prepare(`SELECT r.title, r.details, r.category, r.priority, r.due_date, r.updated_at,
    e.full_name AS employee_name FROM personal_reminders r LEFT JOIN users e ON e.id = r.related_employee_id
    WHERE r.id = ?`).bind(reminderId).first<{ title: string; details: string | null; category: string; priority: string; due_date: string; updated_at: string; employee_name: string | null }>();
  if (!reminder) return { status: "failed", detail: "Reminder not found." };
  const html = `<p><strong>${escapeHtml(reminder.title)}</strong></p>${reminder.employee_name ? `<p>Employee: ${escapeHtml(reminder.employee_name)}</p>` : ""}<p>Due: ${escapeHtml(reminder.due_date)} · ${escapeHtml(reminder.category.replaceAll("_", " "))}${reminder.priority === "high" ? " · high priority" : ""}</p>${reminder.details ? `<p>${escapeHtml(reminder.details)}</p>` : ""}<p><a href="${escapeHtml(origin)}">Open Tasks &amp; Alerts</a></p>`;
  if (immediate) return sendImmediateNotification(null, [recipient], `${prefix}: ${reminder.title}`, html);
  return sendNotification(null, [recipient], `${prefix}: ${reminder.title}`, html, async () => {
    await database().prepare("UPDATE personal_reminders SET last_notified_at = ? WHERE id = ? AND updated_at = ?")
      .bind(new Date().toISOString(), reminderId, reminder.updated_at).run();
  });
}

async function syncWorkflowRunStatus(runId: number, userId: number, now: string) {
  const pending = await database().prepare("SELECT COUNT(*) AS count FROM workflow_tasks WHERE run_id = ? AND status = 'pending'").bind(runId).first<{ count: number }>();
  const completed = Number(pending?.count ?? 0) === 0;
  await database().prepare("UPDATE workflow_runs SET status = ?, completed_at = ? WHERE id = ? AND status != 'cancelled'")
    .bind(completed ? "completed" : "active", completed ? now : null, runId).run();
  if (completed) {
    await database().prepare("UPDATE workflow_tasks SET completed_by = COALESCE(completed_by, ?) WHERE run_id = ? AND status = 'completed'")
      .bind(userId, runId).run();
  }
}

function monthsAccrued(year: number, accrualStartDate: string | null) {
  const today = new Date();
  if (today.getFullYear() < year) return 0;
  const asOfMonth = today.getFullYear() === year ? today.getMonth() + 1 : 12;
  let startMonth = 1;
  if (accrualStartDate && /^\d{4}-\d{2}-\d{2}$/.test(accrualStartDate)) {
    const startYear = Number(accrualStartDate.slice(0, 4));
    if (startYear > year) return 0;
    if (startYear === year) startMonth = Number(accrualStartDate.slice(5, 7));
  }
  return Math.max(0, asOfMonth - startMonth + 1);
}

async function salaryTracker(year = new Date().getFullYear(), employeeId?: number) {
  const people = await database().prepare(`SELECT u.id, u.full_name, u.email, u.department_id, d.name AS department_name,
      p.user_id AS profile_user_id, p.monthly_rate, p.opening_balance, p.accrual_start_date
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN vacation_accrual_profiles p ON p.user_id = u.id AND p.vacation_year = ?
    WHERE u.status IN ('active', 'on_leave') AND u.employment_type = 'salaried' ${employeeId ? "AND u.id = ?" : ""} ORDER BY u.full_name`).bind(year, ...(employeeId ? [employeeId] : [])).all<Record<string, unknown>>();
  const approved = await database().prepare(`SELECT employee_id, COALESCE(SUM(CAST(total_days AS REAL)), 0) AS approved_days
    FROM vacation_requests WHERE status = 'approved' AND substr(start_date, 1, 4) = ? ${employeeId ? "AND employee_id = ?" : ""} GROUP BY employee_id`).bind(String(year), ...(employeeId ? [employeeId] : [])).all<{ employee_id: number; approved_days: number }>();
  const adjustments = await database().prepare(`SELECT a.id, a.user_id, a.amount_days, a.effective_date, a.note, a.created_at, c.full_name AS created_by_name
    FROM vacation_balance_adjustments a JOIN users c ON c.id = a.created_by WHERE a.vacation_year = ? ${employeeId ? "AND a.user_id = ?" : ""} ORDER BY a.effective_date DESC, a.id DESC`).bind(year, ...(employeeId ? [employeeId] : [])).all<Record<string, unknown>>();
  const approvedMap = new Map(approved.results.map((row) => [Number(row.employee_id), Number(row.approved_days)]));
  const adjustmentMap = new Map<number, number>();
  for (const row of adjustments.results) adjustmentMap.set(Number(row.user_id), (adjustmentMap.get(Number(row.user_id)) ?? 0) + Number(row.amount_days));
  const employees = people.results.map((person) => {
    const monthlyRate = Number(person.monthly_rate ?? 0);
    const openingBalance = Number(person.opening_balance ?? 0);
    const accrued = monthlyRate * monthsAccrued(year, person.accrual_start_date ? String(person.accrual_start_date) : null);
    const approvedDays = approvedMap.get(Number(person.id)) ?? 0;
    const manualAdjustments = adjustmentMap.get(Number(person.id)) ?? 0;
    return { ...person, configured: person.profile_user_id != null, monthly_rate: monthlyRate, opening_balance: openingBalance, accrued_days: accrued,
      approved_days: approvedDays, adjustment_days: manualAdjustments, available_days: openingBalance + accrued + manualAdjustments - approvedDays };
  });
  return { year, employees, adjustments: adjustments.results };
}

async function listDepartments(includeInactive = false) {
  const clause = includeInactive ? "" : "WHERE d.active = 1";
  const result = await database().prepare(`SELECT d.id, d.name, d.active, d.manager_user_id, u.full_name AS manager_name,
    CASE WHEN u.has_portal_access = 1 THEN u.email ELSE NULL END AS manager_email
    FROM departments d LEFT JOIN users u ON u.id = d.manager_user_id ${clause} ORDER BY d.name`).all();
  return result.results;
}

async function listRequests(user: Awaited<ReturnType<typeof requireActiveUser>>) {
  let where = "vr.employee_id = ?";
  const values: unknown[] = [user.id];
  if (user.role === "admin" || user.role === "payroll_admin") {
    where = "1 = 1";
    values.length = 0;
  } else if (user.role === "manager") {
    where = "(vr.department_id = ? OR d.manager_user_id = ? OR vr.employee_id = ? OR routing_approver.id = ?)";
    values.splice(0, values.length, user.department_id ?? -1, user.id, user.id, user.id);
  }
  const result = await database().prepare(`SELECT vr.*, e.full_name AS employee_name, e.email AS employee_email,
    COALESCE(vr.employment_type_snapshot, e.employment_type) AS employment_type, d.name AS department_name, approver.full_name AS decision_by_name,
    routing_approver.id AS approver_user_id, routing_approver.full_name AS approver_name,
    CASE WHEN routing_person.id IS NOT NULL THEN 'Individual' WHEN routing_team.id IS NOT NULL THEN 'Department map' ELSE 'Department manager' END AS approval_route
    FROM vacation_requests vr JOIN users e ON e.id = vr.employee_id JOIN departments d ON d.id = vr.department_id
    LEFT JOIN users approver ON approver.id = vr.decision_by ${approvalRouteJoins("vr.employee_id", "vr.department_id")} WHERE ${where} ORDER BY vr.created_at DESC`)
    .bind(...values).all();
  return result.results;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const [user, count] = await Promise.all([
      currentUser(),
      database().prepare("SELECT COUNT(*) AS count FROM users WHERE status != 'deleted'").first<{ count: number }>(),
    ]);
    const hasActiveAccess = Boolean(user && (user.status === "active" || user.status === "on_leave"));
    const allDepartments = await listDepartments(hasActiveAccess && (user?.role === "admin" || user?.role === "payroll_admin" || user?.role === "manager"));
    const departments = !hasActiveAccess ? allDepartments.map((department) => ({ id: department.id, name: department.name, active: department.active }))
      : user?.role === "manager" ? allDepartments.filter((department) => Number(department.manager_user_id) === user.id || Number(department.id) === user.department_id) : allDepartments;

    if (!user) return Response.json({ user: null, departments, needsSetup: Number(count?.count ?? 0) === 0 });

    const base = { user, departments, needsSetup: Number(count?.count ?? 0) === 0 };
    if (user.status !== "active" && user.status !== "on_leave") return Response.json(base);

    const [requests, requestAlerts, ownTracker, vacationPeople] = await Promise.all([
      listRequests(user),
      requestAlertPreferences(user.id),
      user.employment_type === "salaried" ? salaryTracker(undefined, user.id) : Promise.resolve(undefined),
      user.role === "employee" ? Promise.resolve(undefined) : database().prepare(`SELECT u.id, u.full_name, u.department_id,
        u.employment_type, u.status, d.name AS department_name FROM users u LEFT JOIN departments d ON d.id = u.department_id
        ${approvalRouteJoins("u.id", "u.department_id", "people_routing")}
        WHERE u.status != 'deleted' ${user.role === "manager" ? "AND (d.manager_user_id = ? OR u.department_id = ? OR people_routing_approver.id = ? OR u.id = ?)" : ""}
        ORDER BY u.full_name`).bind(...(user.role === "manager" ? [user.id, user.department_id ?? -1, user.id, user.id] : [])).all(),
    ]);
    const ownBalance = ownTracker?.employees[0];
    const myVacationBalance = ownBalance ? { year: ownTracker!.year, configured: ownBalance.configured,
      availableDays: ownBalance.available_days, accruedDays: ownBalance.accrued_days, approvedDays: ownBalance.approved_days,
      openingBalance: ownBalance.opening_balance, adjustmentDays: ownBalance.adjustment_days } : undefined;
    const visibleDepartmentIds = new Set([...requests.map((record) => Number(record.department_id)), ...(vacationPeople?.results ?? []).map((person) => Number(person.department_id))]);
    const vacationData = { requests, requestAlerts, myVacationBalance, vacationPeople: vacationPeople?.results,
      departments: user.role === "manager" ? allDepartments.filter((department) => Number(department.manager_user_id) === user.id || Number(department.id) === user.department_id || visibleDepartmentIds.has(Number(department.id))) : departments };
    if (new URL(request.url).searchParams.get("view") === "live" || (user.role !== "admin" && user.role !== "payroll_admin")) return Response.json({ ...base, ...vacationData }, { headers: { "Cache-Control": "private, no-store" } });

    const [users, notifications, tracker, settings] = await Promise.all([
      database().prepare(`SELECT u.id, u.full_name, CASE WHEN u.has_portal_access = 1 THEN u.email ELSE '' END AS email,
      u.role, u.status, u.employment_type, u.work_schedule, u.hire_date, u.termination_date, u.leave_start_date, u.leave_end_date,
      u.job_title, u.compensation_amount_cents, u.compensation_frequency, u.phone, u.work_location, u.employee_notes,
      u.has_portal_access, u.is_master_admin, u.department_id,
      d.name AS department_name, u.created_at, u.updated_at FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.status != 'deleted' ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.full_name`).all(),
      database().prepare("SELECT id, request_id, recipients, subject, status, detail, created_at FROM notification_log ORDER BY created_at DESC LIMIT 30").all(),
      user.is_master_admin ? salaryTracker() : Promise.resolve(undefined),
      settingsMap(),
    ]);
    let personalReminders: unknown[] | undefined;
    let workflows: unknown[] | undefined;
    if (user.is_master_admin) {
      const pendingRows = await database().prepare(`SELECT vr.id, vr.employee_id, vr.start_date, vr.end_date, vr.total_days, vr.created_at,
        e.full_name AS employee_name, d.name AS department_name FROM vacation_requests vr JOIN users e ON e.id = vr.employee_id
        JOIN departments d ON d.id = vr.department_id WHERE vr.status = 'pending'`).all<Record<string, unknown>>();
      if (pendingRows.results.length) await database().batch(pendingRows.results.map((pending) => {
        const createdAt = String(pending.created_at ?? new Date().toISOString());
        const createdDate = createdAt.slice(0, 10);
        return database().prepare(`INSERT OR IGNORE INTO personal_reminders
          (owner_user_id, related_employee_id, title, details, category, priority, due_date, status, source_type, source_id, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'vacation', 'high', ?, 'open', 'vacation_request', ?, ?, ?, ?)`).bind(
            user.id, pending.employee_id, `Vacation approval pending — ${pending.employee_name}`,
            `${pending.start_date} to ${pending.end_date} · ${pending.total_days} day(s) · ${pending.department_name}`,
            dateOffset(createdDate, 2), pending.id, user.id, createdAt, createdAt,
          );
      }));
      const reminderRows = await database().prepare(`SELECT r.*, e.full_name AS related_employee_name
        FROM personal_reminders r LEFT JOIN users e ON e.id = r.related_employee_id
        WHERE r.owner_user_id = ? ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END,
        CASE r.priority WHEN 'high' THEN 0 ELSE 1 END, r.due_date, r.id DESC`).bind(user.id).all();
      personalReminders = reminderRows.results;
      const runRows = await database().prepare(`SELECT wr.*, e.full_name AS employee_name, e.work_schedule,
        starter.full_name AS started_by_name FROM workflow_runs wr JOIN users e ON e.id = wr.employee_id
        JOIN users starter ON starter.id = wr.started_by ORDER BY CASE wr.status WHEN 'active' THEN 0 ELSE 1 END, wr.started_at DESC`).all<Record<string, unknown>>();
      const taskRows = await database().prepare(`SELECT wt.* FROM workflow_tasks wt JOIN workflow_runs wr ON wr.id = wt.run_id
        ORDER BY wt.run_id DESC, wt.sort_order`).all<Record<string, unknown>>();
      workflows = runRows.results.map((run) => ({ ...run, tasks: taskRows.results.filter((task) => Number(task.run_id) === Number(run.id)) }));
    }
    const provider = await emailDeliveryProvider();
    const publicSettings = { ...settings };
    delete publicSettings.gmail_relay_secret;
    if (!user.is_master_admin) delete publicSettings.gmail_relay_url;
    const approvalMap = user.role === "admin" ? await loadApprovalMap(allDepartments as Array<{ id: number; manager_user_id: number | null }>, users.results as Array<{ id: number; role: string; status: string; has_portal_access: number }>) : undefined;
    return Response.json({ ...base, ...vacationData, users: users.results, approvalMap,
      settings: { ...publicSettings, hr_email: PRIMARY_HR_EMAIL, email_delivery_ready: Boolean(provider), email_delivery_provider: provider,
        gmail_relay_configured: Boolean(settings.gmail_relay_url && settings.gmail_relay_secret) },
      notifications: notifications.results, tracker, personalReminders, workflows });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load the portal.", 500);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = await request.json() as Payload;
    const action = cleanText(body.action, 40);
    const now = new Date().toISOString();

    if (action === "register") {
      const fullName = cleanText(body.fullName, 100);
      const email = cleanEmail(body.email);
      const password = String(body.password ?? "");
      const departmentId = asId(body.departmentId);
      if (fullName.length < 2 || !validEmail(email)) return jsonError("Enter your full name and a valid email address.");
      if (!passwordIsStrong(password)) return jsonError("Password must have at least 6 characters, including at least one letter and one number.");
      const existing = await database().prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
      if (existing) return jsonError("An account already exists for this email address.", 409);
      const count = await database().prepare("SELECT COUNT(*) AS count FROM users WHERE status != 'deleted'").first<{ count: number }>();
      const firstAccount = Number(count?.count ?? 0) === 0;
      if (firstAccount && !(await secretMatches(runtimeEnv().BOOTSTRAP_SECRET, body.setupCode))) {
        return jsonError("Administrator setup requires the private setup code configured by the site owner.", 403);
      }
      if (!firstAccount && !departmentId) return jsonError("Choose your department.");
      if (departmentId) {
        const department = await database().prepare("SELECT id FROM departments WHERE id = ? AND active = 1").bind(departmentId).first();
        if (!department) return jsonError("That department is unavailable.");
      }
      let credentials: Awaited<ReturnType<typeof hashPassword>>;
      try {
        credentials = await hashPassword(password);
      } catch (error) {
        console.error("Password hashing failed during registration", error instanceof Error ? error.message : "Unknown hashing error");
        return jsonError("The account could not be secured. Please try again.", 500);
      }
      const created = await database().prepare(`INSERT INTO users
        (full_name, email, password_hash, password_salt, role, status, employment_type, is_master_admin, department_id, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, 'hourly', ?, ?, ?, ?
        WHERE ? = 0 OR NOT EXISTS (SELECT 1 FROM users WHERE status != 'deleted')`)
        .bind(fullName, email, credentials.hash, credentials.salt, firstAccount ? "admin" : "employee", firstAccount ? "active" : "pending", firstAccount ? 1 : 0, departmentId, now, now, firstAccount ? 1 : 0)
        .run();
      if (!created.meta.changes) return jsonError("Administrator setup has already completed. Refresh and register for employee access.", 409);
      const createdId = Number(created.meta.last_row_id);
      if (!created.success || !Number.isInteger(createdId) || createdId < 1) throw new Error("Account could not be created.");
      await createSession(createdId);
      return Response.json({ ok: true, firstAccount, message: firstAccount ? "Master administrator created." : "Registration submitted for HR approval." });
    }

    if (action === "login") {
      const email = cleanEmail(body.email);
      const password = String(body.password ?? "");
      const user = await database().prepare("SELECT * FROM users WHERE email = ? AND status != 'deleted'").bind(email).first<Record<string, unknown>>();
      if (!user) return jsonError("Email or password is incorrect.", 401);
      const lockedUntil = user.locked_until ? new Date(String(user.locked_until)) : null;
      if (lockedUntil && lockedUntil > new Date()) return jsonError("This account is temporarily locked. Try again in 15 minutes.", 423);
      const valid = await verifyPassword(password, String(user.password_salt), String(user.password_hash));
      if (!valid) {
        const attempts = Number(user.failed_attempts ?? 0) + 1;
        const lock = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
        await database().prepare("UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?")
          .bind(attempts >= 5 ? 0 : attempts, lock, now, user.id).run();
        return jsonError(attempts >= 5 ? "Too many attempts. This account is locked for 15 minutes." : "Email or password is incorrect.", 401);
      }
      if (!Number(user.has_portal_access ?? 1)) return jsonError("Portal access has not been enabled for this employee record.", 403);
      if (user.status === "disabled") return jsonError("This account has been disabled. Contact HR.", 403);
      if (user.status === "terminated") return jsonError("This account is no longer active.", 403);
      await database().prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?").bind(now, user.id).run();
      await createSession(Number(user.id));
      return Response.json({ ok: true });
    }

    if (action === "logout") {
      await clearSession();
      return Response.json({ ok: true });
    }

    const user = await requireActiveUser();

    if (action === "saveRequestAlerts") {
      if (user.role !== "admin" && user.role !== "manager" && user.role !== "payroll_admin") return jsonError("Manager or administrator access required.", 403);
      const preferences = { inApp: body.inApp !== false, email: body.email !== false };
      await database().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(`request_alerts_${user.id}`, JSON.stringify(preferences)).run();
      return Response.json({ ok: true, requestAlerts: preferences });
    }

    if (action === "changePassword") {
      const currentPassword = String(body.currentPassword ?? "");
      const newPassword = String(body.newPassword ?? "");
      if (!passwordIsStrong(newPassword)) return jsonError("New password must have at least 6 characters, including at least one letter and one number.");
      const record = await database().prepare("SELECT password_hash, password_salt FROM users WHERE id = ?").bind(user.id).first<{ password_hash: string; password_salt: string }>();
      if (!record || !(await verifyPassword(currentPassword, record.password_salt, record.password_hash))) return jsonError("Current password is incorrect.", 401);
      const next = await hashPassword(newPassword);
      await database().prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
        .bind(next.hash, next.salt, now, user.id).run();
      return Response.json({ ok: true });
    }

    if (action === "createRequest") {
      if (!user.department_id) return jsonError("HR must assign your department before you can submit a request.");
      const startDate = cleanText(body.startDate, 10);
      const endDate = cleanText(body.endDate, 10);
      const totalDays = Number(body.totalDays);
      const vacationPayRequested = Boolean(body.vacationPayRequested) && user.employment_type === "hourly";
      const vacationPayAmount = Number(body.vacationPayAmount);
      const notes = cleanText(body.notes, 1000);
      const acknowledged = Boolean(body.acknowledged);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || new Date(endDate) < new Date(startDate)) return jsonError("Enter a valid vacation date range.");
      if (!Number.isFinite(totalDays) || totalDays <= 0 || totalDays > 60) return jsonError("Enter the total vacation days requested.");
      if (!acknowledged) return jsonError("Confirm that the request is accurate before submitting.");
      if (vacationPayRequested && totalDays > 10) return jsonError("Vacation pay requests are limited to a maximum of two work weeks.");
      if (vacationPayRequested && (!Number.isFinite(vacationPayAmount) || vacationPayAmount <= 0)) return jsonError("Enter the vacation pay amount requested.");
      const amountCents = vacationPayRequested ? Math.round(vacationPayAmount * 100) : null;
      const created = await database().prepare(`INSERT INTO vacation_requests
        (employee_id, department_id, start_date, end_date, total_days, vacation_pay_requested, vacation_pay_amount_cents, employee_notes, employee_acknowledged_at, status, created_at, updated_at, employment_type_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING id`)
        .bind(user.id, user.department_id, startDate, endDate, String(totalDays), vacationPayRequested ? 1 : 0, amountCents, notes, now, now, now, user.employment_type)
        .first<{ id: number }>();
      if (!created) throw new Error("Request could not be submitted.");
      const department = await database().prepare("SELECT d.name, m.id AS manager_id, m.email AS manager_email FROM departments d LEFT JOIN users m ON m.id = d.manager_user_id AND m.status = 'active' AND m.has_portal_access = 1 WHERE d.id = ?")
        .bind(user.department_id).first<{ name: string; manager_id: number | null; manager_email: string | null }>();
      const ownerId = await masterAdminId();
      if (ownerId) {
        await database().prepare(`INSERT OR IGNORE INTO personal_reminders
          (owner_user_id, related_employee_id, title, details, category, priority, due_date, status, source_type, source_id, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'vacation', 'high', ?, 'open', 'vacation_request', ?, ?, ?, ?)`).bind(
            ownerId, user.id, `Vacation approval pending — ${user.full_name}`,
            `${startDate} to ${endDate} · ${totalDays} day${totalDays === 1 ? "" : "s"} · ${department?.name ?? "Unassigned"}`,
            dateOffset(todayDate(), 2), created.id, user.id, now, now,
          ).run();
      }
      const routing = await resolveApproval(user.id, user.department_id);
      const recipients = await newRequestRecipients(routing?.approver_email);
      const origin = new URL(request.url).origin;
      const mail = await sendNotification(created.id, recipients, `Vacation request from ${user.full_name}`, `<p><strong>${user.full_name}</strong> submitted a vacation request for ${startDate} to ${endDate} (${totalDays} day${totalDays === 1 ? "" : "s"}).</p><p>Department: ${department?.name ?? "Unassigned"}</p><p><a href="${origin}">Review the request</a></p>`);
      return Response.json({ ok: true, id: created.id, notification: mail.status });
    }

    if (action === "cancelRequest") {
      const requestId = asId(body.requestId);
      if (!requestId) return jsonError("Request not found.");
      const result = await database().prepare("UPDATE vacation_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND employee_id = ? AND status = 'pending'")
        .bind(now, requestId, user.id).run();
      if (!result.meta.changes) return jsonError("Only your pending requests can be cancelled.", 403);
      return Response.json({ ok: true });
    }

    if (action === "decideRequest") {
      if (user.role !== "admin" && user.role !== "manager") return jsonError("Manager access required.", 403);
      const requestId = asId(body.requestId);
      const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : null;
      const decisionNotes = cleanText(body.decisionNotes, 1000);
      if (!requestId || !decision) return jsonError("Choose approve or reject.");
      const record = await database().prepare(`SELECT vr.*, e.full_name AS employee_name, e.email AS employee_email, COALESCE(vr.employment_type_snapshot, e.employment_type) AS employment_type, d.name AS department_name, routing_approver.id AS approver_user_id
        FROM vacation_requests vr JOIN users e ON e.id = vr.employee_id JOIN departments d ON d.id = vr.department_id
        ${approvalRouteJoins("vr.employee_id", "vr.department_id")} WHERE vr.id = ?`).bind(requestId).first<Record<string, unknown>>();
      if (!record || record.status !== "pending") return jsonError("This request is no longer pending.");
      if (Number(record.employee_id) === user.id) return jsonError("Your own vacation must be approved or rejected by another manager or HR administrator.", 403);
      if (user.role === "manager" && Number(record.approver_user_id) !== user.id) return jsonError("This request is assigned to another approver or HR.", 403);
      const decisionResult = await database().prepare(`UPDATE vacation_requests SET status = ?, decision_by = ?, decision_notes = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'
        AND (? = 'admin' OR id IN (SELECT check_request.id FROM vacation_requests check_request
          ${approvalRouteJoins("check_request.employee_id", "check_request.department_id", "check_routing")}
          WHERE check_request.id = ? AND check_routing_approver.id = ?))`)
        .bind(decision, user.id, decisionNotes, now, now, requestId, user.role, requestId, user.id).run();
      if (!decisionResult.meta.changes) return jsonError("Another reviewer has already decided this request.", 409);
      await database().prepare(`UPDATE personal_reminders SET status = 'done', completed_at = ?, updated_at = ?
        WHERE source_type = 'vacation_request' AND source_id = ? AND status = 'open'`).bind(now, now, requestId).run();
      await sendNotification(requestId, [String(record.employee_email), ...await approvalRecipients()], `Vacation request ${decision}`, `<p>Your vacation request for ${record.start_date} to ${record.end_date} was <strong>${decision}</strong> by ${user.full_name}.</p>${decisionNotes ? `<p>Note: ${decisionNotes}</p>` : ""}`);
      if (decision === "approved" && record.employment_type === "hourly" && Number(record.vacation_pay_requested)) {
        await sendNotification(requestId, await payrollRecipients(), `Vacation pay ready — ${String(record.employee_name)}`,
          `<p>Approved hourly vacation requires payroll processing.</p><p><strong>${escapeHtml(record.employee_name)}</strong> · ${escapeHtml(record.department_name)} · ${escapeHtml(record.start_date)} to ${escapeHtml(record.end_date)}</p><p>Requested amount: $${(Number(record.vacation_pay_amount_cents) / 100).toFixed(2)} · Request #${requestId}</p><p><a href="${new URL(request.url).origin}">Open Payroll's pending queue</a></p>`);
      }
      return Response.json({ ok: true });
    }

    if (action === "updatePayroll") {
      if (user.role !== "admin" && user.role !== "payroll_admin") return jsonError("Payroll administrator access required.", 403);
      const requestId = asId(body.requestId);
      const payrollProcessed = Boolean(body.payrollProcessed);
      const payrollDate = cleanText(body.payrollDate, 10) || null;
      const amount = body.payrollAmount === "" || body.payrollAmount == null ? null : Number(body.payrollAmount);
      if (!requestId) return jsonError("Request not found.");
      if (amount != null && (!Number.isFinite(amount) || amount < 0)) return jsonError("Enter a valid payroll amount.");
      const record = await database().prepare(`SELECT vr.*, COALESCE(vr.employment_type_snapshot, u.employment_type) AS employment_type
        FROM vacation_requests vr JOIN users u ON u.id = vr.employee_id WHERE vr.id = ?`).bind(requestId).first<Record<string, unknown>>();
      if (!record || record.employment_type !== "hourly" || !["approved", "rejected"].includes(String(record.status))) return jsonError("Payroll records require a manager-decided hourly request.");
      if (record.hr_finalized) return jsonError("HR has finalized this record; payroll processing is closed.", 409);
      const needsPayment = record.status === "approved" && Number(record.vacation_pay_requested) === 1;
      if (payrollDate && !validDate(payrollDate)) return jsonError("Enter a valid payroll date.");
      if (payrollProcessed && needsPayment && (!payrollDate || amount == null || amount <= 0)) return jsonError("Enter the payroll date and amount paid before completing payroll.");
      if (!needsPayment && amount != null && amount !== 0) return jsonError("This request does not authorize a vacation-pay payment.");
      const result = await database().prepare("UPDATE vacation_requests SET payroll_processed = ?, payroll_date = ?, payroll_amount_paid_cents = ?, payroll_saved_by = ?, payroll_saved_at = ?, updated_at = ? WHERE id = ? AND hr_finalized = 0")
        .bind(payrollProcessed ? 1 : 0, payrollDate, needsPayment && amount != null ? Math.round(amount * 100) : 0, user.id, now, now, requestId).run();
      if (!result.meta.changes) return jsonError("This payroll record has changed. Refresh and try again.", 409);
      return Response.json({ ok: true });
    }

    if (action === "finalizeRequest") {
      if (user.role !== "admin") return jsonError("HR administrator access required.", 403);
      const requestId = asId(body.requestId);
      if (!requestId) return jsonError("Request not found.");
      const result = await database().prepare(`UPDATE vacation_requests SET hr_finalized = 1, hr_finalized_by = ?, hr_finalized_at = ?, updated_at = ?
        WHERE id = ? AND hr_finalized = 0 AND status IN ('approved', 'rejected')
        AND (COALESCE(employment_type_snapshot, (SELECT employment_type FROM users WHERE id = employee_id)) = 'salaried' OR payroll_processed = 1)`)
        .bind(user.id, now, now, requestId).run();
      if (!result.meta.changes) return jsonError("A manager decision and, for hourly employees, a completed payroll record are required before HR sign-off.", 409);
      return Response.json({ ok: true });
    }

    if (action === "updateApprovedVacation") {
      if (user.role !== "admin") return jsonError("Administrator access required.", 403);
      const requestId = asId(body.requestId);
      const startDate = cleanText(body.startDate, 10);
      const endDate = cleanText(body.endDate, 10);
      const totalDays = Number(body.totalDays);
      const notes = cleanText(body.notes, 1000);
      if (!requestId) return jsonError("Vacation record not found.");
      if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) return jsonError("Enter a valid vacation date range.");
      if (!Number.isFinite(totalDays) || totalDays < 0.5 || totalDays > 60) return jsonError("Enter total vacation days between 0.5 and 60.");
      const record = await database().prepare(`SELECT vr.id, vr.status, e.email AS employee_email, e.full_name AS employee_name
        FROM vacation_requests vr JOIN users e ON e.id = vr.employee_id WHERE vr.id = ?`).bind(requestId)
        .first<{ id: number; status: string; employee_email: string; employee_name: string }>();
      if (!record || record.status !== "approved") return jsonError("Only approved vacation can be edited from the calendar.");
      await database().prepare("UPDATE vacation_requests SET start_date = ?, end_date = ?, total_days = ?, employee_notes = ?, updated_at = ? WHERE id = ?")
        .bind(startDate, endDate, String(totalDays), notes, now, requestId).run();
      const notification = await sendNotification(requestId, [record.employee_email, ...await approvalRecipients()],
        `Vacation dates updated for ${record.employee_name}`,
        `<p>The approved vacation record for <strong>${escapeHtml(record.employee_name)}</strong> was updated by ${escapeHtml(user.full_name)}.</p><p>${escapeHtml(startDate)} to ${escapeHtml(endDate)} (${totalDays} day${totalDays === 1 ? "" : "s"}).</p>${notes ? `<p>Note: ${escapeHtml(notes)}</p>` : ""}`);
      return Response.json({ ok: true, notification: notification.status });
    }

    if (action === "saveApprovalMap") {
      if (user.role !== "admin") return jsonError("HR administrator access required to change approval routing.", 403);
      try { return Response.json({ ok: true, approvalMap: await saveApprovalMap(body.graph, body.revision, user.id) }); }
      catch (error) { const message = error instanceof Error ? error.message : "Unable to save the approval map."; return jsonError(message, message.includes("Another administrator") ? 409 : 400); }
    }

    if (user.role !== "admin" && user.role !== "payroll_admin") return jsonError("Administrator access required.", 403);

    if (action === "createReminder") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const title = cleanText(body.title, 140);
      const details = cleanText(body.details, 1000);
      const category = ["vacation", "benefits", "training", "review", "document", "return_to_work", "custom"].includes(String(body.category)) ? String(body.category) : "custom";
      const priority = body.priority === "high" ? "high" : "normal";
      const dueDate = cleanText(body.dueDate, 10);
      const relatedEmployeeId = asId(body.relatedEmployeeId);
      if (!title) return jsonError("Enter a reminder title.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return jsonError("Choose a valid due date.");
      const created = await database().prepare(`INSERT INTO personal_reminders
        (owner_user_id, related_employee_id, title, details, category, priority, due_date, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) RETURNING id`).bind(user.id, relatedEmployeeId, title, details, category, priority, dueDate, user.id, now, now).first<{ id: number }>();
      if (!created) throw new Error("Reminder could not be created.");
      const notification = await emailReminder(created.id, new URL(request.url).origin, "Reminder scheduled");
      if (notification.status === "sent") {
        await database().prepare("UPDATE personal_reminders SET last_notified_at = ? WHERE id = ?").bind(now, created.id).run();
      }
      return Response.json({ ok: true, notification: notification.status, detail: notification.detail });
    }

    if (action === "updateReminder") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const reminderId = asId(body.reminderId);
      if (!reminderId) return jsonError("Reminder not found.");
      const reminder = await database().prepare("SELECT source_type, source_id, related_employee_id FROM personal_reminders WHERE id = ? AND owner_user_id = ?")
        .bind(reminderId, user.id).first<{ source_type: string | null; source_id: number | null; related_employee_id: number | null }>();
      if (!reminder) return jsonError("Reminder not found.");
      if (body.operation === "delete") {
        if (reminder.source_type) return jsonError("This system-generated reminder cannot be deleted separately.");
        await database().prepare("DELETE FROM personal_reminders WHERE id = ? AND owner_user_id = ?").bind(reminderId, user.id).run();
        return Response.json({ ok: true });
      }
      if (body.operation === "edit") {
        const title = cleanText(body.title, 140);
        const details = cleanText(body.details, 1000);
        const category = ["vacation", "benefits", "training", "review", "document", "return_to_work", "custom"].includes(String(body.category)) ? String(body.category) : "custom";
        const priority = body.priority === "high" ? "high" : "normal";
        const dueDate = cleanText(body.dueDate, 10);
        const relatedEmployeeId = reminder.source_type === "workflow_task" ? reminder.related_employee_id : asId(body.relatedEmployeeId);
        if (!title) return jsonError("Enter a reminder title.");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return jsonError("Choose a valid due date.");
        await database().prepare(`UPDATE personal_reminders SET related_employee_id = ?, title = ?, details = ?, category = ?,
          priority = ?, due_date = ?, last_notified_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?`)
          .bind(relatedEmployeeId, title, details, category, priority, dueDate, now, reminderId, user.id).run();
        if (reminder.source_type === "workflow_task" && reminder.source_id) {
          await database().prepare("UPDATE workflow_tasks SET title = ?, details = ?, due_date = ? WHERE id = ?")
            .bind(title, details, dueDate, reminder.source_id).run();
        }
        const notification = await emailReminder(reminderId, new URL(request.url).origin, "Reminder updated");
        if (notification.status === "sent") {
          await database().prepare("UPDATE personal_reminders SET last_notified_at = ? WHERE id = ?").bind(now, reminderId).run();
        }
        return Response.json({ ok: true, notification: notification.status, detail: notification.detail });
      }
      if (body.operation === "snooze") {
        const dueDate = cleanText(body.dueDate, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return jsonError("Choose a valid snooze date.");
        await database().prepare("UPDATE personal_reminders SET due_date = ?, status = 'open', completed_at = NULL, last_notified_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?")
          .bind(dueDate, now, reminderId, user.id).run();
        if (reminder.source_type === "workflow_task" && reminder.source_id) {
          await database().prepare("UPDATE workflow_tasks SET due_date = ?, status = 'pending', completed_by = NULL, completed_at = NULL WHERE id = ?")
            .bind(dueDate, reminder.source_id).run();
          const task = await database().prepare("SELECT run_id FROM workflow_tasks WHERE id = ?").bind(reminder.source_id).first<{ run_id: number }>();
          if (task) await syncWorkflowRunStatus(task.run_id, user.id, now);
        }
        return Response.json({ ok: true });
      }
      const completed = body.completed !== false;
      await database().prepare("UPDATE personal_reminders SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?")
        .bind(completed ? "done" : "open", completed ? now : null, now, reminderId, user.id).run();
      if (reminder.source_type === "workflow_task" && reminder.source_id) {
        await database().prepare("UPDATE workflow_tasks SET status = ?, completed_by = ?, completed_at = ? WHERE id = ?")
          .bind(completed ? "completed" : "pending", completed ? user.id : null, completed ? now : null, reminder.source_id).run();
        const task = await database().prepare("SELECT run_id FROM workflow_tasks WHERE id = ?").bind(reminder.source_id).first<{ run_id: number }>();
        if (task) await syncWorkflowRunStatus(task.run_id, user.id, now);
      }
      return Response.json({ ok: true });
    }

    if (action === "sendReminderNow") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const reminderId = asId(body.reminderId);
      if (!reminderId) return jsonError("Reminder not found.");
      const owned = await database().prepare("SELECT id FROM personal_reminders WHERE id = ? AND owner_user_id = ?").bind(reminderId, user.id).first();
      if (!owned) return jsonError("Reminder not found.");
      const notification = await emailReminder(reminderId, new URL(request.url).origin, "Reminder", true);
      if (notification.status === "sent") {
        await database().prepare("UPDATE personal_reminders SET last_notified_at = ? WHERE id = ?").bind(now, reminderId).run();
      }
      return Response.json({ ok: true, notification: notification.status, detail: notification.detail });
    }

    if (action === "startWorkflow") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const workflowType = String(body.workflowType) as WorkflowType;
      const allowedTypes: WorkflowType[] = ["onboarding", "return_to_work", "probation_review", "document_expiry", "offboarding"];
      const employeeId = asId(body.employeeId);
      const targetDate = cleanText(body.targetDate, 10);
      if (!allowedTypes.includes(workflowType) || !employeeId) return jsonError("Choose a workflow and employee.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return jsonError("Choose a valid target date.");
      const employee = await database().prepare("SELECT id, full_name, work_schedule FROM users WHERE id = ? AND status != 'deleted'").bind(employeeId)
        .first<{ id: number; full_name: string; work_schedule: string | null }>();
      if (!employee) return jsonError("Employee not found.");
      const workflow = await createWorkflowRecord(workflowType, employee, targetDate, user.id, now);
      const recipient = await personalReminderEmail();
      const notification = recipient ? await sendNotification(null, [recipient], `Workflow started: ${workflow.definition.title}`,
        `<p>The workflow for <strong>${escapeHtml(employee.full_name)}</strong> has started. Every open step was added to Tasks &amp; Alerts.</p><ul>${workflow.emailTasks.map((task) => `<li><strong>${escapeHtml(task.title)}</strong> — ${task.skipped ? "skipped" : `due ${escapeHtml(task.dueDate)}`}</li>`).join("")}</ul><p><a href="${escapeHtml(new URL(request.url).origin)}">Open the workflow centre</a></p>`) : { status: "not_configured", detail: "Save a personal reminder email in Settings." };
      return Response.json({ ok: true, runId: workflow.runId, notification: notification.status, detail: notification.detail });
    }

    if (action === "completeWorkflowTask") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const taskId = asId(body.taskId);
      if (!taskId) return jsonError("Workflow task not found.");
      const task = await database().prepare("SELECT id, run_id, status FROM workflow_tasks WHERE id = ?").bind(taskId).first<{ id: number; run_id: number; status: string }>();
      if (!task) return jsonError("Workflow task not found.");
      const completed = body.completed !== false;
      await database().prepare("UPDATE workflow_tasks SET status = ?, completed_by = ?, completed_at = ? WHERE id = ?")
        .bind(completed ? "completed" : "pending", completed ? user.id : null, completed ? now : null, taskId).run();
      await database().prepare("UPDATE personal_reminders SET status = ?, completed_at = ?, updated_at = ? WHERE owner_user_id = ? AND source_type = 'workflow_task' AND source_id = ?")
        .bind(completed ? "done" : "open", completed ? now : null, now, user.id, taskId).run();
      await syncWorkflowRunStatus(task.run_id, user.id, now);
      return Response.json({ ok: true });
    }

    if (action === "cancelWorkflow") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const runId = asId(body.runId);
      if (!runId) return jsonError("Workflow not found.");
      await database().prepare("UPDATE workflow_runs SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'active'").bind(now, runId).run();
      await database().prepare(`UPDATE personal_reminders SET status = 'done', completed_at = ?, updated_at = ? WHERE owner_user_id = ?
        AND source_type = 'workflow_task' AND source_id IN (SELECT id FROM workflow_tasks WHERE run_id = ?)`).bind(now, now, user.id, runId).run();
      return Response.json({ ok: true });
    }

    if (action === "saveUser" || action === "savePerson") {
      const userId = asId(body.userId);
      const fullName = cleanText(body.fullName, 100);
      const status = ["pending", "active", "on_leave", "terminated", "disabled"].includes(String(body.status)) ? String(body.status) : "pending";
      const employmentType = ["hourly", "salaried"].includes(String(body.employmentType)) ? String(body.employmentType) : "hourly";
      const workSchedule = ["full_time", "part_time"].includes(String(body.workSchedule)) ? String(body.workSchedule) : null;
      const departmentId = asId(body.departmentId);
      const hireDate = cleanText(body.hireDate, 10);
      const leaveStartDate = cleanText(body.leaveStartDate, 10);
      const leaveEndDate = cleanText(body.leaveEndDate, 10);
      const terminationDate = status === "terminated" ? cleanText(body.terminationDate, 10) : "";
      const jobTitle = cleanText(body.jobTitle, 120);
      const compensation = body.compensationAmount === "" || body.compensationAmount == null ? null : Number(body.compensationAmount);
      const compensationFrequency = ["hourly", "annual"].includes(String(body.compensationFrequency)) ? String(body.compensationFrequency) : null;
      const phone = cleanText(body.phone, 40);
      const workLocation = cleanText(body.workLocation, 100);
      const employeeNotes = cleanText(body.employeeNotes, 2000);
      if (!userId || fullName.length < 2) return jsonError("Enter the employee's full name.");
      if (compensation != null && (!Number.isFinite(compensation) || compensation < 0 || compensation > 10000000)) return jsonError("Enter a valid compensation amount.");
      if (["active", "on_leave", "terminated"].includes(status) && !validDate(hireDate)) return jsonError("Enter the employee's hire date for reporting.");
      if (status === "terminated" && !validDate(terminationDate)) return jsonError("Enter the employee's termination date.");
      if (terminationDate && hireDate && terminationDate < hireDate) return jsonError("Termination date cannot be before the hire date.");
      if (status === "on_leave" && !validDate(leaveStartDate)) return jsonError("Enter the leave start date.");
      if (status === "on_leave" && !validDate(leaveEndDate)) return jsonError("Enter the expected return date so the return-to-work workflow can be scheduled.");
      if (leaveEndDate && (!validDate(leaveEndDate) || leaveEndDate < leaveStartDate)) return jsonError("Enter a valid leave end date.");
      if (departmentId) {
        const department = await database().prepare("SELECT id FROM departments WHERE id = ?").bind(departmentId).first();
        if (!department) return jsonError("Choose a valid department.");
      }
      const target = await database().prepare("SELECT email, role, status, is_master_admin, has_portal_access FROM users WHERE id = ? AND status != 'deleted'")
        .bind(userId).first<{ email: string; role: string; status: string; is_master_admin: number; has_portal_access: number }>();
      if (!target) return jsonError("Employee record not found.");
      if (target?.is_master_admin && !user.is_master_admin) return jsonError("Only the master administrator can edit this account.", 403);
      const requestedEmail = cleanEmail(body.email);
      const requestedRole = ["employee", "manager", "admin", "payroll_admin"].includes(String(body.role)) ? String(body.role) : target.role;
      const email = action === "saveUser" && target.has_portal_access ? requestedEmail : target.email;
      const role = action === "saveUser" ? requestedRole : target.role;
      if (target.has_portal_access && !validEmail(email)) return jsonError("Enter a valid account email.");
      if (userId === user.id && (role !== user.role || status !== "active")) return jsonError("You cannot remove your own administrator access.");
      await database().prepare(`UPDATE users SET full_name = ?, email = ?, role = ?, status = ?, employment_type = ?, work_schedule = ?,
        hire_date = ?, termination_date = ?, leave_start_date = ?, leave_end_date = ?, job_title = ?, compensation_amount_cents = ?,
        compensation_frequency = ?, phone = ?, work_location = ?, employee_notes = ?, department_id = ?, updated_at = ? WHERE id = ?`)
        .bind(fullName, email, role, status, employmentType, workSchedule, hireDate || null, terminationDate || null,
          leaveStartDate || null, leaveEndDate || null, jobTitle || null, compensation == null ? null : Math.round(compensation * 100),
          compensationFrequency, phone || null, workLocation || null, employeeNotes || null, departmentId, now, userId).run();
      if (status === "pending" || status === "terminated" || status === "disabled") await database().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
      if (status === "terminated") await database().prepare("UPDATE departments SET manager_user_id = NULL WHERE manager_user_id = ?").bind(userId).run();
      let workflow: "created" | "updated" | null = null;
      if (status === "on_leave" && leaveEndDate) {
        const ownerUserId = await masterAdminId();
        const activeReturnWorkflow = await database().prepare("SELECT id FROM workflow_runs WHERE employee_id = ? AND workflow_type = 'return_to_work' AND status = 'active' LIMIT 1").bind(userId).first();
        if (ownerUserId && (target.status !== "on_leave" || activeReturnWorkflow)) {
          const ensured = await ensureReturnToWorkWorkflow({ id: userId, full_name: fullName, work_schedule: workSchedule }, leaveEndDate, ownerUserId, now);
          workflow = ensured.created ? "created" : "updated";
          if (ensured.created) {
            const recipient = await personalReminderEmail();
            if (recipient) await sendNotification(null, [recipient], `Return-to-work workflow started: ${fullName}`,
              `<p><strong>${escapeHtml(fullName)}</strong> was placed on leave through People. A return-to-work workflow has been scheduled for ${escapeHtml(leaveEndDate)} and its tasks were added to Tasks &amp; Alerts.</p><p><a href="${escapeHtml(new URL(request.url).origin)}">Open the workflow centre</a></p>`);
          }
        }
      }
      return Response.json({ ok: true, workflow });
    }

    if (action === "addPerson") {
      const fullName = cleanText(body.fullName, 100);
      const status = ["active", "on_leave", "terminated"].includes(String(body.status)) ? String(body.status) : "active";
      const employmentType = ["hourly", "salaried"].includes(String(body.employmentType)) ? String(body.employmentType) : "hourly";
      const workSchedule = ["full_time", "part_time"].includes(String(body.workSchedule)) ? String(body.workSchedule) : null;
      const departmentId = asId(body.departmentId);
      const hireDate = cleanText(body.hireDate, 10);
      const leaveStartDate = cleanText(body.leaveStartDate, 10);
      const leaveEndDate = cleanText(body.leaveEndDate, 10);
      const terminationDate = cleanText(body.terminationDate, 10);
      const jobTitle = cleanText(body.jobTitle, 120);
      const compensation = body.compensationAmount === "" || body.compensationAmount == null ? null : Number(body.compensationAmount);
      const compensationFrequency = ["hourly", "annual"].includes(String(body.compensationFrequency)) ? String(body.compensationFrequency) : null;
      const phone = cleanText(body.phone, 40);
      const workLocation = cleanText(body.workLocation, 100);
      const employeeNotes = cleanText(body.employeeNotes, 2000);
      if (fullName.length < 2) return jsonError("Enter the employee's full name.");
      if (!validDate(hireDate)) return jsonError("Enter the employee's hire date.");
      if (status === "on_leave" && (!validDate(leaveStartDate) || !validDate(leaveEndDate) || leaveEndDate < leaveStartDate)) return jsonError("Enter valid leave and expected return dates.");
      if (status === "terminated" && (!validDate(terminationDate) || terminationDate < hireDate)) return jsonError("Enter a valid termination date.");
      if (compensation != null && (!Number.isFinite(compensation) || compensation < 0 || compensation > 10000000)) return jsonError("Enter a valid compensation amount.");
      if (departmentId) {
        const department = await database().prepare("SELECT id FROM departments WHERE id = ? AND active = 1").bind(departmentId).first();
        if (!department) return jsonError("Choose an active department.");
      }
      const credentials = await hashPassword(crypto.randomUUID());
      const created = await database().prepare(`INSERT INTO users
        (full_name, email, password_hash, password_salt, role, status, employment_type, work_schedule, hire_date, termination_date,
         leave_start_date, leave_end_date, job_title, compensation_amount_cents, compensation_frequency, phone, work_location,
         employee_notes, has_portal_access, department_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'employee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?) RETURNING id`)
        .bind(fullName, internalRecordEmail(), credentials.hash, credentials.salt, status, employmentType, workSchedule, hireDate,
          status === "terminated" ? terminationDate : null, status === "on_leave" ? leaveStartDate : null, status === "on_leave" ? leaveEndDate : null,
          jobTitle || null, compensation == null ? null : Math.round(compensation * 100), compensationFrequency, phone || null,
          workLocation || null, employeeNotes || null, departmentId, now, now).first<{ id: number }>();
      let workflow: "created" | null = null;
      if (created && status === "on_leave") {
        const ownerUserId = await masterAdminId();
        if (ownerUserId) {
          await ensureReturnToWorkWorkflow({ id: created.id, full_name: fullName, work_schedule: workSchedule }, leaveEndDate, ownerUserId, now);
          workflow = "created";
          const recipient = await personalReminderEmail();
          if (recipient) await sendNotification(null, [recipient], `Return-to-work workflow started: ${fullName}`,
            `<p><strong>${escapeHtml(fullName)}</strong> was added as on leave. A return-to-work workflow has been scheduled for ${escapeHtml(leaveEndDate)} and its tasks were added to Tasks &amp; Alerts.</p><p><a href="${escapeHtml(new URL(request.url).origin)}">Open the workflow centre</a></p>`);
        }
      }
      return Response.json({ ok: true, userId: created?.id, workflow });
    }

    if (action === "addUser") {
      const fullName = cleanText(body.fullName, 100);
      const email = cleanEmail(body.email);
      const password = String(body.password ?? "");
      if (fullName.length < 2) return jsonError("Enter the employee's full name.");
      if (!validEmail(email)) return jsonError("Enter a valid employee email address.");
      if (!passwordIsStrong(password)) return jsonError("Temporary password must have at least 6 characters, including at least one letter and one number.");
      const role = ["employee", "manager", "admin", "payroll_admin"].includes(String(body.role)) ? String(body.role) : "employee";
      const employmentType = ["hourly", "salaried"].includes(String(body.employmentType)) ? String(body.employmentType) : "hourly";
      const workSchedule = ["full_time", "part_time"].includes(String(body.workSchedule)) ? String(body.workSchedule) : null;
      const departmentId = asId(body.departmentId);
      const hireDate = cleanText(body.hireDate, 10);
      if (!validDate(hireDate)) return jsonError("Enter the employee's hire date for reporting.");
      const credentials = await hashPassword(password);
      await database().prepare(`INSERT INTO users (full_name, email, password_hash, password_salt, role, status, employment_type, work_schedule, hire_date, department_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
        .bind(fullName, email, credentials.hash, credentials.salt, role, employmentType, workSchedule, hireDate, departmentId, now, now).run();
      return Response.json({ ok: true });
    }

    if (action === "saveAccess") {
      const userId = asId(body.userId);
      const email = cleanEmail(body.email);
      const password = String(body.password ?? "");
      const role = ["employee", "manager", "admin", "payroll_admin"].includes(String(body.role)) ? String(body.role) : "employee";
      if (!userId || !validEmail(email)) return jsonError("Choose an employee and enter a valid email.");
      const target = await database().prepare("SELECT id, status, hire_date, is_master_admin, has_portal_access FROM users WHERE id = ? AND status != 'deleted'")
        .bind(userId).first<{ id: number; status: string; hire_date: string | null; is_master_admin: number; has_portal_access: number }>();
      if (!target) return jsonError("Employee record not found.");
      if (target.is_master_admin && !user.is_master_admin) return jsonError("Only the master administrator can edit this account.", 403);
      if (target.is_master_admin && role !== "admin") return jsonError("The master administrator must retain Administrator access.", 403);
      if (userId === user.id && role !== user.role) return jsonError("You cannot change your own administrator role.", 403);
      if (!target.has_portal_access && !passwordIsStrong(password)) return jsonError("A new account needs a temporary password with at least 6 characters, one letter and one number.");
      const existing = await database().prepare("SELECT id FROM users WHERE email = ? AND id != ? AND status != 'deleted'").bind(email, userId).first();
      if (existing) return jsonError("That email is already connected to another employee.", 409);
      const activate = Boolean(body.activate) && target.status === "pending";
      if (activate && !validDate(target.hire_date ?? "")) return jsonError("Add the employee's hire date in People before approving access.");
      if (password) {
        if (!passwordIsStrong(password)) return jsonError("Temporary password must have at least 6 characters, including one letter and one number.");
        const credentials = await hashPassword(password);
        await database().prepare(`UPDATE users SET email = ?, role = ?, has_portal_access = 1, status = ?, password_hash = ?, password_salt = ?,
          failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`)
          .bind(email, role, activate ? "active" : target.status, credentials.hash, credentials.salt, now, userId).run();
        await database().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
      } else {
        await database().prepare("UPDATE users SET email = ?, role = ?, has_portal_access = 1, status = ?, updated_at = ? WHERE id = ?")
          .bind(email, role, activate ? "active" : target.status, now, userId).run();
      }
      return Response.json({ ok: true });
    }

    if (action === "revokeAccess") {
      const userId = asId(body.userId);
      if (!userId || userId === user.id) return jsonError("You cannot remove your own access.");
      const target = await database().prepare("SELECT is_master_admin FROM users WHERE id = ? AND status != 'deleted'").bind(userId).first<{ is_master_admin: number }>();
      if (!target) return jsonError("Employee record not found.");
      if (target.is_master_admin) return jsonError("The master administrator's access cannot be removed.", 403);
      const credentials = await hashPassword(crypto.randomUUID());
      await database().prepare(`UPDATE users SET email = ?, password_hash = ?, password_salt = ?, role = 'employee', has_portal_access = 0,
        failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`)
        .bind(internalRecordEmail(), credentials.hash, credentials.salt, now, userId).run();
      await database().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
      await database().prepare("UPDATE departments SET manager_user_id = NULL WHERE manager_user_id = ?").bind(userId).run();
      return Response.json({ ok: true });
    }

    if (action === "resetPassword") {
      const userId = asId(body.userId);
      const password = String(body.password ?? "");
      if (!userId || !passwordIsStrong(password)) return jsonError("Temporary password must have at least 6 characters, including at least one letter and one number.");
      const target = await database().prepare("SELECT is_master_admin, has_portal_access FROM users WHERE id = ?").bind(userId).first<{ is_master_admin: number; has_portal_access: number }>();
      if (target?.is_master_admin && !user.is_master_admin) return jsonError("Only the master administrator can reset this account.", 403);
      if (!target?.has_portal_access) return jsonError("This employee does not currently have portal access.");
      const credentials = await hashPassword(password);
      await database().prepare("UPDATE users SET password_hash = ?, password_salt = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?")
        .bind(credentials.hash, credentials.salt, now, userId).run();
      await database().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
      return Response.json({ ok: true });
    }

    if (action === "deleteUser") {
      const userId = asId(body.userId);
      if (!userId || userId === user.id) return jsonError("You cannot delete your own account.");
      const target = await database().prepare("SELECT is_master_admin FROM users WHERE id = ?").bind(userId).first<{ is_master_admin: number }>();
      if (target?.is_master_admin) return jsonError("The master administrator account cannot be deleted.", 403);
      await database().prepare("UPDATE users SET email = 'deleted-' || id || '-' || email, status = 'deleted', updated_at = ? WHERE id = ?")
        .bind(now, userId).run();
      await database().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
      await database().prepare("UPDATE departments SET manager_user_id = NULL WHERE manager_user_id = ?").bind(userId).run();
      return Response.json({ ok: true });
    }

    if (action === "saveDepartment") {
      const departmentId = asId(body.departmentId);
      const name = cleanText(body.name, 80);
      const managerUserId = asId(body.managerUserId);
      const active = body.active !== false;
      if (!name) return jsonError("Department name is required.");
      if (managerUserId) {
        const manager = await database().prepare("SELECT id FROM users WHERE id = ? AND role IN ('manager', 'admin') AND status = 'active' AND has_portal_access = 1")
          .bind(managerUserId).first();
        if (!manager) return jsonError("Choose an active manager or administrator with portal access.");
      }
      if (departmentId) {
        await database().prepare("UPDATE departments SET name = ?, manager_user_id = ?, active = ? WHERE id = ?")
          .bind(name, managerUserId, active ? 1 : 0, departmentId).run();
      } else {
        await database().prepare("INSERT INTO departments (name, manager_user_id, active, created_at) VALUES (?, ?, 1, ?)")
          .bind(name, managerUserId, now).run();
      }
      return Response.json({ ok: true });
    }

    if (action === "saveSettings") {
      const companyName = cleanText(body.companyName, 100);
      const approvalEmails = parseApprovalEmails(cleanText(body.approvalEmails, 2000));
      if (!companyName) return jsonError("Enter a company name.");
      const invalidEmails = approvalEmails.filter((email) => !isApprovalEmail(email));
      if (invalidEmails.length) return jsonError(`Approval recipients must use @sweetsfromtheearth.com: ${invalidEmails.join(", ")}`);
      const updates = [
        database().prepare("INSERT INTO settings (key, value) VALUES ('company_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(companyName),
        database().prepare("INSERT INTO settings (key, value) VALUES ('hr_email', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(PRIMARY_HR_EMAIL),
        database().prepare("INSERT INTO settings (key, value) VALUES ('approval_emails', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(approvalEmails.join("\n")),
      ];
      if (user.is_master_admin) {
        const personalReminderEmail = cleanEmail(body.personalReminderEmail);
        const personalReminderEnabled = Boolean(body.personalReminderEnabled);
        if (personalReminderEnabled && !validEmail(personalReminderEmail)) return jsonError("Enter a valid personal reminder email address.");
        updates.push(
          database().prepare("INSERT INTO settings (key, value) VALUES ('personal_reminder_email', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(personalReminderEmail),
          database().prepare("INSERT INTO settings (key, value) VALUES ('personal_reminder_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(personalReminderEnabled ? "true" : "false"),
        );
      }
      await database().batch(updates);
      return Response.json({ ok: true });
    }

    if (action === "saveGmailConnection") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const relayUrl = cleanText(body.gmailRelayUrl, 1000);
      const relaySecret = cleanText(body.gmailRelaySecret, 1000);
      let parsedUrl: URL;
      try { parsedUrl = new URL(relayUrl); } catch { return jsonError("Enter a valid Google Apps Script web-app URL."); }
      if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "script.google.com" || !parsedUrl.pathname.startsWith("/macros/s/") || !parsedUrl.pathname.endsWith("/exec")) {
        return jsonError("Use the Google Apps Script web-app URL ending in /exec.");
      }
      const existing = await database().prepare("SELECT value FROM settings WHERE key = 'gmail_relay_secret'").first<{ value: string }>();
      const secretToSave = relaySecret || existing?.value || "";
      if (secretToSave.length < 32) return jsonError("The Gmail relay password must be at least 32 characters.");
      await database().batch([
        database().prepare("INSERT INTO settings (key, value) VALUES ('gmail_relay_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(relayUrl),
        database().prepare("INSERT INTO settings (key, value) VALUES ('gmail_relay_secret', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(secretToSave),
      ]);
      return Response.json({ ok: true });
    }

    if (action === "disconnectGmail") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      await database().batch([
        database().prepare("UPDATE settings SET value = '' WHERE key = 'gmail_relay_url'"),
        database().prepare("UPDATE settings SET value = '' WHERE key = 'gmail_relay_secret'"),
      ]);
      return Response.json({ ok: true });
    }

    if (action === "testPersonalReminder") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const email = cleanEmail(body.email);
      if (!validEmail(email)) return jsonError("Enter a valid reminder email address.");
      const result = await sendImmediateNotification(null, [email], "Your HR reminder email is connected",
        `<p>This is a test from your HR portal.</p><p>When a task becomes due or overdue, the portal will send a daily reminder digest to <strong>${email.replace(/[&<>"']/g, "")}</strong>.</p>`);
      return Response.json({ ok: true, delivery: result.status, detail: result.detail });
    }

    if (action === "saveAccrualProfile") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const userId = asId(body.userId);
      const year = Number(body.year);
      const monthlyRate = Number(body.monthlyRate);
      const openingBalance = Number(body.openingBalance);
      const accrualStartDate = cleanText(body.accrualStartDate, 10) || null;
      if (!userId || !Number.isInteger(year) || year < 2020 || year > 2100) return jsonError("Choose a valid employee and vacation year.");
      if (!Number.isFinite(monthlyRate) || monthlyRate < 0 || monthlyRate > 10) return jsonError("Enter a monthly accrual rate between 0 and 10 days.");
      if (!Number.isFinite(openingBalance) || Math.abs(openingBalance) > 365) return jsonError("Enter a valid opening balance.");
      if (accrualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(accrualStartDate)) return jsonError("Enter a valid accrual start date.");
      const salaryEmployee = await database().prepare("SELECT id FROM users WHERE id = ? AND employment_type = 'salaried' AND status != 'deleted'").bind(userId).first();
      if (!salaryEmployee) return jsonError("The vacation tracker is only available for salaried employees.");
      await database().prepare(`INSERT INTO vacation_accrual_profiles (user_id, vacation_year, monthly_rate, opening_balance, accrual_start_date, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, vacation_year) DO UPDATE SET monthly_rate = excluded.monthly_rate,
        opening_balance = excluded.opening_balance, accrual_start_date = excluded.accrual_start_date, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(userId, year, monthlyRate, openingBalance, accrualStartDate, user.id, now).run();
      return Response.json({ ok: true });
    }

    if (action === "addBalanceAdjustment") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const userId = asId(body.userId);
      const year = Number(body.year);
      const amountDays = Number(body.amountDays);
      const effectiveDate = cleanText(body.effectiveDate, 10);
      const note = cleanText(body.note, 240);
      if (!userId || !Number.isInteger(year) || !Number.isFinite(amountDays) || amountDays === 0 || Math.abs(amountDays) > 365) return jsonError("Enter a valid adjustment amount.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || Number(effectiveDate.slice(0, 4)) !== year) return jsonError("The adjustment date must be in the selected vacation year.");
      if (!note) return jsonError("Add a note explaining the adjustment.");
      await database().prepare(`INSERT INTO vacation_balance_adjustments (user_id, vacation_year, amount_days, effective_date, note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(userId, year, amountDays, effectiveDate, note, user.id, now).run();
      return Response.json({ ok: true });
    }

    if (action === "deleteBalanceAdjustment") {
      if (!user.is_master_admin) return jsonError("Master administrator access required.", 403);
      const adjustmentId = asId(body.adjustmentId);
      if (!adjustmentId) return jsonError("Adjustment not found.");
      await database().prepare("DELETE FROM vacation_balance_adjustments WHERE id = ?").bind(adjustmentId).run();
      return Response.json({ ok: true });
    }

    return jsonError("Unknown action.", 404);
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "The request could not be completed.";
    console.error("Vacation portal request failed", message);
    if (message.includes("UNIQUE constraint failed")) return jsonError("That email or department name is already in use.", 409);
    return jsonError(message, 500);
  }
}
