"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { isDecided, pendingFor, processingLabel } from "../lib/vacation-stages";
import ApprovalDesigner from "./approval-designer";
import type { ApprovalMapDocument } from "../lib/approval-map-types";
import { vacationInPeriod } from "../lib/vacation-period";

type User = {
  id: number;
  full_name: string;
  email: string;
  role: "employee" | "manager" | "admin" | "payroll_admin";
  status: "pending" | "active" | "on_leave" | "terminated" | "disabled";
  employment_type: "hourly" | "salaried";
  work_schedule: "full_time" | "part_time" | null;
  hire_date: string | null;
  termination_date: string | null;
  leave_start_date: string | null;
  leave_end_date: string | null;
  job_title: string | null;
  compensation_amount_cents: number | null;
  compensation_frequency: "hourly" | "annual" | null;
  phone: string | null;
  work_location: string | null;
  employee_notes: string | null;
  has_portal_access: number;
  is_master_admin: number;
  department_id: number | null;
  department_name?: string | null;
};

type Department = {
  id: number;
  name: string;
  active: number;
  manager_user_id: number | null;
  manager_name?: string | null;
  manager_email?: string | null;
};

type VacationRequest = {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_email: string;
  employment_type: string;
  department_name: string;
  department_id: number;
  start_date: string;
  end_date: string;
  total_days: string;
  vacation_pay_requested: number;
  vacation_pay_amount_cents: number | null;
  employee_notes: string | null;
  employee_acknowledged_at: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decision_by_name: string | null;
  decision_notes: string | null;
  decided_at: string | null;
  payroll_processed: number;
  payroll_date: string | null;
  payroll_amount_paid_cents: number | null;
  hr_finalized: number;
  hr_finalized_at: string | null;
  payroll_saved_at: string | null;
  approver_user_id: number | null;
  approver_name: string | null;
  approval_route: string;
  created_at: string;
};

type PortalData = {
  user: User | null;
  departments: Department[];
  needsSetup: boolean;
  requests?: VacationRequest[];
  approvalMap?: ApprovalMapDocument;
  users?: User[];
  vacationPeople?: Array<{ id: number; full_name: string; department_id: number | null; department_name: string | null; employment_type: string; status: string }>;
  requestAlerts?: { inApp: boolean; email: boolean };
  myVacationBalance?: { year: number; configured: boolean; availableDays: number; accruedDays: number; approvedDays: number; openingBalance: number; adjustmentDays: number };
  settings?: { company_name?: string; hr_email?: string; approval_emails?: string; personal_reminder_email?: string; personal_reminder_enabled?: string; email_delivery_ready?: boolean; email_delivery_provider?: "gmail" | "resend" | null; gmail_relay_url?: string; gmail_relay_configured?: boolean };
  notifications?: Array<{ id: number; status: string; detail?: string; recipients?: string; subject?: string; created_at?: string }>;
  personalReminders?: PersonalReminder[];
  workflows?: WorkflowRun[];
  tracker?: {
    year: number;
    employees: TrackerEmployee[];
    adjustments: TrackerAdjustment[];
  };
};

type PersonalReminder = {
  id: number;
  related_employee_id: number | null;
  related_employee_name?: string | null;
  title: string;
  details: string | null;
  category: string;
  priority: "normal" | "high";
  due_date: string;
  status: "open" | "done";
  source_type: string | null;
  source_id: number | null;
};

type WorkflowTask = {
  id: number;
  run_id: number;
  title: string;
  details: string | null;
  branch_label: string | null;
  sort_order: number;
  due_date: string;
  status: "pending" | "completed" | "skipped";
};

type WorkflowRun = {
  id: number;
  workflow_type: "onboarding" | "return_to_work" | "probation_review" | "document_expiry" | "offboarding";
  employee_id: number;
  employee_name: string;
  work_schedule: string | null;
  title: string;
  target_date: string;
  status: "active" | "completed" | "cancelled";
  started_at: string;
  tasks: WorkflowTask[];
};

type TrackerEmployee = {
  id: number;
  full_name: string;
  email: string;
  department_name?: string | null;
  monthly_rate: number;
  opening_balance: number;
  accrual_start_date: string | null;
  accrued_days: number;
  approved_days: number;
  adjustment_days: number;
  available_days: number;
};

type TrackerAdjustment = {
  id: number;
  user_id: number;
  amount_days: number;
  effective_date: string;
  note: string;
  created_by_name: string;
};

const employmentLabels = { hourly: "Hourly", salaried: "Salaried" };
const scheduleLabels = { full_time: "Full-time", part_time: "Part-time" };
const employeeStatusLabels = { pending: "Pending", active: "Active", on_leave: "On leave", terminated: "Terminated", disabled: "Disabled" };
const statusLabels = { pending: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled" };
const roleLabels = { employee: "Employee", manager: "Manager", admin: "HR administrator", payroll_admin: "Payroll administrator" };
const workflowTemplateMeta: Array<{ type: WorkflowRun["workflow_type"]; title: string; description: string; targetLabel: string; mark: string }> = [
  { type: "onboarding", title: "Employee onboarding", description: "Profile, benefits branch, training and 30-day check-in.", targetLabel: "Hire date", mark: "01" },
  { type: "return_to_work", title: "Return to work", description: "Documentation, schedule, workplace supports and follow-up.", targetLabel: "Return date", mark: "02" },
  { type: "probation_review", title: "Probation review", description: "Manager feedback, review meeting, outcome and letter.", targetLabel: "Review date", mark: "03" },
  { type: "document_expiry", title: "Document expiry", description: "Automatic 90-, 60- and 30-day checkpoints before expiry.", targetLabel: "Expiry date", mark: "04" },
  { type: "offboarding", title: "Offboarding", description: "Access, property, final payroll, ROE and file closure.", targetLabel: "Last working day", mark: "05" },
];

async function callApi(action: string, body: Record<string, unknown> = {}) {
  const focused = document.activeElement;
  const control = focused instanceof HTMLButtonElement ? focused : null;
  const wasDisabled = control?.disabled ?? false;
  if (control) { control.disabled = true; control.setAttribute("aria-busy", "true"); }
  window.dispatchEvent(new CustomEvent("portal-operation", { detail: 1 }));
  try {
    const response = await fetch("/api/app", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(response.status >= 500 ? "The service is temporarily unavailable. Please try again shortly." : "Your connection expired. Refresh and sign in again.");
    const payload = await response.json() as { error?: string; [key: string]: unknown };
    if (!response.ok) throw new Error(payload.error || "Unable to save. Please try again.");
    return payload;
  } finally {
    if (control) { control.disabled = wasDisabled; control.removeAttribute("aria-busy"); }
    window.dispatchEvent(new CustomEvent("portal-operation", { detail: -1 }));
  }
}

// Retry only reads; replaying approvals or submissions could duplicate writes.
async function readPortal(url: string, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store", signal });
      if (![502, 503, 504].includes(response.status)) return response;
      if (attempt === 2) throw new Error("The service is temporarily unavailable. Please try again shortly.");
    } catch (error) {
      if (signal?.aborted || attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  throw new Error("The service is temporarily unavailable.");
}

function BrandLogo({ className = "" }: { className?: string }) {
  // Use the company's official asset, served locally without an external request.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={`brand-logo ${className}`} src="/sfte-logo.png" alt="Sweets from the Earth" width="106" height="85" />;
}

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    vacation: "M4 5h16v15H4z M8 3v4 M16 3v4 M4 10h16 M8 14h3",
    dashboard: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    new: "M12 5v14 M5 12h14", requests: "M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4",
    approvals: "M6 3h12v18H6z M9 12l2 2 4-4", calendar: "M4 5h16v15H4z M8 3v4 M16 3v4 M4 10h16",
    tracker: "M4 4h16v16H4z M4 10h16 M10 4v16 M16 4v16",
    alerts: "M12 3a6 6 0 0 0-6 6v5l-2 3h16l-2-3V9a6 6 0 0 0-6-6z M10 21h4",
    workflows: "M4 4h6v6H4z M14 14h6v6h-6z M7 10v7h7 M14 7h6 M17 4v6",
    "approval-process": "M3 3h7v6H3z M14 15h7v6h-7z M6 9v9h8 M14 3h7v6h-7z M10 6h4",
    reports: "M4 20V4 M4 20h16 M8 16v-5 M12 16V7 M16 16V9",
    people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-4",
    departments: "M9 3h6v5H9z M3 16h6v5H3z M15 16h6v5h-6z M12 8v4 M6 16v-4h12v4",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  };
  return <svg className="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.dashboard} /></svg>;
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(`${value.length === 10 ? value + "T12:00:00" : value}`);
  return new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatMoney(cents?: number | null) {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
}

function compensationLabel(person: User) {
  if (person.compensation_amount_cents == null) return "Not recorded";
  return `${formatMoney(person.compensation_amount_cents)} ${person.compensation_frequency === "hourly" ? "per hour" : "per year"}`;
}

function addCalendarDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function businessDays(start: string, end: string) {
  if (!start || !end || end < start) return "";
  let total = 0;
  const cursor = new Date(`${start}T12:00:00`);
  const finish = new Date(`${end}T12:00:00`);
  while (cursor <= finish) {
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) total += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return String(total);
}

function StatusPill({ status }: { status: VacationRequest["status"] }) {
  return <span className={`status-pill status-${status}`}><span className="status-dot" />{statusLabels[status]}</span>;
}

function Toast({ message, tone }: { message: string; tone: "success" | "error" }) {
  return <div className={`toast toast-${tone}`} role={tone === "error" ? "alert" : "status"}><span className="toast-icon" aria-hidden="true">{tone === "success" ? "✓" : "!"}</span><div className="toast-copy"><strong>{tone === "success" ? "Success" : "Something needs attention"}</strong><p>{message}</p></div></div>;
}

function AuthScreen({ data, refresh, notify }: { data: PortalData; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void }) {
  const [mode, setMode] = useState<"login" | "register">(data.needsSetup ? "register" : "login");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ fullName: "", email: "", password: "", departmentId: "", setupCode: "" });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await callApi(mode, form);
      notify(String(result.message ?? (mode === "login" ? "Welcome back." : "Account created.")));
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to continue.", "error");
    } finally { setBusy(false); }
  }

  return <div className="auth-shell">
    <section className="auth-brand">
      <BrandLogo />
      <div className="auth-copy">
        <p className="eyebrow">Employee self-service</p>
        <h1>Your people.<br />One place.</h1>
        <p>Manage time off, employee information and the everyday work of HR.</p>
      </div>
      <div className="auth-steps">
        <span><b>01</b> Submit your dates</span><span><b>02</b> Manager reviews</span><span><b>03</b> Download the record</span>
      </div>
    </section>
    <section className="auth-panel">
      <div className="auth-card">
        {data.needsSetup && <div className="setup-note"><strong>First-time setup</strong><span>Only the owner with the private setup code can create the HR administrator.</span></div>}
        <p className="eyebrow">SFTE People</p>
        <h2>{mode === "login" ? "Welcome back" : data.needsSetup ? "Create the HR administrator" : "Request an account"}</h2>
        <p className="muted">{mode === "login" ? "Sign in with your company email and password." : data.needsSetup ? "This account will control access, departments, and approvals." : "HR will review your registration before you can submit requests."}</p>
        <div className="auth-tabs" role="tablist">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>{data.needsSetup ? "Set up admin" : "Register"}</button>
        </div>
        <form onSubmit={submit} className="stack-form">
          {mode === "register" && <label>Full name<input required autoComplete="name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="Your full name" /></label>}
          {mode === "register" && data.needsSetup && <label>Private setup code<input required type="password" autoComplete="off" value={form.setupCode} onChange={(e) => setForm({ ...form, setupCode: e.target.value })} placeholder="Enter the owner's setup code" /></label>}
          <label>Company email<input required type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" /></label>
          {mode === "register" && !data.needsSetup && <label>Department<select required value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}><option value="">Select your department</option>{data.departments.filter((d) => d.active).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>}
          <label>Password<input required minLength={mode === "register" ? 6 : undefined} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={mode === "login" ? "Your password" : "6+ characters with a letter and number"} />{mode === "register" && <small className="password-help">Use at least 6 characters with one letter and one number.</small>}</label>
          <button className="button button-primary button-wide" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : data.needsSetup ? "Create administrator" : "Submit registration"}</button>
        </form>
        <p className="security-note">Protected by encrypted passwords and secure sign-in sessions.</p>
      </div>
    </section>
  </div>;
}

function PendingScreen({ user, logout }: { user: User; logout: () => void }) {
  return <main className="pending-shell"><div className="pending-card"><div className="pending-icon">⌛</div><p className="eyebrow">Account received</p><h1>Your access is pending</h1><p>HR needs to approve your account before you can submit vacation requests. You can return here and sign in again after approval.</p><div className="pending-details"><span>Signed in as</span><strong>{user.email}</strong></div><button className="button button-secondary" onClick={logout}>Sign out</button></div></main>;
}

function InactiveScreen({ user, logout }: { user: User; logout: () => void }) {
  const copy = user.status === "on_leave"
    ? { icon: "○", eyebrow: "Account on leave", title: "Your portal access is paused", body: "HR has marked your employment status as on leave. Contact HR if you need portal access restored." }
    : user.status === "terminated"
      ? { icon: "—", eyebrow: "Account inactive", title: "Your portal access has ended", body: "This employee account is no longer active." }
      : { icon: "!", eyebrow: "Account disabled", title: "Your portal access is disabled", body: "Contact HR if you believe this status should be changed." };
  return <main className="pending-shell"><div className="pending-card"><div className="pending-icon">{copy.icon}</div><p className="eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p>{copy.body}</p><div className="pending-details"><span>Signed in as</span><strong>{user.email}</strong></div><button className="button button-secondary" onClick={logout}>Sign out</button></div></main>;
}

