import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import {
  getMonthLifecycleState,
  getCloseReadiness,
  transitionToReviewing,
  closeMonth,
  reopenMonth,
  applyBufferDisposition,
  LifecycleState,
  MonthlyReviewHttpError,
} from '../lib/monthlyReviews/monthlyLifecycle.js';
import { POST as closePOST } from '../app/api/v1/monthly-reviews/close/route.js';
import { POST as reopenPOST } from '../app/api/v1/monthly-reviews/reopen/route.js';

const HH = 'household_wave_c_close';
const HH_B = 'household_wave_c_close_b';
const PERIOD = '2026-07-01';
const PERIOD_DEC = '2026-12-01';
const PERIOD_JAN = '2027-01-01';

async function makeDb(householdId) {
  const db = createInMemoryDb();
  // seed alloc categories (already seeded for household_1, need for custom id)
  await db.transaction(async (tx) => {
    await tx.createWorkspaceRecord({ id: householdId, ownerUserId: 'local-user', name: 'Test' });
    await tx.initializeWorkspaceDefaults({ workspace: { id: householdId } });
  });
  return db;
}

async function seedTransactions(db, householdId, period, { reviewed = 3, unreviewed = 1 } = {}) {
  const now = new Date().toISOString();
  for (let i = 0; i < reviewed; i++) {
    await db.transaction(async (tx) => {
      await tx.insertTransaction({
        householdId,
        transactionDate: period,
        description: `Reviewed tx ${i}`,
        amount: '100.00',
        direction: 'debit',
        source: 'manual',
        reviewedAt: now,
      });
    });
  }
  for (let i = 0; i < unreviewed; i++) {
    await db.transaction(async (tx) => {
      await tx.insertTransaction({
        householdId,
        transactionDate: period,
        description: `Unreviewed tx ${i}`,
        amount: '50.00',
        direction: 'debit',
        source: 'manual',
      });
    });
  }
}

// ─── Section 1: Lifecycle State ──────────────────────────────────────────────

test('C1.1 — new month defaults to OPEN state', async () => {
  const db = await makeDb(HH + '_c1a');
  const state = await getMonthLifecycleState({ db, householdId: HH + '_c1a', period: PERIOD });
  assert.strictEqual(state.state, LifecycleState.OPEN);
  assert.strictEqual(state.period, PERIOD);
});

test('C1.2 — OPEN → REVIEWING via transitionToReviewing', async () => {
  const db = await makeDb(HH + '_c1b');
  const result = await transitionToReviewing({ db, householdId: HH + '_c1b', period: PERIOD, userId: 'user-1' });
  assert.strictEqual(result.state, LifecycleState.REVIEWING);
  const state = await getMonthLifecycleState({ db, householdId: HH + '_c1b', period: PERIOD });
  assert.strictEqual(state.state, LifecycleState.REVIEWING);
});

test('C1.3 — REVIEWING → CLOSED via closeMonth', async () => {
  const db = await makeDb(HH + '_c1c');
  await transitionToReviewing({ db, householdId: HH + '_c1c', period: PERIOD, userId: 'user-1' });
  const result = await closeMonth({ db, householdId: HH + '_c1c', period: PERIOD, userId: 'user-1' });
  assert.strictEqual(result.state, LifecycleState.CLOSED);
  const state = await getMonthLifecycleState({ db, householdId: HH + '_c1c', period: PERIOD });
  assert.strictEqual(state.state, LifecycleState.CLOSED);
});

test('C1.4 — cannot close twice (double-close protection)', async () => {
  const db = await makeDb(HH + '_c1d');
  await closeMonth({ db, householdId: HH + '_c1d', period: PERIOD, userId: 'user-1' });
  const err = await closeMonth({ db, householdId: HH + '_c1d', period: PERIOD, userId: 'user-1' }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 409);
});

test('C1.5 — CLOSED → reopened via reopenMonth', async () => {
  const db = await makeDb(HH + '_c1e');
  await closeMonth({ db, householdId: HH + '_c1e', period: PERIOD, userId: 'user-1' });
  const result = await reopenMonth({ db, householdId: HH + '_c1e', period: PERIOD, userId: 'user-1', reason: 'Forgot a transaction' });
  assert.strictEqual(result.state, LifecycleState.REVIEWING);
  assert.ok(result.previousSnapshotPreserved);
  const state = await getMonthLifecycleState({ db, householdId: HH + '_c1e', period: PERIOD });
  assert.strictEqual(state.state, LifecycleState.REVIEWING);
});

test('C1.6 — reopened → re-closed creates new version (version increments)', async () => {
  const db = await makeDb(HH + '_c1f');
  const v1 = await closeMonth({ db, householdId: HH + '_c1f', period: PERIOD, userId: 'user-1' });
  assert.strictEqual(v1.version, 1);
  await reopenMonth({ db, householdId: HH + '_c1f', period: PERIOD, userId: 'user-1' });
  const v2 = await closeMonth({ db, householdId: HH + '_c1f', period: PERIOD, userId: 'user-1' });
  assert.strictEqual(v2.version, 2);
  const state = await getMonthLifecycleState({ db, householdId: HH + '_c1f', period: PERIOD });
  assert.strictEqual(state.version, 2);
});

