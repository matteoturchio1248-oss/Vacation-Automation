# SFTE HCM — developer handoff

Prepared for Matteo Turchio on October 2, 2026.
Base source snapshot: `4a71bad3805f9419c74f221fa828daa606d25cee`.
Current hosted URL: https://vacation-request-portal.matteoturchio1248.chatgpt.site

This standalone deployment copy adds setup/job authorization, Cloudflare
configuration and a fourth boundary test. The original hosted Site is unchanged.
See `CLOUDFLARE-DEPLOYMENT.md` for the new-host procedure.

## Goal and current status

Review this internal employee/HR portal and move it to a company-controlled secure
hosting environment. Preserve the current workflows and SFTE branding. This
package is a source-code handoff, not a completed migration or an assurance of
production security. The hosted preview currently has an owner-only platform
access gate; its link does not grant the developer access.

The code is a React/TypeScript application with Next-compatible routes, built by
**vinext/Vite for Cloudflare Workers**, using **Cloudflare D1 (SQLite)**. It is not
a conventional Node/Express server and cannot be copied unchanged onto an ordinary
company server. Decide the target architecture before choosing deployment commands.

## Repository contents

Application source is at the repository root. `docs/SCHEMA.sql` initializes an
empty local database only; `drizzle/` is the immutable migration history.
`wrangler.local.jsonc` configures local D1 bootstrap and is not a production
deployment configuration. `docs/CONFIGURATION.example.txt` documents binding
names without credentials. See `README.md` for setup and `docs/GITHUB.md` for
private GitHub publication.

No employee database, sessions, credentials, original Git history, dependencies
or built output is included. The source hosting project ID was removed; the
remaining Sites manifest declares the runtime bindings only.

## Local review with the current architecture

Use Linux or WSL with Node >=22.13.0, npm, Bash, curl, flock and GNU timeout.
The supplied scripts depend on Linux utilities. The current checks ran on Node
24.19.0. Preserve `package-lock.json`; run commands from the repository root:

```sh
npm ci
# Empty local database only; never point this command at production.
npm run db:init:local
cp .dev.vars.example .dev.vars
# Set a private BOOTSTRAP_SECRET (32+ characters) before creating the local admin.
npm run dev
```

The Vite Cloudflare plugin uses `.wrangler/state/v3` for its local binding state.
The bootstrap configuration has the same DB binding and placeholder database ID
as `vite.config.ts`. If your environment changes these, align both configurations
and the persistence directory. Initialize the first admin privately with synthetic
data. No notification provider is configured by this package.

Checks:

```sh
node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit --incremental false
npm run build
npm run test:built
```

Build output is a Worker under `dist/server/index.js` plus client assets. It
expects Cloudflare bindings. `npm run start`/`vinext start` is not evidence that
the existing backend is production-ready on a generic Node server. The runtime
test creates an isolated Miniflare D1 database; it does not send live emails.

## Functionality and role rules to preserve

- Employee files and separate optional portal access; people can exist without
  email/password/login. Search, department/status filters, compensation/contact
  fields, hire/leave/termination dates. Departments are referenced dynamically.
- Roles: Employee, Manager, Administrator, Payroll Admin, plus a master-admin
  flag. Active/on-leave accounts can sign in when access is enabled. Terminated
  and disabled accounts are blocked.
- Everyone with enabled portal access, including Managers and Payroll Admins,
  can submit their own vacation. Self-approval and self-rejection are blocked.
- Admin approval map: department/person boxes, one outgoing initial-approver
  route per source. A person box overrides the department, including an
  unconnected person box. No duplicate request rows or parallel department/person
  queues. HR fallback applies to unconnected/unavailable/self approvers.
- Saving a map reroutes pending requests; completed decisions remain unchanged.
  Revision checking plus transactional route replacement protects concurrent edits.
- Initial decision immediately updates employee history/calendar and salary
  balances, then downstream processing continues on that **same request**.
- **Hourly:** manager decides → Payroll saves a review/payment record → HR
  finalizes. Rejections and leave without requested pay receive review only.
- **Salaried:** manager decides → HR finalizes; no Payroll processing stage.
- Payroll Admin can record payroll but cannot make the initial vacation decision
  or perform HR finalization. Employment classification, not access role, selects
  hourly/salaried flow; new requests snapshot that classification.
- Team calendars and manager visibility remain scoped. HR has global oversight.
  Requests refresh by polling every five seconds while the page is visible;
  this is polling, not WebSockets. Each account can disable request alerts.
- Vacation overview has month/year overlap filters. Salary balances include
  negative balances and admin adjustments. Accrual is calculated on reads from
  an annual profile and credits the full current month, including the start month.
  Annual carryover/new-year profiles are **not automatic**. Approved deductions
  currently use the request start year; review cross-year leave handling.
- Private HR tasks/reminders; onboarding, return-to-work, probation, expiry and
  offboarding workflows. On-leave status with an expected return date starts or
  reschedules return-to-work tasks. Linked reminders synchronize with tasks.
- Workforce hires/departures/growth/leave/headcount/roster reporting; CSV and
  branded PDF exports, with charts where implemented. Historical report accuracy
  depends on completed lifecycle dates.
- The white approval canvas expands/minimizes and supports free panning, zoom
  and Reset view. Panning does not edit boxes, routes or employee data.

## Porting to a company server

The likely port is a company-managed application runtime plus a company-managed
database, private access boundary and background scheduler. The developer should
confirm the server OS, container support, database, URL, TLS, VPN/SSO requirements,
backup/restore process and outbound email policy with IT.

