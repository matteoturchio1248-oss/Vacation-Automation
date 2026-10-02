# Publish Vacation-Automation from GitHub

This is a tested standalone deployment source, not a confirmed live deployment.
Target repository: https://github.com/matteoturchio1248-oss/Vacation-Automation
The uploaded repository contents have not yet been verified from this session.
Compare before replacing files; preserve any subsequent developer changes.

## 1. Put the source files in the repository

The chosen project directory must contain `package.json`, `vite.config.ts`,
`wrangler.jsonc`, `app/` and `drizzle/` as actual files, not only a ZIP attachment.
If the repository contains a folder around these files, use that folder as the
Cloudflare build root. Keep the repository private; the live application can
still offer public registration with HR approval.

## 2. Create a separate database

Sign in to the company/user-controlled Cloudflare account and create a new D1
database named `sfte-hcm-demo`. Copy its UUID. This is a database identifier, not
an API credential. Do not use the original hosted Site's database.

Either replace the placeholder `database_id` in `wrangler.jsonc` with this UUID,
or set `SFTE_D1_DATABASE_ID` as a Cloudflare build variable. Vite incorporates it
into `dist/server/wrangler.json`; the deploy script refuses the placeholder ID.

## 3. Connect the repository to Workers

In Cloudflare, open **Workers & Pages → Create application → Import a
repository**, authorize GitHub access to this repository, and select it.
Use these settings:

| Setting | Value |
| --- | --- |
| Worker name | `vacation-automation` (must match the config) |
| Production branch | The branch containing the source; verify rather than assume |
| Root directory | Directory containing `package.json` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Node version | Node 24 (`.nvmrc` is included) |
| Build database ID | `SFTE_D1_DATABASE_ID`, if not set in the checked-in config |

The Worker is separate from the original Sites deployment. It serves compiled
client assets and API routes and is configured for a `workers.dev` address.

## 4. Initialize the new database once

From a checkout of this source with Node/npm installed and Cloudflare CLI access
to the same account, use the newly created database ID, then:

```sh
npm ci
npx wrangler login
npm run build
node scripts/deploy-cloudflare.mjs --check
npx wrangler d1 migrations apply DB --config dist/server/wrangler.json --remote
```

If using the build variable instead of committing the database ID, supply it to
the local build too. The generated config must contain the new database's real
ID before running the remote migration command. D1 migrations record which
files are applied and do not replay them. The fresh `docs/SCHEMA.sql` is a
reference; do not apply it in addition to tracked migrations.

No employee data or admin account is supplied. Before sharing the link, verify
the database migration and administrator setup both completed.

## 5. Configure private runtime setup

In the Worker's **Settings → Variables & Secrets**, add a private
`BOOTSTRAP_SECRET` with at least 32 random characters. Use a separate
`JOBS_SECRET` if the payroll job endpoint will be used. These are runtime secrets,
not build variables or GitHub source. Do not paste them into chat or screenshots.

Open the deployed application, create your administrator account, and enter the
same private setup code in the setup form. Without it, first-admin registration
is rejected. After successful setup, remove `BOOTSTRAP_SECRET` if desired; normal
employee registrations do not need it. Keep your account password separate.

## 6. Verify and share

Confirm the actual deployment URL works, the logo/assets load, you can sign in,
and a second test registration stays pending. Approve access in **People &
Access → Access**. Verify an unapproved account cannot submit vacation or read
HR records. Then share the verified URL or make its QR code.

Use synthetic information for demonstrations. A full security/capacity review
remains necessary before real HR rollout. The current password policy is still
six characters with a letter and number; review it for company requirements.

## Email and scheduling

No email provider or cron trigger is enabled by this package. Opening/logging
into the site does not start reminder sweeps. Manual/workflow notifications can
be queued, but queuing is not delivery. Configure the approved Gmail/Resend
connection separately when real delivery is wanted.

If later configuring reminders, set HTTPS `APP_ORIGIN` to the verified new URL
and wire the Worker scheduled hook. The protected payroll endpoint accepts
`Authorization: Bearer <JOBS_SECRET>`; coordinate any new schedule with the old
Site's payroll task to avoid duplicate emails. The old task is not modified.

## Official references

- [Connect GitHub to Workers](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Workers build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [D1 migration tracking](https://developers.cloudflare.com/d1/reference/migrations/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