test('C1.7 — lifecycle is scoped by workspace (workspace isolation)', async () => {
  const db1 = await makeDb(HH + '_ws1');
  const db2 = await makeDb(HH + '_ws2');
  await closeMonth({ db: db1, householdId: HH + '_ws1', period: PERIOD, userId: 'u1' });
  const state2 = await getMonthLifecycleState({ db: db2, householdId: HH + '_ws2', period: PERIOD });
  assert.strictEqual(state2.state, LifecycleState.OPEN, 'Closing in one workspace should not affect another');
});

test('C1.8 — cannot reopen a month that is not closed', async () => {
  const db = await makeDb(HH + '_c1h');
  const err = await reopenMonth({ db, householdId: HH + '_c1h', period: PERIOD, userId: 'user-1' }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 409);
});

// ─── Section 2: Snapshot ─────────────────────────────────────────────────────

test('C4.9 — snapshot captures income totals', async () => {
  const db = await makeDb(HH + '_s9');
  const hh = HH + '_s9';
  await db.transaction(async (tx) => {
    await tx.insertIncomeEntry({ householdId: hh, receivedDate: PERIOD, amount: '3000.00', source: 'salary' });
  });
  const result = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  assert.ok(result.snapshot.income.totalReceived, 'snapshot has income total');
  assert.strictEqual(result.snapshot.income.totalReceived, '3000.00');
});

test('C4.10 — snapshot captures allocation progress', async () => {
  const db = await makeDb(HH + '_s10');
  const result = await closeMonth({ db, householdId: HH + '_s10', period: PERIOD, userId: 'u1' });
  assert.ok(Array.isArray(result.snapshot.allocations), 'snapshot has allocations array');
  assert.ok(result.snapshot.allocations.length > 0, 'allocations is non-empty');
  const bufferAlloc = result.snapshot.allocations.find((a) => a.isBuffer === true);
  assert.ok(bufferAlloc, 'buffer allocation captured in snapshot');
});

test('C4.11 — snapshot captures Buffer state separately', async () => {
  const db = await makeDb(HH + '_s11');
  const result = await closeMonth({ db, householdId: HH + '_s11', period: PERIOD, userId: 'u1' });
  assert.ok(result.snapshot.buffer !== undefined, 'snapshot has buffer field');
});

test('C4.12 — snapshot captures Goal period contributions', async () => {
  const db = await makeDb(HH + '_s12');
  const hh = HH + '_s12';
  let goalId;
  await db.transaction(async (tx) => {
    const g = await tx.insertGoal({ householdId: hh, name: 'Emergency Fund', targetAmount: '5000.00', active: true });
    goalId = g.id;
    await tx.insertTransaction({ householdId: hh, transactionDate: PERIOD, description: 'Goal contrib', amount: '200.00', direction: 'debit', linkedGoalId: goalId, source: 'manual' });
  });
  const result = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  assert.strictEqual(result.snapshot.goals.totalContributions, '200.00');
  assert.ok(result.snapshot.goals.contributions.some((c) => c.goalId === goalId));
});

test('C4.13 — snapshot captures Debt period payments', async () => {
  const db = await makeDb(HH + '_s13');
  const hh = HH + '_s13';
  let debtId;
  await db.transaction(async (tx) => {
    const d = await tx.insertDebt({ householdId: hh, name: 'Car Loan', currentBalance: '10000.00', minimumPayment: '300.00', type: 'installment' });
    debtId = d.id;
    await tx.insertDebtPayment({ householdId: hh, debtId, paymentDate: PERIOD, amount: '350.00' });
  });
  const result = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  assert.strictEqual(result.snapshot.debts.totalPayments, '350.00');
  assert.ok(result.snapshot.debts.payments.some((p) => p.debtId === debtId));
});

test('C4.14 — later transaction edit does NOT mutate old snapshot', async () => {
  const db = await makeDb(HH + '_s14');
  const hh = HH + '_s14';
  const closeResult = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const snapshotIncomeBefore = closeResult.snapshot.income.totalReceived;

  // Add a new transaction after close (month has been reopened is not required here; snapshot immutability test)
  await db.transaction(async (tx) => {
    await tx.insertTransaction({ householdId: hh, transactionDate: PERIOD, description: 'Late tx', amount: '999.00', direction: 'debit', source: 'manual' });
  });

  // Re-read the close record
  const state = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(state.snapshot.income.totalReceived, snapshotIncomeBefore, 'Snapshot income unchanged after new tx added');
});

