import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const departments = sqliteTable("departments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  managerUserId: integer("manager_user_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  role: text("role", { enum: ["employee", "manager", "admin", "payroll_admin"] }).notNull().default("employee"),
  status: text("status", { enum: ["pending", "active", "on_leave", "terminated", "disabled", "deleted"] }).notNull().default("pending"),
  employmentType: text("employment_type", { enum: ["hourly", "salaried"] }).notNull().default("hourly"),
  workSchedule: text("work_schedule", { enum: ["full_time", "part_time"] }),
  hireDate: text("hire_date"),
  terminationDate: text("termination_date"),
  leaveStartDate: text("leave_start_date"),
  leaveEndDate: text("leave_end_date"),
  jobTitle: text("job_title"),
  compensationAmountCents: integer("compensation_amount_cents"),
  compensationFrequency: text("compensation_frequency", { enum: ["hourly", "annual"] }),
  phone: text("phone"),
  workLocation: text("work_location"),
  employeeNotes: text("employee_notes"),
  hasPortalAccess: integer("has_portal_access", { mode: "boolean" }).notNull().default(true),
  isMasterAdmin: integer("is_master_admin", { mode: "boolean" }).notNull().default(false),
  departmentId: integer("department_id").references(() => departments.id),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: text("locked_until"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const vacationAccrualProfiles = sqliteTable("vacation_accrual_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  vacationYear: integer("vacation_year").notNull(),
  monthlyRate: real("monthly_rate").notNull().default(0),
  openingBalance: real("opening_balance").notNull().default(0),
  accrualStartDate: text("accrual_start_date"),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("accrual_profile_user_year_idx").on(table.userId, table.vacationYear)]);

export const vacationBalanceAdjustments = sqliteTable("vacation_balance_adjustments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  vacationYear: integer("vacation_year").notNull(),
  amountDays: real("amount_days").notNull(),
  effectiveDate: text("effective_date").notNull(),
  note: text("note").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const vacationRequests = sqliteTable("vacation_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employeeId: integer("employee_id").notNull().references(() => users.id),
  departmentId: integer("department_id").notNull().references(() => departments.id),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  totalDays: text("total_days").notNull(),
  vacationPayRequested: integer("vacation_pay_requested", { mode: "boolean" }).notNull().default(false),
  vacationPayAmountCents: integer("vacation_pay_amount_cents"),
  employeeNotes: text("employee_notes"),
  employeeAcknowledgedAt: text("employee_acknowledged_at").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "cancelled"] }).notNull().default("pending"),
  decisionBy: integer("decision_by").references(() => users.id),
  decisionNotes: text("decision_notes"),
  decidedAt: text("decided_at"),
  payrollProcessed: integer("payroll_processed", { mode: "boolean" }).notNull().default(false),
  payrollDate: text("payroll_date"),
  payrollAmountPaidCents: integer("payroll_amount_paid_cents"),
  employmentTypeSnapshot: text("employment_type_snapshot", { enum: ["hourly", "salaried"] }),
  hrFinalized: integer("hr_finalized", { mode: "boolean" }).notNull().default(false),
  hrFinalizedBy: integer("hr_finalized_by").references(() => users.id),
  hrFinalizedAt: text("hr_finalized_at"),
  payrollSavedBy: integer("payroll_saved_by").references(() => users.id),
  payrollSavedAt: text("payroll_saved_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastReminderAt: text("last_reminder_at"),
  reminderCount: integer("reminder_count").notNull().default(0),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const approvalMaps = sqliteTable("approval_maps", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  graphJson: text("graph_json").notNull(),
  writeToken: text("write_token").notNull(),
  updatedBy: integer("updated_by").notNull().references(() => users.id),
  updatedAt: text("updated_at").notNull(),
});

export const approvalRoutes = sqliteTable("approval_routes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mapId: text("map_id").notNull().references(() => approvalMaps.id),
  sourceKind: text("source_kind", { enum: ["person", "department"] }).notNull(),
  sourceId: integer("source_id").notNull(),
  targetKind: text("target_kind", { enum: ["person", "department"] }),
  targetId: integer("target_id"),
}, (table) => [uniqueIndex("approval_route_source_idx").on(table.mapId, table.sourceKind, table.sourceId)]);

export const notificationLog = sqliteTable("notification_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: integer("request_id").references(() => vacationRequests.id),
  recipients: text("recipients").notNull(),
  subject: text("subject").notNull(),
  status: text("status").notNull(),
  detail: text("detail"),
  htmlBody: text("html_body"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: text("last_attempt_at"),
  createdAt: text("created_at").notNull(),
});

export const personalReminders = sqliteTable("personal_reminders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull().references(() => users.id),
  relatedEmployeeId: integer("related_employee_id").references(() => users.id),
  title: text("title").notNull(),
  details: text("details"),
  category: text("category").notNull().default("custom"),
  priority: text("priority", { enum: ["normal", "high"] }).notNull().default("normal"),
  dueDate: text("due_date").notNull(),
  status: text("status", { enum: ["open", "done"] }).notNull().default("open"),
  sourceType: text("source_type"),
  sourceId: integer("source_id"),
  completedAt: text("completed_at"),
  lastNotifiedAt: text("last_notified_at"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("reminder_source_owner_idx").on(table.ownerUserId, table.sourceType, table.sourceId)]);

export const workflowRuns = sqliteTable("workflow_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workflowType: text("workflow_type", { enum: ["onboarding", "return_to_work", "probation_review", "document_expiry", "offboarding"] }).notNull(),
  employeeId: integer("employee_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  targetDate: text("target_date").notNull(),
  status: text("status", { enum: ["active", "completed", "cancelled"] }).notNull().default("active"),
  startedBy: integer("started_by").notNull().references(() => users.id),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
});

export const workflowTasks = sqliteTable("workflow_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull().references(() => workflowRuns.id),
  title: text("title").notNull(),
  details: text("details"),
  branchLabel: text("branch_label"),
  sortOrder: integer("sort_order").notNull(),
  dueDate: text("due_date").notNull(),
  status: text("status", { enum: ["pending", "completed", "skipped"] }).notNull().default("pending"),
  completedBy: integer("completed_by").references(() => users.id),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
});
