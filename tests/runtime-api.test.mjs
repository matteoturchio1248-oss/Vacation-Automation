import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";

test("production worker preserves access controls and durably queues reminders", async () => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: new URL("../dist/server/index.js", import.meta.url).pathname,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "isolated-hcm-test" },
    bindings: { BOOTSTRAP_SECRET: "Synthetic-only-bootstrap-code-for-tests", JOBS_SECRET: "Synthetic-only-job-code-for-runtime-tests" },
  });
  try {
    const db = await mf.getD1Database("DB");
    const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    for (const entry of journal.entries) {
      const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
      for (const statement of sql.split("--> statement-breakpoint").filter((part) => part.trim())) {
        await db.prepare(statement.trim()).run();
      }
    }
    let cookie = "";
    async function request(body, view = "") {
      const response = await mf.dispatchFetch(`http://localhost/api/app${view}`, body ? {
        method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body),
      } : { headers: { cookie } });
      const text = await response.text();
      const result = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
      return { response, result };
    }
    const initial = await request();
    assert.equal(initial.response.status, 200);
    assert.equal(initial.result.needsSetup, true);
    assert.equal(initial.result.user, null);
    const setupBody = { action: "register", fullName: "QA Administrator", email: "admin@example.invalid", password: "LocalTest1234" };
    assert.equal((await request(setupBody)).response.status, 403);
    assert.equal((await request({ ...setupBody, setupCode: "incorrect" })).response.status, 403);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM users").first()).count, 0);
    const registration = await request({ ...setupBody, setupCode: "Synthetic-only-bootstrap-code-for-tests" });
    assert.equal(registration.response.status, 200);
    cookie = registration.response.headers.get("set-cookie").split(";")[0];
    await db.prepare("UPDATE settings SET value = 'admin@example.invalid' WHERE key = 'personal_reminder_email'").run();
    const reminder = await request({ action: "createReminder", title: "Isolated QA reminder", dueDate: "2099-12-01", category: "custom" });
    assert.equal(reminder.response.status, 200);
    assert.equal(reminder.result.notification, "queued");
    const row = await db.prepare("SELECT title FROM personal_reminders WHERE title = ?").bind("Isolated QA reminder").first();
    assert.equal(row.title, "Isolated QA reminder");
    const log = await db.prepare("SELECT status, html_body FROM notification_log WHERE subject LIKE '%Isolated QA reminder%' ORDER BY id DESC LIMIT 1").first();
    assert.equal(log.status, "queued");
    assert.ok(log.html_body);
    const dashboard = await request();
    assert.equal(dashboard.response.status, 200);
    assert.equal(dashboard.result.user.is_master_admin, 1);
    assert.ok(dashboard.result.notifications.every((entry) => !("html_body" in entry)));
    const adminCookie = cookie;
    const office = await db.prepare("SELECT id FROM departments WHERE name = 'Office'").first();
    const warehouse = await db.prepare("SELECT id FROM departments WHERE name = 'Warehouse'").first();
    async function addPerson(name, email, role, departmentId, employmentType) {
      const result = await db.prepare(`INSERT INTO users (full_name, email, password_hash, password_salt, role, status,
        employment_type, department_id, created_at, updated_at)
        SELECT ?, ?, password_hash, password_salt, ?, 'active', ?, ?, created_at, updated_at FROM users WHERE id = 1 RETURNING id`)
        .bind(name, email, role, employmentType, departmentId).first();
      return result.id;
    }
    const managerId = await addPerson("Office manager", "manager@example.invalid", "manager", office.id, "hourly");
    const otherManagerId = await addPerson("Warehouse manager", "other-manager@example.invalid", "manager", warehouse.id, "hourly");
    const employeeId = await addPerson("Salaried employee", "salary@example.invalid", "employee", office.id, "salaried");
    const hourlyId = await addPerson("Hourly employee", "hourly@example.invalid", "employee", warehouse.id, "hourly");
    await db.prepare("UPDATE departments SET manager_user_id = ? WHERE id = ?").bind(managerId, office.id).run();
    await db.prepare("UPDATE departments SET manager_user_id = ? WHERE id = ?").bind(otherManagerId, warehouse.id).run();
    const year = new Date().getFullYear();
    await db.prepare(`INSERT INTO vacation_accrual_profiles (user_id, vacation_year, monthly_rate, opening_balance, updated_at)
      VALUES (?, ?, 0, 20, ?)`).bind(employeeId, year, new Date().toISOString()).run();
    async function login(email) { const result = await request({ action: "login", email, password: "LocalTest1234" }); assert.equal(result.response.status, 200); cookie = result.response.headers.get("set-cookie").split(";")[0]; }
    await login("salary@example.invalid");
    const personal = await request();
    assert.equal(personal.result.myVacationBalance.availableDays, 20);
    assert.equal(personal.result.myVacationBalance.configured, true);
    assert.equal(personal.result.users, undefined);
    assert.equal(personal.result.tracker, undefined);
    assert.equal(personal.result.vacationPeople, undefined);
    const submitted = await request({ action: "createRequest", startDate: `${year}-12-01`, endDate: `${year}-12-03`, totalDays: 3, acknowledged: true });
    assert.equal(submitted.response.status, 200);
    const firstMail = await db.prepare("SELECT recipients FROM notification_log WHERE request_id = ?").bind(submitted.result.id).first();
    assert.match(firstMail.recipients, /manager@example\.invalid/);
    assert.match(firstMail.recipients, /admin@example\.invalid/);
    assert.doesNotMatch(firstMail.recipients, /other-manager/);
    await login("manager@example.invalid");
    const managerView = await request(undefined, "?view=live");
    assert.deepEqual(managerView.result.departments.map((department) => department.id), [office.id]);
    assert.ok(managerView.result.vacationPeople.some((person) => person.id === employeeId));
    assert.ok(managerView.result.vacationPeople.every((person) => person.department_id === office.id));
    assert.equal(managerView.result.myVacationBalance, undefined);
    assert.equal(managerView.result.users, undefined);
    assert.ok(managerView.result.requests.some((record) => record.id === submitted.result.id));
    await request({ action: "saveRequestAlerts", inApp: false, email: false });
    const optedOut = await request(undefined, "?view=live");
    assert.deepEqual(optedOut.result.requestAlerts, { inApp: false, email: false });
    const approved = await request({ action: "decideRequest", requestId: submitted.result.id, decision: "approved" });
    assert.equal(approved.response.status, 200);
    await login("salary@example.invalid");
    assert.equal((await request(undefined, "?view=live")).result.myVacationBalance.availableDays, 17);
    cookie = adminCookie;
    await request({ action: "saveRequestAlerts", inApp: false, email: false });
    await login("salary@example.invalid");
    const second = await request({ action: "createRequest", startDate: `${year}-12-08`, endDate: `${year}-12-09`, totalDays: 2, acknowledged: true });
    const mutedMail = await db.prepare("SELECT recipients FROM notification_log WHERE request_id = ?").bind(second.result.id).first();
    assert.doesNotMatch(mutedMail.recipients, /manager@example\.invalid|admin@example\.invalid/);
    await login("other-manager@example.invalid");
    assert.ok((await request(undefined, "?view=live")).result.requests.every((record) => record.department_id === warehouse.id));
    const denied = await request({ action: "decideRequest", requestId: second.result.id, decision: "approved" });
    assert.equal(denied.response.status, 403);
    await login("hourly@example.invalid");
    const hourly = await request(undefined, "?view=live");
    assert.equal(hourly.result.user.id, hourlyId);
    assert.equal(hourly.result.myVacationBalance, undefined);
    cookie = adminCookie;
    const adminLive = await request(undefined, "?view=live");
    assert.ok(adminLive.result.requests.some((record) => record.id === second.result.id));
    assert.deepEqual(adminLive.result.requestAlerts, { inApp: false, email: false });

    // Salary: manager decision controls leave immediately; only HR closes it.
    const payrollId = await addPerson("Payroll accountant", "payroll@example.invalid", "payroll_admin", office.id, "hourly");
    await login("payroll@example.invalid");
    const payrollView = await request();
    assert.equal(payrollView.result.user.role, "payroll_admin");
    assert.ok(payrollView.result.users.some((person) => person.id === hourlyId));
    assert.equal(payrollView.result.tracker, undefined);
    assert.equal((await request({ action: "finalizeRequest", requestId: submitted.result.id })).response.status, 403);
    assert.equal((await request({ action: "updatePayroll", requestId: submitted.result.id, payrollProcessed: true })).response.status, 400);
    cookie = adminCookie;
    assert.equal((await request({ action: "finalizeRequest", requestId: submitted.result.id })).response.status, 200);
    assert.equal((await request({ action: "finalizeRequest", requestId: submitted.result.id })).response.status, 409);
    const salaryFinal = await db.prepare("SELECT status, hr_finalized, payroll_processed FROM vacation_requests WHERE id = ?").bind(submitted.result.id).first();
    assert.deepEqual(salaryFinal, { status: "approved", hr_finalized: 1, payroll_processed: 0 });

    // Hourly: wait for a real payroll record; snapshot survives profile edits.
    await login("hourly@example.invalid");
    const payout = await request({ action: "createRequest", startDate: `${year}-12-15`, endDate: `${year}-12-16`, totalDays: 2, vacationPayRequested: true, vacationPayAmount: 350, acknowledged: true });
    assert.equal(payout.response.status, 200);
    const payoutId = payout.result.id;
    await login("payroll@example.invalid");
    assert.equal((await request({ action: "updatePayroll", requestId: payoutId, payrollProcessed: true, payrollDate: `${year}-12-01`, payrollAmount: 350 })).response.status, 400);
    assert.equal((await request({ action: "decideRequest", requestId: payoutId, decision: "approved" })).response.status, 403);
    await login("other-manager@example.invalid");
    assert.equal((await request({ action: "decideRequest", requestId: payoutId, decision: "approved" })).response.status, 200);
    assert.equal((await request({ action: "decideRequest", requestId: payoutId, decision: "rejected" })).response.status, 400);
    const payoutMail = await db.prepare("SELECT recipients FROM notification_log WHERE request_id = ? AND subject LIKE 'Vacation pay ready%' ").bind(payoutId).first();
    assert.equal(payoutMail.recipients, "payroll@example.invalid");
    await db.prepare("UPDATE users SET employment_type = 'salaried' WHERE id = ?").bind(hourlyId).run();
    cookie = adminCookie;
    const hourlyApproved = (await request(undefined, "?view=live")).result.requests.find((record) => record.id === payoutId);
    assert.equal(hourlyApproved.status, "approved");
    assert.equal(hourlyApproved.employment_type, "hourly");
    assert.equal(hourlyApproved.hr_finalized, 0);
    assert.equal((await request({ action: "finalizeRequest", requestId: payoutId })).response.status, 409);

    // Unattended job: queue once, verify persistence and suppress duplicates.
    for (const method of ["GET", "POST"]) {
      assert.equal((await mf.dispatchFetch("http://localhost/api/jobs/payroll-digest", { method })).status, 401);
      assert.equal((await mf.dispatchFetch("http://localhost/api/jobs/payroll-digest", { method, headers: { Authorization: "Bearer incorrect" } })).status, 401);
    }
    async function job(method) { const response = await mf.dispatchFetch("http://localhost/api/jobs/payroll-digest", { method, headers: { Authorization: "Bearer Synthetic-only-job-code-for-runtime-tests" } }); return { response, result: await response.json() }; }
    const firstDigest = await job("POST");
    assert.equal(firstDigest.response.status, 200);
    assert.equal(firstDigest.result.pendingPayouts, 1);
    assert.equal(firstDigest.result.queued, 1);
    const digestReadback = await job("GET");
    assert.equal(digestReadback.result.lastRun.checkedAt, firstDigest.result.checkedAt);
    assert.equal((await job("POST")).result.queued, 0);
    await db.prepare("UPDATE settings SET value = '2000-01-01T00:00:00.000Z' WHERE key = 'payroll_digest_last_queued_payroll@example.invalid'").run();
    assert.equal((await job("POST")).result.queued, 1);
    await login("payroll@example.invalid");
    assert.equal((await request({ action: "updatePayroll", requestId: payoutId, payrollProcessed: true })).response.status, 400);
    assert.equal((await request({ action: "updatePayroll", requestId: payoutId, payrollProcessed: true, payrollDate: "2026-02-30", payrollAmount: 350 })).response.status, 400);
    assert.equal((await request({ action: "updatePayroll", requestId: payoutId, payrollProcessed: true, payrollDate: `${year}-12-01`, payrollAmount: 350 })).response.status, 200);
    assert.equal((await job("POST")).result.pendingPayouts, 0);
    cookie = adminCookie;
    assert.equal((await request({ action: "finalizeRequest", requestId: payoutId })).response.status, 200);
    const payoutFinal = await db.prepare("SELECT status, hr_finalized, payroll_saved_by, payroll_amount_paid_cents FROM vacation_requests WHERE id = ?").bind(payoutId).first();
    assert.deepEqual(payoutFinal, { status: "approved", hr_finalized: 1, payroll_saved_by: payrollId, payroll_amount_paid_cents: 35000 });
    await login("payroll@example.invalid");
    assert.equal((await request({ action: "updatePayroll", requestId: payoutId, payrollProcessed: false })).response.status, 409);

    // Rejection is retained as rejection; the hourly review never pays it.
    await db.prepare("UPDATE users SET employment_type = 'hourly' WHERE id = ?").bind(hourlyId).run();
    await login("hourly@example.invalid");
    const declined = await request({ action: "createRequest", startDate: `${year}-12-20`, endDate: `${year}-12-21`, totalDays: 2, vacationPayRequested: true, vacationPayAmount: 100, acknowledged: true });
    await login("other-manager@example.invalid");
    await request({ action: "decideRequest", requestId: declined.result.id, decision: "rejected" });
    await login("payroll@example.invalid");
    assert.equal((await request({ action: "updatePayroll", requestId: declined.result.id, payrollProcessed: true, payrollAmount: 100 })).response.status, 400);
    assert.equal((await request({ action: "updatePayroll", requestId: declined.result.id, payrollProcessed: true, payrollAmount: 0 })).response.status, 200);
    cookie = adminCookie;
    assert.equal((await request({ action: "finalizeRequest", requestId: declined.result.id })).response.status, 200);
    assert.equal((await db.prepare("SELECT status FROM vacation_requests WHERE id = ?").bind(declined.result.id).first()).status, "rejected");
    assert.equal((await job("GET")).result.pendingPayouts, 0);
    await login("salary@example.invalid");
    assert.equal((await request(undefined, "?view=live")).result.myVacationBalance.availableDays, 17);

    // Manager and Payroll Admin self-service uses their own employment record.
    await db.prepare("UPDATE users SET employment_type = 'salaried' WHERE id = ?").bind(managerId).run();
    await db.prepare(`INSERT INTO vacation_accrual_profiles (user_id, vacation_year, monthly_rate, opening_balance, updated_at)
      VALUES (?, ?, 0, 20, ?)`).bind(managerId, year, new Date().toISOString()).run();
    await login("manager@example.invalid");
    await request({ action: "saveRequestAlerts", inApp: true, email: true });
    assert.equal((await request()).result.myVacationBalance.availableDays, 20);
    const managerVacation = await request({ action: "createRequest", employeeId, startDate: `${year}-11-02`, endDate: `${year}-11-03`, totalDays: 2, acknowledged: true });
    assert.equal(managerVacation.response.status, 200);
    const managerRecord = await db.prepare("SELECT employee_id, employment_type_snapshot, status FROM vacation_requests WHERE id = ?").bind(managerVacation.result.id).first();
    assert.deepEqual(managerRecord, { employee_id: managerId, employment_type_snapshot: "salaried", status: "pending" });
    const managerRouting = await db.prepare("SELECT recipients FROM notification_log WHERE request_id = ?").bind(managerVacation.result.id).first();
    assert.match(managerRouting.recipients, /hr@sweetsfromtheearth\.com/);
    assert.doesNotMatch(managerRouting.recipients, /manager@example\.invalid/);
    for (const decision of ["approved", "rejected"]) {
      assert.equal((await request({ action: "decideRequest", requestId: managerVacation.result.id, decision })).response.status, 403);
    }
    assert.equal((await request(undefined, "?view=live")).result.requests.find((record) => record.id === managerVacation.result.id).status, "pending");
    cookie = adminCookie;
    assert.equal((await request({ action: "decideRequest", requestId: managerVacation.result.id, decision: "approved" })).response.status, 200);
    assert.equal((await request({ action: "finalizeRequest", requestId: managerVacation.result.id })).response.status, 200);
    // Moving teams must preserve personal history without opening the old team.
    await db.prepare("UPDATE users SET department_id = ? WHERE id = ?").bind(warehouse.id, managerId).run();
    await db.prepare("UPDATE departments SET manager_user_id = NULL WHERE id = ?").bind(office.id).run();
    await login("manager@example.invalid");
    const reassigned = (await request(undefined, "?view=live")).result;
    assert.equal(reassigned.myVacationBalance.availableDays, 18);
    assert.ok(reassigned.requests.some((record) => record.id === managerVacation.result.id));
    assert.ok(reassigned.requests.every((record) => record.department_id === warehouse.id || record.employee_id === managerId));
    assert.ok(reassigned.vacationPeople.every((person) => person.department_id === warehouse.id));
    await db.prepare("UPDATE users SET department_id = ? WHERE id = ?").bind(office.id, managerId).run();
    await db.prepare("UPDATE departments SET manager_user_id = ? WHERE id = ?").bind(managerId, office.id).run();

    await login("payroll@example.invalid");
    assert.equal((await request()).result.myVacationBalance, undefined);
    const payrollVacation = await request({ action: "createRequest", startDate: `${year}-11-09`, endDate: `${year}-11-10`, totalDays: 2, vacationPayRequested: true, vacationPayAmount: 200, acknowledged: true });
    assert.equal(payrollVacation.response.status, 200);
    const ownPayroll = (await request(undefined, "?view=live")).result.requests.find((record) => record.id === payrollVacation.result.id);
    assert.equal(ownPayroll.employee_id, payrollId);
    assert.equal(ownPayroll.vacation_pay_requested, 1);
    assert.equal((await request({ action: "cancelRequest", requestId: second.result.id })).response.status, 403);
    assert.equal((await request({ action: "cancelRequest", requestId: payrollVacation.result.id })).response.status, 200);

    // A salaried Payroll Admin follows the salary flow, not the hourly role flow.
    await db.prepare("UPDATE users SET employment_type = 'salaried' WHERE id = ?").bind(payrollId).run();
    await db.prepare(`INSERT INTO vacation_accrual_profiles (user_id, vacation_year, monthly_rate, opening_balance, updated_at)
      VALUES (?, ?, 0, 10, ?)`).bind(payrollId, year, new Date().toISOString()).run();
    const payrollSalary = await request({ action: "createRequest", startDate: `${year}-11-16`, endDate: `${year}-11-17`, totalDays: 2, vacationPayRequested: true, vacationPayAmount: 200, acknowledged: true });
    assert.equal(payrollSalary.response.status, 200);
    assert.equal((await db.prepare("SELECT vacation_pay_requested FROM vacation_requests WHERE id = ?").bind(payrollSalary.result.id).first()).vacation_pay_requested, 0);
    await login("manager@example.invalid");
    assert.equal((await request({ action: "decideRequest", requestId: payrollSalary.result.id, decision: "approved" })).response.status, 200);
    await login("payroll@example.invalid");
    assert.equal((await request()).result.myVacationBalance.availableDays, 8);
    assert.equal((await request({ action: "updatePayroll", requestId: payrollSalary.result.id, payrollProcessed: true })).response.status, 400);
    cookie = adminCookie;
    assert.equal((await request({ action: "finalizeRequest", requestId: payrollSalary.result.id })).response.status, 200);

    // One mapped route per request, with person overrides and atomic admin edits.
    const node = (kind, entityId, x = 40, y = 40) => ({ id: `${kind}:${entityId}`, kind, entityId, x, y });
    const graph = {
      nodes: [node("department", office.id), node("person", managerId, 430), node("person", otherManagerId, 820), node("person", employeeId, 40, 240)],
      edges: [{ from: `department:${office.id}`, to: `person:${managerId}` }, { from: `person:${employeeId}`, to: `person:${otherManagerId}` }],
    };
    const initialMap = (await request()).result.approvalMap;
    assert.equal(initialMap.revision, 0);
    await login("payroll@example.invalid");
    assert.equal((await request()).result.approvalMap, undefined);
    assert.equal((await request({ action: "saveApprovalMap", graph, revision: 0 })).response.status, 403);
    await login("manager@example.invalid");
    assert.equal((await request({ action: "saveApprovalMap", graph, revision: 0 })).response.status, 403);
    await login("salary@example.invalid");
    assert.equal((await request({ action: "saveApprovalMap", graph, revision: 0 })).response.status, 403);
    cookie = adminCookie;
    const mapped = await request({ action: "saveApprovalMap", graph, revision: 0 });
    assert.equal(mapped.response.status, 200);
    assert.equal(mapped.result.approvalMap.revision, 1);
    assert.equal((await request()).result.approvalMap.revision, 1);
    assert.equal((await request({ action: "saveApprovalMap", graph, revision: 0 })).response.status, 409);
    const invalidGraphs = [
      { ...graph, nodes: [...graph.nodes, graph.nodes[0]] },
      { ...graph, edges: [...graph.edges, { from: `person:${employeeId}`, to: `person:${managerId}` }] },
      { ...graph, edges: [...graph.edges, { from: `person:${managerId}`, to: `department:${office.id}` }] },
      { ...graph, edges: [{ from: `department:${office.id}`, to: `person:${employeeId}` }] },
      { ...graph, edges: [...graph.edges, { from: `person:${otherManagerId}`, to: `person:${managerId}` }, { from: `person:${managerId}`, to: `person:${otherManagerId}` }] },
    ];
    for (const invalid of invalidGraphs) assert.equal((await request({ action: "saveApprovalMap", graph: invalid, revision: 1 })).response.status, 400);
    assert.equal((await db.prepare("SELECT revision FROM approval_maps WHERE id = 'vacation'").first()).revision, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM approval_routes WHERE map_id = 'vacation'").first()).count, graph.nodes.length);

    await login("manager@example.invalid");
    const oldQueue = (await request(undefined, "?view=live")).result.requests;
    assert.equal(oldQueue.find((record) => record.id === second.result.id).approver_user_id, otherManagerId);
    assert.equal((await request({ action: "decideRequest", requestId: second.result.id, decision: "approved" })).response.status, 403);
    await login("other-manager@example.invalid");
    const exceptionView = (await request(undefined, "?view=live")).result;
    assert.equal(exceptionView.requests.filter((record) => record.id === second.result.id).length, 1);
    assert.equal(exceptionView.requests.find((record) => record.id === second.result.id).approval_route, "Individual");
    assert.ok(exceptionView.departments.some((department) => department.id === office.id));
    assert.ok(exceptionView.vacationPeople.some((person) => person.id === employeeId));
    await login("salary@example.invalid");
    const exceptionRequest = await request({ action: "createRequest", startDate: `${year}-12-24`, endDate: `${year}-12-24`, totalDays: 1, acknowledged: true });
    assert.equal(exceptionRequest.response.status, 200);
    const exceptionMail = await db.prepare("SELECT recipients FROM notification_log WHERE request_id = ?").bind(exceptionRequest.result.id).first();
    assert.match(exceptionMail.recipients, /other-manager@example\.invalid/);
    assert.doesNotMatch(exceptionMail.recipients, /(?:^|,)manager@example\.invalid/);
    cookie = adminCookie;
    const allMapped = (await request()).result.requests;
    assert.equal(allMapped.filter((record) => record.id === exceptionRequest.result.id).length, 1);
    assert.equal(allMapped.find((record) => record.id === payrollSalary.result.id).approver_user_id, managerId);

    // Department targets use their current eligible manager.
    const departmentTarget = { ...graph, nodes: [...graph.nodes, node("department", warehouse.id, 820, 240)],
      edges: [graph.edges[0], { from: `person:${employeeId}`, to: `department:${warehouse.id}` }] };
    assert.equal((await request({ action: "saveApprovalMap", graph: departmentTarget, revision: 1 })).response.status, 200);
    assert.equal((await request()).result.requests.find((record) => record.id === second.result.id).approver_user_id, otherManagerId);

    // A pulled-out person with no line falls back to HR, never their old department.
    const unconnected = { ...departmentTarget, edges: [graph.edges[0]] };
    assert.equal((await request({ action: "saveApprovalMap", graph: unconnected, revision: 2 })).response.status, 200);
    assert.equal((await request()).result.requests.find((record) => record.id === second.result.id).approver_user_id, null);
    await login("manager@example.invalid");
    assert.equal((await request({ action: "decideRequest", requestId: second.result.id, decision: "approved" })).response.status, 403);
    await login("other-manager@example.invalid");
    assert.equal((await request({ action: "decideRequest", requestId: second.result.id, decision: "approved" })).response.status, 403);
    cookie = adminCookie;

    // Simultaneous saves share an expected revision: exactly one wins.
    const contenders = [graph, { ...graph, nodes: graph.nodes.map((entry) => ({ ...entry, x: entry.x + 20 })) }];
    const saves = await Promise.all(contenders.map(async (candidate) => {
      const response = await mf.dispatchFetch("http://localhost/api/app", { method: "POST", headers: { "Content-Type": "application/json", cookie: adminCookie },
        body: JSON.stringify({ action: "saveApprovalMap", graph: candidate, revision: 3 }) });
      return { status: response.status, result: await response.json() };
    }));
    assert.deepEqual(saves.map((save) => save.status).sort(), [200, 409]);
    const winner = saves.find((save) => save.status === 200).result.approvalMap;
    assert.deepEqual((await request()).result.approvalMap, winner);
    assert.equal(winner.revision, 4);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM approval_routes WHERE map_id = 'vacation'").first()).count, graph.nodes.length);
    await login("other-manager@example.invalid");
    assert.equal((await request({ action: "decideRequest", requestId: second.result.id, decision: "approved" })).response.status, 200);
    const mappedDecision = await db.prepare("SELECT status, decision_by, hr_finalized FROM vacation_requests WHERE id = ?").bind(second.result.id).first();
    assert.deepEqual(mappedDecision, { status: "approved", decision_by: otherManagerId, hr_finalized: 0 });
    await login("salary@example.invalid");
    assert.equal((await request()).result.myVacationBalance.availableDays, 15);
    cookie = adminCookie;
    assert.equal((await request({ action: "finalizeRequest", requestId: second.result.id })).response.status, 200);
    // Completed decisions remain untouched by later route changes.
    assert.equal((await request({ action: "saveApprovalMap", graph: unconnected, revision: 4 })).response.status, 200);
    assert.equal((await db.prepare("SELECT status FROM vacation_requests WHERE id = ?").bind(second.result.id).first()).status, "approved");
    cookie = "";
    const anonymous = await request();
    assert.equal(anonymous.result.user, null);
    assert.equal(anonymous.result.users, undefined);
    const forbidden = await request({ action: "createReminder", title: "Not allowed", dueDate: "2099-12-01" });
    assert.equal(forbidden.response.status, 401);
  } finally {
    await mf.dispose();
  }
});
