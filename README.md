# Nomi — Resource Allocation Framework

A multi-tenant personal finance platform for intentional income allocation, financial planning, and stewardship.

Nomi is built around a simple idea: instead of only explaining where money went, help users decide where money should go — then maintain a trustworthy financial picture as income, spending, debt, goals, and accounts change.

At its core is a deterministic allocation engine that keeps financial authority separate from AI-generated guidance.

**AI can explain financial state. It does not define financial truth.**

---

## What Nomi Handles

- **Income allocation** — Plan how incoming money should be distributed before it is spent
- **Financial accounts** — Track account-backed financial state and reconciliation
- **Transactions** — Import, categorize, review, and attribute financial activity
- **Goals** — Connect real transactions to savings and financial goals
- **Debt** — Track obligations, payment pace, and balance trajectory
- **Cash-flow forecasting** — Deterministic 30/60/90-day projections
- **Monthly lifecycle** — Review, close, and preserve immutable monthly financial snapshots
- **Household collaboration** — Multi-user workspaces, roles, invitations, and activity
- **AI-assisted insights** — Explain financial state without allowing AI to become the financial source of truth

---

## Architecture

Nomi is designed around financial correctness, tenant isolation, and explicit sources of truth.

### Multi-Tenant Security

- PostgreSQL Row-Level Security
- Server-established trusted workspace context
- Least-privilege `raf_app` runtime database role
- Workspace membership and role enforcement
- Layered application + database authorization

### Financial Domain

- Deterministic Revenue Allocation Formula
- Financial account and reconciliation infrastructure
- Bank-statement imports with duplicate detection
- Goal and debt transaction attribution
- Obligation-aware debt payment tracking
- Independent payment-pace and balance-trajectory modeling
- Deterministic cash-flow forecasting
- Immutable monthly review snapshots

### Reliability & Operations

- Audit trails
- Structured request logging
- Database readiness checks
- Production error monitoring
- Sensitive-data scrubbing
- Automated financial and tenant-isolation tests

---

## Certification

**Status:** Phase 8 Full-Year Lifecycle Certification Complete ✅

**Certification:** RAF (underlying framework) READY WITH DOCUMENTED LIMITATIONS

**Test Results:** 1,569 passing · 0 failing · 26 skipped

**Documentation:** [RAF_FINAL_CERTIFICATION.md](docs/testing/RAF_FINAL_CERTIFICATION.md)

The certification suite exercises Nomi's core financial engine (RAF) across a full financial-year lifecycle rather than validating features only in isolation.

---

## Tech Stack

- **Frontend:** React · Vite · TypeScript
- **Backend:** Node.js
- **Database:** PostgreSQL · SQLite for supported local/test workflows
- **Security:** PostgreSQL RLS · Least-privilege runtime roles
- **Monitoring:** Sentry · Structured logging
- **Testing:** Node test infrastructure + financial lifecycle and isolation suites

---

## Prerequisites

- Node.js 20+
- npm

---

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a local environment file:

```bash
cp .env.example .env
```

3. Configure required environment variables (documented in `.env.example`):

For local SQLite-backed workflows:

```env
RAF_DB_PATH=./path/to/raf.db
PORT=3000
```

`PORT` is optional and defaults to `3000`.

The API validates required environment configuration at startup and exits with a clear error when configuration is missing or invalid.

---

## Run Locally

**Frontend:**

```bash
npm run dev
```

**Backend API:**

```bash
npm run dev:api
```

The API emits structured JSON request logs for route-level observability.

---

## Seed Demo Data

Populate a local database with demo household data:

```bash
npm run seed:demo
```

---

## Tests

Run the complete test suite:

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

**Current certified baseline:**

```text
1,569 passing
0 failing
26 skipped
```

---

## Design Philosophy

Nomi follows a few core principles:

**Financial truth should be deterministic.**
Core financial state comes from explicit domain rules, not probabilistic AI output.

**Security should exist below the UI.**
Tenant isolation is enforced through trusted server context and PostgreSQL policies rather than relying only on frontend filtering.

**Explainability matters.**
A financial system should be able to explain why balances, forecasts, debt trajectories, and allocations changed.

**Architecture should follow the financial model.**
The goal isn't to accumulate features. It's to maintain a coherent and trustworthy representation of a household's financial state.

---

## Current Direction

Nomi continues to deepen around:

- Financial lifecycle correctness
- Forecast explainability
- Debt and goal intelligence
- Reconciliation
- Multi-user household collaboration
- Financial-health modeling
- AI-assisted interpretation over deterministic financial state

---

## Repository

[github.com/Amber-E-Moseri/raf_app](https://github.com/Amber-E-Moseri/raf_app)

---

## Documentation

- [SPECIFICATION.md](SPECIFICATION.md) — Product specification and feature matrix
- [RAF_FINAL_CERTIFICATION.md](docs/testing/RAF_FINAL_CERTIFICATION.md) — Phase 8 certification report
- [docs/financial-authority-map.md](docs/financial-authority-map.md) — Financial authority boundaries
- [docs/month-lifecycle-authority.md](docs/month-lifecycle-authority.md) — Workflow state machine
