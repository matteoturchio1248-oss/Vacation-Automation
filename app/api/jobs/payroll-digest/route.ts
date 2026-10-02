import { payrollDigestStatus, runPayrollDigest } from "../../../../lib/payroll-reminders";
import { jobAuthorized } from "../../../../lib/service-access";

export const dynamic = "force-dynamic";
function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
export async function GET(request: Request) {
  if (!(await jobAuthorized(request))) return unauthorized();
  return Response.json(await payrollDigestStatus(), { headers: { "Cache-Control": "private, no-store" } });
}
export async function POST(request: Request) {
  if (!(await jobAuthorized(request))) return unauthorized();
  try {
    return Response.json({ ok: true, ...await runPayrollDigest(new URL(request.url).origin) });
  } catch {
    return Response.json({ error: "Payroll digest could not be queued. The next scheduled run can retry." }, { status: 500 });
  }
}
