# FeedbackOS V6.1

V6.1 adds a platform-level **Super Admin Launch Control Plane** for staged product releases.

## Super Admin
Set `SUPER_ADMIN_EMAILS` in `.env` to one or more comma-separated platform-owner emails. Run the migration, then sign in with that account.

The Super Admin can:
- Create and organize release phases
- Launch/pause phases with one click
- Require measurable benchmark gates before launch
- Force launch when a strategic decision overrides a gate
- Manage features and plan tiers per phase
- Create and publish launch campaigns
- Show live release announcements to workspace users

## Release philosophy
FeedbackOS is intentionally shipped in phases so product value can be revealed progressively: Foundation → Problem Intelligence → Customer/Product Intelligence → Executive/Automation → Operating System → SaaS/Security → AI Intelligence Lab.

The benchmark system supports users, active workspaces, feedback volume, paid workspaces and MRR. Revenue is stored on workspaces for launch-planning purposes; integrate billing later for authoritative financial data.

## Run
```bash
cd backend
npm install
npm run migrate
npm test
npm run dev
```
# FeedbackOS V5.9

FeedbackOS V5.9 is the Production SaaS Control Center release built on V5.4 RBAC, session security, and V5.3 tenant isolation.

## What changed

- Formal workspace roles: **admin, manager, member, integration**.
- Explicit RBAC permission matrix at `GET /api/security/rbac`.
- Managers can manage invitations and integrations; admins retain security, API-key, and member-role controls.
- Admins can change a member between admin/manager/member and suspend/reactivate members.
- Invitation lifecycle: revoke and resend pending invitations.
- Session security: last-seen tracking, IP/user-agent metadata, admin session list, and session revocation.
- Security control-plane summary: members, pending invitations, active sessions, and API-key status.
- New **Security & permissions** UI with RBAC matrix, sessions, security events, and tenant-isolation diagnostics.
- Upgrade-safe V5.4 migration adds invitation/session security columns and indexes.
- Built-in Node test suite (`npm test`) for RBAC, session controls, migration safety, and tenant-context wiring.
- Optional live DB smoke test (`npm run test:db`) validates required security tables against the configured MariaDB database.

## Important security model

Every authenticated API request receives a workspace context. V5.3's tenant-aware DB wrapper remains enabled in V5.4. RBAC is defense-in-depth: endpoint permissions are explicit and the database layer still scopes business-table access by workspace.

V5.4 does **not** claim that every historical service query has been formally proven safe against arbitrary SQL/subquery patterns. Run the two-workspace isolation test against the real database before production SaaS use.

## Run locally

```bash
cd backend
npm install
npm run migrate
npm test
npm run dev
```

Open `http://localhost:5000`.

For an existing V5.x database, **do not reset or recreate the database**. The migration is intended to upgrade the current schema in place.

## Live database smoke test

After configuring `backend/.env`:

```bash
cd backend
npm run migrate
npm run test:db
```

`test:db` checks that the identity/security tables exist and reports basic workspace/session/API-key state. It does not create test users or mutate production data.

## V5.9 control-plane test

V5.9 adds workspace switching, per-workspace settings/security policies, API-key scope validation, and CSV audit export. Run `npm run migrate`, `npm test`, then verify two workspaces can be switched only by users who belong to both. Admins can open Security & permissions to review policy and export audit history.

## V5.4 end-to-end test

1. Register Workspace A as an admin.
2. Create a manager invitation and a member invitation.
3. Accept one invitation and verify the member appears in the workspace.
4. Open **Security & permissions** and verify the role matrix.
5. Change a member role as admin; verify the new role appears after refresh.
6. Suspend a member and verify their active sessions are revoked.
7. Create an integration as admin/manager and test its connection.
8. Create an API key as admin and verify its secret is shown only once.
9. Ingest feedback using the API key and confirm it stays inside Workspace A.
10. Register Workspace B with a separate account.
11. Add feedback/problems to Workspace B.
12. Verify Workspace A cannot see or modify Workspace B data, and vice versa.
13. Verify a member cannot call admin-only security/member/API-key endpoints.
14. Verify a manager can manage invitations/integrations but cannot manage member roles or API keys.
15. Revoke an invitation and verify its token can no longer be accepted.
16. Resend an invitation and verify the old token is invalid and the new token works.
17. Revoke an API key and verify API-key ingestion fails afterward.
18. Run the admin tenant-isolation diagnostic and require `PASS` with zero unscoped rows.

