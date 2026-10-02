import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";

test("public setup locks without configuration, is atomic, and leaves new employees pending", async () => {
  const common = {
    modules: true,
    scriptPath: new URL("../dist/server/index.js", import.meta.url).pathname,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "isolated-public-setup-test" },
  };
  const setupCode = "Synthetic-only-code-for-public-setup-tests";
  const mf = new Miniflare(common);
  try {
    let db = await mf.getD1Database("DB");
    const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    for (const entry of journal.entries) {
      const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
      for (const statement of sql.split("--> statement-breakpoint").filter((part) => part.trim())) await db.prepare(statement.trim()).run();
    }
    async function register(email, extra = {}) {
      return mf.dispatchFetch("http://localhost/api/app", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "register", fullName: "Synthetic test account", email, password: "LocalTest1234", ...extra }),
      });
    }
    assert.equal((await register("setup@example.invalid", { setupCode })).status, 403);
    assert.equal((await mf.dispatchFetch("http://localhost/api/jobs/payroll-digest", { method: "POST", headers: { Authorization: `Bearer ${setupCode}` } })).status, 401);
    await mf.setOptions({ ...common, bindings: { BOOTSTRAP_SECRET: setupCode } });
    db = await mf.getD1Database("DB");
    const office = await db.prepare("SELECT id FROM departments WHERE name = 'Office'").first();
    const concurrent = await Promise.all([
      register("first@example.invalid", { setupCode, departmentId: office.id }),
      register("second@example.invalid", { setupCode, departmentId: office.id }),
    ]);
    assert.ok(concurrent.every((response) => [200, 409].includes(response.status)));
    assert.ok(concurrent.some((response) => response.status === 200));
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_master_admin = 1").first()).count, 1);
    await db.prepare("UPDATE departments SET manager_user_id = (SELECT id FROM users WHERE is_master_admin = 1) WHERE id = ?").bind(office.id).run();
    const anonymous = await (await mf.dispatchFetch("http://localhost/api/app")).json();
    assert.ok(anonymous.departments.every((department) => !Object.hasOwn(department, "manager_email") && !Object.hasOwn(department, "manager_name") && !Object.hasOwn(department, "manager_user_id")));
    const pending = await register("pending@example.invalid", { departmentId: office.id });
    assert.equal(pending.status, 200);
    const employee = await db.prepare("SELECT role, status, is_master_admin FROM users WHERE email = 'pending@example.invalid'").first();
    assert.deepEqual(employee, { role: "employee", status: "pending", is_master_admin: 0 });
    const cookie = pending.headers.get("set-cookie").split(";")[0];
    const pendingView = await (await mf.dispatchFetch("http://localhost/api/app", { headers: { cookie } })).json();
    assert.equal(pendingView.user.status, "pending");
    assert.equal(pendingView.users, undefined);
    assert.equal(pendingView.requests, undefined);
    assert.ok(pendingView.departments.every((department) => !Object.hasOwn(department, "manager_email")));
    const denied = await mf.dispatchFetch("http://localhost/api/app", {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ action: "createRequest", startDate: "2099-12-01", endDate: "2099-12-02", totalDays: 2, acknowledged: true }),
    });
    assert.equal(denied.status, 401);
    const before = await db.prepare("SELECT COUNT(*) AS count FROM notification_log").first();
    await mf.dispatchFetch("http://localhost/api/app");
    const after = await db.prepare("SELECT COUNT(*) AS count FROM notification_log").first();
    assert.equal(after.count, before.count);
  } finally {
    await mf.dispose();
  }
});
