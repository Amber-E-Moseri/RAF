import test from 'node:test';
import assert from 'node:assert/strict';

import { createFinancialAccount, updateFinancialAccount } from '../lib/accounts/accounts.js';
import {
  createDebt,
  linkDebtToFinancialAccount,
  listDebts,
  unlinkDebtFromFinancialAccount,
  updateDebt,
} from '../lib/debts/debts.js';
import { resolveDebtBalanceAuthority } from '../lib/debts/debtBalanceAuthority.js';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';

const HID = 'household_test';

function makeDb() {
  return createInMemoryDb({ householdId: HID });
}

async function seedCreditCard(db, { currentBalance = '1500.00', name = 'Test Card' } = {}) {
  return createFinancialAccount({
    db,
    householdId: HID,
    input: {
      name,
      accountType: 'credit_card',
      currentBalance,
      institution: 'Test Bank',
    },
  });
}

async function seedDebt(db, { startingBalance = '2000.00', financialAccountId = null } = {}) {
  return createDebt({
    db,
    householdId: HID,
    input: {
      name: 'Test Debt',
      startingBalance,
      apr: '18.99',
      minimumPayment: '50.00',
      monthlyPayment: '100.00',
      financialAccountId,
    },
  });
}

// debtBalanceAuthority unit tests

test('resolveDebtBalanceAuthority - manual debt returns manual_derived source', () => {
  const result = resolveDebtBalanceAuthority({ debt: { financialAccountId: null }, financialAccount: null });
  assert.equal(result.source, 'manual_derived');
  assert.equal(result.balance, null);
});

test('resolveDebtBalanceAuthority - account-backed debt returns financial_account source', () => {
  const debt = { financialAccountId: 'acct-1' };
  const account = { id: 'acct-1', currentBalance: '1234.56' };
  const result = resolveDebtBalanceAuthority({ debt, financialAccount: account });
  assert.equal(result.source, 'financial_account');
  assert.equal(result.balance, '1234.56');
  assert.equal(result.financialAccountId, 'acct-1');
});

test('resolveDebtBalanceAuthority - throws when debt has financialAccountId but account is null (broken link)', () => {
  const debt = { financialAccountId: 'acct-1' };
  assert.throws(
    () => resolveDebtBalanceAuthority({ debt, financialAccount: null }),
    /linked debt requires a financial account/,
  );
});

test('resolveDebtBalanceAuthority - reads both camelCase and snake_case fields', () => {
  const debt = { financial_account_id: 'acct-1' };
  const account = { id: 'acct-1', current_balance: '500.00' };
  const result = resolveDebtBalanceAuthority({ debt, financialAccount: account });
  assert.equal(result.source, 'financial_account');
  assert.equal(result.balance, '500.00');
});

test('resolveDebtBalanceAuthority - uses Math.abs so negative account balances become positive liability', () => {
  const debt = { financialAccountId: 'acct-1' };
  const account = { id: 'acct-1', currentBalance: '-750.00' };
  const result = resolveDebtBalanceAuthority({ debt, financialAccount: account });
  assert.equal(result.balance, '750.00');
});

// createDebt with linked account

test('createDebt with financialAccountId sets balanceAuthority.source = financial_account', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1500.00' });
  const debt = await seedDebt(db, { financialAccountId: account.id });

  assert.equal(debt.financialAccountId, account.id);
  assert.equal(debt.balanceAuthority?.source, 'financial_account');
  assert.equal(debt.currentBalance, '1500.00');
});

test('createDebt without financialAccountId uses ledger derivation', async () => {
  const db = makeDb();
  const debt = await seedDebt(db, { startingBalance: '2000.00' });

  assert.equal(debt.financialAccountId, null);
  assert.equal(debt.balanceAuthority?.source, 'manual_derived');
  assert.equal(debt.currentBalance, '2000.00');
});

test('createDebt rejects non-liability account type', async () => {
  const db = makeDb();
  const account = await createFinancialAccount({
    db,
    householdId: HID,
    input: { name: 'Checking', accountType: 'checking', currentBalance: '5000.00', institution: 'Bank' },
  });

  await assert.rejects(
    () => seedDebt(db, { financialAccountId: account.id }),
    { message: /liability account/ },
  );
});

