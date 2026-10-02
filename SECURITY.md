# Security and private data

Keep this internal HCM repository private. Do not commit employee data, database
exports, sessions, passwords, API keys or Gmail relay secrets. Ignore rules and
the limited source check do not replace staged-file review or a full secret scan.

Report suspected vulnerabilities privately to the repository owner and company
IT. Do not post real employee records or credentials in issues, pull requests,
Actions output or screenshots. No public disclosure email is configured here.

## Current hosting assumptions

The live Site has an owner-private platform gate. That protection does not
accompany a clone or company-server deployment.

This standalone copy protects `/api/jobs/payroll-digest` GET/POST with a
`JOBS_SECRET` bearer credential and locks it if the secret is missing/short. Do
not reuse the original Site credential. The original Site is unchanged.

First-administrator registration now requires a matching private
`BOOTSTRAP_SECRET` (32+ characters). An atomic insert prevents concurrent setup
requests from creating multiple master administrators. Regular registrations
remain pending until HR approves access.
Revalidate role/team restrictions, self-approval protections, session handling
and transaction guarantees after porting the runtime/database.

Page loads do not run reminder sweeps in this copy. A scheduled hook is not
proof of an active scheduler, and this deployment enables no cron triggers. Configure credentials and transfer HR data separately. Saved
Gmail relay secrets currently live in database settings; review secret-manager
storage for the target environment.

See `docs/DEVELOPER-HANDOFF.md` for migration details. No independent security
audit or load benchmark is included.
