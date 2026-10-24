# Shared AI Context Runtime — Detailed Implementation Plan

**Working name:** `ctx`  
**Document type:** Product and technical implementation plan  
**Status:** Proposed architecture  
**Version:** 1.0

---

## 1. Executive Summary

Build `ctx`, a cross-client, cross-account, and cross-device shared context runtime for AI coding agents. A developer should be able to work in one AI tool, switch to another tool or account, and resume from the latest verified project state with a command such as:

```bash
ctx /path/to/project continue
```

The system does **not** transfer an LLM's internal context window, hidden reasoning, or KV cache between providers. Instead, it maintains durable, structured project memory and reconstructs a compact, relevant context package for the current agent.

TOON (Token-Oriented Object Notation) is a model-facing serialization optimization. It is not the database, source of truth, or a replacement for client-required API schemas. The context compiler should compare TOON with minified JSON and use the format that best meets token, correctness, and latency goals.

### Product promise

> Switch AI tools or accounts, run `ctx <project> continue`, and resume from the latest verified project state without manually reconstructing the previous conversation.

### Primary outcomes

1. Persistent project memory across CLI sessions, accounts, machines, and supported clients.
2. Reliable task checkpoints and cross-agent handoff.
3. Relevant, token-budgeted context instead of dumping full conversation history.
4. Measurable token efficiency through TOON where beneficial.
5. Secure, auditable, conflict-aware updates from multiple agents.
6. Extensible client adapters, initially for two supported coding clients and a generic MCP interface.

---

## 2. Goals and Non-Goals

### Goals

- Resolve a stable project identity from a local working directory.
- Store project facts, decisions, task state, checkpoints, and event history.
- Resume tasks from a different client or provider account when authorized.
- Verify the current Git state before relying on a checkpoint.
- Generate context appropriate for the active client and model.
- Serialize eligible structured data as TOON, with minified JSON fallback.
- Track token counts, latency, retrieval quality, and resume success.
- Provide a secure API and MCP tools for compatible clients.
- Support recoverable failures and concurrent agents.

### Non-goals for the MVP

- Transferring a provider's private conversation history or internal model state.
- Guaranteeing automatic context injection into every GUI or existing conversation.
- Replacing Git, the task tracker, or the user's source-of-truth systems.
- Storing passwords, provider API keys, OAuth refresh tokens, or other secrets as memory.
- Requiring a vector database, Redis, Kubernetes, or a complex event-broker cluster on day one.
- Automatically executing destructive operations or production deployments without policy and approval.
- Promising that TOON always uses fewer tokens than minified JSON.

---

## 3. User Experience and Command Design

### Primary command

```bash
ctx /path/to/project continue
```

Expected behavior:

1. Resolve the local directory and stable project ID.
2. Check user authentication and project permissions.
3. Inspect Git repository, branch, HEAD commit, and working-tree changes.
4. Retrieve the latest valid checkpoint and active task.
5. Retrieve only relevant decisions, facts, and recent events.
6. Assemble and budget the context package.
7. Encode structured context as TOON or compact JSON based on measured benefit.
8. Adapt the package to the active client.
9. Present or inject the resume prompt through a supported integration.
10. Record a resume event and start a new checkpoint lineage.

### Supporting commands

```bash
ctx init
ctx status
ctx checkpoint
ctx continue
ctx history
ctx inspect
ctx config
ctx auth login
ctx auth logout
ctx project link
ctx memory search "refresh-token rotation"
ctx doctor
```

The MVP may implement only `init`, `status`, `checkpoint`, `continue`, `history`, `auth login`, and `doctor`.

### Example resume output

```text
Project: shared-auth-service
Task: Implement refresh-token rotation
Checkpoint: ckpt_045 (version 45)
Branch: feature/auth-refresh
Repository state: working tree has uncommitted changes
Completed: JWT authentication, refresh-token endpoint
Pending: fix token rotation tests, run regression suite
Next action: inspect the failing token rotation test

Context format: TOON
Estimated input tokens: 2,140
Client integration: prompt handoff
```

