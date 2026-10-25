# ⚡ Shared AI Context Runtime (`ctx`)

<div align="center">

<img src="./assets/poster.svg" alt="Shared AI Context Runtime Banner" width="100%" />

<br/><br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22_LTS_(20+-24)-green.svg?logo=node.js)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17.6-336791.svg?logo=postgresql)](https://www.postgresql.org/)
[![CI Matrix](https://img.shields.io/badge/CI_Matrix-Node_20%20%7C%2022%20%7C%2024-green.svg)](ci/github-ci.yml)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-SDK_1.32-purple.svg)](https://modelcontextprotocol.io/)
[![TOON](https://img.shields.io/badge/TOON_Format-4.4.0-ff69b4.svg)](https://toonformat.dev/)
[![Tests](https://img.shields.io/badge/Tests-Passing_25%2F25-brightgreen.svg)]()
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg?logo=docker)]()

**Cross-client, cross-account, and cross-device persistent context runtime for AI coding agents.**

*Switch AI tools or accounts, run `ctx continue`, and seamlessly resume from the latest verified project state.*

[Features](#-key-features) • [Architecture](#-architecture) • [Quickstart](#-quickstart) • [MCP Server](#-model-context-protocol-mcp-server) • [Benchmarks](#-toon-token-efficiency) • [Roadmap](#-roadmap)

</div>

---

## 🎯 The Problem

When working with modern AI coding assistants (Claude Code, Cursor, Copilot, Antigravity, VS Code), context is trapped inside provider-specific conversation threads and ephemeral IDE sessions. 

When you:
- Switch from a terminal tool (e.g. Claude Code) to an editor (e.g. Cursor)
- Switch developer accounts or model providers
- Move between your laptop and another machine

...the agent loses all working memory. You are forced to manually copy-paste terminal outputs, explain what was completed, and re-establish the next action.

## 💡 The Solution

`ctx` does **not** attempt to transfer hidden LLM KV caches or proprietary provider weights. Instead, it maintains **canonical, durable project memory** in PostgreSQL, verifies repository state against Git drift, and reconstructs a compact, token-budgeted context package encoded with **TOON (Token-Oriented Object Notation)** or minified JSON.

```bash
ctx /path/to/project continue
```

```text
Project:          shared-auth-service
Task:             Implement refresh-token rotation
Checkpoint:       ckpt_045 (version 45)
Branch:           feature/auth-refresh
Repository state: working tree has uncommitted changes (2 files modified)
Completed:        JWT authentication, refresh-token endpoint
Pending:          fix token rotation tests, run regression suite
Next action:      inspect the failing token rotation test

Context format:   TOON (saved 2.6% tokens vs JSON)
Estimated tokens: 176
Client adapter:   Claude Code (prompt-ready)
```

---

## ✨ Key Features

- 🔄 **Cross-Tool Task Continuity:** Checkpoint your work in one tool (via CLI or MCP) and resume instantly in another tool or machine.
- 📦 **Immutable Versioned Checkpoints:** Every checkpoint preserves working-tree diffs, uncommitted file lists, completed items with evidence, and next actions.
- 🛡️ **Git Drift Detection:** Detects and flags branch changes, uncommitted edits, and HEAD commit shifts between sessions before resuming.
- 📉 **TOON Token Compression:** Evaluates candidate representations using `@toon-format/toon` against minified JSON baselines, dynamically selecting the format that consumes the fewest input tokens.
- 🔌 **Native Model Context Protocol (MCP) Server:** Exposes 12 typed MCP tools over stdio for direct integration into Cursor, Claude Desktop, and Antigravity.
- 🐘 **PostgreSQL 17 Canonical Store:** Hybrid relational governance with JSONB snapshots, foreign key cascades, and optimistic concurrency versioning.

---

## 🏛️ Architecture

```text
               ┌──────────────────────────────────────────────┐
               │         Supported Agent Clients              │
               │   Cursor • Claude Code • Antigravity • IDE   │
               └──────────────────────┬───────────────────────┘
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                  ┌──────▼──────┐           ┌──────▼──────┐
                  │   ctx CLI   │           │ MCP Server  │
                  │  (terminal) │           │   (stdio)   │
                  └──────┬──────┘           └──────┬──────┘
                         │                         │
                         └────────────┬────────────┘
                                      │ HTTP / JSON
                        ┌─────────────▼─────────────┐
                        │    Context API Gateway    │
                        │   (Fastify + Validation)  │
                        └─────────────┬─────────────┘
                                      │
                        ┌─────────────▼─────────────┐
                        │    Context Orchestrator   │
                        │  • Task Resolver          │
                        │  • Git Drift Inspector    │
                        │  • Context Assembler      │
                        └─────────────┬─────────────┘
                                      │
                        ┌─────────────▼─────────────┐
                        │   Serialization Adapter   │
                        │ • TOON Format SDK         │
                        │ • Minified JSON Fallback  │
                        │ • Token Estimation Engine │
                        └─────────────┬─────────────┘
                                      │
                        ┌─────────────▼─────────────┐
                        │   PostgreSQL 17 Database  │
                        │  Projects • Checkpoints   │
                        │  Tasks • Memory • Events  │
                        └───────────────────────────┘
```

---

## 📂 Monorepo Structure

```text
shared-ai-context-runtime/
├── apps/
│   ├── cli/            # ctx command-line tool (Commander, Git inspection, formatting)
│   ├── api/            # Fastify HTTP service & PostgreSQL connection pool
│   └── mcp-server/     # Official Model Context Protocol (MCP) stdio server
├── packages/
│   ├── schemas/        # Canonical Zod schemas & TypeScript contracts
│   ├── serializers/    # TOON (@toon-format/toon) & JSON optimizer
│   └── client-adapters/# Claude Code & Generic Prompt Handoff adapters
├── migrations/         # PostgreSQL 17 relational DDL migrations
└── tests/
    └── e2e/            # Full multi-agent handoff & drift detection tests
```

---

## 🚀 Quickstart

### Prerequisites

- **Node.js** v22 LTS (Active LTS pinned in Docker; Node v20+ and v24 also supported in CI matrix)
- **PostgreSQL 17** (or local portable binary)
- **Git**

### 1. Installation

```bash
git clone https://github.com/Sayantan-git-commits/shared-ai-context-runtime.git
cd shared-ai-context-runtime
npm install
npm run build
```

### 2. Run Database & Migrations

If using your local PostgreSQL instance:
```bash
# Create database
createdb -U postgres ctx_db

# Run transactional database migrations
npm run migrate
```
*(Optionally provide a custom connection string: `DATABASE_URL="postgresql://user:pass@host:5432/ctx_db" npm run migrate`)*

### 3. Start the API Gateway

```bash
export DATABASE_URL="postgresql://postgres@127.0.0.1:5432/ctx_db"
npm run api
```
*(On Windows PowerShell: `$env:DATABASE_URL="postgresql://postgres@127.0.0.1:5432/ctx_db"; npm run api`)*

The server will boot on `http://127.0.0.1:3000`.

---

## 💻 CLI Commands

The `ctx` CLI can be executed via `npm run ctx -- <command>` or globally via `ctx`:

```bash
# Verify environment, Git, and API reachability
ctx doctor

# Initialize project identity in .ctx/config.json
ctx init --name "my-service"

# View active task, latest checkpoint version, and Git working tree state
ctx status

# Record an immutable verified checkpoint
ctx checkpoint -m "Completed JWT authentication; next: implement token rotation"

# Resume in another client with TOON compression (with optional budget and drift flags)
ctx continue --budget 4000 --ignore-drift

# View complete version history
ctx history

# View append-only agent event audit trail
ctx events
```

---

## 🤖 Model Context Protocol (MCP) Server

Connect `ctx` directly to your favorite AI assistant so the model can inspect checkpoints, record architectural decisions, and assemble context autonomously.

### Available MCP Tools

| Tool | Parameters | Description |
|---|---|---|
| `ctx_project_resolve` | `projectName`, `gitRemoteUrl` | Resolves or registers project identity |
| `ctx_get_status` | `projectId` | Returns project health, branch, and active task |
| `ctx_get_checkpoint` | `projectId`, `latestOnly` | Retrieves latest or historical checkpoints |
| `ctx_save_checkpoint` | `projectId`, `branch`, `completedItems`, `nextAction`, ... | Records an immutable checkpoint |
| `ctx_record_decision` | `projectId`, `title`, `content`, `type` | Stores decisions and rules in semantic memory |
| `ctx_assemble_context`| `projectId`, `taskId`, `formatPreference`, `tokenBudget` | Compiles and token-optimizes context via TOON |
| `ctx_update_task` | `taskId`, `status`, `nextAction`, `expectedVersion` | Updates task lifecycle with optimistic concurrency check |
| `ctx_record_event` | `projectId`, `eventType`, `payload` | Logs an event in the append-only audit stream |
| `ctx_list_events` | `projectId`, `taskId` | Retrieves audit event trail for a project or task |
| `ctx_search_memory` | `projectId`, `query`, `type`, `limit` | Full-text keyword search across memory entries and decisions |
| `ctx_acquire_task_lease` | `taskId`, `agentId`, `durationSeconds` | Locks a task for single-agent execution (preventing races) |
| `ctx_release_task_lease` | `taskId`, `leaseToken` | Releases active lease back to pool upon completion |

### Configuration

#### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "ctx": {
      "command": "node",
      "args": ["<PATH_TO_REPO>/apps/mcp-server/dist/index.js"],
      "env": {
        "CTX_API_URL": "http://127.0.0.1:3000",
        "CTX_AUTH_TOKEN": "your-api-token"
      }
    }
  }
}
```

#### Cursor / Antigravity (`mcpSettings.json`)
```json
{
  "mcpServers": {
    "ctx": {
      "command": "node",
      "args": ["<PATH_TO_REPO>/apps/mcp-server/dist/index.js"],
      "env": {
        "CTX_API_URL": "http://127.0.0.1:3000",
        "CTX_AUTH_TOKEN": "your-api-token"
      }
    }
  }
}
```

---

## 📊 TOON Token Efficiency & Benchmarks

`ctx` incorporates **Token-Oriented Object Notation (TOON)** as a runtime serialization adapter. During context assembly, the compiler benchmarks candidate representations against minified JSON and selects the most compact valid format.

Run the reproducible benchmark suite anytime:

```bash
npm run benchmark
```

```text
================================================================================
             SHARED AI CONTEXT RUNTIME - SERIALIZATION BENCHMARKS                
               TOON vs. Minified JSON Token Savings & Latency                   
               Tokenizer: cl100k_base BPE (via gpt-tokenizer)                   
================================================================================

┌─────────┬─────────────────────────────────────────────────────┬─────────────┬───────────┬─────────────┬───────────┬─────────────┬─────────────┐
│ (index) │ Scenario                                            │ JSON Tokens │ JSON (ms) │ TOON Tokens │ TOON (ms) │ Savings (%) │ Auto Choice │
├─────────┼─────────────────────────────────────────────────────┼─────────────┼───────────┼─────────────┼───────────┼─────────────┼─────────────┤
│ 0       │ 'Small Context (1 Task, 3 Decisions, 5 Facts)'      │ 639         │ '15.42'   │ 669         │ '1.73'    │ '-4.7%'     │ 'JSON'      │
│ 1       │ 'Medium Context (10 Tasks, 20 Decisions, 25 Facts)' │ 3006        │ '4.82'    │ 2957        │ '5.92'    │ '1.6%'      │ 'TOON'      │
│ 2       │ 'Large Context (35 Tasks, 60 Decisions, 70 Facts)'  │ 7886        │ '21.01'   │ 7762        │ '8.16'    │ '1.6%'      │ 'TOON'      │
└─────────┴─────────────────────────────────────────────────────┴─────────────┴───────────┴─────────────┴───────────┴─────────────┴─────────────┘
```

---

## 🐳 Docker Deployment & Smoke Verification

Run the complete production stack (PostgreSQL 17.4 + transactional migration runner + Fastify API Gateway) with Docker Compose:

```bash
# 1. Start all services in the background
docker compose up --build -d

# 2. Check service status (ctx-migrate will complete, ctx-api will become healthy)
docker compose ps

# 3. Verify API readiness endpoint
curl -f http://127.0.0.1:3000/health

# 4. View logs
docker compose logs --tail=100
```

With optional API key authentication:
```bash
CTX_AUTH_TOKEN="my-secret-key" docker compose up -d
```

---

## 🧪 Testing

Run all unit and end-to-end integration tests:

```bash
npm test
```

```text
✔ AdapterRegistry resolves fallback adapter
✔ CheckpointSchema validates valid checkpoint
✔ ContextPackageSchema validates structure
✔ ContextSerializer encodes and round-trips TOON & JSON
✔ ContextSerializer enforces tokenBudget pruning on large context
✔ API: health check returns ok
✔ API: resolve project and checkpoint workflow
✔ API: authentication middleware enforces token check on protected routes
✔ API: multi-tenant isolation prevents cross-organization access
✔ API: health check reports ready status and fails when dependencies are unhealthy
✔ API: PostgresContextStore.checkHealth() catches database driver errors and sanitizes external disclosure
✔ API: in-memory store is rejected from production mode and reports unhealthy
✔ API: validateStartupConfig prohibits ephemeral storage in production
✔ API: concurrent checkpoint creation maintains atomic version sequence
✔ Git inspector reports repo state safely
✔ Config manager saves and loads .ctx/config.json
✔ CLI: normalizeArgv supports path-first syntax 'ctx <path> continue'
✔ Git: redactSecrets masks sensitive credentials and API keys in diffs
✔ Git: redactSecrets sanitizes database connection URLs and JWT tokens
✔ Git: isSensitivePath identifies files that must never have diff contents captured
✔ Git: GIT_PATHSPEC_EXCLUSIONS aligns with sensitive path patterns
✔ MCP Server: initializes with all core tools registered
✔ MCP Server: enforces authentication when calling protected API routes
✔ MCP Server: workingTreeClean defaults to fail-closed (clean: false) when omitted or dirty
✔ E2E: Full cross-client handoff workflow (Tool A -> Tool B)

25 passed, 0 failed
```

---

## 🗺️ Roadmap

- [x] **Phase 1: Foundation** (PostgreSQL 17, schema migrations, CLI commands `init`/`status`/`checkpoint`)
- [x] **Phase 2: TOON Context Optimizer** (`@toon-format/toon`, token measurement, round-trip validation)
- [x] **Phase 3: Model Context Protocol (MCP)** (`@modelcontextprotocol/sdk` stdio server with 12 tools)
- [x] **Phase 4: Token Budgeting & Concurrency** (Priority-based pruning, Git drift guardrails, HTTP 409 conflict detection, event stream)
- [x] **Phase 5: Full-Text Memory Search & Leases** (PostgreSQL `tsvector`/`tsquery` search and multi-agent task locks)
- [x] **Phase 6: Production Hardening & Benchmarks** (Bearer/API key auth, rate-limiting, Docker Compose, automated benchmark suite)

---

## 📄 License

Licensed under the [MIT License](LICENSE).
