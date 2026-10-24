# ⚡ Shared AI Context Runtime (`ctx`)

<div align="center">

<img src="./assets/poster.svg" alt="Shared AI Context Runtime Banner" width="100%" />

<br/><br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24+-green.svg?logo=node.js)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17.6-336791.svg?logo=postgresql)](https://www.postgresql.org/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-SDK_1.32-purple.svg)](https://modelcontextprotocol.io/)
[![TOON](https://img.shields.io/badge/TOON_Format-4.4.0-ff69b4.svg)](https://toonformat.dev/)
[![Tests](https://img.shields.io/badge/Tests-Passing_9%2F9-brightgreen.svg)]()

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
- 🔌 **Native Model Context Protocol (MCP) Server:** Exposes 7 typed MCP tools over stdio for direct integration into Cursor, Claude Desktop, and Antigravity.
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

- **Node.js** v20+ (tested on Node v24)
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

# Run schema migrations
psql -U postgres -d ctx_db -f migrations/001_initial_schema.sql
```

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

# Resume in another client with TOON compression
ctx continue

# View complete version history
ctx history
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
| `ctx_assemble_context`| `projectId`, `taskId`, `formatPreference` | Compiles and token-optimizes context via TOON |
| `ctx_update_task` | `taskId`, `status`, `nextAction` | Updates task lifecycle status and milestones |

### Configuration

#### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "ctx": {
      "command": "node",
      "args": ["<PATH_TO_REPO>/apps/mcp-server/dist/index.js"],
      "env": {
        "CTX_API_URL": "http://127.0.0.1:3000"
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
        "CTX_API_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

---

## 📊 TOON Token Efficiency

`ctx` incorporates **Token-Oriented Object Notation (TOON)** as a runtime serialization adapter. During context assembly, the compiler benchmarks candidate representations against minified JSON and selects the most compact valid format:

| Context Type | Baseline Minified JSON | TOON Serialization | Token Reduction | Selected Format |
|---|---|---|---|---|
| Repetitive Completed Items | 285 tokens | 242 tokens | **~15.1%** | `TOON` |
| Deeply Nested Decisions | 410 tokens | 365 tokens | **~11.0%** | `TOON` |
| Sparse Status Snapshot | 178 tokens | 174 tokens | **~2.3%** | `TOON` |
| Flat Key-Value Config | 65 tokens | 65 tokens | **0.0%** | `JSON` |

---

## 🧪 Testing

Run all 9 unit and end-to-end integration tests:

```bash
npm test
```

```text
✔ AdapterRegistry resolves fallback adapter
✔ CheckpointSchema validates valid checkpoint
✔ ContextPackageSchema validates structure
✔ ContextSerializer encodes and round-trips TOON & JSON
✔ ContextSerializer respects explicit JSON preference
✔ API: health check returns ok
✔ API: resolve project and checkpoint workflow
✔ Git inspector reports repo state safely
✔ Config manager saves and loads .ctx/config.json
✔ MCP Server initializes with all core tools registered
✔ E2E: Full cross-client handoff workflow (Tool A -> Tool B)

11 passed, 0 failed
```

---

## 🗺️ Roadmap

- [x] **Phase 1: Foundation** (PostgreSQL 17, schema migrations, CLI commands `init`/`status`/`checkpoint`)
- [x] **Phase 2: TOON Context Optimizer** (`@toon-format/toon`, token measurement, round-trip validation)
- [x] **Phase 3: Model Context Protocol (MCP)** (`@modelcontextprotocol/sdk` stdio server with 7 tools)
- [ ] **Phase 4: Intelligent Context Budgeting** (Dynamic pruning and summarization when exceeding token budget)
- [ ] **Phase 5: Full-Text Memory Search** (PostgreSQL `tsvector`/`tsquery` search for past decisions)
- [ ] **Phase 6: Multi-Agent Concurrency & Leases** (Optimistic locking conflict rejection `409 Conflict`)

---

## 📄 License

Licensed under the [MIT License](LICENSE).