The CLI must clearly state whether it actually launched/injected into a client or merely prepared a prompt for manual use.

---

## 4. System Architecture

```text
                    ┌──────────────────────────┐
                    │ Supported Agent Clients  │
                    │ CLI adapters / MCP tools │
                    └─────────────┬────────────┘
                                  │
                    ┌─────────────▼────────────┐
                    │ ctx CLI                  │
                    │ project detection        │
                    │ checkpoint / continue    │
                    └─────────────┬────────────┘
                                  │ HTTPS
                    ┌─────────────▼────────────┐
                    │ Context API / Gateway    │
                    │ auth, ACLs, rate limits  │
                    └─────────────┬────────────┘
                                  │
                    ┌─────────────▼────────────┐
                    │ Context Orchestrator     │
                    │ task resolver            │
                    │ retrieval and ranking    │
                    │ context compiler         │
                    │ token budget             │
                    └─────────────┬────────────┘
                                  │
                    ┌─────────────▼────────────┐
                    │ Serializer Adapter       │
                    │ TOON / minified JSON     │
                    │ provider/client adapter  │
                    └─────────────┬────────────┘
                                  │
                    ┌─────────────▼────────────┐
                    │ Active Agent / LLM       │
                    └──────────────────────────┘

       ┌───────────────────┬───────────────────┬──────────────────┐
       │ PostgreSQL        │ Git / files       │ Optional services│
       │ canonical memory  │ source of truth   │ pgvector, Redis  │
       └───────────────────┴───────────────────┴──────────────────┘
```

### Core principles

- **Database is authoritative:** serialized context is generated on demand.
- **Git is authoritative for code:** memory references commits and files rather than replacing repository history.
- **Checkpoints are explicit:** a checkpoint records what the agent believes is true at a moment in time.
- **Verify before acting:** a resume process inspects the current repository and detects drift.
- **Provider independence:** project memory is independent of provider conversation IDs.
- **Least privilege:** every read/write is scoped to an authorized user, organization, and project.
- **Idempotency:** retries must not duplicate critical actions or corrupt task state.
- **Traceability:** important memory entries have provenance, timestamps, and version information.

---

## 5. Recommended Technology Stack

### MVP stack

| Layer | Recommendation | Reason |
|---|---|---|
| CLI | TypeScript + Node.js | Cross-platform CLI and easy reuse of the TOON TypeScript SDK |
| API | TypeScript with Fastify or NestJS | Shared language and schema types; choose one framework |
| Validation | Zod or JSON Schema | Validate API inputs and context records |
| Primary database | PostgreSQL | Durable relational state, transactions, JSONB |
| Semantic retrieval | PostgreSQL full-text search first; pgvector later | Avoid premature infrastructure |
| Serialization | Official `@toon-format/toon` package, after verifying its current API | TOON encoding/decoding |
| Authentication | OIDC/OAuth for users; short-lived scoped tokens for agents | Cross-device identity and access control |
| Client integration | Adapter interface + MCP server | Different clients expose different integration surfaces |
| Observability | Structured logs and OpenTelemetry-compatible metrics | Diagnose failures and measure savings |
| Deployment | Docker initially; managed database and a small API service | Keep operational complexity low |

### Add only when needed

- **Redis:** cache and live notifications; never the only checkpoint store.
- **pgvector:** semantic similarity search when keyword/full-text search is inadequate.
- **Object storage:** large documents or artifacts.
- **Event broker:** high-volume asynchronous processing or many connected agents.
- **Kubernetes:** only when operational scale and availability needs justify it.

---

## 6. Memory Model

Treat memory as four logical categories. They may share a database but need different retrieval and update rules.

### 6.1 Working memory

Stores the current task, status, next action, blockers, active branch, relevant paths, and latest checkpoint reference.

**Primary use:** `ctx continue`.

### 6.2 Episodic memory

Stores events such as files changed, commands run, test outcomes, decisions made, and task transitions.