test('createDebt rejects duplicate link (one account per active debt)', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db);
  await seedDebt(db, { financialAccountId: account.id });

  await assert.rejects(
    () => seedDebt(db, { financialAccountId: account.id }),
    { message: /already linked/ },
  );
});

// listDebts with linked accounts

test('listDebts populates balanceAuthority for account-backed debts', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '888.00' });
  await seedDebt(db, { financialAccountId: account.id });

  const result = await listDebts({ db, householdId: HID });
  const [debtItem] = result.items;
  assert.equal(debtItem.balanceAuthority?.source, 'financial_account');
  assert.equal(debtItem.currentBalance, '888.00');
});

test('listDebts currentBalance reflects account balance, not starting balance, for account-backed debts', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '3200.00' });
  await seedDebt(db, { startingBalance: '5000.00', financialAccountId: account.id });

  const result = await listDebts({ db, householdId: HID });
  const [debtItem] = result.items;
  assert.equal(debtItem.currentBalance, '3200.00');
  assert.notEqual(debtItem.currentBalance, '5000.00');
});

// linkDebtToFinancialAccount

test('linkDebtToFinancialAccount links a manual debt to a credit card account', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '700.00' });
  const debt = await seedDebt(db);
  assert.equal(debt.financialAccountId, null);

  const linked = await linkDebtToFinancialAccount({
    db,
    householdId: HID,
    debtId: debt.id,
    financialAccountId: account.id,
  });

  assert.equal(linked.financialAccountId, account.id);
  assert.equal(linked.balanceAuthority?.source, 'financial_account');
  assert.equal(linked.currentBalance, '700.00');
});

// unlinkDebtFromFinancialAccount (safe unlink)

test('unlinkDebtFromFinancialAccount requires confirmedManualBalance', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db);
  const debt = await seedDebt(db, { financialAccountId: account.id });

  await assert.rejects(
    () => unlinkDebtFromFinancialAccount({ db, householdId: HID, debtId: debt.id }),
    { message: /confirmedManualBalance is required/ },
  );
});

test('unlinkDebtFromFinancialAccount fails on a debt that is not linked', async () => {
  const db = makeDb();
  const debt = await seedDebt(db);

  await assert.rejects(
    () => unlinkDebtFromFinancialAccount({ db, householdId: HID, debtId: debt.id, confirmedManualBalance: '2000.00' }),
    { message: /already manually balanced/ },
  );
});

test('unlinkDebtFromFinancialAccount removes link and uses ledger authority', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1500.00' });
  const debt = await seedDebt(db, { startingBalance: '2000.00', financialAccountId: account.id });
  assert.equal(debt.balanceAuthority?.source, 'financial_account');

  const unlinked = await unlinkDebtFromFinancialAccount({
    db,
    householdId: HID,
    debtId: debt.id,
    confirmedManualBalance: '2000.00',
  });

  assert.equal(unlinked.financialAccountId, null);
  assert.equal(unlinked.balanceAuthority?.source, 'manual_derived');
  assert.equal(unlinked.currentBalance, '2000.00');
});

test('unlinkDebtFromFinancialAccount records reconciliation adjustment when confirmed differs from ledger', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1500.00' });
  const debt = await seedDebt(db, { startingBalance: '2000.00', financialAccountId: account.id });

  const unlinked = await unlinkDebtFromFinancialAccount({
    db,
    householdId: HID,
    debtId: debt.id,
    confirmedManualBalance: '1800.00',
  });

  assert.equal(unlinked.currentBalance, '1800.00');
  const adjustments = await db.transaction(async (tx) => tx.listDebtAdjustments({ householdId: HID, debtId: debt.id }));
  const reconciliation = adjustments.find((a) => a.adjustmentType === 'reconciliation');
  assert.ok(reconciliation, 'a reconciliation adjustment must be recorded');
  assert.equal(reconciliation.amount, '-200.00');
});

test('unlinkDebtFromFinancialAccount records no adjustment when confirmed matches ledger exactly', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1500.00' });
  const debt = await seedDebt(db, { startingBalance: '2000.00', financialAccountId: account.id });

  await unlinkDebtFromFinancialAccount({
    db,
    householdId: HID,
    debtId: debt.id,
    confirmedManualBalance: '2000.00',
  });

  const adjustments = await db.transaction(async (tx) => tx.listDebtAdjustments({ householdId: HID, debtId: debt.id }));
  const reconciliation = adjustments.filter((a) => a.adjustmentType === 'reconciliation');
  assert.equal(reconciliation.length, 0);
});