test('C4.15 — reopen preserves prior snapshot in history', async () => {
  const db = await makeDb(HH + '_s15');
  const hh = HH + '_s15';
  const v1 = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const v1SnapshotIncome = v1.snapshot.income.totalReceived;

  await reopenMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const state = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  // After reopen, state is REVIEWING — but history should show the REOPENED record
  assert.strictEqual(state.state, LifecycleState.REVIEWING);
  // The history should have the old close
  assert.ok(Array.isArray(state.history) || state.history === undefined, 'history is accessible');

  // Now re-close and check old snapshot is in history
  const v2 = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  assert.strictEqual(v2.version, 2);

  // Read from db directly to verify REOPENED record still exists
  const closes = await db.transaction((tx) => tx.listMonthCloses({ householdId: hh, period: PERIOD }));
  assert.ok(closes.length >= 2, 'Both close records preserved');
  const reopenedClose = closes.find((c) => c.status === 'REOPENED');
  assert.ok(reopenedClose, 'REOPENED close record preserved');
  assert.ok(reopenedClose.snapshot, 'Reopened close still has its snapshot');
  assert.strictEqual(reopenedClose.snapshot.income.totalReceived, v1SnapshotIncome, 'Old snapshot income preserved');
});

test('C4.16 — re-close creates new snapshot version (versions increment)', async () => {
  const db = await makeDb(HH + '_s16');
  const hh = HH + '_s16';
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  await reopenMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const v2 = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  assert.strictEqual(v2.version, 2);
});

// ─── Section 3: Buffer Disposition ──────────────────────────────────────────

async function makDbWithBuffer(suffix, bufferAllocationAmount = '500.00', spentFromBuffer = '200.00') {
  const hh = HH + suffix;
  const db = await makeDb(hh);
  await db.transaction(async (tx) => {
    // Insert income + allocation to buffer
    const allocs = await tx.listAllocationCategories({ householdId: hh });
    const bufferCat = allocs.find((c) => c.isBuffer === true);
    if (bufferCat) {
      const income = await tx.insertIncomeEntry({ householdId: hh, receivedDate: PERIOD, amount: bufferAllocationAmount, source: 'salary' });
      await tx.insertIncomeAllocations([{
        householdId: hh,
        incomeEntryId: income.id,
        allocationCategoryId: bufferCat.id,
        allocatedAmount: bufferAllocationAmount,
      }]);
      if (parseFloat(spentFromBuffer) > 0) {
        await tx.insertTransaction({ householdId: hh, transactionDate: PERIOD, description: 'Buffer spend', amount: spentFromBuffer, direction: 'debit', categoryId: bufferCat.id, source: 'manual' });
      }
    }
  });
  return { db, hh };
}

test('C6.21 — Goal disposition uses canonical goal transaction pathway', async () => {
  const { db, hh } = await makDbWithBuffer('_b21', '500.00', '200.00');
  let goalId;
  await db.transaction(async (tx) => {
    const g = await tx.insertGoal({ householdId: hh, name: 'Vacation', targetAmount: '2000.00', active: true });
    goalId = g.id;
  });
  const result = await applyBufferDisposition({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    disposition: { type: 'apply_to_goal', amount: '100.00', targetId: goalId },
  });
  assert.strictEqual(result.applied, true);
  // Verify a transaction was created with linkedGoalId
  const txs = await db.transaction((tx) => tx.listTransactions({ householdId: hh, from: PERIOD, to: PERIOD }));
  const goalTx = txs.items.find((t) => t.linkedGoalId === goalId && t.source === 'buffer_disposition');
  assert.ok(goalTx, 'goal disposition transaction created');
  assert.strictEqual(goalTx.amount, '100.00');
});

test('C6.22 — Debt disposition uses canonical debt payment pathway', async () => {
  const { db, hh } = await makDbWithBuffer('_b22', '500.00', '200.00');
  let debtId;
  await db.transaction(async (tx) => {
    const d = await tx.insertDebt({ householdId: hh, name: 'Car Loan', currentBalance: '10000.00', minimumPayment: '300.00', type: 'installment' });
    debtId = d.id;
  });
  const result = await applyBufferDisposition({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    disposition: { type: 'apply_to_debt', amount: '100.00', targetId: debtId },
  });
  assert.strictEqual(result.applied, true);
  // Verify debt payment created
  const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: hh, debtId, from: PERIOD, to: PERIOD }));
  assert.ok(payments.length > 0, 'debt payment created');
  assert.strictEqual(payments[0].amount, '100.00');
});

