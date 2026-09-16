# RAF App

RAF (Resource Allocation Framework) is a deposit-driven financial allocation app with a Vite + React frontend and a Node API backend.

**Status:** Phase 8 Full-Year Lifecycle Certification Complete ✅  
**Certification:** RAF READY WITH DOCUMENTED LIMITATIONS  
**Test Results:** 1,569 passing / 0 failing / 26 skipped  
**Documentation:** [RAF_FINAL_CERTIFICATION.md](docs/testing/RAF_FINAL_CERTIFICATION.md)

## Prerequisites

- Node.js 20+
- npm

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a local environment file:

```bash
cp .env.example .env
```

3. Ensure required variables are present in `.env`:

- `RAF_DB_PATH` (required) - relative or absolute path to SQLite DB file
- `PORT` (optional, defaults to `3000`)

The API validates env vars at startup and exits with a clear error if they are missing or invalid.

## Run Locally

Frontend (Vite):

```bash
npm run dev
```

Backend API:

```bash
npm run dev:api
```

The API emits structured JSON request logs for route-level observability.

## Seed Demo Data

Populate a local database with demo household data:

```bash
npm run seed:demo
```

## Tests

Run all tests:

```bash
npm test
```

Run the high-impact maintainability tests added in this pass:

```bash
node --test tests/financialHealthScore.unit.test.js tests/trajectoryEngine.unit.test.js tests/surplusAllocation.unit.test.js
```

