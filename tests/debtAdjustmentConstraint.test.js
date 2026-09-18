/**
 * PostgreSQL integration test — raf.debt_adjustments CHECK constraint.
 *
 * Proves the actual DB constraint rather than in-memory validation.
 * Gated behind three env vars so it never runs accidentally against production.
 *
 * Run with:
 *   RAF_RUN_POSTGRES_RLS_TESTS=true RAF_CONFIRM_NON_PRODUCTION_DB=true \
 *     node --test tests/debtAdjustmentConstraint.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Pool } from 'pg';
import { buildDebtsRepository } from '../lib/repositories/postgres/debtsRepository.js';
import { unlinkDebtFromFinancialAccount } from '../lib/debts/debts.js';

const connectionString = process.env.DATABASE_URL ?? process.env.SUPABASE_DATABASE_URL;
const shouldRun = Boolean(connectionString)
  && process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true'
  && process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';

const maybeTest = shouldRun ? test : test.skip;

// Stable test UUIDs — never collide with real data; rolled back at end.
const WORKSPACE_ID   = 'd0c00000-0000-4000-8000-000000000001';
const OWNER_ID       = 'd0c00000-0000-4000-8000-000000000002';
const DEBT_ID        = 'd0c00000-0000-4000-8000-000000000010';
const ACCOUNT_ID     = 'd0c00000-0000-4000-8000-000000000020';
const LINKED_DEBT_ID = 'd0c00000-0000-4000-8000-000000000030';

async function expectRejectsInSavepoint(client, run) {
  await client.query('SAVEPOINT constraint_expected_rejection');
  try {
    await assert.rejects(run);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT constraint_expected_rejection');
    await client.query('RELEASE SAVEPOINT constraint_expected_rejection');
  }
}

maybeTest('raf.debt_adjustments CHECK constraint — PostgreSQL readiness closure', async () => {
  const pool = new Pool({
    connectionString,
    ssl: process.env.RAF_POSTGRES_SSL === 'false' || process.env.RAF_POSTGRES_SSL === '0'
      ? false
      : { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Bootstrap minimal workspace so RLS and FK constraints are satisfied.
    await client.query(`
      INSERT INTO raf.app_users (id, email, raw_json)
      VALUES ($1, 'debt-constraint-test@example.test', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [OWNER_ID]);

    await client.query(`
      INSERT INTO raf.workspaces (id, name, type, owner_user_id, raw_json)
      VALUES ($1, 'Debt Constraint Test Workspace', 'household', $2, '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [WORKSPACE_ID, OWNER_ID]);

    await client.query(`
      INSERT INTO raf.workspace_members (workspace_id, user_id, role, status, raw_json)
      VALUES ($1, $2, 'owner', 'active', '{}'::jsonb)
      ON CONFLICT (workspace_id, user_id) DO NOTHING
    `, [WORKSPACE_ID, OWNER_ID]);

    // Set RLS context.
    await client.query("SELECT set_config('raf.user_id', $1, true)", [OWNER_ID]);
    await client.query("SELECT set_config('raf.workspace_id', $1, true)", [WORKSPACE_ID]);

    const repo = buildDebtsRepository(client, 'raf');

    // Insert seed debt (manual, no financial account).
    await repo.insertDebt({
      id: DEBT_ID,
      householdId: WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Constraint Test Debt',
      startingBalance: '2000.00',
      apr: '0',
      minimumPayment: '0.00',
      monthlyPayment: '0.00',
      sortOrder: 0,
      isActive: true,
    });

    // Case A — 'correction' persists
    const adjA = await repo.insertDebtAdjustment({
      householdId: WORKSPACE_ID,
      debtId: DEBT_ID,
      amount: '-50.00',
      adjustmentType: 'correction',
      effectiveDate: '2026-09-17',
      note: 'Case A: correction',
    });
    assert.ok(adjA.id, 'Case A: correction adjustment created');

    // Case B — 'interest' persists
    const adjB = await repo.insertDebtAdjustment({
      householdId: WORKSPACE_ID,
      debtId: DEBT_ID,
      amount: '25.00',
      adjustmentType: 'interest',
      effectiveDate: '2026-09-17',
      note: 'Case B: interest',
    });
    assert.ok(adjB.id, 'Case B: interest adjustment created');

    // Case C — 'fee' persists
    const adjC = await repo.insertDebtAdjustment({
      householdId: WORKSPACE_ID,
      debtId: DEBT_ID,
      amount: '15.00',
      adjustmentType: 'fee',
      effectiveDate: '2026-09-17',
      note: 'Case C: fee',
    });
    assert.ok(adjC.id, 'Case C: fee adjustment created');

    // Case D — 'reconciliation' persists (this was the P0 blocker)
    const adjD = await repo.insertDebtAdjustment({
      householdId: WORKSPACE_ID,
      debtId: DEBT_ID,
      amount: '100.00',
      adjustmentType: 'reconciliation',
      effectiveDate: '2026-09-17',
      note: 'Case D: reconciliation (system boundary)',
    });
    assert.ok(adjD.id, 'Case D: reconciliation adjustment created — P0 constraint fix confirmed');

    // Case E — invalid types rejected by DB CHECK constraint
    await expectRejectsInSavepoint(client, () =>
      repo.insertDebtAdjustment({
        householdId: WORKSPACE_ID,
        debtId: DEBT_ID,
        amount: '5.00',
        adjustmentType: 'payment',
        effectiveDate: '2026-09-17',
        note: 'Case E1: payment type (invalid)',
      }),
    );

    await expectRejectsInSavepoint(client, () =>
      repo.insertDebtAdjustment({
        householdId: WORKSPACE_ID,
        debtId: DEBT_ID,
        amount: '39.00',
        adjustmentType: 'late_fee',
        effectiveDate: '2026-09-17',
        note: 'Case E2: late_fee (generated-only, excluded from DB constraint)',
      }),
    );

    // Phase 5 — unlink regression via real PostgreSQL path.
    // Set up: seed a financial account and an account-backed debt.
    await client.query(`
      INSERT INTO raf.financial_accounts
        (id, workspace_id, name, account_type, current_balance, status, created_at, updated_at, raw_json)
      VALUES ($1, $2, 'Constraint Test Card', 'credit_card', '1600.00', 'active', now(), now(), '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [ACCOUNT_ID, WORKSPACE_ID]);

    await repo.insertDebt({
      id: LINKED_DEBT_ID,
      householdId: WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
      financialAccountId: ACCOUNT_ID,
      name: 'Linked Constraint Test Debt',
      startingBalance: '2000.00',
      apr: '0',
      minimumPayment: '0.00',
      monthlyPayment: '0.00',
      sortOrder: 1,
      isActive: true,
    });

    // The ledger has no manual adjustments, so manual-derived balance = startingBalance = 2000.00.
    // confirmedManualBalance is 1800.00 → delta = 1800 - 2000 = -200.00.
    // establishManualAuthorityBoundary must write a 'reconciliation' adjustment of -200.00.
    const testDb = {
      transaction: (fn) => fn(repo),
      ...repo,
    };

    const unlinked = await unlinkDebtFromFinancialAccount({
      db: testDb,
      householdId: WORKSPACE_ID,
      debtId: LINKED_DEBT_ID,
      confirmedManualBalance: '1800.00',
    });

    // Debt must now be manual (no financial account).
    assert.equal(
      unlinked.financialAccountId ?? unlinked.financial_account_id ?? null,
      null,
      'Phase 5: debt is now manual after unlink',
    );

    // Exactly one reconciliation adjustment must exist for the linked debt.
    const linkedAdjustments = await repo.listDebtAdjustments({
      householdId: WORKSPACE_ID,
      debtId: LINKED_DEBT_ID,
    });
    const reconciliation = linkedAdjustments.filter((a) => a.adjustmentType === 'reconciliation');
    assert.equal(reconciliation.length, 1, 'Phase 5: exactly one reconciliation adjustment created');
    assert.equal(reconciliation[0].amount, '-200.00', 'Phase 5: reconciliation amount = 1800 - 2000 = -200.00');

    // Financial account balance must be unchanged (no mutation of account).
    const accountResult = await client.query(
      'SELECT current_balance FROM raf.financial_accounts WHERE id = $1',
      [ACCOUNT_ID],
    );
    assert.equal(
      String(accountResult.rows[0].current_balance),
      '1600.00',
      'Phase 5: financial account balance unchanged after unlink',
    );

    // No debt_payments created during unlink.
    const payments = await repo.listDebtPayments({ householdId: WORKSPACE_ID, debtId: LINKED_DEBT_ID });
    assert.equal(payments.length, 0, 'Phase 5: no payment record created during unlink');

  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