| Dependency | Current implementation | Required migration work |
| --- | --- | --- |
| App runtime | `vite.config.ts`, `worker/index.ts`, vinext Worker entry | Choose a supported server runtime; adapt Worker-specific bootstrapping/assets/image handling. Keep Next-compatible handlers where possible. |
| Database | `lib/database.ts`, `db/index.ts`, D1 `.prepare/.bind/.first/.all/.run/.batch` | Implement a server database adapter or refactor queries. Preserve `meta.changes`, inserted IDs, atomic claims and transaction behavior. SQLite syntax is not automatically portable to PostgreSQL/MySQL. |
| Background work | `cloudflare:workers` `waitUntil`, Worker `scheduled`, externally invoked job | Replace with a durable server queue/scheduler; work must survive the response and process restarts. |
| Runtime values | `globalThis.__VACATION_PORTAL_ENV__` set from Worker bindings | Supply application configuration safely in the new runtime. Merely creating a `.env` file does not implement this adapter. |
| Platform identity/gate | Sites owner-only dispatch; optional helpers in `app/chatgpt-auth.ts` | Replace with the company access boundary and any chosen SSO. No Sites token or account password is supplied. |
| Deployment metadata | `.openai/hosting.json`, `build/sites-vite-plugin.ts` | Treat as current-host references; replace deployment-specific wiring for the company target. Do not deploy into the original Site from this copy. |

Cloudflare-specific imports occur in `db/index.ts` and
`lib/notifications.ts`; `worker/index.ts` installs the DB/config binding and
exposes a scheduled hook without request-triggered reminder sweeps. Check all of these, not just the UI.

## Email and scheduled work

`lib/notifications.ts` supports Gmail Apps Script relay or Resend. Gmail runtime
values take precedence over the saved Gmail connection; saved Gmail is next,
then Resend. With no provider, notifications remain queued. `queued` is not proof
of delivery. The notification log keeps bodies/status/retry metadata; retries
are attempted by the reminder sweep, up to five attempts.

Configure a company-approved provider separately. If retaining the Gmail relay,
the developer needs the existing Apps Script project's authorized owner,
deployment URL and matching secret through an approved private channel. Neither
the secret nor the deployed relay is included in this source snapshot. The app
currently allows the relay secret to be stored in the database settings; evaluate
moving it into the new server's secret manager.

The original Site's payroll summary is invoked every five days at 9am Toronto time
by an external cloud task; this standalone copy enables no such schedule. Its endpoint is `/api/jobs/payroll-digest`: GET status,
POST `{}` to queue, GET to verify `lastRun.checkedAt`. It selects eligible Payroll
Admin emails and honors opt-outs, excludes paid/rejected/cancelled/salaried
requests, and applies an atomic five-day claim per recipient. Do not migrate the
old Sites service credential; provision new scheduler authorization instead.

This standalone copy requires `JOBS_SECRET` bearer authorization for both job
methods. The unchanged original Site still uses its owner-private dispatch
boundary. Do not point the old payroll automation at this new deployment.

In this copy, general reminder sweeps no longer run on page loads. The Worker
scheduled hook uses the configured HTTPS `APP_ORIGIN`. The deployment has no
cron triggers; add and verify a separate schedule only when required.

At cutover, coordinate the existing external payroll task with Matteo so that
old and new installations do not both send summaries. This handoff changes no
current jobs, credentials, access policy or production data.

## Data migration and security review

Schema is `db/schema.ts`; ordered immutable migrations are `drizzle/0000` through
`0008`, with `_journal.json`. `ensureDatabase()` seeds defaults; it does not
create the schema. Preserve IDs and references across users, departments,
requests, balances, approval routes, reminders, workflows and payroll records.
Preserve employment snapshots and completion flags. Export/import any live data
separately through an authorized encrypted channel; never attach the HR database
to ordinary email. For an existing database, use migrations matching its current
schema rather than the fresh-database `SCHEMA.sql`.

Before employee rollout, review these concrete boundaries:

1. Provision the first admin privately. On an empty database, first registration
   requires `BOOTSTRAP_SECRET` (32+ characters); the master-admin insert is atomic.
2. Revalidate every role/team permission and own-request restriction after the
   runtime/database port; UI visibility alone is not authorization.
3. Review authentication/CSRF/session controls for the new deployment. Current
   cookies are HttpOnly, SameSite=Lax and Secure in production, with a seven-day
   session. Passwords are salted PBKDF2; current password policy is only six
   characters plus a letter/number, with an account lock after failed logins.
4. Authenticate scheduled jobs and secure email secrets, TLS, backups and database
   access under company control. Revoke copied sessions during data cutover.

No capacity/load benchmark or independent security audit is supplied. The API
loads role-scoped collections rather than paginating all history; assess polling,
report generation, data retention and large datasets for the intended workforce.
Access removal currently substitutes placeholder account fields while retaining
the employee file/history; preserve this behavior during migration.

## Acceptance and rollout

Use synthetic data in staging first. Validate manager, admin, payroll and employee
self-service; individual-vs-department routing; hourly vs salaried flows; calendar
and balance changes; filters/reports/PDFs; RTW/reminder synchronization; scheduled
email delivery without a logged-in user; and unauthorized endpoint access.

Agree an export window, verify backup restoration, reconcile record counts and
balances, invalidate migrated sessions, switch URLs/providers/jobs once, and keep
a rollback path. The source is ready for review; target-server compatibility,
security approval and real-data migration remain developer/IT work.