// updateDebt with financialAccountId = null also enforces safe unlink

test('updateDebt PATCH with financialAccountId=null requires confirmedManualBalance', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1200.00' });
  const debt = await seedDebt(db, { financialAccountId: account.id });

  await assert.rejects(
    () => updateDebt({ db, householdId: HID, debtId: debt.id, input: { financialAccountId: null } }),
    { message: /confirmedManualBalance is required/ },
  );
});

test('updateDebt PATCH with financialAccountId=null + confirmedManualBalance succeeds', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1200.00' });
  const debt = await seedDebt(db, { startingBalance: '2000.00', financialAccountId: account.id });

  const updated = await updateDebt({
    db,
    householdId: HID,
    debtId: debt.id,
    input: { financialAccountId: null, confirmedManualBalance: '1200.00' },
  });

  assert.equal(updated.financialAccountId, null);
  assert.equal(updated.balanceAuthority?.source, 'manual_derived');
  assert.equal(updated.currentBalance, '1200.00');
});

// account balance changes propagate immediately

test('account balance change is reflected in debt currentBalance on next listDebts', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1000.00' });
  await seedDebt(db, { financialAccountId: account.id });

  await db.transaction(async (tx) => tx.updateFinancialAccount({ householdId: HID, accountId: account.id, patch: { currentBalance: '999.00' } }));

  const result = await listDebts({ db, householdId: HID });
  assert.equal(result.items[0].currentBalance, '999.00');
});

// ============================================================
// Account deletion authority boundary — blocker remediation
// ============================================================

// The FK on debts.financial_account_id uses ON DELETE NO ACTION (not SET NULL).
// These tests verify the service-layer invariant that backs that schema choice:
// a debt must NEVER silently revert to manual authority because the backing
// account disappeared. The only permitted transition is the explicit safe-unlink
// path (confirmedManualBalance required).

test('authority does not silently revert when account status is archived', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1200.00' });
  await seedDebt(db, { financialAccountId: account.id });

  await updateFinancialAccount({ db, householdId: HID, accountId: account.id, input: { status: 'archived' } });

  const result = await listDebts({ db, householdId: HID });
  const [debt] = result.items;
  assert.equal(debt.balanceAuthority?.source, 'financial_account', 'archived account still backs the debt authority');
  assert.equal(debt.currentBalance, '1200.00', 'balance still comes from the (archived) account');
  assert.equal(debt.financialAccountId, account.id);
});

test('listDebts throws explicitly rather than silently reverting when linked account is unavailable', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '800.00' });
  await seedDebt(db, { financialAccountId: account.id });

  // Simulate a hypothetical direct-SQL SET NULL bypass by removing the account
  // from inMemory state while leaving financial_account_id set on the debt.
  // This is the broken state the ON DELETE SET NULL FK would have prevented.
  db.state.financialAccounts = db.state.financialAccounts.filter((a) => a.id !== account.id);

  await assert.rejects(
    () => listDebts({ db, householdId: HID }),
    /linked debt requires a financial account/,
    'must throw, not silently revert to manual_derived',
  );
});

test('safe unlink is the only permitted service path to transition from account to manual authority', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1500.00' });
  const debt = await seedDebt(db, { startingBalance: '2000.00', financialAccountId: account.id });
  assert.equal(debt.balanceAuthority?.source, 'financial_account');

  // Verify that PATCH without confirmedManualBalance is rejected
  await assert.rejects(
    () => updateDebt({ db, householdId: HID, debtId: debt.id, input: { financialAccountId: null } }),
    /confirmedManualBalance is required/,
  );

  // Verify that the explicit safe-unlink path succeeds
  const unlinked = await unlinkDebtFromFinancialAccount({
    db, householdId: HID, debtId: debt.id, confirmedManualBalance: '2000.00',
  });
  assert.equal(unlinked.balanceAuthority?.source, 'manual_derived');
  assert.equal(unlinked.financialAccountId, null);
});

