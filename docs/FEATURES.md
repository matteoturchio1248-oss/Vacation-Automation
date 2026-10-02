# Application behavior



HR administrators can open **Approval process**, add department or person boxes,
drag box headers, and use Connect to assign an initial approver.
Expand canvas opens the large white map area to nearly the full screen;
Minimize canvas restores its normal size without dropping edits. Click and drag
empty canvas space to pan freely in any direction without scroll boundaries.
Panning translates the view without changing boxes or routes and does not rerender
the graph on every pointer move. Focus the canvas and use arrow keys to pan;
Reset view (or Home) returns to the starting view. Zoom keeps the viewport centre.
Individual boxes retain their original fixed size and Connect/Details controls.
Connections can target an active Manager/Administrator with portal access or a
department whose assigned manager meets those requirements. Save activates the
map. Payroll Admins, managers and employees cannot change it.

A person box always overrides its department, including when it is unconnected.
An unconnected box, unavailable approver or self-approval falls back to HR.
Departments omitted from the map retain their traditional manager assignment.
Each source has at most one outgoing connection; duplicate boxes, branches,
self-approval and circular connections are rejected. Department membership
previews exclude individually mapped people.

The map determines one initial decision, not a serial chain of manager decisions.
An approver's outgoing line determines their own vacation route. Existing hourly
Payroll/HR and salaried HR stages remain unchanged. Saving reroutes pending
requests, notifications and pending reminders without duplicating request rows;
completed decisions, balances, calendars and processing stay on the same record.
Team visibility remains available, but only the assigned manager may decide a
pending request. HR administrators retain oversight and cannot self-approve.

`approval_maps` stores the graph and revision; `approval_routes` has a unique
index on map/source kind/source ID. A transaction and write-token guards apply
the revision update and route replacement atomically. Stale concurrent saves
return 409 without changing the winning graph or its routes.

Vacation overview defaults to the current month/year. Department and individual
request lists filter by overlapping leave dates; All months shows one selected
year, never all-time history. Cross-month/year leave appears in each overlapping
period as the same full request, without splitting or prorating its booked days.

Salary accrual is calculated on reads from the saved annual profile: opening
balance + monthly rate × inclusive months from the configured start month through
the current month + adjustments − approved days. The full current month is
credited at its start. Past years count through December; future years accrue
zero. Each year needs its own profile; annual rollover is not automatic.

## Vacation processing and payroll digest

Every active portal role can submit their own vacation under New request and
read/cancel their own pending requests under My requests. Managers retain their
own history after a department reassignment without gaining access to other
employees in their former department. A manager's own pending request is excluded
from their review queue. The decision endpoint blocks self-approval/rejection for
all approvers; when the requester is the assigned department manager, initial
notifications and pending reminders route to HR/admins instead of that manager.
Hourly/salaried rules depend on employment classification, not access role.

Manager approval/rejection is `vacation_requests.status`; approved leave appears
in history, the calendar and salaried balances immediately. Hourly requests then
require a saved payroll review before HR finalizes the same record. Rejected
hourly requests and hourly leave without requested pay receive review only,
never a payment. Salaried requests bypass payroll and go directly to HR.
New requests snapshot employment classification so later profile edits do not
switch an existing request's processing workflow. Legacy requests use the
employee's recorded classification. Existing decisions/payroll data are retained;
the new HR completion flag starts open until HR reviews them.

Payroll Admin mirrors the ordinary administrator's workspace and employee/access
management. It cannot decide vacation, edit approved vacation or finalize HR
sign-off, and it has no master-administrator tools. Notifications select active
or on-leave Payroll Admin accounts with enabled portal access, using their saved
account email and respecting their email notification preference. No accountant
account is invented automatically.

The standalone job endpoint is `/api/jobs/payroll-digest`. GET and POST require
`Authorization: Bearer <JOBS_SECRET>`; missing or incorrect credentials return
401 before querying or queueing. This copy is not controlled by the original
owner-private Site's service credential or payroll automation.

GET returns counts and last-run metadata. POST queues eligible approved hourly
vacation-pay summaries with an atomic five-day guard per opted-in Payroll Admin.
Empty lists queue no email. Queued means persisted, not delivered. No new job
schedule or email provider is enabled by this deployment package.