**Primary use:** reconstructing why a task is in its current state.

### 6.3 Semantic memory

Stores durable project facts, architecture decisions, constraints, naming conventions, and verified knowledge.

**Primary use:** retrieving relevant facts across sessions.

### 6.4 Procedural memory

Stores project workflows and rules, such as test commands, code style, build instructions, deployment gates, and review policies.

**Primary use:** helping a new agent follow the project's established process.

Do not store hidden chain-of-thought. Store concise decisions, evidence, actions, results, and next steps.

---

## 7. Database Design

Use migrations and foreign keys. Add `organization_id` or an equivalent tenant scope to records that require tenant isolation.

### 7.1 `organizations`

- `id` UUID primary key
- `name`
- `created_at`

### 7.2 `users`

- `id` UUID primary key
- `organization_id`
- `identity_provider`
- `provider_subject`
- `created_at`
- Unique constraint on identity provider + subject

### 7.3 `projects`

- `id` UUID primary key
- `organization_id`
- `name`
- `git_remote_normalized`
- `default_branch`
- `config_json` JSONB
- `created_at`
- `updated_at`

Do not use an absolute local path as the global project ID. Paths vary between machines. Use an explicit project ID mapped to a normalized Git remote, with a local mapping file and a confirmation step when identity is ambiguous.

### 7.4 `project_memberships`

- `project_id`
- `user_id`
- `role`
- `created_at`
- Composite primary key (`project_id`, `user_id`)

### 7.5 `agents`

- `id` UUID primary key
- `project_id`
- `owner_user_id`
- `provider`
- `client_type`
- `client_version` nullable
- `last_seen_at`
- `metadata_json` JSONB

Never treat the provider account itself as the project identity.

### 7.6 `tasks`

- `id` UUID primary key
- `project_id`
- `title`
- `status` (`pending`, `in_progress`, `blocked`, `completed`, `cancelled`)
- `assigned_agent_id` nullable
- `next_action`
- `current_version` integer
- `priority`
- `created_at`
- `updated_at`
- `completed_at` nullable

### 7.7 `checkpoints`

- `id` UUID primary key
- `project_id`
- `task_id` nullable
- `version` integer
- `branch`
- `git_commit` nullable
- `working_tree_summary` JSONB
- `state_json` JSONB
- `created_by_agent_id`
- `created_at`
- `validity_status` (`valid`, `stale`, `superseded`, `needs_review`)
- `idempotency_key` nullable

A checkpoint is immutable after creation. A new checkpoint supersedes an old one rather than overwriting it.

### 7.8 `memory_entries`

- `id` UUID primary key
- `project_id`
- `type` (`fact`, `decision`, `procedure`, `note`)
- `title`
- `content`
- `structured_content` JSONB nullable
- `source_type`
- `source_ref` nullable
- `confidence` nullable
- `created_by_agent_id` nullable
- `version`
- `created_at`
- `updated_at`
- `expires_at` nullable
- `is_deleted` boolean default false

Use provenance and explicit expiry for facts that can become stale. Avoid treating a model-generated assumption as a verified fact.

### 7.9 `agent_events`

- `id` UUID primary key
- `project_id`
- `task_id` nullable
- `agent_id`
- `event_type`
- `payload` JSONB
- `created_at`
- `correlation_id`
- `idempotency_key` nullable

Events should be append-only for auditability, subject to retention and deletion policies.

### 7.10 `memory_embeddings` (optional later)

- `memory_id` primary/foreign key
- `embedding` vector with a dimension compatible with the selected embedding model
- `embedding_model`
- `updated_at`

Embeddings are derived indexes. Preserve original content and rebuild embeddings when the model or indexing strategy changes.

### 7.11 `context_metrics`

- `id` UUID primary key
- `project_id`
- `task_id` nullable
- `client_type`
- `model_id` nullable
- `serialization_format`
- `estimated_input_tokens`
- `actual_input_tokens` nullable
- `assembly_latency_ms`
- `serialization_latency_ms`
- `resume_outcome` nullable
- `created_at`