## API additions

- `GET /api/security/rbac`
- `PATCH /api/workspace/members/:userId`
- `POST /api/workspace/invitations/:id/revoke`
- `POST /api/workspace/invitations/:id/resend`
- `GET /api/security/sessions`
- `DELETE /api/security/sessions/:id`
- `GET /api/security/control-plane`
- Existing V5.3 endpoint retained: `GET /api/security/tenant-isolation`

## Notes

Invitation email delivery is still intentionally not included in this MVP. Invite endpoints return a token/URL for controlled testing. Production email delivery can be added later through a transactional email provider.


## V5.9 — Observability & SaaS Operations
V5.9 adds an operational control plane: database health checks, API latency/error metrics, ingestion monitoring, job-run tracking, health snapshots, and a manager/admin Operations Center API. All operational records are workspace-scoped.

Run `npm test` for local security/control-plane tests. Run `npm run migrate` before starting the server. `GET /api/ops/status`, `/api/ops/metrics`, `/api/ops/jobs`, and `/api/ops/ingestion` require manager/admin access.


## V5.9 Data Quality Center
Run `npm run migrate` then `npm test`. Managers/Admins can open Data Quality, run scans, resolve flags, and explicitly retry missing AI classifications.


## V5.9 — AI Evaluation & Quality Lab
Adds governed AI runs, structured-output validation, confidence tracking, token/cost accounting, AI policy controls, auditable human overrides, and an AI Governance dashboard.


## V5.9 AI Quality Lab
Golden datasets, evaluation runs, field-level accuracy, model/prompt comparisons, baseline tracking, and regression detection are available under **AI Quality Lab**. Evaluation runs require `OPENAI_API_KEY` and intentionally use real model calls, so run them against a small curated dataset first.


## V6.0 — Intelligent Feedback Learning Loop
Human-reviewed AI corrections are aggregated into measurable learning signals and candidate correction patterns. Candidate patterns require Manager/Admin approval; no prompt or production AI behavior is changed automatically.

## V6.4 — Product Launch OS

V6.2 adds the commercial launch-control layer: product plans, feature flags, plan entitlements, workspace feature overrides, roadmap, waitlist, upgrade prompts and conversion telemetry. Super Admins can keep production features disabled until the intended release phase is live, package capabilities into plans, capture demand before launch, and measure upgrade intent/completion.

Upgrade with the existing `.env` and database:

```bash
cd FeedbackOS-V6.2-build/backend
npm install
npm run migrate
npm test
npm run dev
```

Super Admins get **Product Launch OS** in the platform navigation. Normal workspace users do not.


## V6.3 Launch Experience
Customer-facing release journey: teaser, early access, beta, launch, waitlist capture and release telemetry. Super Admin controls launch experiences and beta access.


## V6.4
Launch Analytics & Growth Intelligence: demand funnel, benchmark progress, growth recommendations, phase/feature performance, and immutable analytics snapshots.

## V6.6 Monetization & Upgrade Intelligence

Adds subscriptions, billing events, upgrade intents, revenue attribution, pricing experiment storage, customer billing visibility, and a Super Admin Revenue Command Center. Payment processing remains provider-neutral; no card is charged by the built-in manual subscription controls.

## V6.7 — Retention, Churn & Expansion Intelligence

V6.7 turns customer feedback into directional retention signals. It adds customer health scoring, churn-risk and expansion cohorts, revenue-at-risk estimation, negative-feedback reason analysis, retention snapshots, and a workspace Retention & Churn command center.

### Retention APIs
- `GET /api/retention/overview?days=90`
- `POST /api/retention/snapshot`
- `GET /api/retention/snapshots`
- `GET /api/superadmin/retention?days=90`

Health is based on product feedback behavior (negative rate, recurrence, unresolved problems, severity and positive signals). It is a directional product-health model, not a guaranteed prediction of customer cancellation.