test('after safe unlink, account status change does not affect the now-manual debt authority', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1500.00' });
  await seedDebt(db, { startingBalance: '2000.00', financialAccountId: account.id });

  await unlinkDebtFromFinancialAccount({ db, householdId: HID, debtId: (await listDebts({ db, householdId: HID })).items[0].id, confirmedManualBalance: '2000.00' });
  await updateFinancialAccount({ db, householdId: HID, accountId: account.id, input: { status: 'archived' } });

  const result = await listDebts({ db, householdId: HID });
  const [debt] = result.items;
  assert.equal(debt.balanceAuthority?.source, 'manual_derived', 'authority is manual after safe unlink, not changed by archiving');
  assert.equal(debt.financialAccountId, null);
});

test('manual debt is unaffected by any account status operations', async () => {
  const db = makeDb();
  const manualDebt = await seedDebt(db, { startingBalance: '3000.00' });
  assert.equal(manualDebt.balanceAuthority?.source, 'manual_derived');

  const account = await seedCreditCard(db, { currentBalance: '999.00' });
  await updateFinancialAccount({ db, householdId: HID, accountId: account.id, input: { status: 'archived' } });

  const result = await listDebts({ db, householdId: HID });
  const [debt] = result.items;
  assert.equal(debt.balanceAuthority?.source, 'manual_derived');
  assert.equal(debt.currentBalance, '3000.00');
  assert.equal(debt.financialAccountId, null);
});

test('linked debt authority is isolated from unrelated account status operations', async () => {
  const db = makeDb();
  const accountA = await seedCreditCard(db, { currentBalance: '600.00', name: 'Card A' });
  await seedDebt(db, { financialAccountId: accountA.id });

  const accountB = await createFinancialAccount({
    db, householdId: HID,
    input: { name: 'Card B', accountType: 'credit_card', currentBalance: '400.00', institution: 'Bank B' },
  });
  await updateFinancialAccount({ db, householdId: HID, accountId: accountB.id, input: { status: 'archived' } });

  const result = await listDebts({ db, householdId: HID });
  const [debt] = result.items;
  assert.equal(debt.financialAccountId, accountA.id, 'debt still linked to account A');
  assert.equal(debt.balanceAuthority?.source, 'financial_account');
  assert.equal(debt.currentBalance, '600.00');
});

test('unlink creates at most one reconciliation adjustment and zero canonical transactions', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1000.00' });
  const debt = await seedDebt(db, { startingBalance: '2000.00', financialAccountId: account.id });

  const transactionsBefore = db.state.transactions.length;

  await unlinkDebtFromFinancialAccount({
    db, householdId: HID, debtId: debt.id, confirmedManualBalance: '1800.00',
  });

  assert.equal(db.state.transactions.length, transactionsBefore, 'unlink must not create canonical transactions');

  const adjustments = await db.transaction(async (tx) => tx.listDebtAdjustments({ householdId: HID, debtId: debt.id }));
  const reconciliations = adjustments.filter((a) => a.adjustmentType === 'reconciliation');
  assert.equal(reconciliations.length, 1, 'exactly one reconciliation adjustment');
});

test('link does not copy account balance to debt startingBalance', async () => {
  const db = makeDb();
  const account = await seedCreditCard(db, { currentBalance: '1500.00' });
  const debt = await seedDebt(db, { startingBalance: '2000.00' });
  assert.equal(debt.startingBalance, '2000.00');

  const linked = await linkDebtToFinancialAccount({
    db, householdId: HID, debtId: debt.id, financialAccountId: account.id,
  });

  assert.equal(linked.startingBalance, '2000.00', 'startingBalance must not be overwritten with account balance');
  assert.equal(linked.currentBalance, '1500.00', 'currentBalance reads from account authority');
  assert.notEqual(linked.startingBalance, linked.currentBalance);
});

test('cross-workspace account cannot satisfy a debt link in another workspace', async () => {
  const db = makeDb();

  // Create an account in household_2 (a different workspace)
  const otherHouseholdId = 'household_other';
  const otherAccount = await createFinancialAccount({
    db, householdId: otherHouseholdId,
    input: { name: 'Other Card', accountType: 'credit_card', currentBalance: '500.00', institution: 'Other Bank' },
  });

  // Attempt to link it from household_test — must fail (account not found in HID workspace)
  const debt = await seedDebt(db);
  await assert.rejects(
    () => linkDebtToFinancialAccount({ db, householdId: HID, debtId: debt.id, financialAccountId: otherAccount.id }),
    /financial account not found/,
    'cross-workspace account must not be linkable',
  );
});