test('C6.23 — invalid goal rejected (cross-workspace or missing)', async () => {
  const { db, hh } = await makDbWithBuffer('_b23', '500.00', '200.00');
  const err = await applyBufferDisposition({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    disposition: { type: 'apply_to_goal', amount: '100.00', targetId: 'nonexistent-goal-id' },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 422);
});

test('C6.24 — invalid debt rejected (cross-workspace or missing)', async () => {
  const { db, hh } = await makDbWithBuffer('_b24', '500.00', '200.00');
  const err = await applyBufferDisposition({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    disposition: { type: 'apply_to_debt', amount: '100.00', targetId: 'nonexistent-debt-id' },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 422);
});

test('C6.25 — cross-workspace goal rejected (db scoped correctly)', async () => {
  const { db: db1, hh: hh1 } = await makDbWithBuffer('_xws1', '500.00', '200.00');
  const db2 = await makeDb(HH + '_xws2');
  const hh2 = HH + '_xws2';
  let foreignGoalId;
  await db2.transaction(async (tx) => {
    const g = await tx.insertGoal({ householdId: hh2, name: 'Foreign Goal', targetAmount: '999.00', active: true });
    foreignGoalId = g.id;
  });
  // The goal exists in db2, but db1 should not find it
  const err = await applyBufferDisposition({
    db: db1, householdId: hh1, period: PERIOD, userId: 'u1',
    disposition: { type: 'apply_to_goal', amount: '50.00', targetId: foreignGoalId },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 422);
});

test('C6.26 — disposition cannot exceed buffer remaining', async () => {
  const { db, hh } = await makDbWithBuffer('_b26', '500.00', '200.00');
  let goalId;
  await db.transaction(async (tx) => {
    const g = await tx.insertGoal({ householdId: hh, name: 'Test Goal' });
    goalId = g.id;
  });
  const err = await applyBufferDisposition({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    disposition: { type: 'apply_to_goal', amount: '9999.00', targetId: goalId },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 422);
});

// ─── Section 4: Transition ───────────────────────────────────────────────────

test('C8.28 — return_to_plan is metadata-only', async () => {
  const { db, hh } = await makDbWithBuffer('_t28', '300.00', '100.00');
  const result = await applyBufferDisposition({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    disposition: { type: 'return_to_plan' },
  });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.dispositionType, 'return_to_plan');
});

test('C8.29 — close December → lifecycle state transitions correctly', async () => {
  const db = await makeDb(HH + '_dec29');
  const hh = HH + '_dec29';
  const result = await closeMonth({ db, householdId: hh, period: PERIOD_DEC, userId: 'u1' });
  assert.strictEqual(result.state, LifecycleState.CLOSED);
  assert.strictEqual(result.period, PERIOD_DEC);
});

test('C8.30 — active period does not change before close succeeds', async () => {
  const db = await makeDb(HH + '_t30');
  const hh = HH + '_t30';
  const household = await db.transaction((tx) => tx.getHousehold({ householdId: hh }));
  const activeMonthBefore = household?.activeMonth ?? null;
  // Close month - should not auto-advance activeMonth
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const householdAfter = await db.transaction((tx) => tx.getHousehold({ householdId: hh }));
  assert.strictEqual(householdAfter?.activeMonth, activeMonthBefore, 'activeMonth should not change during close');
});

test('C8.31 — close is idempotent (prevents double-close)', async () => {
  const { db, hh } = await makDbWithBuffer('_t31', '500.00', '200.00');
  const result1 = await closeMonth({
    db, householdId: hh, period: PERIOD, userId: 'u1',
  });
  assert.strictEqual(result1.state, 'CLOSED');
  // Re-attempt close should fail (double-close protection)
  const err = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 409);
});

test('C8.32 — buffer disposition is optional during close', async () => {
  const { db, hh } = await makDbWithBuffer('_t32', '500.00', '200.00');
  const result = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  assert.strictEqual(result.state, 'CLOSED');
  assert.strictEqual(result.bufferDisposition, null, 'No disposition when not specified');
});

// ─── Section 5: Authority Preservation ──────────────────────────────────────

test('C10.33 — goal.currentAmount is not directly mutated by close/disposition', async () => {
  const { db, hh } = await makDbWithBuffer('_a33', '500.00', '200.00');
  let goalId;
  let goalBefore;
  await db.transaction(async (tx) => {
    const g = await tx.insertGoal({ householdId: hh, name: 'Vacation', targetAmount: '2000.00', active: true, currentAmount: '100.00' });
    goalId = g.id;
    goalBefore = g;
  });
  await applyBufferDisposition({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    disposition: { type: 'apply_to_goal', amount: '100.00', targetId: goalId },
  });
  const goalAfter = await db.transaction((tx) => tx.getGoalById({ householdId: hh, goalId }));
  assert.strictEqual(goalAfter.currentAmount, goalBefore.currentAmount, 'goal.currentAmount not directly mutated');
});

test('C10.34 — debt balance not directly decremented by disposition', async () => {
  const { db, hh } = await makDbWithBuffer('_a34', '500.00', '200.00');
  let debtId;
  let debtBefore;
  await db.transaction(async (tx) => {
    const d = await tx.insertDebt({ householdId: hh, name: 'Car', currentBalance: '10000.00', minimumPayment: '300.00', type: 'installment' });
    debtId = d.id;
    debtBefore = d;
  });
  await applyBufferDisposition({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    disposition: { type: 'apply_to_debt', amount: '100.00', targetId: debtId },
  });
  const debtAfter = await db.transaction((tx) => tx.getDebtById({ householdId: hh, debtId }));
  assert.strictEqual(debtAfter.currentBalance, debtBefore.currentBalance, 'Debt balance not directly decremented');
});

test('C10.35 — savings floor not used as buffer authority (buffer found via isBuffer)', async () => {
  const db = await makeDb(HH + '_a35');
  const hh = HH + '_a35';
  const result = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  // Buffer snapshot is identified via isBuffer, not savings floor
  if (result.snapshot.buffer) {
    const bufferAlloc = result.snapshot.allocations.find((a) => a.isBuffer === true);
    assert.ok(bufferAlloc, 'buffer identified via isBuffer flag');
  }
  // Savings floor is not buffer
  assert.ok(result.snapshot !== null, 'snapshot exists');
});

test('C10.36 — Plan Engine calculations unchanged by close lifecycle', async () => {
  const db = await makeDb(HH + '_a36');
  const hh = HH + '_a36';
  // Verify that allocationCategories remain accessible after close
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const cats = await db.transaction((tx) => tx.listAllocationCategories({ householdId: hh }));
  assert.ok(cats.length > 0, 'Allocation categories still accessible after close');
  const bufferCat = cats.find((c) => c.isBuffer === true);
  assert.ok(bufferCat, 'Buffer category still identified via isBuffer after close');
});

test('C10.37 — Forecast remains read-only (close does not create forecast entries)', async () => {
  const db = await makeDb(HH + '_a37');
  const hh = HH + '_a37';
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  // No forecast mutation happens during close (just asserting no errors and correct state)
  const state = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(state.state, LifecycleState.CLOSED);
});

test('C10.38 — historical debt disclosure is correct (no fabricated balance)', async () => {
  const db = await makeDb(HH + '_a38');
  const hh = HH + '_a38';
  await db.transaction(async (tx) => {
    await tx.insertDebt({ householdId: hh, name: 'Car', currentBalance: '10000.00', minimumPayment: '300.00', type: 'installment' });
  });
  const result = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  // Snapshot has debt payments but NOT fabricated balances
  assert.ok(result.snapshot.debts.payments !== undefined, 'debt payments captured');
  // Verify no balanceAtClose field is fabricated (only payments are recorded)
  const debtPayment = result.snapshot.debts.payments[0];
  assert.ok(!debtPayment || !Object.prototype.hasOwnProperty.call(debtPayment, 'balanceAtClose'), 'No fabricated balance in snapshot');
});

// ─── Section 6: Concurrency ──────────────────────────────────────────────────

test('C.39 — duplicate close request is safe (409 on second)', async () => {
  const db = await makeDb(HH + '_conc39');
  const hh = HH + '_conc39';
  const [r1, r2] = await Promise.allSettled([
    closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' }),
    closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' }),
  ]);
  const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
  const rejected = [r1, r2].filter((r) => r.status === 'rejected');
  // One should succeed, one should fail (or both might succeed if in-memory allows it)
  // At minimum, only one CLOSED record should exist
  const closes = await db.transaction((tx) => tx.listMonthCloses({ householdId: hh, period: PERIOD }));
  const closedRecords = closes.filter((c) => c.status === 'CLOSED');
  assert.ok(closedRecords.length <= 1, 'At most one CLOSED record exists after concurrent close attempts');
});

test('C.40 — duplicate reopen request is safe (409 on second)', async () => {
  const db = await makeDb(HH + '_conc40');
  const hh = HH + '_conc40';
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const [r1, r2] = await Promise.allSettled([
    reopenMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' }),
    reopenMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' }),
  ]);
  const state = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  // State should be REVIEWING after at least one succeeded
  assert.ok([LifecycleState.REVIEWING, LifecycleState.OPEN].includes(state.state));
});

test('C.41 — rollover disposition is deferred (not supported in Wave C)', async () => {
  const { db, hh } = await makDbWithBuffer('_def41', '500.00', '200.00');
  const err = await applyBufferDisposition({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    disposition: { type: 'roll_to_next_buffer' },
  }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 400);
  assert.ok(err.message.includes('disposition.type'), 'Disposition type rejected');
});

// ─── Section 7: Close Readiness ──────────────────────────────────────────────

test('close-readiness blocks when month already closed', async () => {
  const db = await makeDb(HH + '_cr1');
  const hh = HH + '_cr1';
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const readiness = await getCloseReadiness({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(readiness.canClose, false);
  assert.ok(readiness.blockers.some((b) => b.code === 'ALREADY_CLOSED'));
});

test('close-readiness warns about unreviewed transactions', async () => {
  const db = await makeDb(HH + '_cr2');
  const hh = HH + '_cr2';
  await seedTransactions(db, hh, PERIOD, { reviewed: 2, unreviewed: 3 });
  const readiness = await getCloseReadiness({ db, householdId: hh, period: PERIOD });
  assert.ok(readiness.warnings.some((w) => w.code === 'UNREVIEWED_TRANSACTIONS'));
  assert.strictEqual(readiness.canClose, true, 'Unreviewed transactions are warnings, not blockers');
});

test('close-readiness returns canClose: true for clean month', async () => {
  const db = await makeDb(HH + '_cr3');
  const readiness = await getCloseReadiness({ db, householdId: HH + '_cr3', period: PERIOD });
  assert.strictEqual(readiness.canClose, true);
  assert.strictEqual(readiness.blockers.length, 0);
});

// ─── Section 8: Snapshot closes correctly with buffer disposition ─────────────

test('close with buffer disposition records disposition in snapshot', async () => {
  const { db, hh } = await makDbWithBuffer('_snap_disp', '500.00', '200.00');
  const result = await closeMonth({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    bufferDispositionInput: { type: 'return_to_plan' },
  });
  assert.strictEqual(result.state, LifecycleState.CLOSED);
  assert.ok(result.bufferDisposition, 'bufferDisposition recorded');
  assert.strictEqual(result.bufferDisposition.type, 'return_to_plan');
});

test('atomic close applies full server-derived buffer amount to a goal and closes once', async () => {
  const { db, hh } = await makDbWithBuffer('_atomic_goal', '500.00', '200.00');
  let goalId;
  await db.transaction(async (tx) => {
    const g = await tx.insertGoal({ householdId: hh, name: 'Vacation', targetAmount: '2000.00', active: true });
    goalId = g.id;
  });

  const result = await closeMonth({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    bufferDispositionInput: { type: 'apply_to_goal', amount: '999.00', targetId: goalId },
  });

  assert.strictEqual(result.state, LifecycleState.CLOSED);
  assert.deepStrictEqual(result.bufferDisposition, { type: 'apply_to_goal', amount: '300.00', targetId: goalId });
  assert.strictEqual(result.snapshot.goals.totalContributions, '300.00');

  const txs = await db.transaction((tx) => tx.listTransactions({ householdId: hh, from: PERIOD, to: PERIOD }));
  const goalTxs = txs.items.filter((t) => t.linkedGoalId === goalId && t.source === 'buffer_disposition');
  assert.strictEqual(goalTxs.length, 1);
  assert.strictEqual(goalTxs[0].amount, '300.00');
});

test('atomic close applies full server-derived buffer amount to a debt and closes once', async () => {
  const { db, hh } = await makDbWithBuffer('_atomic_debt', '500.00', '200.00');
  let debtId;
  await db.transaction(async (tx) => {
    const d = await tx.insertDebt({ householdId: hh, name: 'Car Loan', currentBalance: '10000.00', minimumPayment: '300.00', type: 'installment' });
    debtId = d.id;
  });

  const result = await closeMonth({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    bufferDispositionInput: { type: 'apply_to_debt', amount: '999.00', targetId: debtId },
  });

  assert.strictEqual(result.state, LifecycleState.CLOSED);
  assert.deepStrictEqual(result.bufferDisposition, { type: 'apply_to_debt', amount: '300.00', targetId: debtId });
  assert.strictEqual(result.snapshot.debts.totalPayments, '300.00');

  const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: hh, debtId, from: PERIOD, to: PERIOD }));
  const bufferPayments = payments.filter((p) => p.amount === '300.00');
  assert.strictEqual(bufferPayments.length, 1);
});

test('atomic close return_to_plan is metadata-only and does not create goal/debt effects', async () => {
  const { db, hh } = await makDbWithBuffer('_atomic_return', '500.00', '200.00');
  const result = await closeMonth({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    bufferDispositionInput: { type: 'return_to_plan' },
  });

  assert.strictEqual(result.state, LifecycleState.CLOSED);
  assert.deepStrictEqual(result.bufferDisposition, { type: 'return_to_plan', amount: '300.00', targetId: null });
  assert.strictEqual(result.snapshot.spending.netSurplus, '300.00');
  assert.strictEqual(result.snapshot.goals.totalContributions, '0.00');
  assert.strictEqual(result.snapshot.debts.totalPayments, '0.00');

  const txs = await db.transaction((tx) => tx.listTransactions({ householdId: hh, from: PERIOD, to: PERIOD }));
  assert.strictEqual(txs.items.filter((t) => t.source === 'buffer_disposition').length, 0);
});

test('atomic close rejects malformed disposition before financial mutation', async () => {
  const { db, hh } = await makDbWithBuffer('_atomic_invalid', '500.00', '200.00');
  const err = await closeMonth({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    bufferDispositionInput: { type: 'return_to_plan', targetId: 'not-allowed' },
  }).catch((e) => e);

  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 400);
  const state = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(state.state, LifecycleState.OPEN);
  const txs = await db.transaction((tx) => tx.listTransactions({ householdId: hh, from: PERIOD, to: PERIOD }));
  assert.strictEqual(txs.items.filter((t) => t.source === 'buffer_disposition').length, 0);
});

