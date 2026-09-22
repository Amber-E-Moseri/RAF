# Nomi — Personal Finance, Intentionally Allocated

Nomi is a multi-tenant personal finance platform for intentional income allocation, planning, debt management, goals, reconciliation, and financial forecasting.

Most financial tools are designed to explain where money went. Nomi starts one step earlier: helping users decide where income should go, then maintaining a trustworthy financial picture as transactions, accounts, debts, goals, and plans change.

Underneath Nomi is **RAF**, a deterministic financial engine responsible for allocation, financial state, forecasting, and monthly lifecycle behavior. **Remi**, Nomi's AI assistant, operates above that financial authority rather than replacing it.

> **AI can explain financial state. It does not define financial truth.**

---

## Product Preview

_Screenshots coming soon._

---

## What Nomi Does

- **Income allocation** — Distribute income intentionally before it is spent
- **Financial accounts** — Account-backed state, balance tracking, and reconciliation
- **Transactions** — Import, categorize, review, and attribute financial activity
- **Goals** — Connect real transactions to savings and financial goals
- **Debt** — Track obligations, payment pace, and balance trajectory
- **Cash-flow forecasting** — Deterministic 30/60/90-day projections
- **Monthly lifecycle** — Review, close, and preserve monthly financial snapshots
- **Household collaboration** — Multi-user workspaces, roles, invitations, and activity
- **AI-assisted insights** — Remi explains financial state without becoming its source of truth

---

## How It Works

```
React / TypeScript
        │
        ▼
   RAF API (Node.js)
        │
   ┌────┴────┐
   ▼         ▼
PostgreSQL   Remi
+ RLS        AI layer
   │
   ▼
Deterministic
financial state
```

**RAF** owns financial authority: allocation calculations, account balances, goal and debt attribution, forecasts, and monthly close state. The database is the single source of truth.

**Remi** reads from that authoritative state to answer questions, explain changes, and surface insights. It never writes financial state directly.

---

## Architecture

### Financial Authority

- Deterministic Revenue Allocation Formula
- Account and reconciliation infrastructure
- Bank-statement import, review, and duplicate-detection workflows
- Goal and debt transaction attribution
- Obligation-aware debt payment tracking
- Independent payment-pace and balance-trajectory modeling
- Deterministic 30/60/90-day cash-flow forecasting
- Persisted monthly close snapshots

### Multi-Tenant Security

- PostgreSQL Row-Level Security
- Server-established trusted workspace context
- Least-privilege `raf_app` runtime database role
- Workspace membership and role enforcement
- Layered application + database authorization

### Reliability & Operations

- Audit trails
- Structured request logging
- Database readiness checks
- Production error monitoring (Sentry)
- Sensitive-data scrubbing
- Automated financial and tenant-isolation tests

---

## Engineering Highlights

- **Deterministic 30/60/90-day forecasting** — cash-flow projections built from allocated income, scheduled obligations, and goal commitments, not statistical inference
- **PostgreSQL RLS tenant isolation** — every query executes under a trusted workspace context set server-side; no row is visible across tenant boundaries
- **Month-close lifecycle** — a state machine governs review → close → snapshot; persisted snapshots protect historical financial state
- **Transaction reconciliation** — import staging, duplicate detection, and manual review before transactions enter authoritative state
- **Exactly-once protections** — idempotency guards on import and allocation mutations
- **Financial lifecycle certification** — full-year lifecycle test suite exercises RAF across income, allocation, transactions, goals, debts, forecasts, and monthly close

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React · Vite · TypeScript |
| Backend | Node.js |
| Database | PostgreSQL · SQLite (local/test workflows) |
| Security | PostgreSQL RLS · Least-privilege runtime roles |
| Monitoring | Sentry · Structured logging |
| Testing | Node test infrastructure + financial lifecycle and isolation suites |

---

## Running Locally

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
npm install
cp .env.example .env
```

Configure required variables (documented in `.env.example`). For local SQLite-backed workflows:

```env
RAF_DB_PATH=./path/to/raf.db
PORT=3000
```

`PORT` defaults to `3000`. The API validates all required configuration at startup and exits with a clear error if anything is missing.

### Start

```bash
# Frontend
npm run dev

# Backend API
npm run dev:api
```

The API emits structured JSON request logs for route-level observability.

### Seed Demo Data

```bash
npm run seed:demo
```

---

## Testing & Certification

```bash
npm test
```

Run selected high-impact financial engine tests:

```bash
node --test \
  tests/financialHealthScore.unit.test.js \
  tests/trajectoryEngine.unit.test.js \
  tests/surplusAllocation.unit.test.js
```

**Certification:** Full-year financial lifecycle certification completed — [RAF_FINAL_CERTIFICATION.md](docs/testing/RAF_FINAL_CERTIFICATION.md)

**Release validation gates:** PostgreSQL, RLS, tenant-isolation, financial lifecycle, typecheck, build, and hosted CI.

---

## Design Principles

**Financial truth should be deterministic.**
Core financial state comes from explicit domain rules, not probabilistic AI output.

**Security should exist below the UI.**
Tenant isolation is enforced through trusted server context and PostgreSQL policies — not frontend filtering.

**Explainability matters.**
A financial system should be able to explain why balances, forecasts, debt trajectories, and allocations changed.

**Architecture should follow the financial model.**
The goal is a coherent and trustworthy representation of a household's financial state, not a growing list of features.

---

## Documentation

- [SPECIFICATION.md](SPECIFICATION.md) — Product specification and feature matrix
- [RAF_FINAL_CERTIFICATION.md](docs/testing/RAF_FINAL_CERTIFICATION.md) — Phase 8 certification report
- [docs/financial-authority-map.md](docs/financial-authority-map.md) — Financial authority boundaries
- [docs/month-lifecycle-authority.md](docs/month-lifecycle-authority.md) — Month-close workflow state machine

---

[github.com/Amber-E-Moseri/raf_app](https://github.com/Amber-E-Moseri/raf_app)
