# SFTE HCM

Internal employee, vacation and HR operations portal for Sweets from the Earth.
Keep this repository **private** and invite authorized developers individually.

## Capabilities

- Employee files, optional portal access, departments and lifecycle dates.
- Employee, Manager, Administrator and Payroll Admin workspaces.
- Vacation requests, approval routing, team calendars and salaried balances.
- Hourly Payroll/HR processing and salaried HR finalization on the same request.
- Workflows, linked reminders and automatic return-to-work tasks.
- Workforce reports, CSV exports and branded PDF reports with charts.
- Responsive SFTE interface and a freely pannable approval canvas.

See [application behavior](docs/FEATURES.md) for detailed role and workflow rules.

## Architecture

TypeScript / React with Next-compatible routes, **vinext + Vite**, Cloudflare
Workers and D1 (SQLite), with Drizzle migrations. Dependencies are pinned in
`package-lock.json`.

This is the current application source, **not a finished company-server port**.
A generic Node server requires runtime, database and scheduler adaptations
explained in the [developer handoff](docs/DEVELOPER-HANDOFF.md).

## Local setup

Use Linux or WSL, Node 24 (see `.nvmrc`), npm, Bash and GNU `timeout`.
The existing engine minimum is 22.13.0; the prepared checks use Node 24.

```sh
npm ci
npm run db:init:local
cp .dev.vars.example .dev.vars
# Set a private BOOTSTRAP_SECRET of at least 32 characters in .dev.vars.
npm run dev
```

`db:init:local` applies tracked D1 migrations to the local database. It is safe to repeat;
applied migrations are recorded. Never use this command for production data migration.
Vite and local Wrangler share the `DB` placeholder binding and `.wrangler/state`
persistence directory. Use the development URL printed by Vite. Create the first
administrator privately with synthetic data.

No email provider is configured. Binding names are documented in
[configuration](docs/CONFIGURATION.example.txt) and `.env.example`. The app reads
Worker bindings: creating `.env` alone does not implement a server adapter.

## Validation

```sh
npm run check:source
npm run typecheck
npm run lint
npm test
```

`npm test` builds once, validates the Worker artifact and runs all four
test files. `npm run test:built` checks an already built artifact. Runtime tests
use disposable databases and synthetic accounts; they do not send live email.
GitHub Actions runs these checks on pushes and pull requests with read-only
repository permissions, no production secrets and no deployment step. Cloudflare deployment is configured separately.

The source check detects selected credential patterns and private runtime files;
it is not a comprehensive secret scanner or security audit. Successful tests do
not certify production security or establish capacity limits.

## Repository layout

| Path | Purpose |
| --- | --- |
| `app/` | UI, styles and API routes |
| `lib/` | Database, sessions, approvals, notifications and HR logic |
| `worker/` | Current Cloudflare runtime entrypoint |
| `db/`, `drizzle/` | Schema and immutable migrations |
| `public/`, `.vinext/fonts/` | Logo, assets and vendored fonts |
| `scripts/`, `tests/` | Build, source checks and existing tests |
| `docs/` | Developer and GitHub handoff notes |
| `.github/` | CI and review template |

`.openai/hosting.json` retains binding declarations for the build. The original
deployment project ID was removed from this copy. This repository has no automatic
connection to the live Site and does not include its Git history.

## Before company rollout

Read [SECURITY.md](SECURITY.md) and the developer handoff. Payroll jobs require the private `JOBS_SECRET` bearer credential; first-admin
setup requires `BOOTSTRAP_SECRET`. Revalidate role/team restrictions,
and configure HTTPS, backups, actual scheduling and email separately. Transfer
employee data and credentials through an approved private channel.

Salary accrual uses saved annual profiles; new-year profiles and carryover are not
automatic. Page loads do not trigger reminder sweeps in this copy. No automatic
reminder schedule is enabled by the deployment configuration.

## Deploy the GitHub repository

Follow [Cloudflare deployment](docs/CLOUDFLARE-DEPLOYMENT.md) to configure the
new database, secrets, build and live link. The extracted application source is available in
`matteoturchio1248-oss/Vacation-Automation`. Hosting still requires a new D1
database, runtime secrets and deployment setup.

## Put it on GitHub

Follow [docs/GITHUB.md](docs/GITHUB.md) to create a private repository and push
this source. The archive has no `.git` directory, credential or GitHub remote.
GitHub Pages cannot host this database-backed application.

No open-source license is granted by this handoff. Third-party dependencies and
assets retain their own licenses; review redistribution rights before sharing
outside the company.