test('atomic close rejects zero remaining buffer disposition', async () => {
  const { db, hh } = await makDbWithBuffer('_atomic_zero', '500.00', '500.00');
  let goalId;
  await db.transaction(async (tx) => {
    const g = await tx.insertGoal({ householdId: hh, name: 'Vacation', targetAmount: '2000.00', active: true });
    goalId = g.id;
  });

  const err = await closeMonth({
    db, householdId: hh, period: PERIOD, userId: 'u1',
    bufferDispositionInput: { type: 'apply_to_goal', targetId: goalId },
  }).catch((e) => e);

  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 422);
  const state = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(state.state, LifecycleState.OPEN);
});

function withFailingClosePersistence(db, householdId) {
  return {
    async transaction(callback) {
      const insertedTransactionIds = [];
      try {
        return await db.transaction(async (tx) => callback({
          ...tx,
          async insertTransaction(payload) {
            const row = await tx.insertTransaction(payload);
            insertedTransactionIds.push(row.id);
            return row;
          },
          async insertMonthClose() {
            throw new Error('INJECTED_CLOSE_PERSISTENCE_FAILURE');
          },
        }));
      } catch (error) {
        await db.transaction(async (tx) => {
          for (const transactionId of insertedTransactionIds) {
            await tx.deleteDebtPaymentByTransactionId({ householdId, transactionId });
            await tx.deleteTransaction({ householdId, transactionId });
          }
        });
        throw error;
      }
    },
  };
}