Avoid storing sensitive prompt bodies in metrics by default.

---

## 8. Local Project Configuration

Create a `.ctx/` directory or a single `.ctx.json` file, based on the project's needs.

Example `.ctx/config.json`:

```json
{
  "schema_version": 1,
  "project_id": "project-uuid",
  "api_base_url": "https://ctx.example.com",
  "default_branch": "main",
  "checkpoint_policy": {
    "on_manual_command": true,
    "on_milestone": true,
    "include_uncommitted_diff_summary": true
  }
}
```

The project ID and endpoint are not secrets. Credentials must be kept in the operating system credential store or a dedicated secret manager.

Decide whether `.ctx/` is committed to Git. A safe default is to commit a non-secret project configuration when it helps team collaboration, while keeping machine-specific paths and credentials outside the repository. Do not commit raw prompts, sensitive environment variables, or private user memory accidentally.

---

## 9. Checkpoint Data Contract

A checkpoint should be structured and validated. Example:

```json
{
  "schema_version": 1,
  "project_id": "project-uuid",
  "task_id": "task-uuid",
  "status": "in_progress",
  "branch": "feature/auth-refresh",
  "git_commit": "abc123",
  "working_tree": {
    "clean": false,
    "changed_paths": [
      "src/auth/refresh.py",
      "tests/test_refresh_tokens.py"
    ]
  },
  "completed": [
    {
      "description": "JWT authentication implemented",
      "evidence": "tests/test_auth.py passed"
    }
  ],
  "pending": [
    "Fix token rotation tests",
    "Run the regression suite"
  ],
  "decisions": [
    {
      "decision": "Use rotating refresh tokens",
      "source_memory_id": "memory-uuid"
    }
  ],
  "blockers": [],
  "next_action": "Inspect the failing token rotation test",
  "last_verified_at": "2026-10-24T00:00:00Z"
}
```

The timestamp is illustrative. Generate real timestamps at runtime.

The record should distinguish:
- verified results from agent claims;
- committed state from uncommitted changes;
- current task status from historical status;
- planned actions from completed actions;
- a checkpoint from a provider-specific session.

---

## 10. TOON Integration Plan

### 10.1 Position in the architecture

TOON is a **serialization adapter** inside the context compiler:

```text
Canonical database records
        ↓
Relevant-memory retrieval
        ↓
Context assembly and deduplication
        ↓
Token-budget enforcement
        ↓
Candidate encoders: TOON / minified JSON
        ↓
Tokenizer-based measurement
        ↓
Choose valid, smaller representation
        ↓
Client-specific prompt/context adapter
```

### 10.2 Rules

1. PostgreSQL and validated JSON-compatible objects remain canonical.
2. Generate TOON at request time; do not make TOON the database's only stored representation.
3. Benchmark against minified JSON, not just pretty JSON.
4. Measure the complete model input, including format instructions and relevant system context.
5. Use each provider's tokenizer when available; otherwise mark estimates as estimates.
6. Preserve required fields and provenance during compression.
7. Keep tool calls, HTTP payloads, and APIs in their required schemas.
8. Use TOON for suitable repeated structured records; use compact JSON when it is smaller or safer.
9. Validate encoder/decoder round trips and handle malformed or unsupported values.
10. Track token savings, latency, and task correctness.

### 10.3 Serializer interface

Illustrative TypeScript contract:

```typescript
type ContextFormat = "toon" | "json";

interface ContextPackage {
  schemaVersion: number;
  projectId: string;
  taskId?: string;
  checkpointVersion?: number;
  instructions: string[];
  facts: Record<string, unknown>;
  decisions: Array<Record<string, unknown>>;
  taskState: Record<string, unknown>;
  recentEvents: Array<Record<string, unknown>>;
}

interface EncodedContext {
  format: ContextFormat;
  serialized: string;
  estimatedTokens: number;
  baselineTokens: number;
  contextVersion: number;
}

interface ContextSerializer {
  encode(context: ContextPackage): Promise<EncodedContext>;
}
```

