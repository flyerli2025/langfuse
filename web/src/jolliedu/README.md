# jolliedu — self-built (non-EE) admin API

A license-compliant, self-hosted admin surface for programmatically managing
organizations, projects, API keys, audit logs, and data deletion — **without an
Enterprise (EE) license**.

Langfuse's packaged admin API (`/api/admin/*`, `/api/public/projects` POST,
etc.) is gated behind the EE `admin-api` entitlement, which requires
`LANGFUSE_EE_LICENSE_KEY`. This module reimplements the same operations over the
**MIT core** primitives, authenticated by a single static bearer token.

## Compliance boundary

Langfuse's license is split by directory (see repo-root `/LICENSE`):

- `ee/`, `web/src/ee/`, `worker/src/ee/` → Enterprise License.
- Everything else (`packages/shared/**`, `web/src/features/**`, Prisma models,
  RBAC) → MIT.

This module lives entirely outside the EE directories and only calls MIT
primitives:

- `prisma.organization.create` / `prisma.project.create` — MIT Prisma models.
- `createAndAddApiKeysToDb` — `@langfuse/shared/src/server/auth/apiKeys` (MIT).
- `prisma.auditLog.findMany/count` — same query shape as the MIT
  `web/src/server/api/routers/auditLogs.ts` (the EE audit-log-viewer is only a
  React table wrapper, not the query).
- `ProjectDeleteQueue`, `traceDeletionProcessor` —
  `@langfuse/shared/src/server` (MIT).

It does **not** copy EE-directory code, and it does **not** bypass the EE
license gate. Authentication is an independent implementation (not the EE
`AdminApiAuthService`).

## Layout

```
web/src/jolliedu/
├── auth.ts                       shared static-token gate (used by all features)
├── admin/                        org / project / apiKey management
│   ├── organizations.ts
│   ├── projects.ts
│   └── apiKeys.ts
├── audit-log/
│   └── auditLogs.ts              read-only audit log listing
└── data-deletion/
    ├── projectDeletion.ts        soft-delete project + enqueue hard-delete
    └── traceDeletion.ts          enqueue trace deletion

web/src/pages/api/jolliedu/       thin Pages Router shims (re-export handlers)
├── admin/organizations/index.ts
├── admin/organizations/[orgId]/projects/index.ts
├── admin/projects/[projectId]/apiKeys/index.ts
├── audit-log/index.ts
└── data-deletion/projects/[projectId]/{index,traces/index}.ts
```

Pages Router requires route files under `pages/api/`, so each URL is a one-line
shim that re-exports its handler from `web/src/jolliedu/*`.

## Configuration

The API is **disabled unless** `SELF_ADMIN_API_KEY` is set (fail-closed → 503).
It is a server-only env var declared in `web/src/env.mjs`.

```bash
# generate a strong token
openssl rand -hex 32
```

### Local dev

```bash
# put the token in the repo-root .env (web loads ../.env)
echo "SELF_ADMIN_API_KEY=<token>" >> .env
# env is validated at startup — (re)start the processes
pnpm run dev:web      # HTTP endpoints
pnpm run dev:worker   # required for data-deletion queue consumers
```

Env changes require a restart (validated at boot). New route files and handler
edits hot-reload in dev.

### Self-hosted containers (docker-compose)

The default `docker-compose.yml` pulls **prebuilt** official images, which do
**not** contain this code. The compose file has been adjusted so `langfuse-web`
and `langfuse-worker` build from this source tree (an `image:` + `build:` pair)
and the web service passes `SELF_ADMIN_API_KEY` into the container.

```bash
# 1. token in the .env next to docker-compose.yml (compose substitutes ${VAR})
echo "SELF_ADMIN_API_KEY=$(openssl rand -hex 32)" >> .env

# 2. build from source and start
docker compose up --build -d

# 3. verify the value reached the container
docker compose exec langfuse-web printenv SELF_ADMIN_API_KEY
```

After changing any `jolliedu/*` code, rebuild: `docker compose up --build -d`
(production images are static — no hot reload). Changing only the token value
needs `docker compose up -d` (recreates the container, no image rebuild).

> A `404` from an endpoint means the running image predates this code (rebuild).
> A `401`/`503` means the code is live.

## Endpoints

All requests send `Authorization: Bearer $SELF_ADMIN_API_KEY`. Base URL below is
`http://localhost:3000`.