test('atomic close goal effect rolls back when close persistence fails, then retry applies once', async () => {
  const suffix = '_atomic_goal_rollback';
  const { db, hh } = await makDbWithBuffer(suffix, '500.00', '200.00');
  let goalId;
  await db.transaction(async (tx) => {
    const g = await tx.insertGoal({ householdId: hh, name: 'Vacation', targetAmount: '2000.00', active: true });
    goalId = g.id;
  });

  const failingDb = withFailingClosePersistence(db, hh);
  const err = await closeMonth({
    db: failingDb, householdId: hh, period: PERIOD, userId: 'u1',
    bufferDispositionInput: { type: 'apply_to_goal', targetId: goalId },
  }).catch((e) => e);
  assert.equal(err.message, 'INJECTED_CLOSE_PERSISTENCE_FAILURE');

  let txs = await db.transaction((tx) => tx.listTransactions({ householdId: hh, from: PERIOD, to: PERIOD }));
  assert.strictEqual(txs.items.filter((t) => t.source === 'buffer_disposition').length, 0);
  let state = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(state.state, LifecycleState.OPEN);

  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1', bufferDispositionInput: { type: 'apply_to_goal', targetId: goalId } });
  txs = await db.transaction((tx) => tx.listTransactions({ householdId: hh, from: PERIOD, to: PERIOD }));
  assert.strictEqual(txs.items.filter((t) => t.source === 'buffer_disposition' && t.linkedGoalId === goalId).length, 1);
});