The exact implementation should follow the installed TOON SDK's current API and type definitions. Do not assume the sample interface is supplied by the package.

### 10.4 Token savings calculation

For a measured baseline token count \(B\) and TOON token count \(T\):

\[
\text{Savings (\%)} = \frac{B-T}{B}\times100
\]

Record negative savings too. If TOON uses more tokens, choose the smaller valid alternative.

### 10.5 Proposed acceptance criteria

- At least 15% median token reduction on a defined set of eligible structured contexts.
- No material degradation in checkpoint interpretation or task success.
- No required field loss in round-trip tests.
- No significant latency regression in the end-to-end resume path.
- Correct fallback to minified JSON when TOON does not improve the result.

These are proposed project targets, not guaranteed performance.

---

## 11. Context Retrieval and Budgeting

Use a layered retrieval strategy.

### First: deterministic retrieval

Fetch:
- latest valid checkpoint;
- current task and its status;
- project rules and relevant procedures;
- decisions explicitly linked to the task;
- recent events after the checkpoint;
- file/branch/commit information.

### Second: relevance-based retrieval

Search historical notes and events by:
- project ID;
- task ID;
- file paths and symbols;
- keywords/full-text search;
- semantic similarity, if pgvector is enabled.

### Third: context compiler

Prioritize information in this order:

1. System and client-required instructions.
2. Current task and next action.
3. Current repository state and uncommitted changes.
4. Relevant constraints, decisions, and procedures.
5. Recent evidence and blockers.
6. Supporting historical context.

Do not silently truncate required state. If the package exceeds the budget, reduce low-priority history, summarize it with provenance, or ask the agent to retrieve more information on demand.

Reserve context capacity for the active model's output and tool interactions. Budgets differ by model and provider.

---

## 12. API Design

Use versioned endpoints and a shared schema library.

### Proposed REST endpoints

```text
POST   /v1/projects/resolve
GET    /v1/projects/:projectId
POST   /v1/projects/:projectId/checkpoints
GET    /v1/projects/:projectId/checkpoints/latest
GET    /v1/projects/:projectId/tasks
POST   /v1/projects/:projectId/tasks
GET    /v1/tasks/:taskId
PATCH  /v1/tasks/:taskId
POST   /v1/tasks/:taskId/checkpoints
GET    /v1/projects/:projectId/memories
POST   /v1/projects/:projectId/memories
POST   /v1/projects/:projectId/context/assemble
POST   /v1/projects/:projectId/context/metrics
GET    /v1/projects/:projectId/events
```

### Context assembly request

```json
{
  "task_id": "task-uuid",
  "client_type": "claude-code",
  "model_id": "optional-model-id",
  "format_preference": "auto",
  "token_budget": 8000
}
```

### Context assembly response

```json
{
  "context_id": "context-uuid",
  "project_id": "project-uuid",
  "task_id": "task-uuid",
  "checkpoint_version": 45,
  "format": "toon",
  "content": "encoded context goes here",
  "estimated_tokens": 2140,
  "sources": [
    {
      "type": "checkpoint",
      "id": "checkpoint-uuid"
    }
  ]
}
```

These examples are proposed contracts. Validate and version them before implementation. Do not trust a client-supplied `organization_id` as authorization; derive permissions from the authenticated principal and server-side membership records.

---

## 13. MCP and Client Adapter Strategy

### MCP tools to expose

- `ctx_project_resolve`
- `ctx_get_status`
- `ctx_get_checkpoint`
- `ctx_search_memory`
- `ctx_assemble_context`
- `ctx_save_checkpoint`
- `ctx_record_decision`
- `ctx_record_event`
- `ctx_update_task`

Keep tools narrow, typed, permission-checked, and auditable. Avoid a single unrestricted tool that can read or modify all projects.

### Client adapter interface

Define an adapter contract:

