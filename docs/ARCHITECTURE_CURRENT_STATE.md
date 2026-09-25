# RAF / NOMI Architecture — Current State (Post-PR#38 + PR#39)

**Date**: 2026-09-24  
**Baseline Code SHA**: 27110425d503ed37286519af25af714c2e1c95d1  
**Status**: Reconciled post-convergence and Profile Session UI  
**Previous Baseline**: 64759ced (2026-09-22, pre-PR#38 + PR#39)

---

## Executive Summary

Current main includes:
- **PR #38**: Convergence release (Tracks A, B, D, E)
  - Native RAF password recovery (Track A2)
  - NOMI branding (Track B)
  - Debt dashboard and forecast (Track D)
  - Security and quality hardening (Track E)

- **PR #39**: Profile Session UI adaptation
  - Session-aware authenticated email display
  - Workspace membership transparency
  - Intentionally deferred remiTier presentation (backend reliability gap)

No production deployment has occurred. All changes are in main, available for staged rollout.

---

## Authentication & Session Model

### Current Authority

**Native RAF Authentication**: Active (primary auth)
- Email/password-based login and signup
- Implements password hashing and verification (`lib/auth/password.js`)
- JWT issued and validated by RAF backend (`lib/auth/jwt.js`)
- Session stored in localStorage as JSON

**Password Recovery**: Active (Track A2)
- Email-based password reset enabled
- Recovery token lifetime: 1 hour
- Reset does NOT invalidate existing JWTs (they remain valid until expiry)
- Existing JWTs survive password reset (24-hour lifetime)

**Supabase Auth Wiring**: Parked (not activated)
- Code exists (feature/supabase-auth-wiring branch)
- Fallback path for Supabase OAuth when authProvider='supabase'
- Not integrated into main convergence
- Remains optional future path

### Session Contract

Current `AuthContext.AuthSession`:
```typescript
{
  token: string,                      // JWT
  accessToken?: string,
  refreshToken?: string,
  expiresAt?: number | null,
  userId: string,                     // Required
  email: string,                      // Required, from registration/login (native auth)
  householdId: string,
  householdName: string,
  workspaceId?: string,               // Optional, falls back to householdId
  workspaceName?: string,             // Optional, falls back to householdName
  workspaces?: WorkspaceMembership[],  // Optional array of workspace memberships
  remiTier?: "free" | "paid"         // Optional, UNRELIABLE (see below)
}
```

**Known Issue**: `remiTier` field is typed but not reliably populated at backend. Backend falls back to 'free' when `user.remiTier` is undefined, making display semantically unreliable. Profile UI (PR #39) intentionally omits tier presentation until backend authority clarifies.

---

## Product Naming

- **Nomi**: Current product branding (NOMI)
- **RAF**: Internal system name (Regulatory Allocation Framework)
- **Remi**: AI assistant component (separate service)

Terminology is now consistent across UI (Track B branding complete).

---

## Workspace & Multi-Tenancy

### Model

- Each user belongs to one household (workspace)
- Workspace contains: household members, financial accounts, allocations, goals, debt records
- `workspace_id` is the primary data-scoping dimension for RLS

### Workspace Switching

- `AuthContext.switchWorkspace(workspaceId)` updates active workspace
- Updates session in localStorage + AuthContext
- Triggers `raf:workspace-changed` custom event
- Financial data is re-queried for new workspace

### RLS Enforcement

All household tables scoped by `workspace_id` (primary workspace isolation dimension):
- income_allocations
- debt_accounts
- transaction_splits
- goals
- monthly_reviews
- etc.

Cross-workspace queries are forbidden at every layer (row-level, application, API).

---

## Authentication & Password Recovery Known Issues

### Deferred Items

1. **current_workspace_id() search_path hardening**
   - Status: RESOLVED
   - Implementation: Migration 20260903090000 applies `SET search_path = raf, pg_catalog`
   - Ensures workspace context cannot be bypassed via pg_catalog function lookups

2. **Process-local password-reset rate limiting**
   - Status: Deferred
   - Current: Per-user rate limit via database counter
   - Note: NOT global/distributed
   - Impact: Within-process concurrent resets possible
   - Timeline: Post-release security hardening

3. **JWT invalidation after password reset**
   - Status: Accepted behavior
   - Current: Existing JWTs remain valid until natural expiry (24h)
   - Rationale: Invalidating JWTs at reset time would force re-auth
   - Risk: Low (24h window, user controls reset)

---

## Profile UI & Session Transparency

### PR #39: Session-Aware Profile

Displays authenticated session data:
- **Email**: From session.email (required, always present)
- **Avatar**: First letter of email in primary-color circle
- **Active Workspace**: session.workspaceName or fallback householdName
- **Workspace ID**: Last 8 characters (secondary display)
- **Workspace Memberships**: List of all workspaces user belongs to
  - Shows workspace name, role, status
  - Read-only (no workspace switching from Profile)

### Intentional Omissions

- **Remiiter Badge (Free/Paid)**: Removed (f3f70a9 commit)
  - Reason: Backend remiTier not reliably populated
  - Decision: Omit presentation until backend authority clarifies
  - Not a blocker for Profile release (PR #39 merged cleanly)

---

## Financial Architecture

### Allocation Model

- All money as `Decimal(12,2)` (stored as NUMERIC in PostgreSQL)
- API returns money as string decimals (e.g., `"1250.00"`)
- Allocation percentages stored as fractions: `0.1000 = 10%`
- Active allocation percents sum to `1.0000 ± 0.0001` (enforced on write)
- Rounding remainder routes to `buffer` account

### Debt Model

- Debt balances are **derived** from payment history
- Never stored or manually edited
- Computed from `debt_transactions` (payment history)
- Payment reconciliation via statement imports

### Income & Monthly Lifecycle

- Income source configured with allocation percentages
- `income_allocations` rows are **immutable** after creation
- Editing income entry deletes and recreates allocations (transactional)
- Monthly close: Performs allocation splits, routes buffer surplus

---

## Import Pipeline

### Statement Imports

**Current Mechanism**:
- File upload (PDF, CSV, OFX)
- Merchant rule matching
- Transaction extraction
- Reconciliation with existing transactions

**Known Gap (PR #39 scope)**:
- `importBankStatement` path bypasses file-hash idempotency protection
- Database has file-hash infrastructure but current ingestion doesn't use it
- **Status**: Deferred (separate follow-up)
- **Impact**: Re-importing same file can create duplicate transactions
- **Recommendation**: Verify duplicate detection on UI, add idempotency layer post-release

### Import Reconciliation

- Transactions matched against existing records
- Merchant rules applied automatically
- Manual reconciliation available for uncertain matches

---

## PostgreSQL Architecture

### Migration Runner

- Raw SQL migrations (no Prisma)
- Migrations applied in order by `canonical-migration-runner`
- **Known Limitation**: Live PostgreSQL attestation impossible in current runner
  - Runner verifies migrations against disposable test DB
  - Production schema state cannot be attested without prod access

### Migration Supersession

- Mechanism exists to mark migrations as superseded
- Allows cleanup of broken/invalid migrations without re-running full suite
- Example: Migration 20260313170000 marked superseded via hash-pinned record (PR #36)

---

## Deployment & Hosting

### Current Stack

- **Frontend**: Vite + React 18 with React Router, TypeScript strict
- **Backend**: Express.js / Node.js (Render) with PostgreSQL Row Level Security
- **Database**: PostgreSQL via Supabase/Neon
- **Auth**: Native RAF email/password authentication with RFC JWT validation
- **Error tracking**: Sentry
- **Remi (AI Advisory)**: Co-located subsystem in RAF Express backend (not separately deployed)

### Deployment Authorization

- Main includes all necessary code for staged rollout
- **Production deployment NOT authorized** at this time
- Rollout decisions remain with product team

---

## Known Issues & Deferred Work

### High Priority (Post-Release)

1. **remiTier backend authority** (blocks entitlement presentation)
   - Gap: Backend doesn't guarantee remiTier population
   - Impact: Profile cannot safely display Free/Paid badge
   - PR #39 correctly omits badge until resolved
   - Timeline: Requires backend remiTier sourcing clarification

2. **importBankStatement idempotency**
   - Gap: File-hash protection exists but not applied
   - Impact: Duplicate imports possible
   - Timeline: Post-release implementation

### Medium Priority

4. **Process-local password-reset rate limiting**
   - Gap: Distributed rate limiting not implemented
   - Impact: High-concurrency reset abuse possible (low risk)
   - Timeline: Post-release hardening

5. **Password reset JWT invalidation**
   - Status: Accepted design (not a bug)
   - Rationale: Keep existing JWTs valid (24h) to avoid forced re-auth
   - Timeline: Monitor for abuse, revisit if needed

---

## Testing & Certification

### Current Test Baseline

```
Tests: 1988
Suites: 128
Pass: 1988
Fail: 0
Cancelled: 0
Skipped: 69
```

**Verification**: Regression suite clean on current main. All required CI checks passing.

### Certification Status

- ✅ Typecheck: PASS
- ✅ Lint: PASS
- ✅ Build: PASS
- ✅ Unit tests: PASS
- ✅ Integration tests: PASS
- ✅ RLS enforcement: PASS
- ✅ Responsive design: VERIFIED
- ⏸️ Production deployment: NOT AUTHORIZED

---

## Architecture Decision Record

### Recent Decisions (Post-PR#38 + PR#39)

1. **Password recovery via native RAF** (Track A2)
   - Decision: Implement native RAF password reset
   - Rationale: Native RAF email/password auth requires its own recovery flow; no external provider handles it
   - Status: Implemented, merged PR #38

2. **Profile remiTier badge omission** (PR #39 f3f70a9)
   - Decision: Omit Free/Paid tier presentation
   - Rationale: Backend remiTier unreliable
   - Status: Merged (correct engineering judgment)

3. **Supabase auth wiring deferred**
   - Decision: Keep as optional future path
   - Rationale: Native RAF auth sufficient for MVP
   - Status: Code exists, not activated

---

## Next Steps

### Immediate

- Code is ready for staged production rollout
- Product team makes deployment authorization decision

### Post-Release

1. Clarify remiTier backend authority
2. Add importBankStatement idempotency protection
3. Review password reset rate limiting

---

**Document Version**: 1.1  
**Reconciliation Date**: 2026-09-24  
**Baseline**: main @ 27110425d503ed37286519af25af714c2e1c95d1  
**Status**: Architecture guide reconciled against current code. Ready for team review.