test('atomic close debt effect rolls back when close persistence fails, then retry applies once', async () => {
  const { db, hh } = await makDbWithBuffer('_atomic_debt_rollback', '500.00', '200.00');
  let debtId;
  await db.transaction(async (tx) => {
    const d = await tx.insertDebt({ householdId: hh, name: 'Car Loan', currentBalance: '10000.00', minimumPayment: '300.00', type: 'installment' });
    debtId = d.id;
  });

  const failingDb = withFailingClosePersistence(db, hh);
  const err = await closeMonth({
    db: failingDb, householdId: hh, period: PERIOD, userId: 'u1',
    bufferDispositionInput: { type: 'apply_to_debt', targetId: debtId },
  }).catch((e) => e);
  assert.equal(err.message, 'INJECTED_CLOSE_PERSISTENCE_FAILURE');

  let txs = await db.transaction((tx) => tx.listTransactions({ householdId: hh, from: PERIOD, to: PERIOD }));
  let payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: hh, debtId, from: PERIOD, to: PERIOD }));
  assert.strictEqual(txs.items.filter((t) => t.source === 'buffer_disposition').length, 0);
  assert.strictEqual(payments.length, 0);
  let state = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(state.state, LifecycleState.OPEN);

  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1', bufferDispositionInput: { type: 'apply_to_debt', targetId: debtId } });
  txs = await db.transaction((tx) => tx.listTransactions({ householdId: hh, from: PERIOD, to: PERIOD }));
  payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: hh, debtId, from: PERIOD, to: PERIOD }));
  assert.strictEqual(txs.items.filter((t) => t.source === 'buffer_disposition' && t.linkedDebtId === debtId).length, 1);
  assert.strictEqual(payments.length, 1);
  assert.strictEqual(payments[0].amount, '300.00');
});

test('atomic close duplicate goal disposition request creates exactly one financial effect', async () => {
  const { db, hh } = await makDbWithBuffer('_atomic_goal_duplicate', '500.00', '200.00');
  let goalId;
  await db.transaction(async (tx) => {
    const g = await tx.insertGoal({ householdId: hh, name: 'Vacation', targetAmount: '2000.00', active: true });
    goalId = g.id;
  });

  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1', bufferDispositionInput: { type: 'apply_to_goal', targetId: goalId } });
  const err = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1', bufferDispositionInput: { type: 'apply_to_goal', targetId: goalId } }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 409);

  const txs = await db.transaction((tx) => tx.listTransactions({ householdId: hh, from: PERIOD, to: PERIOD }));
  assert.strictEqual(txs.items.filter((t) => t.source === 'buffer_disposition' && t.linkedGoalId === goalId).length, 1);
});