```typescript
interface AgentClientAdapter {
  detect(): Promise<boolean>;
  getClientInfo(): Promise<{
    clientType: string;
    version?: string;
  }>;
  prepareResume(context: EncodedContext): Promise<{
    mode: "injected" | "prompt-ready";
    message: string;
  }>;
}
```

The interface is illustrative. Actual adapters must follow each client's supported interfaces and version-specific behavior.

### Integration policy

- Prefer official CLI options, MCP, hooks, or documented APIs.
- Do not assume all GUI clients accept arbitrary prompt injection.
- If direct injection is unsupported, create a resume prompt and copy/open it for the user.
- Clearly report which mode was used.
- Never claim the task was resumed until the active client has actually received the context.

Start with two clients with reliable, documented integration surfaces, then add others.

---

## 14. Resume Algorithm

Pseudocode:

```text
continue(project_path):
    local_project = inspect_project(project_path)
    project = resolve_project_identity(local_project)
    principal = authenticate()
    authorize(principal, project, "context:read")

    checkpoint = load_latest_valid_checkpoint(project)

    if checkpoint is missing:
        explain_no_checkpoint()
        offer_initialize_or_create_checkpoint()
        return

    repository_state = inspect_git_state(project_path)
    drift = compare(checkpoint.repository_state, repository_state)

    if drift is material:
        mark_checkpoint_stale_or_needs_review()
        present_differences()
        require_resolution_when_unsafe()

    task_state = load_task(checkpoint.task_id)
    decisions = retrieve_linked_decisions(task_state)
    events = load_relevant_events_after(checkpoint.created_at)
    knowledge = retrieve_relevant_project_memory(task_state)

    package = assemble_and_rank(
        checkpoint,
        repository_state,
        task_state,
        decisions,
        events,
        knowledge
    )

    encoded_context = optimize_and_encode(package)
    adapter = detect_supported_client()
    result = adapter.prepareResume(encoded_context)

    record_resume_event(result, encoded_context.metadata)
    present_result_and_sources(result)
```

Use bounded timeouts, retry rules, structured error codes, and correlation IDs. Never execute an inferred next action automatically just because it appears in a checkpoint.

---

## 15. Checkpoint and Conflict Strategy

### Checkpoint triggers

- Explicit `ctx checkpoint`.
- Completion of a meaningful task milestone.
- Before a risky or disruptive operation, when supported.
- After a verified test/build result.
- On a client hook or session-end event, if reliably available.

### Concurrency

- Use optimistic locking with `current_version`.
- Require the expected version on updates.
- Reject stale writes with a conflict response.
- Keep checkpoints immutable.
- Use idempotency keys for retried writes.
- Record merges and conflict resolutions as events.
- Use task leases only if concurrent work assignment requires them; leases must expire and be recoverable.

### Git drift

Compare:
- repository remote;
- branch;
- HEAD commit;
- uncommitted file paths and a safe diff summary;
- relevant generated artifacts or test results.

Do not automatically discard local changes, reset branches, checkout another branch, or overwrite files during resume. Show conflicts and require a safe resolution.

---

## 16. Security, Privacy, and Governance

Security is a core requirement because shared context may contain proprietary source details and internal project decisions.

- Authenticate users with a supported identity flow.
- Scope every operation by organization and project membership.
- Use short-lived, revocable agent credentials.
- Store provider secrets in a secure credential store, not project memory.
- Redact credentials, tokens, private keys, and sensitive environment values from logs and checkpoints.
- Validate context records and cap request sizes.
- Enforce rate limits and per-tenant quotas.
- Encrypt network traffic and use managed encryption at rest.
- Audit reads and writes to sensitive project memory.
- Provide retention, export, deletion, and revocation workflows.
- Protect against prompt injection in retrieved documents: retrieved text is untrusted data, not an instruction to override system policy.
- Require approval for destructive actions and privileged deployment operations.
- Never share context across accounts unless the authenticated user has access to the same project.
- Establish policies for deleting user content, embeddings, derived summaries, and retained event records.

---

## 17. Observability and Performance

