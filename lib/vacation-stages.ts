// Approval controls leave and balances; processing never changes that decision.
export type VacationStageRecord = { employee_id: number; status: string; employment_type: string; payroll_processed: number; hr_finalized: number; approver_user_id?: number | null };
export function isDecided(record: VacationStageRecord) { return record.status === "approved" || record.status === "rejected"; }
export function pendingFor(record: VacationStageRecord, role: string, userId: number) {
  if (role === "manager") return record.status === "pending" && record.employee_id !== userId && record.approver_user_id === userId;
  if (role === "employee") return record.status === "pending";
  if (role === "payroll_admin") return record.employment_type === "hourly" && isDecided(record) && !record.payroll_processed && !record.hr_finalized;
  return record.status === "pending" || (isDecided(record) && !record.hr_finalized);
}
export function processingLabel(record: VacationStageRecord) {
  if (record.status === "cancelled") return "Cancelled";
  if (record.status === "pending") return "Awaiting manager";
  if (record.hr_finalized) return "HR finalized";
  if (record.employment_type === "hourly" && !record.payroll_processed) return record.status === "rejected" ? "Awaiting payroll review · no payment" : "Awaiting payroll record";
  return "Awaiting HR sign-off";
}
