# Operational Guide: Shared AI Context Runtime (`ctx`)

This guide outlines production deployment, secret management, database maintenance, backup/restore, migration lifecycle, health monitoring, and incident response procedures.

---

## 1. Architecture Overview

```
 [AI Coding Clients: Claude Code / Cursor / Antigravity]
                           │
                 (STDIO / MCP Protocol)
                           │
                           ▼
                  [apps/mcp-server]
                           │
                     (HTTP / JSON)
                           ▼
            [apps/api (Fastify REST Gateway)]
            ├─ Auth & Tenant Middleware
            ├─ Token Budgeting & TOON Serializer
            └─ Advisory Lock Checkpoint Versioner
                           │
                 (PostgreSQL Connection Pool)
                           ▼
               [PostgreSQL 17.4 Database]
               ├─ schema_migrations (Ledger)
               ├─ projects (Multi-Tenant Org Index)
               ├─ checkpoints (Immutable History)
               ├─ tasks (Optimistic Locking)
               └─ agent_events (Audit Trail)
```

---

## 2. Environment Configuration & Secret Management

All sensitive secrets must be managed via environment variables (or Vault injectors). Never commit filled `.env` or credential files.

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `NODE_ENV` | **Yes** | `production` | Enforces non-ephemeral storage checks |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string (`postgresql://user:pass@host:5432/ctx_db`) |
| `CTX_AUTH_TOKEN` | Optional | — | Global master Bearer/API-key token for single-tenant mode |
| `CTX_AUTH_TOKENS` | Optional | — | Multi-tenant token mapping: `{"<token>": "<org_uuid>"}` |
| `PORT` | Optional | `3000` | HTTP listening port for `apps/api` |
| `HOST` | Optional | `0.0.0.0` | Bind host address |
| `ENABLE_RATE_LIMIT`| Optional | `true` | Enables sliding window rate limiting (100 req/min/IP) |

### Secret Rotation Procedure

1. **Zero-Downtime Token Rotation:**
   - In multi-tenant environments, append the new token to `CTX_AUTH_TOKENS` alongside the retiring token.
   - Update client adapters (`~/.ctx/config.json` or MCP settings) to use the new token.
   - Once traffic ceases on the old token, remove it from `CTX_AUTH_TOKENS` and restart `ctx-api`.
2. **Database Credential Rotation:**
   - Create new credentials in PostgreSQL with matching permissions.
   - Update `DATABASE_URL` in container orchestration (`docker compose` or Kubernetes Secret).
   - Perform a rolling restart (`docker compose up -d --no-deps ctx-api`).

---

## 3. Database Maintenance & Migration Lifecycle

### Running Migrations

Database schema versions are tracked deterministically in `schema_migrations`.

```bash
# Execute outstanding SQL migrations idempotently
npm run migrate

# Or with an explicit connection string:
DATABASE_URL="postgresql://user:pass@db:5432/ctx_db" node scripts/migrate.js
```

### Migration Failure Recovery

- Every migration runs inside a PostgreSQL transaction (`BEGIN ... COMMIT`).
- If any statement fails, the runner triggers an immediate `ROLLBACK`, logs the failed statement, and exits with code 1.
- No partial migration rows are written to `schema_migrations`.
- To resume: rectify the faulty SQL syntax or schema lock, and re-execute `npm run migrate`.

---

## 4. Backup & Disaster Recovery Procedures

### Automated Database Backup

```bash
# Full logical dump with schema and table data
pg_dump -h <host> -U postgres -d ctx_db -F c -b -v -f "/backups/ctx_db_$(date +%Y%m%d_%H%M%S).dump"
```

### Disaster Recovery & Restoration

To restore context state to a fresh or recovered PostgreSQL instance:

```bash
# 1. Ensure target database exists
createdb -h <host> -U postgres ctx_db

# 2. Restore schema, tables, and indexes from dump
pg_restore -h <host> -U postgres -d ctx_db -v "/backups/ctx_db_backup.dump"

# 3. Verify migration status
node scripts/migrate.js

# 4. Verify API health check transitions to 200 OK
curl -f http://127.0.0.1:3000/health
```

---

## 5. Health Probes & Monitoring

The API provides an unauthenticated `/health` endpoint designed for Kubernetes liveness and readiness probes.

### Health Check Behavior

- **HTTP 200 OK (`{"status":"ok"}`):**
  - PostgreSQL pool is reachable and executing active queries.
  - All database schema migrations are applied and up-to-date.
- **HTTP 503 Service Unavailable (`{"status":"unhealthy","error":"Database unavailable"}`):**
  - Database pool connectivity is broken or credentials rejected.
  - Internal database hosts, passwords, and connection traces are sanitized and never disclosed in the response.

### Recommended Docker / Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 5
readinessProbe:
  httpGet:
    path: /health
    port: 3000
  periodSeconds: 5
  timeoutSeconds: 3
```

---

## 6. Performance Benchmarks & SLA Thresholds

Verified on real multi-tenant concurrent HTTP network workloads:

| Metric | Measured Baseline | Production SLA Gate |
| :--- | :---: | :---: |
| **Throughput** | ~200 req/sec | $\ge 50$ req/sec |
| **p50 Latency** | 41.38 ms | $\le 80$ ms |
| **p95 Latency** | 131.15 ms | $\le 250$ ms |
| **p99 Latency** | 194.66 ms | $\le 300$ ms |
| **Error Rate** | 0.00% | $\le 0.1\%$ |
| **Advisory Version Collisions** | 0 collisions | 0 collisions |

---

## 7. Incident Response Playbook

### High 5xx Error Rate / Unhealthy Readiness
1. Check container logs: `docker compose logs --tail=100 ctx-api`.
2. Verify PostgreSQL container health: `docker compose ps postgres`.
3. Check database connection limits:
   ```sql
   SELECT count(*) FROM pg_stat_activity WHERE datname = 'ctx_db';
   ```
4. If connections are exhausted, verify `pg_advisory_xact_lock` transactions are releasing properly on commit.

### Client Checkpoint Collision (HTTP 409 Conflict)
1. HTTP 409 indicates an intentional optimistic concurrency lock rejection on tasks.
2. The calling client should fetch the latest task version via `GET /v1/tasks/:id` and retry with `expectedVersion: currentVersion`.