Track these measurements from the start:

### Reliability

- Resume success rate.
- Checkpoint save success rate.
- Stale checkpoint detection rate.
- Conflict and retry rate.
- Context retrieval failures.
- Incorrect or incomplete task recovery rate.

### Efficiency

- Baseline JSON token count.
- TOON token count.
- Actual model input tokens when available.
- Serialization and assembly latency.
- Total resume latency.
- Model cost per completed task.
- Cache hit rate, if caching is introduced.

### Correctness

- Exact recovery of task ID and status.
- Correct retrieval of the next action.
- Correct detection of Git drift.
- No loss of required fields during encoding/decoding.
- Task completion and test outcomes after handoff.

Log metadata by default, not full sensitive context bodies. Use trace IDs across CLI, API, database operations, and client adapters.

---

## 18. Testing Strategy

### Unit tests

- Project ID resolution and path mapping.
- Schema validation.
- Checkpoint version handling.
- Token-budget calculations.
- TOON and JSON encoding/decoding.
- Redaction and access-control functions.
- Context ranking and filtering.

### Integration tests

- CLI ↔ API ↔ PostgreSQL.
- Save checkpoint, terminate process, and resume.
- Resume after changing the local project path.
- Resume after switching client adapters.
- TOON/JSON selection using actual tokenizer measurements.
- Concurrent writes and stale-version conflicts.
- Authentication and tenant isolation.

### End-to-end scenarios

1. Agent A saves a checkpoint; Agent B resumes on the same machine.
2. Agent A saves a checkpoint; another machine resumes from it.
3. A user changes AI provider account but retains authorization to the shared project.
4. The repository branch changes after checkpoint creation.
5. Uncommitted changes exist during resume.
6. Two agents attempt to update the same task.
7. TOON is larger than minified JSON and the optimizer falls back correctly.
8. A retrieved document contains malicious instructions.
9. The context API is temporarily unavailable.
10. A checkpoint is missing, corrupt, or incompatible with a newer schema.

### Proposed release gates

- No cross-tenant data leakage in authorization tests.
- No silent overwrite of newer task state.
- Correct checkpoint and next-action recovery in the defined evaluation set.
- All required fields survive serialization round trips.
- TOON selection is based on measurements, not assumptions.
- No destructive repository operations during resume without explicit approval.

---

## 19. Phased Delivery Plan

Timeline is an estimate for a focused implementation; integration and deployment requirements may change it.

### Phase 1 — Foundation (Week 1)

- Initialize CLI and API repositories or monorepo.
- Define project/task/checkpoint schemas.
- Set up PostgreSQL migrations.
- Implement authentication and project membership checks.
- Implement `ctx init`, `ctx status`, and manual checkpoint saving.

**Exit criteria:** context survives process restart and is scoped to authorized projects.

### Phase 2 — TOON and context compiler (Week 2)

- Add the official TOON SDK.
- Implement TOON and minified JSON encoders.
- Build token measurement and format selection.
- Add schema validation and round-trip tests.
- Create a representative benchmark corpus.

**Exit criteria:** format choice is measurable and safe; metrics capture the comparison.

### Phase 3 — Retrieval and checkpoint reliability (Weeks 3–4)

- Add deterministic retrieval and context ranking.
- Add task and checkpoint versioning.
- Implement Git drift detection.
- Add event history and provenance.
- Add context-budget enforcement and fallback behavior.

**Exit criteria:** resume returns a verified, relevant package without loading the entire history.

### Phase 4 — Client adapters and MCP (Weeks 5–6)

- Define adapter interface.
- Integrate two target clients with supported interfaces.
- Implement MCP server and scoped tools.
- Add prompt-ready fallback for unsupported clients.
- Implement resume and checkpoint CLI flows.

**Exit criteria:** a task can be saved in one supported client and resumed in another.

### Phase 5 — Search and multi-agent coordination (Weeks 7–8)

- Add full-text search and, if needed, pgvector.
- Add change notifications if a real-time requirement exists.
- Implement conflict handling and idempotency.
- Test cross-machine resume and simultaneous agents.