function RequestForm({ user, balance, refresh, notify }: { user: User; balance?: PortalData["myVacationBalance"]; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void }) {
  const [form, setForm] = useState({ startDate: "", endDate: "", totalDays: "", vacationPayRequested: false, vacationPayAmount: "", notes: "", acknowledged: false });
  const [busy, setBusy] = useState(false);
  const payAllowed = user.employment_type === "hourly";

  function setDate(field: "startDate" | "endDate", value: string) {
    const next = { ...form, [field]: value };
    next.totalDays = businessDays(next.startDate, next.endDate);
    setForm(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const result = await callApi("createRequest", form);
      notify(result.notification === "sent" ? "Request submitted and notifications sent."
        : result.notification === "queued" ? "Request submitted. Email notifications are queued for delivery."
        : "Request submitted, but email delivery failed. HR can review the delivery status in Settings.", result.notification === "failed" ? "error" : "success");
      setForm({ startDate: "", endDate: "", totalDays: "", vacationPayRequested: false, vacationPayAmount: "", notes: "", acknowledged: false });
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to submit request.", "error"); }
    finally { setBusy(false); }
  }

  return <section className="content-section form-section">
    <div className="section-heading"><div><p className="eyebrow">New request</p><h1>Plan your time away</h1><p>Enter your vacation dates and confirm the request below.</p></div><div className="employee-chip"><div className="avatar small">{initials(user.full_name)}</div><span><strong>{user.full_name}</strong><small>{user.department_name ?? "Department not assigned"}</small></span></div></div>
    {user.employment_type === "salaried" && <PersonalVacationBalance balance={balance} />}
    <form className="request-form" onSubmit={submit}>
      <div className="form-block"><div className="block-number">1</div><div className="block-content"><h2>Vacation dates</h2><p>Weekends are excluded from the suggested total. Adjust the total if your schedule differs.</p><div className="field-grid three"><label>Start date<input type="date" required value={form.startDate} onChange={(e) => setDate("startDate", e.target.value)} /></label><label>End date<input type="date" required min={form.startDate} value={form.endDate} onChange={(e) => setDate("endDate", e.target.value)} /></label><label>Total days<input type="number" required min="0.5" max="60" step="0.5" value={form.totalDays} onChange={(e) => setForm({ ...form, totalDays: e.target.value })} placeholder="0" /></label></div></div></div>
      <div className="form-block"><div className="block-number">2</div><div className="block-content"><h2>Vacation pay</h2>{payAllowed ? <><p>Hourly employees may request vacation pay with their time-off request. Maximum payout is two work weeks.</p><label className="check-card"><input type="checkbox" checked={form.vacationPayRequested} onChange={(e) => setForm({ ...form, vacationPayRequested: e.target.checked, vacationPayAmount: e.target.checked ? form.vacationPayAmount : "" })} /><span><strong>Request vacation pay</strong><small>I would like vacation pay issued for this vacation period.</small></span></label>{form.vacationPayRequested && <label className="amount-field">Amount requested (CAD)<div><span>$</span><input type="number" min="0.01" step="0.01" required value={form.vacationPayAmount} onChange={(e) => setForm({ ...form, vacationPayAmount: e.target.value })} placeholder="0.00" /></div></label>}<p className="form-footnote">Vacation pay may not be paid out between November 14 and December 31 unless vacation time is taken.</p></> : <div className="locked-card"><span className="lock-mark">×</span><div><strong>Vacation pay requests are not available</strong><p>Your account is classified as salaried, so the vacation-pay section is blocked.</p></div></div>}</div></div>
      <div className="form-block"><div className="block-number">3</div><div className="block-content"><h2>Details and confirmation</h2><label>Optional note<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Add any helpful context for your manager…" /></label><label className="acknowledge"><input type="checkbox" required checked={form.acknowledged} onChange={(e) => setForm({ ...form, acknowledged: e.target.checked })} /><span>I confirm that this request is accurate. My signed-in name, email, and submission time will be recorded as my electronic acknowledgement.</span></label></div></div>
      <div className="form-actions"><p>Requests are sent to HR and your assigned approver.</p><button className="button button-primary" disabled={busy}>{busy ? "Submitting…" : "Submit vacation request"}</button></div>
    </form>
  </section>;
}

async function downloadPdf(record: VacationRequest, companyName = "Sweets from the Earth") {
  const { createVacationRecordPdf, loadPdfLogo } = await import("../lib/pdf-style");
  const pdf = await createVacationRecordPdf({ companyName, requestId: record.id, status: statusLabels[record.status], sections: [
    { title: "Employee information", fields: [
      { label: "Employee", value: record.employee_name }, { label: "Email", value: record.employee_email },
      { label: "Department", value: record.department_name }, { label: "Employment type", value: employmentLabels[record.employment_type as keyof typeof employmentLabels] ?? record.employment_type },
    ] },
    { title: "Vacation details", fields: [
      { label: "Start date", value: formatDate(record.start_date) }, { label: "End date", value: formatDate(record.end_date) },
      { label: "Total days", value: record.total_days }, { label: "Vacation pay", value: record.employment_type !== "hourly" ? "Not available - salaried" : record.vacation_pay_requested ? `Requested: ${formatMoney(record.vacation_pay_amount_cents)}` : "Not requested" },
      { label: "Employee note", value: record.employee_notes || "No note provided", fullWidth: true },
    ] },
    { title: "Electronic acknowledgements", fields: [
      { label: "Submitted by", value: `${record.employee_name} (${record.employee_email})` }, { label: "Submitted", value: formatDate(record.employee_acknowledged_at) },
      { label: "Manager decision", value: record.decision_by_name ? `${statusLabels[record.status]} by ${record.decision_by_name}` : "Pending" }, { label: "Decision date", value: formatDate(record.decided_at) },
      { label: "Decision note", value: record.decision_notes || "No note provided", fullWidth: true },
    ] },
    { title: "Payroll processing", fields: [
      { label: "Payroll processed", value: record.payroll_processed ? "Yes" : "No" }, { label: "Payroll date", value: formatDate(record.payroll_date) },
      { label: "Amount paid", value: formatMoney(record.payroll_amount_paid_cents) },
      { label: "Processing stage", value: processingLabel(record) },
      { label: "HR finalized", value: formatDate(record.hr_finalized_at) },
    ] },
  ] }, await loadPdfLogo());
  pdf.save(`Vacation_Request_${record.employee_name.replace(/[^a-z0-9]+/gi, "_")}_${record.start_date}.pdf`);
}

function RequestCard({ record, user, refresh, notify, companyName, personalView = false }: { record: VacationRequest; user: User; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void; companyName: string; personalView?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  async function exportRecord() { setExporting(true); try { await downloadPdf(record, companyName); } catch (error) { notify(error instanceof Error ? error.message : "Unable to download PDF.", "error"); } finally { setExporting(false); } }
  const [decisionNotes, setDecisionNotes] = useState(record.decision_notes ?? "");
  const [payroll, setPayroll] = useState({ payrollProcessed: Boolean(record.payroll_processed), payrollDate: record.payroll_date ?? "", payrollAmount: record.payroll_amount_paid_cents == null ? "" : String(record.payroll_amount_paid_cents / 100) });
  const canDecide = !personalView && record.employee_id !== user.id && record.status === "pending" && (user.role === "admin" || (user.role === "manager" && record.approver_user_id === user.id));
  const needsPayment = record.status === "approved" && record.vacation_pay_requested === 1;
  const canPayroll = !personalView && (user.role === "payroll_admin" || user.role === "admin") && record.employment_type === "hourly" && isDecided(record) && !record.hr_finalized;
  const canFinalize = isDecided(record) && !record.hr_finalized && (record.employment_type === "salaried" || Boolean(record.payroll_processed));
  async function act(action: string, body: Record<string, unknown>, message: string) { try { await callApi(action, body); notify(message); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to update request.", "error"); } }
  return <article className={`request-card ${expanded ? "expanded" : ""}`}>
    <button className="request-summary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
      <div className="date-tile"><strong>{new Date(record.start_date + "T12:00:00").toLocaleDateString("en-CA", { month: "short" }).toUpperCase()}</strong><span>{new Date(record.start_date + "T12:00:00").getDate()}</span></div>
      <div className="request-primary"><strong>{(personalView || user.role === "employee") ? `${formatDate(record.start_date)} – ${formatDate(record.end_date)}` : record.employee_name}</strong><span>{(personalView || user.role === "employee") ? `${record.total_days} day${Number(record.total_days) === 1 ? "" : "s"} • ${record.department_name}` : `${formatDate(record.start_date)} – ${formatDate(record.end_date)} • ${record.total_days} days`}</span></div>
      <StatusPill status={record.status} /><span className="chevron">⌄</span>
    </button>
    {expanded && <div className="request-detail">
      <div className="detail-grid"><div><small>Employee</small><strong>{record.employee_name}</strong><span>{record.employee_email}</span></div><div><small>Department</small><strong>{record.department_name}</strong><span>{employmentLabels[record.employment_type as keyof typeof employmentLabels] ?? record.employment_type}</span></div><div><small>Vacation pay</small><strong>{record.employment_type !== "hourly" ? "Blocked" : record.vacation_pay_requested ? formatMoney(record.vacation_pay_amount_cents) : "Not requested"}</strong><span>{record.employment_type !== "hourly" ? "Salaried employee" : "Maximum two weeks"}</span></div><div><small>Submitted</small><strong>{formatDate(record.created_at)}</strong><span>Request #{record.id}</span></div></div>
      {record.employee_notes && <div className="note-box"><small>Employee note</small><p>{record.employee_notes}</p></div>}
      {record.decision_notes && <div className="note-box decision"><small>Decision note</small><p>{record.decision_notes}</p></div>}
      {record.status === "pending" && <p className="form-footnote">Initial approver: <strong>{record.approver_name ?? "HR"}</strong> · {record.approval_route}{record.approver_user_id == null ? " · HR fallback" : ""}</p>}
      {record.employee_id === user.id && record.status === "pending" && user.role !== "employee" && <p className="form-footnote">Your request will be reviewed by another manager or HR. You cannot approve your own vacation.</p>}
      {!personalView && user.role !== "employee" && <div className="processing-stage"><strong>{processingLabel(record)}</strong><span>Manager decision → {record.employment_type === "hourly" ? "Payroll record → " : ""}HR sign-off. Approved leave is already in the employee history and calendar.</span></div>}
      {canDecide && <div className="decision-box"><label>Optional note<textarea value={decisionNotes} onChange={(e) => setDecisionNotes(e.target.value)} placeholder="Add context for the employee…" /></label><div><button className="button button-danger-soft" onClick={() => act("decideRequest", { requestId: record.id, decision: "rejected", decisionNotes }, "Request rejected.")}>Reject</button><button className="button button-success" onClick={() => act("decideRequest", { requestId: record.id, decision: "approved", decisionNotes }, "Request approved.")}>Approve request</button></div></div>}
      {canPayroll && <div className="payroll-box"><div><small>Hourly processing</small><strong>Payroll record</strong>{!needsPayment && <span>No payment authorized · review only</span>}</div><label className="inline-check"><input type="checkbox" checked={payroll.payrollProcessed} onChange={(e) => setPayroll({ ...payroll, payrollProcessed: e.target.checked })} /> {needsPayment ? "Paid / processed" : "Review complete"}</label><label>{needsPayment ? "Payroll date" : "Review date"}<input type="date" value={payroll.payrollDate} onChange={(e) => setPayroll({ ...payroll, payrollDate: e.target.value })} /></label>{needsPayment && <label>Amount paid<input type="number" min="0" step="0.01" value={payroll.payrollAmount} onChange={(e) => setPayroll({ ...payroll, payrollAmount: e.target.value })} /></label>}<button className="button button-secondary small-button" onClick={() => act("updatePayroll", { requestId: record.id, ...payroll, payrollAmount: needsPayment ? payroll.payrollAmount : "0" }, "Payroll record saved. HR can now finish sign-off.")}>Save payroll record</button></div>}
      {!personalView && user.role === "admin" && isDecided(record) && !record.hr_finalized && <div className="hr-signoff"><span>{canFinalize ? "Complete HR review to clear this request from Pending." : "Payroll must complete its record before HR can finish."}</span><button className="button button-success" disabled={!canFinalize} onClick={() => act("finalizeRequest", { requestId: record.id }, "HR sign-off saved. The request remains in employee history.")}>{record.status === "approved" ? "Approved · finish HR sign-off" : "Finalize rejected request"}</button></div>}
      {record.hr_finalized === 1 && <p className="form-footnote">HR finalized {formatDate(record.hr_finalized_at)}. This permanent record remains available in employee history.</p>}
      <div className="detail-actions"><button className="button button-secondary" disabled={exporting} aria-busy={exporting} onClick={exportRecord}>{exporting ? "Preparing PDF…" : "Download PDF"}</button>{(personalView || user.role === "employee") && record.employee_id === user.id && record.status === "pending" && <button className="text-button danger-text" onClick={() => act("cancelRequest", { requestId: record.id }, "Request cancelled.")}>Cancel request</button>}</div>
    </div>}
  </article>;
}

function RequestsList({ title, eyebrow, records, user, refresh, notify, companyName, emptyText }: { title: string; eyebrow: string; records: VacationRequest[]; user: User; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void; companyName: string; emptyText: string }) {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? records : records.filter((record) => record.status === filter);
  return <section className="content-section"><div className="section-heading compact"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{records.filter((record) => record.status === "pending").length} awaiting a decision</p></div><div className="filter-tabs">{["all", "pending", "approved", "rejected"].map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div></div><div className="requests-list">{filtered.length ? filtered.map((record) => <RequestCard key={record.id} record={record} user={user} refresh={refresh} notify={notify} companyName={companyName} personalView />) : <div className="empty-state"><span>✓</span><h3>Nothing here</h3><p>{emptyText}</p></div>}</div></section>;
}

function PersonalVacationBalance({ balance }: { balance?: PortalData["myVacationBalance"] }) {
  if (!balance) return null;
  return <article className={`personal-vacation-balance ${balance.availableDays < 0 ? "negative" : ""}`}><div><p className="eyebrow">My vacation · {balance.year}</p><h2>{balance.configured ? <>{balance.availableDays.toFixed(2)} <span>days available</span></> : "Vacation balance not configured"}</h2><p>{balance.configured ? "Approved vacation is deducted. Pending requests are not yet deducted." : "Contact HR to set your accrual rate and opening balance."}</p></div>{balance.configured && <dl>{[["Opening balance", balance.openingBalance], ["Accrued", balance.accruedDays], ["Approved vacation", balance.approvedDays], ["Adjustments", balance.adjustmentDays]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{Number(value).toFixed(2)}</dd></div>)}</dl>}</article>;
}

type VacationViewProps = { data: PortalData; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void };

function ApprovalQueue({ data, refresh, notify }: VacationViewProps) {
  const [view, setView] = useState<"pending" | "people">("pending");
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [employment, setEmployment] = useState("");
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [year, setYear] = useState("");
  const [history, setHistory] = useState<"approved" | "rejected">("approved");
  const user = data.user!;
  const records = data.requests ?? [];
  const companyName = data.settings?.company_name ?? "Sweets from the Earth";
  const query = search.trim().toLowerCase();
  const matches = (name: string, departmentId: number | null, employmentType: string) => (!query || name.toLowerCase().includes(query)) && (!department || String(departmentId) === department) && (!employment || employmentType === employment);
  const pending = records.filter((record) => pendingFor(record, user.role, user.id) && matches(record.employee_name, record.department_id, record.employment_type));
  const people = (data.vacationPeople ?? []).filter((person) => ["active", "on_leave"].includes(person.status) && matches(person.full_name, person.department_id, person.employment_type));
  const employee = (data.vacationPeople ?? []).find((person) => person.id === employeeId);
  const employeeRecords = records.filter((record) => record.employee_id === employeeId && isDecided(record));
  const years = [...new Set(employeeRecords.map((record) => record.start_date.slice(0, 4)))].sort().reverse();
  const historyRecords = employeeRecords.filter((record) => record.status === history && (!year || record.start_date.startsWith(year)));
  const card = (record: VacationRequest) => <RequestCard key={`${record.id}:${record.payroll_saved_at ?? ""}`} record={record} user={user} refresh={refresh} notify={notify} companyName={companyName} />;
  return <section className="content-section approval-workspace">
    <div className="section-heading compact"><div><p className="eyebrow">{roleLabels[user.role]}</p><h1>Approval queue</h1><p>{user.role === "manager" ? "Decide requests for your teams. Decisions move straight into employee history." : user.role === "payroll_admin" ? "Save payroll records for manager-decided hourly requests. Salaried requests bypass Payroll." : "Review outstanding stages and finalize HR after the required processing is complete."}</p></div></div>
    <div className="filter-tabs queue-tabs" role="tablist" aria-label="Approval queue views"><button role="tab" aria-selected={view === "pending"} className={view === "pending" ? "active" : ""} onClick={() => { setView("pending"); setEmployeeId(null); }}>Pending <b>{records.filter((record) => pendingFor(record, user.role, user.id)).length}</b></button><button role="tab" aria-selected={view === "people"} className={view === "people" ? "active" : ""} onClick={() => setView("people")}>All employees</button></div>
    <div className="queue-filters"><label>Search employees<input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setEmployeeId(null); }} placeholder="Employee name…" /></label><label>Department<select value={department} onChange={(event) => { setDepartment(event.target.value); setEmployeeId(null); }}><option value="">All departments</option>{data.departments.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label>Employment type<select value={employment} onChange={(event) => { setEmployment(event.target.value); setEmployeeId(null); }}><option value="">Hourly and salaried</option><option value="hourly">Hourly</option><option value="salaried">Salaried</option></select></label></div>
    {view === "pending" ? <div className="requests-list">{pending.length ? pending.map(card) : <div className="empty-state"><span>✓</span><h3>No pending work</h3><p>No requests match your role and filters.</p></div>}</div> : employee ? <div className="panel employee-history"><button className="text-button" onClick={() => setEmployeeId(null)}>All employees</button><div className="section-heading compact"><div><p className="eyebrow">Permanent vacation record</p><h2>{employee.full_name}</h2><p>{employee.department_name ?? "Unassigned"} · {employmentLabels[employee.employment_type as keyof typeof employmentLabels]}</p></div><label>Vacation year<select value={year} onChange={(event) => setYear(event.target.value)}><option value="">All years</option>{years.map((item) => <option key={item}>{item}</option>)}</select></label></div><div className="filter-tabs">{(["approved", "rejected"] as const).map((item) => <button key={item} className={history === item ? "active" : ""} onClick={() => setHistory(item)}>{statusLabels[item]} ({employeeRecords.filter((record) => record.status === item && (!year || record.start_date.startsWith(year))).length})</button>)}</div><div className="requests-list">{historyRecords.length ? historyRecords.map(card) : <p className="empty-state">No {history} vacation in this period.</p>}</div></div> : <div className="queue-employee-grid">{people.map((person) => <button className="queue-employee" key={person.id} onClick={() => { setEmployeeId(person.id); setYear(""); setHistory("approved"); }}><span className="avatar">{initials(person.full_name)}</span><span><strong>{person.full_name}</strong><small>{person.department_name ?? "Unassigned"} · {employmentLabels[person.employment_type as keyof typeof employmentLabels]}</small></span><span className="queue-view-label">View</span></button>)}{!people.length && <div className="empty-state">No active employees match your filters.</div>}</div>}
  </section>;
}

function RequestAlertSettings({ data, refresh, notify }: VacationViewProps) {
  const [busy, setBusy] = useState(false);
  const preferences = data.requestAlerts ?? { inApp: true, email: true };
  async function save(field: "inApp" | "email", checked: boolean) {
    setBusy(true);
    try { await callApi("saveRequestAlerts", { ...preferences, [field]: checked }); await refresh(); notify("Your request notification preferences were saved."); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to save notification preferences.", "error"); }
    finally { setBusy(false); }
  }
  return <article className="panel request-alert-settings"><p className="eyebrow">Your notifications</p><h2>{data.user?.role === "payroll_admin" ? "Payroll alerts" : "New vacation requests"}</h2><p>{data.user?.role === "payroll_admin" ? "Receive immediate approved vacation-pay emails and outstanding-payment summaries every five days." : data.user?.role === "manager" ? "Receive requests from your assigned teams." : "Receive requests across all departments."} The queue keeps updating when notifications are off.</p><label className="toggle-row"><input type="checkbox" checked={preferences.inApp} disabled={busy} onChange={(event) => void save("inApp", event.target.checked)} /><span><strong>Notify me in the portal</strong><small>Show an alert when a request enters your pending queue while the portal is open.</small></span></label><label className="toggle-row"><input type="checkbox" checked={preferences.email} disabled={busy} onChange={(event) => void save("email", event.target.checked)} /><span><strong>Email my account</strong><small>Send {data.user?.role === "payroll_admin" ? "payroll" : "new-request"} emails to {data.user?.email}. Shared HR routing is separate.</small></span></label></article>;
}

function VacationDepartments({ data, setTab, refresh, notify }: VacationViewProps & { setTab: (tab: string) => void }) {
  const [query, setQuery] = useState("");
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [periodYear, setPeriodYear] = useState(() => new Date().getFullYear());
  const [periodMonth, setPeriodMonth] = useState(() => String(new Date().getMonth() + 1).padStart(2, "0"));
  useEffect(() => { if (departmentId != null) document.querySelector(".department-vacation-detail")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }, [departmentId, employeeId]);
  const requests = data.requests ?? [];
  const people = data.vacationPeople ?? [];
  const teams = [...data.departments.filter((department) => department.active || people.some((person) => person.department_id === department.id) || requests.some((request) => request.department_id === department.id)), ...(people.some((person) => person.department_id == null) ? [{ id: 0, name: "Unassigned department", active: 1, manager_user_id: null }] : [])];
  const selectedTeam = teams.find((department) => department.id === departmentId);
  const teamPeople = people.filter((person) => (person.department_id ?? 0) === departmentId);
  const selectedPerson = people.find((person) => person.id === employeeId);
  const teamRequests = requests.filter((request) => (employeeId ? request.employee_id === employeeId : request.department_id === departmentId) && vacationInPeriod(request, periodYear, periodMonth));
  const years = [...new Set([new Date().getFullYear(), periodYear, ...requests.flatMap((record) => {
    const first = Number(record.start_date.slice(0, 4)), last = Number(record.end_date.slice(0, 4));
    return Array.from({ length: Math.max(1, last - first + 1) }, (_, index) => first + index);
  })])].sort((a, b) => b - a);
  const monthNames = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat("en-CA", { month: "long" }).format(new Date(2000, index, 1)));
  const matches = query.trim() ? people.filter((person) => person.full_name.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const pending = requests.filter((request) => pendingFor(request, data.user!.role, data.user!.id)).length;
  const today = new Date().toISOString().slice(0, 10);
  return <section className="content-section vacation-departments">
    <div className="section-heading compact"><div><p className="eyebrow">{data.user?.role === "manager" ? "My teams" : "All departments"}</p><h1>Vacation overview</h1><p>Open a department to review its employees and time off.</p></div><button className="button button-primary" onClick={() => setTab("approvals")}>{pending} awaiting approval</button></div>
    {data.user?.employment_type === "salaried" && <PersonalVacationBalance balance={data.myVacationBalance} />}
    <div className="vacation-search"><label htmlFor="vacation-employee-search">Find an employee</label><input id="vacation-employee-search" type="search" placeholder="Search employee name…" value={query} onChange={(event) => setQuery(event.target.value)} />{query.trim() && <div className="vacation-search-results">{matches.map((person) => <button key={person.id} onClick={() => { setDepartmentId(person.department_id ?? 0); setEmployeeId(person.id); setQuery(""); }}><span className="avatar small">{initials(person.full_name)}</span><span><strong>{person.full_name}</strong><small>{person.department_name ?? "Unassigned department"}</small></span><span>View vacation</span></button>)}{!matches.length && <p>No employees match this name.</p>}</div>}</div>
    <div className="vacation-department-grid">{teams.map((department) => {
      const team = people.filter((person) => (person.department_id ?? 0) === department.id && (person.status === "active" || person.status === "on_leave"));
      const records = requests.filter((request) => request.department_id === department.id);
      const pendingCount = records.filter((request) => pendingFor(request, data.user!.role, data.user!.id)).length;
      const away = new Set(records.filter((request) => request.status === "approved" && request.start_date <= today && request.end_date >= today).map((request) => request.employee_id)).size;
      return <button className={`vacation-department-card ${departmentId === department.id ? "selected" : ""}`} key={department.id} aria-pressed={departmentId === department.id} onClick={() => { setDepartmentId(department.id); setEmployeeId(null); }}><span className="eyebrow">{department.active ? "Department" : "Inactive department"}</span><strong>{department.name}</strong><span>{team.length} employee{team.length === 1 ? "" : "s"}</span><div><span><b>{pendingCount}</b> pending</span><span><b>{away}</b> away today</span></div></button>;
    })}</div>
    {!teams.length && <div className="empty-state"><h3>No departments assigned</h3><p>HR can assign departments and managers in Departments.</p></div>}
    {selectedTeam && <article className="panel department-vacation-detail"><div className="panel-heading"><div><p className="eyebrow">Department vacation</p><h2>{selectedTeam.name}</h2></div><button className="button button-secondary" onClick={() => { setDepartmentId(null); setEmployeeId(null); }}>Close department</button></div><div className="department-vacation-layout"><div className="vacation-employee-list"><button className={!employeeId ? "active" : ""} onClick={() => setEmployeeId(null)}>All department requests</button>{teamPeople.map((person) => <button key={person.id} className={employeeId === person.id ? "active" : ""} onClick={() => setEmployeeId(person.id)}><span className="avatar small">{initials(person.full_name)}</span><span><strong>{person.full_name}</strong><small>{employmentLabels[person.employment_type as keyof typeof employmentLabels] ?? person.employment_type} · {employeeStatusLabels[person.status as keyof typeof employeeStatusLabels] ?? person.status}</small></span></button>)}{!teamPeople.length && <p>No current employees in this department.</p>}</div><div className="vacation-employee-requests"><h3>{selectedPerson?.full_name ?? "Department requests"}</h3><div className="vacation-period-filters"><label>Year<select value={periodYear} onChange={(event) => setPeriodYear(Number(event.target.value))}>{years.map((year) => <option key={year} value={year}>{year}</option>)}</select></label><label>Month<select value={periodMonth} onChange={(event) => setPeriodMonth(event.target.value)}><option value="all">All months</option>{monthNames.map((name, index) => <option key={name} value={String(index + 1).padStart(2, "0")}>{name}</option>)}</select></label></div><p>{teamRequests.length} vacation request{teamRequests.length === 1 ? "" : "s"} overlapping {periodMonth === "all" ? periodYear : `${monthNames[Number(periodMonth) - 1]} ${periodYear}`}</p>{teamRequests.map((record) => <RequestCard key={record.id} record={record} user={data.user!} refresh={refresh} notify={notify} companyName={data.settings?.company_name ?? "Sweets from the Earth"} />)}{!teamRequests.length && <div className="empty-state compact-empty"><h3>No requests in this period</h3><p>Choose another month or year to view more requests.</p></div>}</div></div></article>}
    <details className="vacation-alert-preferences"><summary>Request notification preferences</summary><RequestAlertSettings data={data} refresh={refresh} notify={notify} /></details>
  </section>;
}

function Dashboard(props: VacationViewProps & { setTab: (tab: string) => void }) {
  return props.data.user?.role === "employee" ? <><div className="employee-balance-wrap"><PersonalVacationBalance balance={props.data.myVacationBalance} /></div><EmployeeDashboard data={props.data} setTab={props.setTab} /></> : <VacationDepartments {...props} />;
}

function EmployeeDashboard({ data, setTab }: { data: PortalData; setTab: (tab: string) => void }) {
  const requests = data.requests ?? [];
  const pending = requests.filter((request) => request.status === "pending");
  const approved = requests.filter((request) => request.status === "approved");
  const current = new Date();
  const openAlerts = (data.personalReminders ?? []).filter((item) => item.status === "open");
  const overdueAlerts = openAlerts.filter((item) => item.due_date < current.toISOString().slice(0, 10));
  const upcoming = approved.filter((request) => new Date(request.end_date + "T23:59:59") >= current).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  return <section className="content-section dashboard-section"><div className="welcome-row"><div><p className="eyebrow">{new Intl.DateTimeFormat("en-CA", { weekday: "long", month: "long", day: "numeric" }).format(current)}</p><h1>Good {current.getHours() < 12 ? "morning" : current.getHours() < 18 ? "afternoon" : "evening"}, {data.user?.full_name.split(" ")[0]}.</h1><p>{data.user?.role === "employee" ? "Here’s the latest on your time-off requests." : "Here’s what needs your attention today."}</p></div><button className="button button-primary" onClick={() => setTab(data.user?.role === "employee" ? "new" : "approvals")}>{data.user?.role === "employee" ? "+ New request" : `${pending.length} pending request${pending.length === 1 ? "" : "s"}`}</button></div>
    {data.user?.is_master_admin === 1 && openAlerts.length > 0 && <button className={`dashboard-alert ${overdueAlerts.length ? "urgent" : ""}`} onClick={() => setTab("alerts")}><span>{overdueAlerts.length ? "!" : "✓"}</span><div><strong>{overdueAlerts.length ? `${overdueAlerts.length} overdue HR task${overdueAlerts.length === 1 ? "" : "s"}` : `${openAlerts.length} open HR reminder${openAlerts.length === 1 ? "" : "s"}`}</strong><small>{overdueAlerts.length ? "Open your private task list to follow up." : "Your workflow and reminder list is up to date."}</small></div><b>View tasks →</b></button>}
    <div className="metric-grid"><article className="metric-card accent"><span className="metric-label">Pending</span><strong>{pending.length}</strong><p>{pending.length ? "Waiting for review" : "You’re all caught up"}</p></article><article className="metric-card"><span className="metric-label">Approved</span><strong>{approved.length}</strong><p>{data.user?.role === "employee" ? "Your approved requests" : "Approved in the portal"}</p></article><article className="metric-card wide"><span className="metric-label">Next approved vacation</span>{upcoming ? <><strong className="metric-date">{formatDate(upcoming.start_date)}</strong><p>{upcoming.employee_name}{data.user?.role === "employee" ? "" : ` • ${upcoming.department_name}`}</p></> : <><strong className="metric-date">No upcoming vacation</strong><p>Approved dates will appear here</p></>}</article></div>
    <div className="dashboard-grid"><article className="panel"><div className="panel-heading"><div><span className="eyebrow">Recent activity</span><h2>Vacation requests</h2></div><button className="text-button" onClick={() => setTab(data.user?.role === "employee" ? "requests" : "approvals")}>View all →</button></div><div className="mini-list">{requests.slice(0, 4).map((request) => <div key={request.id} className="mini-row"><div className="avatar small">{initials(request.employee_name)}</div><div><strong>{data.user?.role === "employee" ? `${formatDate(request.start_date)} – ${formatDate(request.end_date)}` : request.employee_name}</strong><span>{request.total_days} days • {request.department_name}</span></div><StatusPill status={request.status} /></div>)}{!requests.length && <div className="empty-mini">No vacation requests yet.</div>}</div></article><article className="panel policy-panel"><span className="eyebrow">Quick reference</span><h2>Before you submit</h2><ul><li><span>01</span>Confirm your dates with your schedule.</li><li><span>02</span>Hourly employees may request up to two weeks of vacation pay.</li><li><span>03</span>HR and your assigned approver receive the request.</li></ul></article></div>
  </section>;
}

function TeamCalendar({ data, refresh, notify }: { data: PortalData; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void }) {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [editing, setEditing] = useState<VacationRequest | null>(null);
  const [editForm, setEditForm] = useState({ startDate: "", endDate: "", totalDays: "", notes: "" });
  const [teamId, setTeamId] = useState("all");
  const allApproved = (data.requests ?? []).filter((request) => request.status === "approved");
  const approved = allApproved.filter((request) => teamId === "all" || String(request.department_id) === teamId);
  const calendarTeams = data.departments.filter((department) => department.active || allApproved.some((record) => record.department_id === department.id));
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: Array<number | null> = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, index) => index + 1)];
  while (cells.length % 7) cells.push(null);
  const monthLabel = new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric" }).format(month);
  function move(offset: number) { setMonth(new Date(year, monthIndex + offset, 1)); }
  const selectedEvents = selectedDate ? approved.filter((request) => request.start_date <= selectedDate && request.end_date >= selectedDate) : [];
  function beginEdit(record: VacationRequest) {
    setEditing(record);
    setEditForm({ startDate: record.start_date, endDate: record.end_date, totalDays: record.total_days, notes: record.employee_notes ?? "" });
  }
  function setVacationDate(field: "startDate" | "endDate", value: string) {
    const next = { ...editForm, [field]: value };
    next.totalDays = businessDays(next.startDate, next.endDate);
    setEditForm(next);
  }
  async function saveVacation(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    try {
      await callApi("updateApprovedVacation", { requestId: editing.id, ...editForm });
      notify("Approved vacation updated. Employee notifications are queued for delivery.");
      setEditing(null);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to update vacation.", "error"); }
  }
  return <section className="content-section calendar-section">
    <div className="section-heading compact"><div><p className="eyebrow">Interactive calendar</p><h1>{data.user?.role === "employee" ? "My vacation calendar" : "Team vacation calendar"}</h1><p>Select any day to see every approved vacation. Administrators can correct approved dates directly from the day view.</p></div><div className="calendar-controls"><button className="button button-secondary" onClick={() => move(-1)} aria-label="Previous month">←</button><strong>{monthLabel}</strong><button className="button button-secondary" onClick={() => move(1)} aria-label="Next month">→</button></div></div>
    {data.user?.role !== "employee" && <div className="calendar-team-controls"><label>Team<select value={teamId} onChange={(event) => { setTeamId(event.target.value); setSelectedDate(null); }}><option value="all">All my teams</option>{calendarTeams.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label><div className="calendar-team-summary">{calendarTeams.filter((department) => teamId === "all" || String(department.id) === teamId).map((department) => <button key={department.id} className={String(department.id) === teamId ? "active" : ""} onClick={() => { setTeamId(String(department.id)); setSelectedDate(null); }}><strong>{department.name}</strong><span>{new Set(allApproved.filter((record) => record.department_id === department.id && record.start_date <= `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}` && record.end_date >= `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`).map((record) => record.employee_id)).size} employees away this month</span></button>)}</div></div>}
    <div className="calendar-board"><div className="calendar-weekdays">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{cells.map((day, index) => {
      if (!day) return <div className="calendar-day blank" key={`blank-${index}`} />;
      const date = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const events = approved.filter((request) => request.start_date <= date && request.end_date >= date);
      return <button type="button" className={`calendar-day ${date === new Date().toISOString().slice(0, 10) ? "today" : ""} ${events.length ? "has-events" : ""}`} key={date} aria-label={`${formatDate(date)}: ${events.length} approved vacation${events.length === 1 ? "" : "s"}`} onClick={() => setSelectedDate(date)}><span className="calendar-number">{day}</span>{events.length > 0 && <span className="calendar-mobile-count">{events.length} away</span>}<div className="calendar-events">{events.slice(0, 2).map((event) => <span className="calendar-event" key={event.id} title={`${event.department_name} · ${event.employee_name}: ${event.start_date} to ${event.end_date}`}><b>{initials(event.employee_name)}</b><span>{event.employee_name}{data.user?.role !== "employee" && <small>{event.department_name}</small>}</span></span>)}{events.length > 2 && <small>View all {events.length} vacations</small>}</div></button>;
    })}</div></div>
    {!approved.length && <div className="empty-state calendar-empty"><span>□</span><h3>No approved vacation yet</h3><p>Approved requests will populate the calendar automatically.</p></div>}
    {selectedDate && <div className="modal-backdrop" onMouseDown={() => setSelectedDate(null)}><div className="modal-card calendar-day-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">Calendar day</p><h2>{formatDate(selectedDate)}</h2><p>{selectedEvents.length} approved vacation{selectedEvents.length === 1 ? "" : "s"}</p></div><button className="close-button" onClick={() => setSelectedDate(null)}>×</button></div><div className="day-vacation-list">{[...new Set(selectedEvents.map((record) => record.department_id))].map((id) => <section className="calendar-day-team" key={id}><h3>{selectedEvents.find((record) => record.department_id === id)?.department_name}</h3>{selectedEvents.filter((record) => record.department_id === id).map((record) => <article key={record.id}><span className="avatar">{initials(record.employee_name)}</span><div><strong>{record.employee_name}</strong><p>{formatDate(record.start_date)} – {formatDate(record.end_date)}</p><small>{record.total_days} day{Number(record.total_days) === 1 ? "" : "s"}</small></div>{data.user?.role === "admin" && <button className="button button-secondary" onClick={() => beginEdit(record)}>Edit</button>}</article>)}</section>)}{!selectedEvents.length && <div className="empty-state compact-empty"><h3>No vacation on this day</h3><p>Select another day to review approved time off.</p></div>}</div></div></div>}
    {editing && <div className="modal-backdrop modal-over-modal" onMouseDown={() => setEditing(null)}><div className="modal-card" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">Edit approved vacation</p><h2>{editing.employee_name}</h2></div><button className="close-button" onClick={() => setEditing(null)}>×</button></div><form className="stack-form" onSubmit={saveVacation}><div className="field-grid"><label>Start date<input required type="date" value={editForm.startDate} onChange={(event) => setVacationDate("startDate", event.target.value)} /></label><label>End date<input required type="date" value={editForm.endDate} onChange={(event) => setVacationDate("endDate", event.target.value)} /></label></div><label>Total vacation days<input required type="number" min="0.5" max="60" step="0.5" value={editForm.totalDays} onChange={(event) => setEditForm({ ...editForm, totalDays: event.target.value })} /></label><label>Notes<textarea value={editForm.notes} onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })} /></label><p className="form-footnote">Changing the total days also updates the salaried employee’s vacation balance.</p><button className="button button-primary button-wide">Save calendar change</button></form></div></div>}
  </section>;
}

function NotificationsAdmin({ data, refresh, notify, setTab }: { data: PortalData; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void; setTab: (tab: string) => void }) {
  const reminders = data.personalReminders ?? [];
  const [filter, setFilter] = useState<"open" | "done">("open");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PersonalReminder | null>(null);
  const [form, setForm] = useState({ title: "", details: "", category: "custom", priority: "normal", dueDate: new Date().toISOString().slice(0, 10), relatedEmployeeId: "" });
  const today = new Date().toISOString().slice(0, 10);
  const open = reminders.filter((item) => item.status === "open");
  const overdue = open.filter((item) => item.due_date < today);
  const dueSoon = open.filter((item) => item.due_date >= today && item.due_date <= addCalendarDays(today, 7));
  const visible = reminders.filter((item) => item.status === filter);
  function beginAdd() {
    setEditing(null);
    setForm({ title: "", details: "", category: "custom", priority: "normal", dueDate: today, relatedEmployeeId: "" });
    setAdding(true);
  }
  function beginEdit(item: PersonalReminder) {
    setEditing(item);
    setForm({ title: item.title, details: item.details ?? "", category: item.category, priority: item.priority, dueDate: item.due_date, relatedEmployeeId: String(item.related_employee_id ?? "") });
    setAdding(true);
  }
  function deliveryMessage(result: Record<string, unknown>, verb: string) {
    if (result.notification === "sent") return `${verb} and emailed.`;
    if (result.notification === "queued") return `${verb}. Email queued for delivery.`;
    if (result.notification === "failed") return `${verb}, but the email failed: ${String(result.detail ?? "Unknown delivery error")}`;
    if (result.notification === "not_configured") return `${verb}. Add a reminder email in Settings to receive messages.`;
    return verb;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      const result = editing
        ? await callApi("updateReminder", { reminderId: editing.id, operation: "edit", ...form })
        : await callApi("createReminder", form);
      notify(deliveryMessage(result, editing ? "Reminder updated" : "Reminder added"), result.notification === "failed" ? "error" : "success");
      setAdding(false);
      setEditing(null);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to save reminder.", "error"); }
  }
  async function update(item: PersonalReminder, operation: "complete" | "reopen" | "snooze" | "delete") {
    if (operation === "delete" && !window.confirm(`Delete “${item.title}”?`)) return;
    try {
      const body: Record<string, unknown> = { reminderId: item.id, operation };
      if (operation === "complete") body.completed = true;
      if (operation === "reopen") body.completed = false;
      if (operation === "snooze") body.dueDate = addCalendarDays(item.due_date > today ? item.due_date : today, 7);
      await callApi("updateReminder", body); notify(operation === "delete" ? "Reminder deleted." : operation === "snooze" ? "Reminder snoozed for one week." : operation === "reopen" ? "Reminder reopened." : "Reminder completed."); await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to update reminder.", "error"); }
  }
  async function sendNow(item: PersonalReminder) {
    try {
      const result = await callApi("sendReminderNow", { reminderId: item.id });
      notify(result.notification === "sent" ? "Reminder emailed." : String(result.detail ?? "Email was not sent."), result.notification === "sent" ? "success" : "error");
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to email reminder.", "error"); }
  }
  return <section className="content-section alerts-section">
    <div className="section-heading compact"><div><p className="eyebrow">Master administrator only</p><h1>Tasks and alerts</h1><p>Your private HR follow-up list. Workflow steps and reminders stay synchronized.</p></div><button className="button button-primary" onClick={beginAdd}>+ Add reminder</button></div>
    <div className="alert-metrics"><article className={overdue.length ? "attention" : ""}><span>Overdue</span><strong>{overdue.length}</strong></article><article><span>Due in 7 days</span><strong>{dueSoon.length}</strong></article><article><span>Open tasks</span><strong>{open.length}</strong></article></div>
    <div className="alert-toolbar"><div className="filter-tabs"><button className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")}>Open</button><button className={filter === "done" ? "active" : ""} onClick={() => setFilter("done")}>Completed</button></div><span>{visible.length} item{visible.length === 1 ? "" : "s"}</span></div>
    <div className="reminder-list">{visible.map((item) => <article className={`reminder-card ${item.due_date < today && item.status === "open" ? "overdue" : ""}`} key={item.id}>
      <button className={`reminder-check ${item.status === "done" ? "checked" : ""}`} onClick={() => update(item, item.status === "done" ? "reopen" : "complete")} aria-label={item.status === "done" ? "Reopen reminder" : "Complete reminder"}>{item.status === "done" ? "✓" : ""}</button>
      <div className="reminder-copy"><div><span className={`reminder-category category-${item.category}`}>{item.category.replaceAll("_", " ")}</span>{item.priority === "high" && <span className="priority-tag">High priority</span>}{item.source_type === "workflow_task" && <span className="priority-tag">Workflow linked</span>}</div><strong>{item.title}</strong>{item.details && <p>{item.details}</p>}<small>{item.related_employee_name ? `${item.related_employee_name} · ` : ""}{item.status === "done" ? "Completed" : item.due_date < today ? `Overdue · due ${formatDate(item.due_date)}` : `Due ${formatDate(item.due_date)}`}</small></div>
      <div className="reminder-actions">{item.source_type === "vacation_request" && <button onClick={() => setTab("approvals")}>Open request</button>}{item.source_type === "workflow_task" && <button onClick={() => setTab("workflows")}>Open workflow</button>}<button onClick={() => beginEdit(item)}>Edit</button><button onClick={() => sendNow(item)}>Email now</button>{item.status === "open" && <button onClick={() => update(item, "snooze")}>Snooze 1 week</button>}{!item.source_type && <button className="danger-text" onClick={() => update(item, "delete")}>Delete</button>}</div>
    </article>)}{!visible.length && <div className="empty-state"><span>✓</span><h3>{filter === "open" ? "You’re all caught up" : "No completed reminders"}</h3><p>{filter === "open" ? "New workflow tasks and vacation follow-ups will appear here." : "Completed reminders will remain available as a simple activity history."}</p></div>}</div>
    {adding && <div className="modal-backdrop" onMouseDown={() => { setAdding(false); setEditing(null); }}><div className="modal-card" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">Private HR reminder</p><h2>{editing ? "Edit reminder" : "Add something to follow up"}</h2></div><button className="close-button" onClick={() => { setAdding(false); setEditing(null); }}>×</button></div><form className="stack-form" onSubmit={save}><label>Reminder title<input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Follow up on benefits payment" /></label><label>Related employee<select disabled={editing?.source_type === "workflow_task"} value={form.relatedEmployeeId} onChange={(event) => setForm({ ...form, relatedEmployeeId: event.target.value })}><option value="">No employee selected</option>{(data.users ?? []).map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}</select></label><div className="field-grid"><label>Category<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}><option value="custom">General</option><option value="benefits">Benefits</option><option value="training">Training</option><option value="review">Review</option><option value="document">Document</option><option value="return_to_work">Return to work</option><option value="vacation">Vacation</option></select></label><label>Priority<select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option value="normal">Normal</option><option value="high">High</option></select></label></div><label>Due date<input required type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} /></label><label>Notes<textarea value={form.details} onChange={(event) => setForm({ ...form, details: event.target.value })} placeholder="Add the context you will need later…" /></label>{editing?.source_type === "workflow_task" && <p className="form-footnote">Changes to this reminder also update the linked workflow step.</p>}<button className="button button-primary button-wide">{editing ? "Save changes" : "Add reminder and email me"}</button></form></div></div>}
  </section>;
}

function WorkflowCentre({ data, refresh, notify, setTab }: { data: PortalData; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void; setTab: (tab: string) => void }) {
  const workflows = data.workflows ?? [];
  const active = workflows.filter((run) => run.status === "active");
  const [starting, setStarting] = useState<WorkflowRun["workflow_type"] | null>(null);
  const [form, setForm] = useState({ employeeId: "", targetDate: new Date().toISOString().slice(0, 10) });
  const [showCompleted, setShowCompleted] = useState(false);
  const pendingVacation = (data.requests ?? []).filter((request) => request.status === "pending").length;
  const selectedMeta = workflowTemplateMeta.find((item) => item.type === starting);
  async function start(event: FormEvent) {
    event.preventDefault();
    if (!starting) return;
    try { const result = await callApi("startWorkflow", { workflowType: starting, ...form }); notify(result.notification === "sent" ? "Workflow started, reminders created and summary emailed." : "Workflow started and reminders created."); setStarting(null); setForm({ employeeId: "", targetDate: new Date().toISOString().slice(0, 10) }); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to start workflow.", "error"); }
  }
  async function toggleTask(task: WorkflowTask) {
    try { await callApi("completeWorkflowTask", { taskId: task.id, completed: task.status !== "completed" }); notify(task.status === "completed" ? "Task reopened." : "Task completed."); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to update workflow.", "error"); }
  }
  async function cancel(run: WorkflowRun) {
    if (!window.confirm(`Cancel ${run.title}?`)) return;
    try { await callApi("cancelWorkflow", { runId: run.id }); notify("Workflow cancelled."); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to cancel workflow.", "error"); }
  }
  function exportReport() {
    const rows = workflows.flatMap((run) => run.tasks.map((task) => [run.title, run.employee_name, run.workflow_type, run.status, task.title, task.status, task.due_date]));
    const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [["Workflow", "Employee", "Type", "Workflow status", "Task", "Task status", "Due date"], ...rows].map((row) => row.map(quote).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `HR_Workflow_Report_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  const runsToShow = workflows.filter((run) => showCompleted ? run.status !== "active" : run.status === "active");
  return <section className="content-section workflows-section">
    <div className="section-heading compact"><div><p className="eyebrow">Master administrator only</p><h1>Workflow centre</h1><p>Launch repeatable HR processes, track every step and create reminders automatically.</p></div><div className="heading-actions"><button className="button button-secondary" onClick={() => setTab("alerts")}>Open linked reminders</button><button className="button button-secondary" onClick={exportReport} disabled={!workflows.length}>Export report</button><button className="button button-primary" onClick={() => setStarting("onboarding")}>+ Start workflow</button></div></div>
    <div className="workflow-live-card"><div className="workflow-live-heading"><div><span className="eyebrow">Live automated workflow</span><h2>Vacation request and approval</h2><p>{pendingVacation} request{pendingVacation === 1 ? "" : "s"} currently waiting for approval.</p></div><button className="text-button" onClick={() => setTab("approvals")}>Open approval queue →</button></div><div className="flow-map vacation-flow"><div className="flow-node"><span>1</span><strong>Employee submits</strong><small>Request recorded</small></div><i>→</i><div className="flow-node decision"><span>2</span><strong>Manager decision</strong><small>Approve or reject</small></div><i>→</i><div className="flow-branches"><div><b>YES</b><span>HR notified</span><span>Calendar updated</span><span>Balance deducted</span></div><div className="no-branch"><b>NO</b><span>Employee notified</span><span>Request closed</span></div></div></div><p className="flow-footnote">The internal calendar updates automatically. Vacation is deducted from the salaried tracker when applicable; employee and HR notifications use the email connection configured in Settings.</p></div>
    <div className="workflow-live-card onboarding-example"><div className="workflow-live-heading"><div><span className="eyebrow">Branching example</span><h2>Employee onboarding</h2><p>The employee’s work schedule determines the benefits path.</p></div></div><div className="flow-map onboarding-flow"><div className="flow-node"><span>1</span><strong>Employee hired</strong><small>Profile created</small></div><i>→</i><div className="flow-node decision"><span>2</span><strong>Full-time?</strong><small>Schedule check</small></div><i>→</i><div className="flow-branches"><div><b>YES</b><span>Benefits enrollment</span><span>Full training</span><span>30-day check-in</span></div><div className="no-branch"><b>NO</b><span>Skip benefits</span><span>Basic training</span><span>30-day check-in</span></div></div></div></div>
    <div className="template-heading"><div><p className="eyebrow">Reusable templates</p><h2>Start a workflow</h2></div></div><div className="workflow-template-grid">{workflowTemplateMeta.map((template) => <button className="workflow-template" key={template.type} onClick={() => setStarting(template.type)}><span>{template.mark}</span><strong>{template.title}</strong><p>{template.description}</p><b>Start workflow →</b></button>)}</div>
    <div className="run-heading"><div><p className="eyebrow">Workflow register</p><h2>{showCompleted ? "Completed and cancelled" : "Active workflows"}</h2></div><div className="filter-tabs"><button className={!showCompleted ? "active" : ""} onClick={() => setShowCompleted(false)}>Active ({active.length})</button><button className={showCompleted ? "active" : ""} onClick={() => setShowCompleted(true)}>History</button></div></div>
    <div className="workflow-run-list">{runsToShow.map((run) => { const completed = run.tasks.filter((task) => task.status !== "pending").length; const percent = run.tasks.length ? Math.round((completed / run.tasks.length) * 100) : 0; return <article className="workflow-run" key={run.id}><div className="run-summary"><div><span className={`run-status run-${run.status}`}>{run.status}</span><h3>{run.title}</h3><p>Target: {formatDate(run.target_date)} · {completed} of {run.tasks.length} steps complete</p></div><div className="run-progress"><strong>{percent}%</strong><span><i style={{ width: `${percent}%` }} /></span></div></div><div className="workflow-task-list">{run.tasks.map((task) => <button className={`workflow-task task-${task.status}`} key={task.id} disabled={task.status === "skipped" || run.status !== "active"} onClick={() => toggleTask(task)}><span className="task-check">{task.status === "completed" ? "✓" : task.status === "skipped" ? "—" : ""}</span><span><strong>{task.title}</strong><small>{task.branch_label ? `${task.branch_label} · ` : ""}{task.status === "skipped" ? "Skipped automatically" : `Due ${formatDate(task.due_date)}`}</small></span></button>)}</div>{run.status === "active" && <div className="run-actions"><button className="text-button danger-text" onClick={() => cancel(run)}>Cancel workflow</button></div>}</article>; })}{!runsToShow.length && <div className="empty-state"><span>⇢</span><h3>{showCompleted ? "No workflow history yet" : "No active workflows"}</h3><p>Start from a template above and each step will also appear in your Tasks and Alerts list.</p></div>}</div>
    {starting && <div className="modal-backdrop" onMouseDown={() => setStarting(null)}><div className="modal-card" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">{selectedMeta?.title}</p><h2>Start workflow</h2></div><button className="close-button" onClick={() => setStarting(null)}>×</button></div><form className="stack-form" onSubmit={start}><label>Workflow<select value={starting} onChange={(event) => setStarting(event.target.value as WorkflowRun["workflow_type"])}>{workflowTemplateMeta.map((item) => <option value={item.type} key={item.type}>{item.title}</option>)}</select></label><label>Employee<select required value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.target.value })}><option value="">Select an employee</option>{(data.users ?? []).filter((person) => person.status === "active" || person.status === "on_leave").map((person) => <option key={person.id} value={person.id}>{person.full_name}{person.work_schedule ? ` · ${scheduleLabels[person.work_schedule]}` : " · Schedule not set"}</option>)}</select></label><label>{selectedMeta?.targetLabel ?? "Target date"}<input required type="date" value={form.targetDate} onChange={(event) => setForm({ ...form, targetDate: event.target.value })} /></label><div className="workflow-start-note"><strong>What happens next</strong><span>The workflow steps are created with calculated due dates, and each open step is added to your private reminder list.</span></div><button className="button button-primary button-wide">Start workflow</button></form></div></div>}
  </section>;
}

function PeopleAdmin({ data, refresh, notify }: { data: PortalData; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void }) {
  const emptyPerson: Record<string, string> = { fullName: "", employmentType: "hourly", workSchedule: "", departmentId: "", status: "active", hireDate: new Date().toISOString().slice(0, 10), terminationDate: "", leaveStartDate: "", leaveEndDate: "", jobTitle: "", compensationAmount: "", compensationFrequency: "hourly", phone: "", workLocation: "", employeeNotes: "" };
  const users = data.users ?? [];
  const [view, setView] = useState<"people" | "access">("people");
  const [editing, setEditing] = useState<User | null>(null);
  const [profile, setProfile] = useState<User | null>(null);
  const [adding, setAdding] = useState(false);
  const [accessing, setAccessing] = useState<User | null>(null);
  const [addingAccess, setAddingAccess] = useState(false);
  const [accessForm, setAccessForm] = useState({ userId: "", email: "", password: "", role: "employee" });
  const [addForm, setAddForm] = useState(emptyPerson);
  const [filter, setFilter] = useState<"current" | "on_leave" | "terminated" | "pending" | "all">("current");
  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const currentCount = users.filter((person) => person.status === "active" || person.status === "on_leave").length;
  const onLeaveCount = users.filter((person) => person.status === "on_leave").length;
  const terminatedCount = users.filter((person) => person.status === "terminated").length;
  const accessCount = users.filter((person) => person.has_portal_access).length;
  const normalizedSearch = search.trim().toLowerCase();
  const matchesCommon = (person: User) => (departmentFilter === "all" || (departmentFilter === "unassigned" ? !person.department_id : String(person.department_id) === departmentFilter)) && (!normalizedSearch || [person.full_name, person.job_title, person.department_name, person.email].some((value) => String(value ?? "").toLowerCase().includes(normalizedSearch)));
  const visiblePeople = users.filter((person) => matchesCommon(person) && (filter === "all" ? true : filter === "current" ? ["active", "on_leave"].includes(person.status) : person.status === filter));
  const visibleAccess = users.filter((person) => person.has_portal_access && matchesCommon(person));
  const withoutAccess = users.filter((person) => !person.has_portal_access && person.status !== "terminated" && person.status !== "disabled");
  const profileDepartment = profile ? data.departments.find((department) => department.id === profile.department_id) : null;
  function userToForm(person: User) { return { employmentType: person.employment_type, workSchedule: person.work_schedule ?? "", departmentId: String(person.department_id ?? ""), status: person.status, hireDate: person.hire_date ?? "", terminationDate: person.termination_date ?? "", leaveStartDate: person.leave_start_date ?? "", leaveEndDate: person.leave_end_date ?? "", jobTitle: person.job_title ?? "", compensationAmount: person.compensation_amount_cents == null ? "" : String(person.compensation_amount_cents / 100), compensationFrequency: person.compensation_frequency ?? (person.employment_type === "hourly" ? "hourly" : "annual"), phone: person.phone ?? "", workLocation: person.work_location ?? "", employeeNotes: person.employee_notes ?? "" }; }
  function applyPersonForm(person: User, next: Record<string, string>): User { return { ...person, employment_type: next.employmentType as User["employment_type"], work_schedule: (next.workSchedule || null) as User["work_schedule"], department_id: Number(next.departmentId) || null, status: next.status as User["status"], hire_date: next.hireDate || null, termination_date: next.terminationDate || null, leave_start_date: next.leaveStartDate || null, leave_end_date: next.leaveEndDate || null, job_title: next.jobTitle || null, compensation_amount_cents: next.compensationAmount === "" ? null : Math.round(Number(next.compensationAmount) * 100), compensation_frequency: (next.compensationFrequency || null) as User["compensation_frequency"], phone: next.phone || null, work_location: next.workLocation || null, employee_notes: next.employeeNotes || null }; }
  function personPayload(person: User) { return { userId: person.id, fullName: person.full_name, status: person.status, employmentType: person.employment_type, workSchedule: person.work_schedule, departmentId: person.department_id, hireDate: person.hire_date, terminationDate: person.termination_date, leaveStartDate: person.leave_start_date, leaveEndDate: person.leave_end_date, jobTitle: person.job_title, compensationAmount: person.compensation_amount_cents == null ? "" : person.compensation_amount_cents / 100, compensationFrequency: person.compensation_frequency, phone: person.phone, workLocation: person.work_location, employeeNotes: person.employee_notes }; }
  async function savePerson(person: User) { try { const result = await callApi("savePerson", personPayload(person)); notify(result.workflow === "created" ? "Employee updated and return-to-work workflow started." : result.workflow === "updated" ? "Employee and return-to-work workflow updated." : "Employee record updated."); setEditing(null); setProfile(null); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to update employee.", "error"); } }
  async function addPerson(event: FormEvent) { event.preventDefault(); try { const result = await callApi("addPerson", addForm); notify(result.workflow === "created" ? "Employee added and return-to-work workflow started." : "Employee added. Portal access can be granted separately."); setAdding(false); setAddForm(emptyPerson); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to add employee.", "error"); } }
  async function saveAccess(event: FormEvent) { event.preventDefault(); const target = accessing ?? users.find((person) => person.id === Number(accessForm.userId)); if (!target) return; try { await callApi("saveAccess", { userId: target.id, email: accessForm.email, password: accessForm.password, role: accessForm.role, activate: target.status === "pending" }); notify(target.has_portal_access ? "Portal access updated." : "Portal access created."); setAccessing(null); setAddingAccess(false); setAccessForm({ userId: "", email: "", password: "", role: "employee" }); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to save access.", "error"); } }
  function openAccess(person: User) { setAccessing(person); setAddingAccess(false); setAccessForm({ userId: String(person.id), email: person.email, password: "", role: person.role }); }
  async function revokeAccess(person: User) { if (!window.confirm(`Remove portal access for ${person.full_name}? Their employee record will remain.`)) return; try { await callApi("revokeAccess", { userId: person.id }); notify("Portal access removed; the employee record was kept."); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to remove access.", "error"); } }
  async function resetPassword(person: User) { const password = window.prompt(`Enter a temporary password for ${person.full_name}:`); if (!password) return; try { await callApi("resetPassword", { userId: person.id, password }); notify("Password reset. Existing sessions were signed out."); } catch (error) { notify(error instanceof Error ? error.message : "Unable to reset password.", "error"); } }
  async function deletePerson(person: User) { if (!window.confirm(`Delete ${person.full_name}'s employee record? Historical vacation records will be retained.`)) return; try { await callApi("deleteUser", { userId: person.id }); notify("Employee record deleted."); setProfile(null); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to delete employee.", "error"); } }
  return <section className="content-section people-section"><div className="section-heading compact"><div><p className="eyebrow">Employee records</p><h1>People and access</h1><p>Keep employment records separate from who can sign in to the portal.</p></div><button className="button button-primary" onClick={() => view === "people" ? setAdding(true) : setAddingAccess(true)}>{view === "people" ? "+ Add person" : "+ Grant access"}</button></div>
    <div className="people-access-tabs"><button className={view === "people" ? "active" : ""} onClick={() => setView("people")}><strong>People</strong><span>{users.length} employee records</span></button><button className={view === "access" ? "active" : ""} onClick={() => setView("access")}><strong>Access</strong><span>{accessCount} portal accounts</span></button></div>
    {view === "access" && users.some((person) => person.status === "pending") && <div className="approval-banner"><span>{users.filter((person) => person.status === "pending").length}</span><div><strong>Registrations need approval</strong><p>Add the hire date in People, then approve the account here.</p></div></div>}
    {view === "people" && <div className="people-metrics"><article><span>Current headcount</span><strong>{currentCount}</strong></article><article className={onLeaveCount ? "leave" : ""}><span>On leave</span><strong>{onLeaveCount}</strong></article><article><span>Terminated records</span><strong>{terminatedCount}</strong></article></div>}
    <div className="people-search-row"><label className="employee-search"><span>Search employees</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, position, email or team" /></label><label><span>Department</span><select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option value="all">All departments</option><option value="unassigned">Unassigned</option>{data.departments.map((department) => <option key={department.id} value={department.id}>{department.name}{department.active ? "" : " (inactive)"}</option>)}</select></label></div>
    {view === "people" ? <><div className="alert-toolbar"><div className="filter-tabs">{(["current", "on_leave", "terminated", "pending", "all"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "on_leave" ? "On leave" : item[0].toUpperCase() + item.slice(1)}</button>)}</div><span>{visiblePeople.length} employee{visiblePeople.length === 1 ? "" : "s"}</span></div>
      <div className="table-panel"><div className="people-table table-header"><span>Employee</span><span>Department</span><span>Hire date</span><span>Status</span><span /></div>{visiblePeople.map((person) => <div className="people-table" key={person.id}><span className="person-cell"><span className="avatar small">{initials(person.full_name)}</span><span><button className="employee-name-button" onClick={() => setProfile(person)}>{person.full_name}</button><small>{person.job_title || "Position not recorded"}</small></span></span><span>{person.department_name ?? "Unassigned"}<small>{employmentLabels[person.employment_type]} · {person.work_schedule ? scheduleLabels[person.work_schedule] : "Schedule not set"}</small></span><span>{formatDate(person.hire_date)}<small>{person.status === "terminated" ? `Ended ${formatDate(person.termination_date)}` : person.status === "on_leave" ? `Returns ${formatDate(person.leave_end_date)}` : ""}</small></span><span><span className={`account-status account-${person.status}`}>{employeeStatusLabels[person.status]}</span></span><span className="row-actions"><button onClick={() => setProfile(person)}>View file</button><button onClick={() => setEditing({ ...person })}>Edit</button><button className="danger-text" onClick={() => deletePerson(person)}>Delete</button></span></div>)}{!visiblePeople.length && <div className="empty-state compact-empty"><h3>No employees match</h3><p>Try a different search, status or department.</p></div>}</div></> : <div className="table-panel"><div className="access-table table-header"><span>Employee</span><span>Login email</span><span>Role</span><span>Department</span><span /></div>{visibleAccess.map((person) => <div className="access-table" key={person.id}><span className="person-cell"><span className="avatar small">{initials(person.full_name)}</span><span><button className="employee-name-button" onClick={() => setProfile(person)}>{person.full_name}</button><small>{employeeStatusLabels[person.status]}</small></span></span><span>{person.email}</span><span>{roleLabels[person.role]}</span><span>{person.department_name ?? "Unassigned"}</span><span className="row-actions"><button onClick={() => openAccess(person)}>{person.status === "pending" ? "Review" : "Edit access"}</button><button onClick={() => resetPassword(person)}>Reset password</button>{!person.is_master_admin && <button className="danger-text" onClick={() => revokeAccess(person)}>Remove access</button>}</span></div>)}{!visibleAccess.length && <div className="empty-state compact-empty"><h3>No access accounts match</h3><p>Grant access to an employee record or adjust the filters.</p></div>}</div>}
    {profile && <div className="modal-backdrop" onMouseDown={() => setProfile(null)}><div className="modal-card employee-file-modal" onMouseDown={(event) => event.stopPropagation()}><div className="employee-file-hero"><span className="avatar profile-avatar">{initials(profile.full_name)}</span><div><p className="eyebrow">Employee file · #{profile.id}</p><h2>{profile.full_name}</h2><p>{profile.job_title || "Position not recorded"} · {profile.department_name ?? "Unassigned"}</p></div><button className="close-button" onClick={() => setProfile(null)}>×</button></div><div className="employee-file-status"><span className={`account-status account-${profile.status}`}>{employeeStatusLabels[profile.status]}</span><span className={`access-indicator ${profile.has_portal_access ? "connected" : ""}`}>{profile.has_portal_access ? "Portal access enabled" : "No portal access"}</span></div><div className="employee-file-grid"><div><small>Position</small><strong>{profile.job_title || "—"}</strong></div><div><small>Compensation</small><strong>{compensationLabel(profile)}</strong></div><div><small>Employment type</small><strong>{employmentLabels[profile.employment_type]}</strong></div><div><small>Schedule</small><strong>{profile.work_schedule ? scheduleLabels[profile.work_schedule] : "—"}</strong></div><div><small>Department</small><strong>{profile.department_name ?? "Unassigned"}</strong></div><div><small>Department manager</small><strong>{profileDepartment?.manager_name || "Not assigned"}</strong></div><div><small>Work location</small><strong>{profile.work_location || "—"}</strong></div><div><small>Hire date</small><strong>{formatDate(profile.hire_date)}</strong></div><div><small>Phone</small><strong>{profile.phone || "—"}</strong></div>{profile.has_portal_access && <div><small>Login email</small><strong>{profile.email}</strong></div>}{profile.status === "on_leave" && <><div><small>Leave started</small><strong>{formatDate(profile.leave_start_date)}</strong></div><div><small>Expected return</small><strong>{formatDate(profile.leave_end_date)}</strong></div></>}{profile.status === "terminated" && <div><small>Termination date</small><strong>{formatDate(profile.termination_date)}</strong></div>}</div>{profile.employee_notes && <div className="employee-file-notes"><small>HR notes</small><p>{profile.employee_notes}</p></div>}<div className="employee-file-actions"><button className="button button-secondary" onClick={() => { setEditing({ ...profile }); setProfile(null); }}>Edit employee record</button><button className="button button-secondary" onClick={() => { if (profile.has_portal_access) openAccess(profile); else { setAddingAccess(true); setAccessForm({ userId: String(profile.id), email: "", password: "", role: "employee" }); } setProfile(null); }}>{profile.has_portal_access ? "Manage access" : "Grant access"}</button></div></div></div>}
    {(editing || adding) && <div className="modal-backdrop" onMouseDown={() => { setEditing(null); setAdding(false); }}><div className="modal-card employee-edit-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">{adding ? "New employee record" : "Edit employee file"}</p><h2>{adding ? "Add a person" : editing?.full_name}</h2></div><button className="close-button" onClick={() => { setEditing(null); setAdding(false); }}>×</button></div>{adding ? <form className="stack-form" onSubmit={addPerson}><label>Full name<input required value={addForm.fullName} onChange={(event) => setAddForm({ ...addForm, fullName: event.target.value })} /></label><PersonFields form={addForm} setForm={setAddForm} departments={data.departments} /><p className="form-footnote">This creates an employee file only. Email and password are added separately under Access.</p><button className="button button-primary button-wide">Add employee record</button></form> : editing && <form className="stack-form" onSubmit={(event) => { event.preventDefault(); savePerson(editing); }}><label>Full name<input required value={editing.full_name} onChange={(event) => setEditing({ ...editing, full_name: event.target.value })} /></label><PersonFields form={userToForm(editing)} setForm={(next) => setEditing(applyPersonForm(editing, next))} departments={data.departments} /><button className="button button-primary button-wide">Save employee record</button></form>}</div></div>}
    {(addingAccess || accessing) && <div className="modal-backdrop" onMouseDown={() => { setAddingAccess(false); setAccessing(null); }}><div className="modal-card" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">Portal access</p><h2>{accessing ? accessing.full_name : "Grant employee access"}</h2></div><button className="close-button" onClick={() => { setAddingAccess(false); setAccessing(null); }}>×</button></div><form className="stack-form" onSubmit={saveAccess}>{!accessing && <label>Employee<select required value={accessForm.userId} onChange={(event) => setAccessForm({ ...accessForm, userId: event.target.value })}><option value="">Choose an employee</option>{withoutAccess.map((person) => <option key={person.id} value={person.id}>{person.full_name} · {person.department_name ?? "Unassigned"}</option>)}</select></label>}<label>Login email<input required type="email" value={accessForm.email} onChange={(event) => setAccessForm({ ...accessForm, email: event.target.value })} /></label><label>Access role<select value={accessForm.role} onChange={(event) => setAccessForm({ ...accessForm, role: event.target.value })}><option value="employee">Employee</option><option value="manager">Manager</option><option value="admin">Administrator</option><option value="payroll_admin">Payroll administrator</option></select></label><label>{accessing?.has_portal_access ? "New password (optional)" : "Temporary password"}<input required={!accessing?.has_portal_access} minLength={6} type="password" value={accessForm.password} onChange={(event) => setAccessForm({ ...accessForm, password: event.target.value })} placeholder="6+ characters with a letter and number" /></label><button className="button button-primary button-wide">{accessing?.status === "pending" ? "Approve and save access" : accessing?.has_portal_access ? "Save access" : "Grant access"}</button></form></div></div>}
  </section>;
}

function VacationTracker({ data, refresh, notify }: { data: PortalData; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void }) {
  const tracker = data.tracker;
  const [editing, setEditing] = useState<TrackerEmployee | null>(null);
  const [adjusting, setAdjusting] = useState<TrackerEmployee | null>(null);
  const [profile, setProfile] = useState({ monthlyRate: "", openingBalance: "", accrualStartDate: "" });
  const [adjustment, setAdjustment] = useState({ amountDays: "", effectiveDate: new Date().toISOString().slice(0, 10), note: "" });
  if (!tracker) return null;
  const trackerYear = tracker.year;
  const negative = tracker.employees.filter((person) => person.available_days < 0).length;
  function editProfile(person: TrackerEmployee) {
    setEditing(person);
    setProfile({ monthlyRate: String(person.monthly_rate), openingBalance: String(person.opening_balance), accrualStartDate: person.accrual_start_date ?? `${trackerYear}-01-01` });
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    try { await callApi("saveAccrualProfile", { userId: editing.id, year: trackerYear, ...profile }); notify("Accrual settings saved."); setEditing(null); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to save accrual settings.", "error"); }
  }
  async function addAdjustment(event: FormEvent) {
    event.preventDefault();
    if (!adjusting) return;
    try { await callApi("addBalanceAdjustment", { userId: adjusting.id, year: trackerYear, ...adjustment }); notify("Balance adjustment added."); setAdjusting(null); setAdjustment({ amountDays: "", effectiveDate: new Date().toISOString().slice(0, 10), note: "" }); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to add adjustment.", "error"); }
  }
  async function deleteAdjustment(item: TrackerAdjustment) {
    if (!window.confirm("Delete this balance adjustment?")) return;
    try { await callApi("deleteBalanceAdjustment", { adjustmentId: item.id }); notify("Adjustment deleted."); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to delete adjustment.", "error"); }
  }
  return <section className="content-section tracker-section">
    <div className="section-heading compact"><div><p className="eyebrow">Master administrator only</p><h1>Salaried vacation tracker</h1><p>{tracker.year} accrual, carryover, approved time, and available balances.</p></div></div>
    <div className="tracker-metrics tracker-metrics-compact"><article><span>Salaried employees</span><strong>{tracker.employees.length}</strong></article><article className={negative ? "negative" : ""}><span>Negative balances</span><strong>{negative}</strong></article></div>
    <div className="tracker-note"><span>i</span><p>Approved requests are deducted immediately, including future vacation. A balance may go below zero so unaccrued paid time can still be approved.</p></div>
    <div className="table-panel tracker-table-wrap"><div className="tracker-table tracker-header"><span>Employee</span><span>Monthly rate</span><span>Carryover</span><span>YTD accrued</span><span>Approved</span><span>Adjustments</span><span>Available</span><span /></div>
      {tracker.employees.map((person) => <div className="tracker-table" key={person.id}><span className="person-cell"><span className="avatar small">{initials(person.full_name)}</span><span><strong>{person.full_name}</strong><small>{person.department_name ?? "Unassigned"}</small></span></span><span>{person.monthly_rate.toFixed(2)}</span><span>{person.opening_balance.toFixed(2)}</span><span>{person.accrued_days.toFixed(2)}</span><span>−{person.approved_days.toFixed(2)}</span><span>{person.adjustment_days >= 0 ? "+" : ""}{person.adjustment_days.toFixed(2)}</span><span className={person.available_days < 0 ? "balance-negative" : "balance-positive"}>{person.available_days.toFixed(2)}</span><span className="row-actions"><button onClick={() => editProfile(person)}>Accrual</button><button onClick={() => setAdjusting(person)}>Adjust</button></span></div>)}
      {!tracker.employees.length && <div className="empty-state compact-empty"><h3>No salaried employees yet</h3><p>Change an employee’s employment type to Salaried to add them to this tracker.</p></div>}
    </div>
    {tracker.adjustments.length > 0 && <div className="panel adjustment-history"><div className="panel-heading"><div><span className="eyebrow">Audit trail</span><h2>Recent manual adjustments</h2></div></div>{tracker.adjustments.slice(0, 12).map((item) => { const person = tracker.employees.find((employee) => employee.id === Number(item.user_id)); return <div className="adjustment-row" key={item.id}><span><strong>{person?.full_name ?? "Former employee"}</strong><small>{formatDate(item.effective_date)} · {item.note}</small></span><b className={Number(item.amount_days) < 0 ? "balance-negative" : "balance-positive"}>{Number(item.amount_days) > 0 ? "+" : ""}{Number(item.amount_days).toFixed(2)} days</b><button className="text-button danger-text" onClick={() => deleteAdjustment(item)}>Delete</button></div>; })}</div>}
    {editing && <div className="modal-backdrop" onMouseDown={() => setEditing(null)}><div className="modal-card" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">{tracker.year} accrual profile</p><h2>{editing.full_name}</h2></div><button className="close-button" onClick={() => setEditing(null)}>×</button></div><form className="stack-form" onSubmit={saveProfile}><label>Monthly accrual rate (days)<input required type="number" min="0" max="10" step="0.01" value={profile.monthlyRate} onChange={(event) => setProfile({ ...profile, monthlyRate: event.target.value })} /></label><label>Opening balance / carryover (days)<input required type="number" min="-365" max="365" step="0.01" value={profile.openingBalance} onChange={(event) => setProfile({ ...profile, openingBalance: event.target.value })} /></label><label>Accrual start date<input type="date" value={profile.accrualStartDate} onChange={(event) => setProfile({ ...profile, accrualStartDate: event.target.value })} /></label><p className="form-footnote">Accrual includes each month from the start date through the current month, matching the monthly method in your spreadsheet.</p><button className="button button-primary button-wide">Save accrual profile</button></form></div></div>}
    {adjusting && <div className="modal-backdrop" onMouseDown={() => setAdjusting(null)}><div className="modal-card" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">Manual balance entry</p><h2>{adjusting.full_name}</h2></div><button className="close-button" onClick={() => setAdjusting(null)}>×</button></div><form className="stack-form" onSubmit={addAdjustment}><label>Days to add or subtract<input required type="number" min="-365" max="365" step="0.01" value={adjustment.amountDays} onChange={(event) => setAdjustment({ ...adjustment, amountDays: event.target.value })} placeholder="Use -1.5 to subtract" /></label><label>Effective date<input required type="date" min={`${tracker.year}-01-01`} max={`${tracker.year}-12-31`} value={adjustment.effectiveDate} onChange={(event) => setAdjustment({ ...adjustment, effectiveDate: event.target.value })} /></label><label>Reason<textarea required value={adjustment.note} onChange={(event) => setAdjustment({ ...adjustment, note: event.target.value })} placeholder="Carryover correction, additional entitlement, unpaid day…" /></label><button className="button button-primary button-wide">Add adjustment</button></form></div></div>}
  </section>;
}

type WorkforceReport = "summary" | "hires" | "departures" | "leave" | "headcount" | "roster";

const workforceReportOptions: Array<{ id: WorkforceReport; title: string; description: string }> = [
  { id: "summary", title: "Workforce growth", description: "Opening headcount, hires, departures, closing headcount and net growth." },
  { id: "hires", title: "Employees hired", description: "Employees whose hire date falls within the selected period." },
  { id: "departures", title: "Employees leaving", description: "Terminated employees whose last date falls within the selected period." },
  { id: "leave", title: "Employees on leave", description: "Current leave population, dates and percentage of current headcount." },
  { id: "headcount", title: "Headcount by team", description: "Active and on-leave employees grouped by department." },
  { id: "roster", title: "Employee roster", description: "A complete export of employee status, dates, department and employment type." },
];

const reportPalette = ["#45221e", "#b4a034", "#766047", "#d1b66b", "#8f5050", "#527461", "#95855c", "#96717e", "#bc8d61", "#647985"];

function ReportPie({ title, segments }: { title: string; segments: Array<{ label: string; value: number; color: string }> }) {
  const visible = segments.filter((segment) => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  let cursor = 0;
  const stops = visible.map((segment) => {
    const start = cursor;
    cursor += total ? (segment.value / total) * 100 : 0;
    return `${segment.color} ${start}% ${cursor}%`;
  });
  const description = visible.map((segment) => `${segment.label}: ${segment.value}`).join(", ") || "No data";
  return <article className="report-chart-card"><div className="chart-title"><div><span>Pie chart</span><strong>{title}</strong></div><b>{total} total</b></div><div className="pie-chart-layout"><div className="report-pie" role="img" aria-label={`${title}. ${description}`} style={{ background: total ? `conic-gradient(${stops.join(", ")})` : "#e7ecea" }} /><div className="chart-legend">{visible.map((segment) => <div key={segment.label}><i style={{ background: segment.color }} /><span><strong>{segment.label}</strong><small>{segment.value} · {total ? ((segment.value / total) * 100).toFixed(1) : "0.0"}%</small></span></div>)}{!visible.length && <p>No current employee data.</p>}</div></div></article>;
}

function ReportBars({ title, values }: { title: string; values: Array<{ label: string; value: number; tone?: "positive" | "negative" }> }) {
  const maximum = Math.max(1, ...values.map((item) => Math.abs(item.value)));
  return <article className="report-chart-card"><div className="chart-title"><div><span>Bar graph</span><strong>{title}</strong></div></div><div className="report-bars" role="img" aria-label={`${title}. ${values.map((item) => `${item.label}: ${item.value}`).join(", ")}`}>{values.map((item) => <div className="report-bar-row" key={item.label}><span>{item.label}</span><div><i className={item.tone ?? ""} style={{ width: `${Math.max(3, (Math.abs(item.value) / maximum) * 100)}%` }} /></div><b>{item.value}</b></div>)}</div></article>;
}

function ReportsAdmin({ data }: { data: PortalData }) {
  const users = data.users ?? [];
  const workforceRecords = users.filter((person) => person.status === "active" || person.status === "on_leave" || person.status === "terminated");
  const today = new Date().toISOString().slice(0, 10);
  const [report, setReport] = useState<WorkforceReport>("summary");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [period, setPeriod] = useState<"month" | "year" | "custom">("month");
  const [customStart, setCustomStart] = useState(`${today.slice(0, 7)}-01`);
  const [customEnd, setCustomEnd] = useState(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEndDate = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0);
  const monthEnd = `${monthEndDate.getFullYear()}-${String(monthEndDate.getMonth() + 1).padStart(2, "0")}-${String(monthEndDate.getDate()).padStart(2, "0")}`;
  const rangeStart = period === "month" ? monthStart : period === "year" ? `${today.slice(0, 4)}-01-01` : customStart;
  const rangeEnd = period === "month" ? monthEnd : period === "year" ? `${today.slice(0, 4)}-12-31` : customEnd;
  const rangeValid = Boolean(rangeStart && rangeEnd && rangeStart <= rangeEnd);
  const periodRelevant = report === "summary" || report === "hires" || report === "departures";
  const inRange = (value?: string | null) => Boolean(value && value >= rangeStart && value <= rangeEnd);
  const hires = rangeValid ? workforceRecords.filter((person) => inRange(person.hire_date)) : [];
  const departures = rangeValid ? workforceRecords.filter((person) => inRange(person.termination_date)) : [];
  const current = workforceRecords.filter((person) => person.status === "active" || person.status === "on_leave");
  const onLeave = current.filter((person) => person.status === "on_leave");
  const opening = rangeValid ? workforceRecords.filter((person) => person.hire_date && person.hire_date < rangeStart && (!person.termination_date || person.termination_date >= rangeStart)).length : 0;
  const closing = rangeValid ? workforceRecords.filter((person) => person.hire_date && person.hire_date <= rangeEnd && (!person.termination_date || person.termination_date > rangeEnd)).length : 0;
  const netChange = closing - opening;
  const growth = opening ? (netChange / opening) * 100 : null;
  const leavePercent = current.length ? (onLeave.length / current.length) * 100 : 0;
  const missingHireDates = workforceRecords.filter((person) => !person.hire_date).length;
  const teamRows = [...new Set(current.map((person) => person.department_name ?? "Unassigned"))].sort().map((department) => {
    const people = current.filter((person) => (person.department_name ?? "Unassigned") === department);
    return [department, people.filter((person) => person.status === "active").length, people.filter((person) => person.status === "on_leave").length, people.length];
  }) as Array<[string, number, number, number]>;
  const teamSegments = teamRows.map((row, index) => ({ label: row[0], value: row[3], color: reportPalette[index % reportPalette.length] }));
  const statusSegments = [
    { label: "Active", value: current.length - onLeave.length, color: reportPalette[0] },
    { label: "On leave", value: onLeave.length, color: reportPalette[3] },
  ];
  const growthBars = [
    { label: "Opening", value: opening },
    { label: "Hired", value: hires.length, tone: "positive" as const },
    { label: "Left", value: departures.length, tone: "negative" as const },
    { label: "Closing", value: closing },
  ];
  let headers: string[] = [];
  let rows: Array<Array<string | number>> = [];
  if (report === "summary") {
    headers = ["Metric", "Value", "Period"];
    rows = [["Opening headcount", opening, `${rangeStart} to ${rangeEnd}`], ["Employees hired", hires.length, `${rangeStart} to ${rangeEnd}`], ["Employees leaving", departures.length, `${rangeStart} to ${rangeEnd}`], ["Closing headcount", closing, `${rangeStart} to ${rangeEnd}`], ["Net headcount change", netChange, `${rangeStart} to ${rangeEnd}`], ["Growth rate", growth == null ? "Not available" : `${growth.toFixed(1)}%`, `${rangeStart} to ${rangeEnd}`], ["Currently on leave", onLeave.length, `As of ${today}`], ["Current leave percentage", `${leavePercent.toFixed(1)}%`, `As of ${today}`]];
  } else if (report === "hires") {
    headers = ["Employee", "Department", "Hire date", "Status", "Employment type"];
    rows = hires.map((person) => [person.full_name, person.department_name ?? "Unassigned", person.hire_date ?? "", employeeStatusLabels[person.status], employmentLabels[person.employment_type]]);
  } else if (report === "departures") {
    headers = ["Employee", "Department", "Hire date", "Termination date", "Employment type"];
    rows = departures.map((person) => [person.full_name, person.department_name ?? "Unassigned", person.hire_date ?? "", person.termination_date ?? "", employmentLabels[person.employment_type]]);
  } else if (report === "leave") {
    headers = ["Employee", "Department", "Leave start", "Expected return", "Share of current headcount"];
    rows = onLeave.map((person) => [person.full_name, person.department_name ?? "Unassigned", person.leave_start_date ?? "", person.leave_end_date ?? "", `${leavePercent.toFixed(1)}% total on leave`]);
  } else if (report === "headcount") {
    headers = ["Department", "Active", "On leave", "Total headcount"];
    rows = teamRows;
  } else {
    headers = ["Employee", "Position", "Department", "Status", "Hire date", "Termination date", "Leave start", "Expected return", "Employment type", "Schedule", "Compensation", "Work location", "Portal access", "Email"];
    rows = users.map((person) => [person.full_name, person.job_title ?? "", person.department_name ?? "Unassigned", employeeStatusLabels[person.status], person.hire_date ?? "", person.termination_date ?? "", person.leave_start_date ?? "", person.leave_end_date ?? "", employmentLabels[person.employment_type], person.work_schedule ? scheduleLabels[person.work_schedule] : "Not set", compensationLabel(person), person.work_location ?? "", person.has_portal_access ? "Enabled" : "No access", person.email]);
  }
  function exportSelected() {
    if (!rangeValid) return;
    const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [headers, ...rows].map((row) => row.map(quote).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `SFTE_${report}_${rangeStart}_to_${rangeEnd}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function exportPdf() {
    if (!rangeValid || exporting) return;
    setExporting(true); setExportError("");
    try {
      const { createWorkforceReportPdf, loadPdfLogo } = await import("../lib/pdf-style");
      const pdf = await createWorkforceReportPdf({
        companyName: data.settings?.company_name ?? "Sweets from the Earth",
        title: selected.title, period: periodRelevant ? `${rangeStart} to ${rangeEnd}` : `As of ${today}`,
        generated: today, headers, rows,
        bars: report === "summary" ? growthBars : undefined,
        pie: report === "summary" ? { title: "Current workforce status", segments: statusSegments }
          : report === "headcount" ? { title: "Headcount by team", segments: teamSegments } : undefined,
      }, await loadPdfLogo());
      pdf.save(`SFTE_${report}_${periodRelevant ? `${rangeStart}_to_${rangeEnd}` : today}.pdf`);
    } catch (error) { setExportError(error instanceof Error ? error.message : "Unable to export the report. Please try again."); }
    finally { setExporting(false); }
  }
  const selected = workforceReportOptions.find((item) => item.id === report)!;
  return <section className="content-section reports-section">
    <div className="section-heading compact"><div><p className="eyebrow">Master administrator only</p><h1>Workforce reports</h1><p>Choose one report, review its numbers and export only that dataset.</p></div><div className="report-export-actions"><button className="button button-secondary" disabled={!rangeValid || exporting} onClick={exportSelected}>Export CSV</button><button className="button button-primary" disabled={!rangeValid || exporting} aria-busy={exporting} onClick={exportPdf}>{exporting ? "Preparing report…" : "Export PDF report"}</button></div></div>
    {exportError && <p className="error-text" role="alert">{exportError}</p>}
    {missingHireDates > 0 && <div className="tracker-note warning-note"><span>!</span><p><strong>{missingHireDates} employee record{missingHireDates === 1 ? " is" : "s are"} missing a hire date.</strong> Those records are excluded from historical headcount and growth calculations until completed in People &amp; Access.</p></div>}
    <div className="report-layout"><aside className="report-picker">{workforceReportOptions.map((item) => <button key={item.id} className={report === item.id ? "active" : ""} onClick={() => setReport(item.id)}><strong>{item.title}</strong><span>{item.description}</span></button>)}</aside><div className="report-workspace">
      <div className="report-controls"><div><p className="eyebrow">Selected report</p><h2>{selected.title}</h2><p>{selected.description}</p></div>{periodRelevant ? <div className="period-controls"><label>Period<select value={period} onChange={(event) => setPeriod(event.target.value as typeof period)}><option value="month">This month</option><option value="year">This year</option><option value="custom">Custom range</option></select></label>{period === "custom" && <><label>From<input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label>To<input type="date" min={customStart} value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></>}</div> : <span className="as-of-pill">As of {formatDate(today)}</span>}</div>
      {!rangeValid && <div className="tracker-note warning-note"><span>!</span><p><strong>Choose a valid report period.</strong> The end date must be on or after the start date.</p></div>}
      {report === "summary" && <div className="report-metrics"><article><span>Opening</span><strong>{opening}</strong></article><article><span>Hired</span><strong>{hires.length}</strong></article><article><span>Left</span><strong>{departures.length}</strong></article><article><span>Closing</span><strong>{closing}</strong></article><article className={netChange < 0 ? "negative" : "positive"}><span>Net growth</span><strong>{netChange > 0 ? "+" : ""}{netChange}</strong><small>{growth == null ? "No opening baseline" : `${growth.toFixed(1)}%`}</small></article><article><span>On leave now</span><strong>{leavePercent.toFixed(1)}%</strong><small>{onLeave.length} of {current.length}</small></article></div>}
      {report === "summary" && <div className="report-chart-grid"><ReportBars title="Headcount movement" values={growthBars} /><ReportPie title="Current workforce status" segments={statusSegments} /></div>}
      {report === "headcount" && <div className="report-chart-grid single-chart"><ReportPie title="Headcount by team" segments={teamSegments} /></div>}
      <div className="report-table-wrap"><table className="report-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${report}-${index}`}>{row.map((value, cell) => <td key={`${index}-${cell}`}>{value}</td>)}</tr>)}{!rows.length && <tr><td colSpan={headers.length}>No records match this report and period.</td></tr>}</tbody></table></div>
    </div></div>
  </section>;
}

function PersonFields({ form, setForm, departments }: { form: Record<string, string>; setForm: (next: Record<string, string>) => void; departments: Department[] }) {
  return <>
    <div className="field-grid"><label>Position / job title<input value={form.jobTitle ?? ""} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} placeholder="Production Supervisor" /></label><label>Employment status<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{form.status === "pending" && <option value="pending">Pending registration</option>}<option value="active">Active</option><option value="on_leave">On leave</option><option value="terminated">Terminated</option>{form.status === "disabled" && <option value="disabled">Disabled access</option>}</select></label></div>
    <div className="field-grid"><label>Employment type<select value={form.employmentType} onChange={(event) => setForm({ ...form, employmentType: event.target.value, compensationFrequency: event.target.value === "hourly" ? "hourly" : "annual" })}><option value="hourly">Hourly</option><option value="salaried">Salaried</option></select></label><label>Work schedule<select value={form.workSchedule ?? ""} onChange={(event) => setForm({ ...form, workSchedule: event.target.value })}><option value="">Not set</option><option value="full_time">Full-time</option><option value="part_time">Part-time</option></select></label></div>
    <div className="field-grid"><label>Department<select value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}><option value="">Unassigned</option>{departments.filter((department) => department.active || String(department.id) === String(form.departmentId)).map((department) => <option key={department.id} value={department.id}>{department.name}{department.active ? "" : " (inactive)"}</option>)}</select></label><label>Work location<input value={form.workLocation ?? ""} onChange={(event) => setForm({ ...form, workLocation: event.target.value })} placeholder="GF facility, NF facility, Office…" /></label></div>
    <div className="field-grid"><label>Hire date<input required type="date" value={form.hireDate ?? ""} onChange={(event) => setForm({ ...form, hireDate: event.target.value })} /><small className="password-help">Used for headcount and growth reports.</small></label><label>Phone number<input type="tel" value={form.phone ?? ""} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label></div>
    <div className="field-grid"><label>Compensation amount<input type="number" min="0" max="10000000" step="0.01" value={form.compensationAmount ?? ""} onChange={(event) => setForm({ ...form, compensationAmount: event.target.value })} placeholder={form.employmentType === "hourly" ? "Hourly rate" : "Annual salary"} /></label><label>Compensation basis<select value={form.compensationFrequency ?? ""} onChange={(event) => setForm({ ...form, compensationFrequency: event.target.value })}><option value="hourly">Per hour</option><option value="annual">Per year</option></select></label></div>
    {form.status === "on_leave" && <><div className="field-grid"><label>Leave start date<input required type="date" value={form.leaveStartDate ?? ""} onChange={(event) => setForm({ ...form, leaveStartDate: event.target.value })} /></label><label>Expected return date<input required type="date" min={form.leaveStartDate || undefined} value={form.leaveEndDate ?? ""} onChange={(event) => setForm({ ...form, leaveEndDate: event.target.value })} /></label></div><div className="workflow-start-note"><strong>Automatic workflow</strong><span>Saving this employee as on leave starts or reschedules the return-to-work workflow using the expected return date.</span></div></>}
    {form.status === "terminated" && <label>Termination date<input required type="date" min={form.hireDate || undefined} value={form.terminationDate ?? ""} onChange={(event) => setForm({ ...form, terminationDate: event.target.value })} /></label>}
    <label>HR notes<textarea value={form.employeeNotes ?? ""} onChange={(event) => setForm({ ...form, employeeNotes: event.target.value })} placeholder="Private employment notes for this employee file" /></label>
    <div className="field-rule"><strong>Vacation-pay rule</strong><span>{form.employmentType === "hourly" ? "Vacation-pay fields will be available." : "Vacation-pay fields will be blocked."}</span></div>
  </>;
}

function DepartmentsAdmin({ data, refresh, notify }: { data: PortalData; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void }) {
  const [name, setName] = useState("");
  const managers = (data.users ?? []).filter((user) => user.has_portal_access && user.status === "active" && (user.role === "manager" || user.role === "admin"));
  async function save(department: Department, changes: Partial<Department> = {}) { try { await callApi("saveDepartment", { departmentId: department.id, name: changes.name ?? department.name, managerUserId: changes.manager_user_id ?? department.manager_user_id, active: changes.active ?? Boolean(department.active) }); notify("Department updated."); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to update department.", "error"); } }
  async function add(event: FormEvent) { event.preventDefault(); try { await callApi("saveDepartment", { name }); notify("Department added."); setName(""); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to add department.", "error"); } }
  return <section className="content-section"><div className="section-heading compact"><div><p className="eyebrow">Administration</p><h1>Departments and routing</h1><p>Assign the manager who receives and reviews each department’s requests.</p></div></div><form className="add-department" onSubmit={add}><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="New department name" /><button className="button button-primary">Add department</button></form><div className="department-grid">{data.departments.map((department) => <article className={`department-card ${department.active ? "" : "inactive"}`} key={department.id}><div className="department-title"><span className="department-monogram">{department.name.slice(0, 2).toUpperCase()}</span><div><strong>{department.name}</strong><small>{department.active ? "Active" : "Inactive"}</small></div></div><label>Assigned manager<select value={department.manager_user_id ?? ""} onChange={(e) => save(department, { manager_user_id: Number(e.target.value) || null })}><option value="">No manager assigned</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.full_name}</option>)}</select></label><div className="department-actions"><button className="text-button" onClick={() => { const nextName = window.prompt("Department name", department.name); if (nextName) save(department, { name: nextName }); }}>Rename</button><button className={`text-button ${department.active ? "danger-text" : ""}`} onClick={() => save(department, { active: department.active ? 0 : 1 })}>{department.active ? "Deactivate" : "Reactivate"}</button></div></article>)}</div></section>;
}

function SettingsAdmin({ data, refresh, notify }: { data: PortalData; refresh: () => Promise<void>; notify: (message: string, tone?: "success" | "error") => void }) {
  const [form, setForm] = useState({ companyName: data.settings?.company_name ?? "Sweets from the Earth", approvalEmails: data.settings?.approval_emails ?? "", personalReminderEmail: data.settings?.personal_reminder_email || data.user?.email || "", personalReminderEnabled: data.settings?.personal_reminder_enabled === "true" });
  const [gmail, setGmail] = useState({ gmailRelayUrl: data.settings?.gmail_relay_url ?? "", gmailRelaySecret: "" });
  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "" });
  async function saveSettings(event: FormEvent) { event.preventDefault(); try { await callApi("saveSettings", form); notify("Portal settings saved."); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to save settings.", "error"); } }
  async function saveGmail(event: FormEvent) { event.preventDefault(); try { await callApi("saveGmailConnection", gmail); notify("Gmail connection saved."); setGmail({ ...gmail, gmailRelaySecret: "" }); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to save Gmail connection.", "error"); } }
  async function disconnectGmail() { if (!window.confirm("Disconnect Gmail from the portal? Emails will stop sending until another service is connected.")) return; try { await callApi("disconnectGmail"); notify("Gmail disconnected."); setGmail({ gmailRelayUrl: "", gmailRelaySecret: "" }); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to disconnect Gmail.", "error"); } }
  async function changePassword(event: FormEvent) { event.preventDefault(); try { await callApi("changePassword", passwords); notify("Password changed."); setPasswords({ currentPassword: "", newPassword: "" }); } catch (error) { notify(error instanceof Error ? error.message : "Unable to change password.", "error"); } }
  async function testReminder() { try { const result = await callApi("testPersonalReminder", { email: form.personalReminderEmail }); notify(result.delivery === "sent" ? "Test reminder sent." : result.delivery === "queued" ? "Test saved in the queue. The outbound email connection still needs to be activated." : String(result.detail ?? "Test delivery failed."), result.delivery === "failed" ? "error" : "success"); } catch (error) { notify(error instanceof Error ? error.message : "Unable to test reminder email.", "error"); } }
  if (data.user?.role === "manager") return <section className="content-section"><div className="section-heading compact"><div><p className="eyebrow">My settings</p><h1>Request notifications</h1></div></div><RequestAlertSettings data={data} refresh={refresh} notify={notify} /></section>;
  return <section className="content-section">
    <div className="section-heading compact"><div><p className="eyebrow">Administration</p><h1>Portal settings</h1><p>Manage reminder delivery, approval routing and sign-in security.</p></div></div>
    <div className="settings-grid">
      <RequestAlertSettings data={data} refresh={refresh} notify={notify} />
      <form className="panel stack-form" onSubmit={saveSettings}>
        <div className="panel-heading"><div><span className="eyebrow">Vacation notifications</span><h2>Approval recipients</h2></div></div>
        <label>Company name<input value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} /></label>
        <label>Primary HR email<input type="email" value="hr@sweetsfromtheearth.com" readOnly /></label>
        <label>Additional approval recipients<textarea value={form.approvalEmails} onChange={(event) => setForm({ ...form, approvalEmails: event.target.value })} placeholder={"manager@sweetsfromtheearth.com\npayroll@sweetsfromtheearth.com"} /><small className="password-help">Enter one or more @sweetsfromtheearth.com addresses, separated by a new line or comma.</small></label>
        <p className="form-footnote">Every new request goes to HR, the assigned active approver, active admin accounts, and the additional recipients above.</p>
        <button className="button button-primary">Save settings</button>
      </form>
      {data.user?.is_master_admin === 1 && <form className="panel stack-form personal-reminder-panel" onSubmit={saveGmail}>
        <div className="panel-heading"><div><span className="eyebrow">Email delivery</span><h2>Connect your Gmail</h2></div><span className={`connection-pill ${data.settings?.email_delivery_provider === "gmail" ? "connected" : "waiting"}`}>{data.settings?.email_delivery_provider === "gmail" ? "Gmail connected" : "Setup required"}</span></div>
        <label>Google Apps Script web-app URL<input type="url" required value={gmail.gmailRelayUrl} onChange={(event) => setGmail({ ...gmail, gmailRelayUrl: event.target.value })} placeholder="https://script.google.com/macros/s/.../exec" /></label>
        <label>Portal relay password<input type="password" required={!data.settings?.gmail_relay_configured} minLength={32} value={gmail.gmailRelaySecret} onChange={(event) => setGmail({ ...gmail, gmailRelaySecret: event.target.value })} placeholder={data.settings?.gmail_relay_configured ? "Leave blank to keep the saved password" : "Paste the PORTAL_SECRET value"} /><small className="password-help">This must exactly match the PORTAL_SECRET value saved in Google Apps Script. It is never displayed again after saving.</small></label>
        <div className="settings-actions"><button className="button button-primary">Save Gmail connection</button>{data.settings?.gmail_relay_configured && <button className="button button-secondary" type="button" onClick={disconnectGmail}>Disconnect</button>}</div>
      </form>}
      {data.user?.is_master_admin === 1 && <div className="panel stack-form personal-reminder-panel">
        <div className="panel-heading"><div><span className="eyebrow">Personal notifications</span><h2>Your reminder email</h2></div><span className={`connection-pill ${data.settings?.email_delivery_ready ? "connected" : "waiting"}`}>{data.settings?.email_delivery_ready ? "Service connected" : "Connection pending"}</span></div>
        <label>Email for your HR reminders<input type="email" required value={form.personalReminderEmail} onChange={(event) => setForm({ ...form, personalReminderEmail: event.target.value })} placeholder="your@email.com" /></label>
        <label className="toggle-row"><input type="checkbox" checked={form.personalReminderEnabled} onChange={(event) => setForm({ ...form, personalReminderEnabled: event.target.checked })} /><span><strong>Send me a daily reminder digest</strong><small>One email when you have tasks that are due or overdue.</small></span></label>
        <p className="form-footnote">Your reminder address may be your personal Gmail. Text-message reminders require a separate SMS provider and sending number.</p>
        <div className="settings-actions"><button className="button button-primary" type="button" onClick={async () => { try { await callApi("saveSettings", form); notify("Reminder email saved."); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Unable to save reminder email.", "error"); } }}>Save reminder email</button><button className="button button-secondary" type="button" onClick={testReminder}>Send test</button></div>
      </div>}
      <form className="panel stack-form" onSubmit={changePassword}>
        <div className="panel-heading"><div><span className="eyebrow">Security</span><h2>Change password</h2></div></div>
        <label>Current password<input type="password" required value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} /></label>
        <label>New password<input type="password" required minLength={6} value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} placeholder="6+ characters with a letter and number" /><small className="password-help">Use at least 6 characters with one letter and one number.</small></label>
        <button className="button button-secondary">Update password</button>
      </form>
    </div>
    <div className="email-config-note"><span>{data.settings?.email_delivery_ready ? "✓" : "i"}</span><div><strong>{data.settings?.email_delivery_ready ? `${data.settings.email_delivery_provider === "gmail" ? "Gmail" : "Outbound email service"} connected` : "Outbound email connection required"}</strong><p>{data.settings?.email_delivery_ready ? "The portal can send approval and personal reminder emails using the connected service." : "Connect Gmail above, then send yourself a test reminder."}</p></div></div>
  </section>;
}

export default function VacationPortal() {
  const [data, setData] = useState<PortalData | null>(null);
  const [tab, setTab] = useState("dashboard");
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [vacationOpen, setVacationOpen] = useState(true);
  const [operations, setOperations] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"current" | "reconnecting">("current");
  const latestData = useRef<PortalData | null>(null);
  const operationsRef = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSequence = useRef(0);
  const notify = (message: string, tone: "success" | "error" = "success") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = setTimeout(() => setToast(null), tone === "error" ? 8000 : 5500);
  };
  const refresh = async () => {
    const sequence = ++refreshSequence.current;
    const response = await readPortal("/api/app");
    const next = await response.json() as PortalData & { error?: string };
    if (!response.ok) throw new Error(next.error || "Unable to load the portal.");
    if (sequence === refreshSequence.current) { setData(next); setLoadError(false); }
  };
  useEffect(() => {
    latestData.current = data;
  }, [data]);
  useEffect(() => {
    void readPortal("/api/app")
      .then((response) => { if (!response.ok) throw new Error("Unable to load."); return response.json(); })
      .then((next) => setData(next as PortalData))
      .catch(() => setLoadError(true));
    const onOperation = (event: Event) => { const delta = Number((event as CustomEvent).detail); if (delta > 0) refreshSequence.current += 1; operationsRef.current = Math.max(0, operationsRef.current + delta); setOperations(operationsRef.current); };
    window.addEventListener("portal-operation", onOperation);
    return () => { window.removeEventListener("portal-operation", onOperation); if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);
  useEffect(() => {
    if (!data?.user || !["active", "on_leave"].includes(data.user.status)) return;
    const userId = data.user.id;
    const seen = new Set((data.requests ?? []).filter((record) => pendingFor(record, data.user!.role, data.user!.id)).map((record) => record.id));
    let controller: AbortController | null = null;
    let disposed = false;
    async function updateRequests() {
      if (disposed || controller || document.visibilityState === "hidden" || operationsRef.current > 0) return;
      controller = new AbortController();
      const sequence = refreshSequence.current;
      try {
        const response = await readPortal("/api/app?view=live", controller.signal);
        if (!response.ok) throw new Error("Live updates unavailable");
        const next = await response.json() as PortalData;
        if (disposed || sequence !== refreshSequence.current || latestData.current?.user?.id !== userId) return;
        if (!next.user || !["active", "on_leave"].includes(next.user.status)) { setData(next); return; }
        const newRequests = (next.requests ?? []).filter((record) => !seen.has(record.id) && pendingFor(record, next.user!.role, next.user!.id));
        (next.requests ?? []).filter((record) => pendingFor(record, next.user!.role, next.user!.id)).forEach((record) => seen.add(record.id));
        if (newRequests.length && next.user.role !== "employee" && next.requestAlerts?.inApp !== false) {
          notify(newRequests.length === 1 ? `${next.user.role === "payroll_admin" ? "Payroll review ready" : "New vacation request"}: ${newRequests[0].employee_name} · ${newRequests[0].department_name}` : `${newRequests.length} requests need your review. Open the approval queue.`);
        }
        setData((current) => current?.user?.id === userId ? { ...current, ...next, myVacationBalance: next.myVacationBalance, vacationPeople: next.vacationPeople } : current);
        setLiveStatus("current");
      } catch (error) { if (!disposed && !(error instanceof Error && error.name === "AbortError")) setLiveStatus("reconnecting"); }
      finally { controller = null; }
    }
    const timer = setInterval(() => void updateRequests(), 5000);
    const resume = () => void updateRequests();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => { disposed = true; clearInterval(timer); controller?.abort(); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
    // Polling reads current preferences from the server and preserves open form drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.user?.id, data?.user?.status]);
  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", escape); };
  }, [menuOpen]);
  const logout = async () => { try { await callApi("logout"); setData(null); setTab("dashboard"); setMenuOpen(false); await refresh(); } catch { notify("Unable to sign out. Please try again.", "error"); } };
  const navigation = useMemo(() => {
    if (!data?.user) return { vacation: [] as Array<{ id: string; label: string; mark: string; count?: number }>, primary: [] as Array<{ id: string; label: string; mark: string; count?: number }> };
    const pending = (data.requests ?? []).filter((request) => pendingFor(request, data.user!.role, data.user!.id)).length;
    const personalPending = (data.requests ?? []).filter((request) => request.employee_id === data.user!.id && request.status === "pending").length;
    const vacation: Array<{ id: string; label: string; mark: string; count?: number }> = [{ id: "dashboard", label: "Vacation overview", mark: "•" }];
    vacation.push({ id: "new", label: "New request", mark: "+" }, { id: "requests", label: "My requests", mark: "•", count: personalPending });
    if (data.user.role === "employee") vacation.push({ id: "calendar", label: "My calendar", mark: "•" });
    else vacation.push({ id: "approvals", label: "Approval queue", mark: "•", count: pending }, { id: "calendar", label: "Team calendar", mark: "•" });
    if (data.user.role === "admin" && data.user.is_master_admin) vacation.push({ id: "tracker", label: "Salary tracker", mark: "•" });
    const primary: Array<{ id: string; label: string; mark: string; count?: number }> = data.user.role === "admin" || data.user.role === "payroll_admin" ? [
      ...(data.user.is_master_admin ? [{ id: "alerts", label: "Tasks & alerts", mark: "!", count: (data.personalReminders ?? []).filter((item) => item.status === "open").length }, { id: "workflows", label: "Workflows", mark: "↳", count: (data.workflows ?? []).filter((run) => run.status === "active").length }, { id: "reports", label: "Reports", mark: "▤" }] : []),
      { id: "people", label: "People & access", mark: "◎", count: (data.users ?? []).filter((user) => user.status === "pending").length },
      ...(data.user.role === "admin" ? [{ id: "approval-process", label: "Approval process", mark: "↳" }] : []),
      { id: "departments", label: "Departments", mark: "▦" },
      { id: "settings", label: "Settings", mark: "⚙" },
    ] : data.user.role === "manager" ? [{ id: "settings", label: "Settings", mark: "⚙" }] : [];
    return { vacation, primary };
  }, [data]);
  if (!data) return <div className="loading-screen"><BrandLogo /><span>{loadError ? "We couldn't connect to your workspace." : "Loading your workspace…"}</span>{loadError ? <button className="button button-primary" onClick={() => { setLoadError(false); void refresh().catch(() => setLoadError(true)); }}>Try again</button> : <span className="loading-spinner" aria-label="Loading" />}</div>;
  if (!data.user) return <><AuthScreen data={data} refresh={refresh} notify={notify} />{toast && <Toast {...toast} />}</>;
  if (data.user.status === "pending") return <><PendingScreen user={data.user} logout={logout} />{toast && <Toast {...toast} />}</>;
  if (data.user.status !== "active" && data.user.status !== "on_leave") return <><InactiveScreen user={data.user} logout={logout} />{toast && <Toast {...toast} />}</>;
  const companyName = data.settings?.company_name ?? "Sweets from the Earth";
  const vacationActive = navigation.vacation.some((item) => item.id === tab);
  const vacationPending = (data.requests ?? []).filter((request) => pendingFor(request, data.user!.role, data.user!.id)).length;
  const pageTitle = [...navigation.vacation, ...navigation.primary].find((item) => item.id === tab)?.label ?? "Workspace";
  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? "open" : ""}`}><div className="sidebar-brand"><BrandLogo /><span><strong>{companyName}</strong><small>People workspace</small></span><button className="mobile-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}>×</button></div><nav aria-label="Main navigation"><div className={`sidebar-group ${vacationOpen ? "open" : ""}`}><button className={`nav-parent ${vacationActive ? "active" : ""}`} onClick={() => setVacationOpen(!vacationOpen)} aria-expanded={vacationOpen}><span className="nav-mark"><NavIcon name="vacation" /></span>Vacation<span className="nav-end">{Boolean(vacationPending) && <b>{vacationPending}</b>}<i>{vacationOpen ? "⌃" : "⌄"}</i></span></button>{vacationOpen && <div className="sidebar-subnav">{navigation.vacation.map((item) => <button key={item.id} className={`nav-child ${tab === item.id ? "active" : ""}`} aria-current={tab === item.id ? "page" : undefined} onClick={() => { setTab(item.id); setMenuOpen(false); }}><span className="nav-mark"><NavIcon name={item.id} /></span>{item.label}{Boolean(item.count) && <b>{item.count}</b>}</button>)}</div>}</div>{navigation.primary.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => { setTab(item.id); setMenuOpen(false); }}><span className="nav-mark"><NavIcon name={item.id} /></span>{item.label}{Boolean(item.count) && <b>{item.count}</b>}</button>)}</nav><div className="sidebar-footer"><div className="user-card"><div className="avatar">{initials(data.user.full_name)}</div><span><strong>{data.user.full_name}</strong><small>{roleLabels[data.user.role]}</small></span></div><button className="signout-button" onClick={logout}>Sign out</button></div></aside>
    {menuOpen && <button className="menu-overlay" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
    <main className="main-area"><header className="workspace-header"><div className="workspace-heading"><button className="menu-toggle" onClick={() => setMenuOpen(true)} aria-label="Open navigation" aria-expanded={menuOpen}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><BrandLogo className="mobile-logo" /><span className="workspace-breadcrumb">SFTE People<span aria-hidden="true"> / </span></span><strong>{pageTitle}</strong></div><div className="workspace-account"><span className={`operation-status ${operations ? "is-saving" : ""}`} role="status" aria-live="polite">{operations > 0 && <><span className="loading-spinner" />Saving…</>}</span><span className="workspace-role">{roleLabels[data.user.role]}</span><div className="avatar small" title={data.user.full_name}>{initials(data.user.full_name)}</div></div></header>
      <div className="request-live-strip"><span className={liveStatus === "reconnecting" ? "reconnecting" : ""} role="status">{liveStatus === "reconnecting" ? "Updates temporarily unavailable · reconnecting…" : "Requests update automatically"}</span>{data.user.role !== "employee" && <button className="request-inbox-button" onClick={() => setTab("approvals")} aria-label={`${vacationPending} vacation requests awaiting approval`}><NavIcon name="alerts" />{vacationPending} pending request{vacationPending === 1 ? "" : "s"}</button>}</div>
      {tab === "dashboard" && <Dashboard data={data} setTab={setTab} refresh={refresh} notify={notify} />}
      {tab === "new" && <RequestForm user={data.user} balance={data.myVacationBalance} refresh={refresh} notify={notify} />}
      {tab === "requests" && <RequestsList title="My vacation requests" eyebrow="Request history" records={(data.requests ?? []).filter((record) => record.employee_id === data.user!.id)} user={data.user} refresh={refresh} notify={notify} companyName={companyName} emptyText="Your submitted requests will appear here." />}
      {tab === "approvals" && <ApprovalQueue data={data} refresh={refresh} notify={notify} />}
      {tab === "calendar" && <TeamCalendar data={data} refresh={refresh} notify={notify} />}
      {tab === "alerts" && data.user.is_master_admin === 1 && <NotificationsAdmin data={data} refresh={refresh} notify={notify} setTab={setTab} />}
      {tab === "workflows" && data.user.is_master_admin === 1 && <WorkflowCentre data={data} refresh={refresh} notify={notify} setTab={setTab} />}
      {tab === "tracker" && data.user.is_master_admin === 1 && <VacationTracker data={data} refresh={refresh} notify={notify} />}
      {tab === "reports" && data.user.is_master_admin === 1 && <ReportsAdmin data={data} />}
      {tab === "people" && <PeopleAdmin data={data} refresh={refresh} notify={notify} />}
      {tab === "departments" && <DepartmentsAdmin data={data} refresh={refresh} notify={notify} />}
      {tab === "approval-process" && data.user.role === "admin" && data.approvalMap && <ApprovalDesigner key={data.approvalMap.revision} people={data.users ?? []} departments={data.departments} document={data.approvalMap} notify={notify} onSave={async (graph, revision) => { await callApi("saveApprovalMap", { graph, revision }); await refresh(); notify("Approval process saved. Pending requests now follow this map."); }} />}
      {tab === "settings" && <SettingsAdmin data={data} refresh={refresh} notify={notify} />}
    </main>{toast && <Toast {...toast} />}
  </div>;
}