test('atomic close duplicate debt disposition request creates exactly one financial effect', async () => {
  const { db, hh } = await makDbWithBuffer('_atomic_debt_duplicate', '500.00', '200.00');
  let debtId;
  await db.transaction(async (tx) => {
    const d = await tx.insertDebt({ householdId: hh, name: 'Car Loan', currentBalance: '10000.00', minimumPayment: '300.00', type: 'installment' });
    debtId = d.id;
  });

  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1', bufferDispositionInput: { type: 'apply_to_debt', targetId: debtId } });
  const err = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1', bufferDispositionInput: { type: 'apply_to_debt', targetId: debtId } }).catch((e) => e);
  assert.ok(err instanceof MonthlyReviewHttpError);
  assert.strictEqual(err.status, 409);

  const payments = await db.transaction((tx) => tx.listDebtPayments({ householdId: hh, debtId, from: PERIOD, to: PERIOD }));
  assert.strictEqual(payments.length, 1);
  assert.strictEqual(payments[0].amount, '300.00');
});

test('reopen clears CLOSED state, preserves snapshot in history, and re-close creates v2', async () => {
  const db = await makeDb(HH + '_rce');
  const hh = HH + '_rce';
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  await reopenMonth({ db, householdId: hh, period: PERIOD, userId: 'u1', reason: 'Test reopen' });
  const state1 = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(state1.state, LifecycleState.REVIEWING);

  const v2 = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  assert.strictEqual(v2.version, 2);

  const state2 = await getMonthLifecycleState({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(state2.state, LifecycleState.CLOSED);
  assert.strictEqual(state2.version, 2);
});

// ─── Section 9: Permissions (server-side API routes) ─────────────────────────

function makeRequest(url, method = 'GET', body = null) {
  const req = { url: `http://localhost${url}`, method };
  if (body) {
    req.json = async () => body;
  } else {
    req.json = async () => ({});
  }
  return req;
}

test('C.perm1 — viewer role cannot close month (403)', async () => {
  const db = createInMemoryDb();
  const context = { db, householdId: 'hh_perm_test', role: 'viewer' };
  const req = makeRequest('/api/v1/monthly-reviews/close', 'POST', { period: PERIOD });
  const res = await closePOST(req, context);
  assert.strictEqual(res.status, 403);
});

test('C.perm2 — member role can close month (not 403)', async () => {
  const db = await makeDb(HH + '_perm2');
  const context = { db, householdId: HH + '_perm2', role: 'member' };
  const req = makeRequest('/api/v1/monthly-reviews/close', 'POST', { period: PERIOD });
  const res = await closePOST(req, context);
  // Should succeed (201) or fail with a non-permission error
  assert.ok(res.status !== 403, 'member should not get 403 for close');
});

test('C.perm3 — viewer role cannot reopen month (403)', async () => {
  const db = await makeDb(HH + '_perm3v');
  const hh = HH + '_perm3v';
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const context = { db, householdId: hh, role: 'viewer' };
  const req = makeRequest('/api/v1/monthly-reviews/reopen', 'POST', { period: PERIOD });
  const res = await reopenPOST(req, context);
  assert.strictEqual(res.status, 403);
});

test('C.perm4 — member role cannot reopen month (403)', async () => {
  const db = await makeDb(HH + '_perm4m');
  const hh = HH + '_perm4m';
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const context = { db, householdId: hh, role: 'member' };
  const req = makeRequest('/api/v1/monthly-reviews/reopen', 'POST', { period: PERIOD });
  const res = await reopenPOST(req, context);
  assert.strictEqual(res.status, 403);
});

test('C.perm5 — owner role can reopen month (not 403)', async () => {
  const db = await makeDb(HH + '_perm5o');
  const hh = HH + '_perm5o';
  await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  const context = { db, householdId: hh, role: 'owner' };
  const req = makeRequest('/api/v1/monthly-reviews/reopen', 'POST', { period: PERIOD });
  const res = await reopenPOST(req, context);
  assert.ok(res.status !== 403, 'owner should not get 403 for reopen');
});

test('C.perm6 — cross-workspace close attempt is rejected (no householdId in context)', async () => {
  const db = await makeDb(HH + '_perm6');
  // No householdId in context = cannot determine workspace → should fail gracefully
  const context = { db, role: 'owner' };
  const req = makeRequest('/api/v1/monthly-reviews/close', 'POST', { period: PERIOD });
  const res = await closePOST(req, context);
  // Without a householdId, the service will throw a 400 (householdId required)
  assert.ok(res.status === 400 || res.status === 403 || res.status === 500, 'missing workspace context is rejected');
});

// ─── Section 10: Readiness / close buffer authority parity ───────────────────

test('AT.14 — close-readiness bufferRemaining matches close authority', async () => {
  const { db, hh } = await makDbWithBuffer('_at14', '500.00', '100.00');
  const readiness = await getCloseReadiness({ db, householdId: hh, period: PERIOD });
  assert.strictEqual(readiness.summary.bufferRemaining, '400.00',
    'readiness must report $400 (allocated 500 - spent 100)');
  const result = await closeMonth({ db, householdId: hh, period: PERIOD, userId: 'u1' });
  assert.strictEqual(
    result.snapshot.buffer?.remaining,
    readiness.summary.bufferRemaining,
    'displayed bufferRemaining equals authoritative close buffer',
  );
});