**Exit criteria:** authorized agents share current state without silent lost updates.

### Phase 6 — Production hardening (Weeks 9–10)

- Load and security testing.
- Backups and restore tests.
- Metrics, dashboards, alerts, and retention policies.
- Deployment pipeline and rollback plan.
- Documentation and release packaging.

**Exit criteria:** operational readiness review passes.

---

## 20. Suggested Repository Structure

```text
ctx/
├── apps/
│   ├── cli/
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   ├── project/
│   │   │   ├── git/
│   │   │   └── output/
│   │   └── tests/
│   ├── api/
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── auth/
│   │   │   ├── services/
│   │   │   └── middleware/
│   │   └── tests/
│   └── mcp-server/
│       ├── src/
│       └── tests/
├── packages/
│   ├── schemas/
│   ├── context-core/
│   ├── context-retrieval/
│   ├── context-compiler/
│   ├── serializers/
│   │   ├── toon/
│   │   └── json/
│   ├── token-measurement/
│   └── client-adapters/
│       ├── adapter-interface/
│       ├── client-a/
│       └── client-b/
├── migrations/
├── benchmarks/
│   ├── fixtures/
│   ├── scripts/
│   └── reports/
├── docs/
│   ├── architecture.md
│   ├── security.md
│   ├── api.md
│   └── client-support.md
├── tests/
│   ├── integration/
│   └── e2e/
├── docker-compose.yml
├── package.json
└── README.md
```

This is a proposed structure. Start with a monorepo for shared types and fast iteration; split services only when independent deployment or ownership justifies it.

---

## 21. Initial MVP Scope

Build only the pieces needed to prove the core promise.

### Required

- TypeScript CLI.
- PostgreSQL schema and migrations.
- Authentication and project-level authorization.
- Project identity mapping.
- Task state and immutable checkpoints.
- Git state inspection.
- Context assembly with token budget.
- TOON/minified JSON comparison and fallback.
- One reliable client adapter and one second-client handoff path.
- `ctx continue`, `ctx checkpoint`, `ctx status`, and `ctx history`.
- Automated tests and token-savings report.

### Defer

- Full real-time collaboration UI.
- Dedicated vector database.
- Redis, unless a measured requirement exists.
- Kubernetes deployment.
- Automatic agent orchestration.
- Provider-specific conversation import.
- Large-scale distributed event infrastructure.

---

## 22. Definition of Done

The MVP is ready when the following scenario works reliably:

1. A developer opens a project in a supported AI coding tool.
2. The agent completes some work and records a checkpoint.
3. The developer switches to a different supported tool or account.
4. The developer runs `ctx /path/to/project continue`.
5. The CLI identifies the correct shared project and authenticates the user.
6. The runtime loads the latest checkpoint and verifies the current repository state.
7. It retrieves the necessary task facts, decisions, and recent evidence.
8. The context compiler chooses TOON or minified JSON based on measured results.
9. The active client receives the context through a supported integration or a clearly reported prompt-ready fallback.
10. The new agent understands the unfinished task and proceeds without silently overwriting local work.
11. The resulting changes and new checkpoint are recorded with provenance and versioning.
12. Metrics demonstrate context efficiency, resume correctness, and acceptable latency.

---

## 23. Immediate Next Steps

1. Confirm the first two client integrations and verify their current supported entry points.
2. Create the TypeScript monorepo and shared schema package.
3. Implement PostgreSQL migrations for projects, tasks, checkpoints, memberships, and events.
4. Implement `ctx init`, `ctx checkpoint`, and `ctx status`.
5. Add the TOON serializer and minified JSON baseline.
6. Build the first end-to-end test: checkpoint in Client A, resume through Client B.
7. Measure token savings and correctness before adding semantic search or caching.

**Guiding principle:** persistent memory is the source of continuity; retrieval determines what matters; TOON reduces representation overhead when beneficial; and client adapters make the context usable by each agent.