| Method | Path                                                             | Purpose                                 |
| ------ | ---------------------------------------------------------------- | --------------------------------------- |
| POST   | `/api/jolliedu/admin/organizations`                              | create org                              |
| GET    | `/api/jolliedu/admin/organizations`                              | list orgs                               |
| POST   | `/api/jolliedu/admin/organizations/{orgId}/projects`             | create project                          |
| GET    | `/api/jolliedu/admin/organizations/{orgId}/projects`             | list projects                           |
| POST   | `/api/jolliedu/admin/projects/{projectId}/apiKeys`               | mint project key (secret returned once) |
| GET    | `/api/jolliedu/admin/projects/{projectId}/apiKeys`               | list keys (masked)                      |
| GET    | `/api/jolliedu/audit-log?orgId=&projectId=&page=&limit=`         | list audit logs                         |
| DELETE | `/api/jolliedu/data-deletion/projects/{projectId}?confirm=true`  | delete project (async)                  |
| POST   | `/api/jolliedu/data-deletion/projects/{projectId}/traces`        | delete traces (body `{traceIds:[]}`)    |
| DELETE | `/api/jolliedu/data-deletion/organizations/{orgId}?confirm=true` | delete org (all projects must be gone)  |

## End-to-end flow

```bash
export TOKEN="$SELF_ADMIN_API_KEY"
export BASE="http://localhost:3000"

# 1. create an organization
#    Pass "ownerEmail" to attach an existing user as OWNER so the org shows in
#    their UI; omit it for a headless org (invisible until a member is added).
ORG=$(curl -s "$BASE/api/jolliedu/admin/organizations" -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"My Org","ownerEmail":"you@example.com"}')
ORG_ID=$(echo "$ORG" | jq -r .id)

# 2. create a project in that org
PROJECT=$(curl -s "$BASE/api/jolliedu/admin/organizations/$ORG_ID/projects" -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"My Project"}')
PROJECT_ID=$(echo "$PROJECT" | jq -r .id)

# 3. mint a project-scoped ingestion key (secret shown ONCE — save it)
KEY=$(curl -s "$BASE/api/jolliedu/admin/projects/$PROJECT_ID/apiKeys" -X POST \
  -H "Authorization: Bearer $TOKEN")
PK=$(echo "$KEY" | jq -r .publicKey)   # pk-lf-...
SK=$(echo "$KEY" | jq -r .secretKey)   # sk-lf-...

# 4. send a trace — routed to this project purely by the key (Basic auth)
curl -s "$BASE/api/public/ingestion" -X POST \
  -u "$PK:$SK" -H "Content-Type: application/json" \
  -d '{"batch":[{"id":"'$(uuidgen)'","type":"trace-create","timestamp":"'$(date -u +%FT%TZ)'","body":{"id":"'$(uuidgen)'","name":"hello"}}]}'

# 5. read audit logs for the project
curl -s "$BASE/api/jolliedu/audit-log?projectId=$PROJECT_ID" \
  -H "Authorization: Bearer $TOKEN"

# 6. delete specific traces (async; worker purges ClickHouse/S3)
curl -s "$BASE/api/jolliedu/data-deletion/projects/$PROJECT_ID/traces" -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"traceIds":["<traceId>"]}'

# 7. delete the whole project (async hard-delete; confirm guard required)
curl -s "$BASE/api/jolliedu/data-deletion/projects/$PROJECT_ID?confirm=true" -X DELETE \
  -H "Authorization: Bearer $TOKEN"
```

Traces/events are always scoped to a project **by the API key**, never by a
request-body field. Each project needs its own key pair; org-scoped keys are
rejected by ingestion.

## Notes / known gaps

- **Ingestion is per-project.** A project needs its own `pk`/`sk`; org keys
  cannot ingest.
- **Deletion is async.** Project/trace deletion enqueues jobs; the running
  `langfuse-worker` purges ClickHouse/S3. Responses return `202`.
- **Org visibility needs a member.** A static token has no creator user, so
  orgs are headless (invisible in the UI) unless you pass `ownerEmail` on
  create to attach an existing user as OWNER.
- **Org deletion requires all projects gone first.** `DELETE
/organizations/{orgId}` mirrors the MIT `organization.delete`: it refuses
  (`409`) while any project row exists (including soft-deleted ones still being
  hard-deleted), then deletes the org and relies on Prisma cascade.
- These endpoints have **no RBAC** — a single static token is all-or-nothing.
  Keep `SELF_ADMIN_API_KEY` secret and rotate it if leaked.
