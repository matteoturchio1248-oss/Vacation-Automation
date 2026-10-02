# Private GitHub handoff

Based on live source commit `4a71bad3805f9419c74f221fa828daa606d25cee`.
This export adds documentation, CI, source checks and local setup commands and
removes the original hosting project ID. This deployment copy adds setup/job authorization, removes page-triggered
reminder sweeps and hides manager contact details from unapproved visitors.
The dependency lockfile and immutable SQL migrations are preserved.

## Create and push

1. Create an empty **private** repository in the company-controlled GitHub account
   or organization, for example `sfte-hcm`. Do not initialize it with another
   README, license or ignore file.
2. Extract the archive and open a terminal in `sfte-hcm/`.
3. Run these commands, replacing the example URL with the repository URL:

```sh
git init -b main
git add .
node scripts/check-source.mjs
git diff --cached --stat
git commit -m "Import SFTE HCM source and developer handoff"
git remote add origin https://github.com/YOUR-ORGANIZATION/sfte-hcm.git
git push -u origin main
```

Use normal GitHub credential-manager or SSH authentication; never embed tokens
in URLs. Invite your developer individually with the permissions they need.
Review the first Actions run: local checks do not confirm a GitHub-hosted run.

## What this provides

Versioned source, review and automated build/type/lint/runtime checks. It does
not migrate the live database, grant employee access or deploy the company server.
There is no production deployment workflow. GitHub Pages is not suitable for
this application because it requires server APIs and database bindings.

Read `DEVELOPER-HANDOFF.md` before adapting the runtime. Coordinate cutover of
the current Site and payroll task with Matteo so old/new installations do not
send duplicate summaries.

## Excluded files

Original Git history/remotes, production data, sessions, credentials, database
state, dependencies, compiled output and the original hosting project ID.
Synthetic test accounts, the SFTE logo, bundled fonts, schema migrations and
package lockfile are included.
