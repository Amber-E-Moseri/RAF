import test from 'node:test';
import assert from 'node:assert/strict';

import { GET, POST } from '../app/api/v1/debts/route.js';
import { DELETE, PATCH } from '../app/api/v1/debts/[id]/route.js';
import { GET as getAdjustmentsRoute, POST as postAdjustmentRoute } from '../app/api/v1/debts/[id]/adjustments/route.js';
import {
  createDebtAdjustment,
  createDebt,
  deleteDebt,
  linkDebtToFinancialAccount,
  listDebtAdjustments,
  listDebts,
  unlinkDebtFromFinancialAccount,
  updateDebt,
} from '../lib/debts/debts.js';

function createDbDouble({
  debts = [],
  debtPayments = [],
  debtAdjustments = [],
  financialAccounts = [],
  transactions = [],
  household = { id: 'household_1', activeMonth: '2026-03-01' },
  failUpdateDebt = false,
} = {}) {
  const state = {
    debts: debts.map((debt) => ({ ...debt })),
    debtPayments: debtPayments.map((payment) => ({ ...payment })),
    debtAdjustments: debtAdjustments.map((adjustment) => ({ ...adjustment })),
    financialAccounts: financialAccounts.map((account) => ({ ...account })),
    transactions: transactions.map((transaction) => ({ ...transaction })),
    household: { ...household },
    insertedDebt: null,
    updatedDebt: null,
    deletedDebtId: null,
  };

  const tx = {
    async insertDebt(payload) {
      state.insertedDebt = payload;
      const debt = { id: `debt_${state.debts.length + 1}`, ...payload };
      state.debts.push(debt);
      return debt;
    },
    async listDebts() {
      return [...state.debts].sort((left, right) => {
        if (left.sortOrder !== right.sortOrder) {
          return left.sortOrder - right.sortOrder;
        }

        return left.name.localeCompare(right.name);
      });
    },
    async listDebtPayments({ debtId }) {
      if (debtId) {
        return state.debtPayments.filter((payment) => payment.debtId === debtId);
      }

      return [...state.debtPayments];
    },
    async insertDebtAdjustment(payload) {
      const adjustment = { id: `adj_${state.debtAdjustments.length + 1}`, createdAt: '2026-03-13T00:00:00.000Z', ...payload };
      state.debtAdjustments.push(adjustment);
      return adjustment;
    },
    async listDebtAdjustments({ debtId }) {
      if (debtId) {
        return state.debtAdjustments.filter((adjustment) => adjustment.debtId === debtId);
      }

      return [...state.debtAdjustments];
    },
    async getDebtById({ debtId }) {
      return state.debts.find((debt) => debt.id === debtId) ?? null;
    },
    async getFinancialAccountById({ householdId, accountId }) {
      return state.financialAccounts.find((account) =>
        account.id === accountId
        && (account.householdId === householdId || account.workspaceId === householdId)
      ) ?? null;
    },
    async updateDebt({ debtId, patch }) {
      if (failUpdateDebt) {
        throw new Error('forced update failure');
      }
      const index = state.debts.findIndex((debt) => debt.id === debtId);
      state.debts[index] = {
        ...state.debts[index],
        ...patch,
      };
      state.updatedDebt = state.debts[index];
      return state.debts[index];
    },
    async countDebtPaymentsForDebt({ debtId }) {
      return state.debtPayments.filter((payment) => payment.debtId === debtId).length;
    },
    async deleteDebt({ debtId }) {
      state.deletedDebtId = debtId;
      state.debts = state.debts.filter((debt) => debt.id !== debtId);
    },
    async getHousehold() {
      return { ...state.household };
    },
  };

  return {
    state,
    async transaction(callback) {
      const snapshot = {
        debts: state.debts.map((debt) => ({ ...debt })),
        debtPayments: state.debtPayments.map((payment) => ({ ...payment })),
        debtAdjustments: state.debtAdjustments.map((adjustment) => ({ ...adjustment })),
        financialAccounts: state.financialAccounts.map((account) => ({ ...account })),
        transactions: state.transactions.map((transaction) => ({ ...transaction })),
        insertedDebt: state.insertedDebt,
        updatedDebt: state.updatedDebt,
        deletedDebtId: state.deletedDebtId,
      };
      try {
        return await callback(tx);
      } catch (error) {
        state.debts = snapshot.debts;
        state.debtPayments = snapshot.debtPayments;
        state.debtAdjustments = snapshot.debtAdjustments;
        state.financialAccounts = snapshot.financialAccounts;
        state.transactions = snapshot.transactions;
        state.insertedDebt = snapshot.insertedDebt;
        state.updatedDebt = snapshot.updatedDebt;
        state.deletedDebtId = snapshot.deletedDebtId;
        throw error;
      }
    },
  };
}

function buildDebtStressDataset() {
  return {
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Stress Test Card',
        startingBalance: '2000.00',
        apr: 19.99,
        minimumPayment: '45.00',
        monthlyPayment: '120.00',
        statementDay: 5,
        paymentDueDay: 25,
        lateFeeAmount: '35.00',
        autoPostInterest: false,
        autoPostLateFee: false,
        sortOrder: 1,
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    debtPayments: [
      { debtId: 'debt_1', paymentDate: '2026-01-15', amount: '120.00' },
      { debtId: 'debt_1', paymentDate: '2026-02-20', amount: '120.00' },
      { debtId: 'debt_1', paymentDate: '2026-03-18', amount: '80.00' },
      { debtId: 'debt_1', paymentDate: '2026-05-10', amount: '200.00' },
      { debtId: 'debt_1', paymentDate: '2026-06-22', amount: '120.00' },
      { debtId: 'debt_1', paymentDate: '2026-07-19', amount: '120.00' },
      { debtId: 'debt_1', paymentDate: '2026-08-20', amount: '45.00' },
      { debtId: 'debt_1', paymentDate: '2026-09-18', amount: '120.00' },
      { debtId: 'debt_1', paymentDate: '2026-10-15', amount: '400.00' },
      { debtId: 'debt_1', paymentDate: '2026-11-20', amount: '120.00' },
      { debtId: 'debt_1', paymentDate: '2026-12-15', amount: '600.00' },
    ],
    debtAdjustments: [
      { debtId: 'debt_1', householdId: 'household_1', amount: '33.32', adjustmentType: 'interest', effectiveDate: '2026-01-05', note: 'Month 1 interest', createdAt: '2026-01-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '75.00', adjustmentType: 'correction', effectiveDate: '2026-01-10', note: 'Month 1 spend', createdAt: '2026-01-10T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '32.10', adjustmentType: 'interest', effectiveDate: '2026-02-05', note: 'Month 2 interest', createdAt: '2026-02-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '40.00', adjustmentType: 'correction', effectiveDate: '2026-02-12', note: 'Month 2 spend', createdAt: '2026-02-12T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '31.80', adjustmentType: 'interest', effectiveDate: '2026-03-05', note: 'Month 3 interest', createdAt: '2026-03-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '31.40', adjustmentType: 'interest', effectiveDate: '2026-04-05', note: 'Month 4 interest', createdAt: '2026-04-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '35.00', adjustmentType: 'late_fee', effectiveDate: '2026-04-25', note: 'Month 4 late fee', createdAt: '2026-04-25T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '32.50', adjustmentType: 'interest', effectiveDate: '2026-05-05', note: 'Month 5 interest', createdAt: '2026-05-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '29.70', adjustmentType: 'interest', effectiveDate: '2026-06-05', note: 'Month 6 interest', createdAt: '2026-06-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '250.00', adjustmentType: 'correction', effectiveDate: '2026-06-07', note: 'Month 6 spend spike', createdAt: '2026-06-07T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '31.00', adjustmentType: 'interest', effectiveDate: '2026-07-05', note: 'Month 7 interest', createdAt: '2026-07-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '30.20', adjustmentType: 'interest', effectiveDate: '2026-08-05', note: 'Month 8 interest', createdAt: '2026-08-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '30.10', adjustmentType: 'interest', effectiveDate: '2026-09-05', note: 'Month 9 interest', createdAt: '2026-09-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '28.50', adjustmentType: 'interest', effectiveDate: '2026-10-05', note: 'Month 10 interest', createdAt: '2026-10-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '22.40', adjustmentType: 'interest', effectiveDate: '2026-11-05', note: 'Month 11 interest', createdAt: '2026-11-05T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '12.20', adjustmentType: 'interest', effectiveDate: '2026-12-05', note: 'Month 12 interest', createdAt: '2026-12-05T00:00:00.000Z' },
    ],
  };
}

function buildDebtStressDatasetWithTruePayoff() {
  const dataset = buildDebtStressDataset();
  return {
    ...dataset,
    debtPayments: dataset.debtPayments.map((payment) => (
      payment.paymentDate === '2026-12-15'
        ? { ...payment, amount: '1300.22' }
        : payment
    )),
  };
}

test('createDebt creates a debt and returns money values as decimal strings', async () => {
  const db = createDbDouble();

  const result = await createDebt({
    db,
    householdId: 'household_1',
    input: {
      name: 'Visa',
      startingBalance: '5000',
      apr: '19.99',
      minimumPayment: '100',
      monthlyPayment: '250',
      statementDay: 10,
      paymentDueDay: 31,
      lateFeeAmount: '35',
      autoPostInterest: true,
      autoPostLateFee: true,
      sortOrder: 3,
    },
  });

  assert.equal(result.id, 'debt_1');
  assert.equal(result.startingBalance, '5000.00');
  assert.equal(result.currentBalance, '5000.00');
  assert.equal(result.minimumPayment, '100.00');
  assert.equal(result.monthlyPayment, '250.00');
  assert.equal(result.apr, 19.99);
  assert.equal(result.statementDay, 10);
  assert.equal(result.paymentDueDay, 31);
  assert.equal(result.lateFeeAmount, '35.00');
  assert.equal(result.autoPostInterest, true);
  assert.equal(result.autoPostLateFee, true);
  assert.equal(result.status, 'current');
  assert.equal(result.paymentStatus, 'missed_payment');
  assert.equal(result.paymentsThisMonth, '0.00');
  assert.equal(result.financialAccountId, null);
  assert.deepEqual(result.balanceAuthority, {
    source: 'manual_derived',
    balance: null,
    asOf: null,
    financialAccountId: null,
  });
  assert.ok(typeof result.monthsRemaining === 'number' && result.monthsRemaining > 0);
  assert.ok(typeof result.totalInterestRemaining === 'string' && Number(result.totalInterestRemaining) > 0);
  assert.match(result.estimatedPayoffDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('createDebt can create a manual debt without an account link', async () => {
  const db = createDbDouble();

  const result = await createDebt({
    db,
    householdId: 'household_1',
    input: {
      name: 'Family loan',
      startingBalance: '1200.00',
      apr: '0',
      minimumPayment: '0.00',
      monthlyPayment: '100.00',
    },
  });

  assert.equal(result.id, 'debt_1');
  assert.equal(result.financialAccountId, null);
  assert.equal(result.currentBalance, '1200.00');
  assert.equal(db.state.insertedDebt.financialAccountId, null);
});

test('linkDebtToFinancialAccount links a manual debt without changing its id or payment history', async () => {
  const db = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      isActive: true,
    }],
    debtPayments: [{ debtId: 'debt_1', householdId: 'household_1', paymentDate: '2026-03-12', amount: '400.00' }],
    financialAccounts: [{
      id: 'acct_1',
      householdId: 'household_1',
      workspaceId: 'household_1',
      name: 'Visa account',
      accountType: 'credit_card',
      currentBalance: '-4300.00',
      balanceAsOf: '2026-03-31T00:00:00.000Z',
      status: 'active',
    }],
  });

  const result = await linkDebtToFinancialAccount({
    db,
    householdId: 'household_1',
    debtId: 'debt_1',
    financialAccountId: 'acct_1',
  });

  assert.equal(result.id, 'debt_1');
  assert.equal(result.financialAccountId, 'acct_1');
  assert.equal(result.currentBalance, '4300.00');
  assert.equal(result.paymentsThisMonth, '400.00');
  assert.equal(db.state.debtPayments.length, 1);
  assert.equal(db.state.updatedDebt.financialAccountId, 'acct_1');
  assert.deepEqual(result.balanceAuthority, {
    source: 'financial_account',
    balance: '4300.00',
    asOf: '2026-03-31T00:00:00.000Z',
    financialAccountId: 'acct_1',
  });
});

test('linkDebtToFinancialAccount rejects cross-workspace and incompatible accounts', async () => {
  const db = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      isActive: true,
    }],
    financialAccounts: [
      {
        id: 'acct_other',
        householdId: 'household_2',
        workspaceId: 'household_2',
        name: 'Other card',
        accountType: 'credit_card',
        currentBalance: '-5000.00',
        status: 'active',
      },
      {
        id: 'acct_checking',
        householdId: 'household_1',
        workspaceId: 'household_1',
        name: 'Checking',
        accountType: 'checking',
        currentBalance: '5000.00',
        status: 'active',
      },
    ],
  });

  await assert.rejects(
    () => linkDebtToFinancialAccount({ db, householdId: 'household_1', debtId: 'debt_1', financialAccountId: 'acct_other' }),
    /financial account not found/,
  );
  await assert.rejects(
    () => linkDebtToFinancialAccount({ db, householdId: 'household_1', debtId: 'debt_1', financialAccountId: 'acct_checking' }),
    /financial account must be a liability account/,
  );
  assert.equal(db.state.debts[0].financialAccountId, undefined);
});

test('linked debt reads account-backed balance without mutating account or stored debt balance', async () => {
  const db = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      financialAccountId: 'acct_1',
      isActive: true,
    }],
    debtPayments: [{ debtId: 'debt_1', householdId: 'household_1', paymentDate: '2026-03-12', amount: '1000.00' }],
    financialAccounts: [{
      id: 'acct_1',
      householdId: 'household_1',
      workspaceId: 'household_1',
      name: 'Visa account',
      accountType: 'credit_card',
      currentBalance: '-3200.00',
      balanceAsOf: '2026-03-31T00:00:00.000Z',
      status: 'active',
    }],
  });

  const result = await listDebts({ db, householdId: 'household_1' });

  assert.equal(result.items[0].currentBalance, '3200.00');
  assert.equal(result.items[0].balanceAuthority.source, 'financial_account');
  assert.equal(db.state.debts[0].startingBalance, '5000.00');
  assert.equal(db.state.financialAccounts[0].currentBalance, '-3200.00');
});

test('account balance changes do not silently mutate debt fields but do change linked read authority', async () => {
  const db = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Line of Credit',
      startingBalance: '8000.00',
      apr: 10,
      minimumPayment: '100.00',
      monthlyPayment: '300.00',
      financialAccountId: 'acct_1',
      isActive: true,
    }],
    financialAccounts: [{
      id: 'acct_1',
      householdId: 'household_1',
      workspaceId: 'household_1',
      name: 'LOC account',
      accountType: 'line_of_credit',
      currentBalance: '-6500.00',
      balanceAsOf: '2026-03-31T00:00:00.000Z',
      status: 'active',
    }],
  });

  db.state.financialAccounts[0].currentBalance = '-6000.00';
  const result = await listDebts({ db, householdId: 'household_1' });

  assert.equal(result.items[0].currentBalance, '6000.00');
  assert.equal(db.state.debts[0].startingBalance, '8000.00');
  assert.equal(db.state.debts[0].currentBalance, undefined);
});

test('unlinkDebtFromFinancialAccount rejects missing confirmed manual balance', async () => {
  const db = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      financialAccountId: 'acct_1',
      isActive: true,
    }],
  });

  await assert.rejects(
    () => unlinkDebtFromFinancialAccount({ db, householdId: 'household_1', debtId: 'debt_1' }),
    /confirmedManualBalance is required/,
  );
  assert.equal(db.state.debts[0].financialAccountId, 'acct_1');
  assert.equal(db.state.debtAdjustments.length, 0);
});

test('unlinkDebtFromFinancialAccount creates an explicit reconciliation boundary before clearing the link', async () => {
  const db = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      financialAccountId: 'acct_1',
      isActive: true,
    }],
    debtPayments: [{ debtId: 'debt_1', householdId: 'household_1', paymentDate: '2026-03-12', amount: '500.00' }],
    financialAccounts: [{
      id: 'acct_1',
      householdId: 'household_1',
      workspaceId: 'household_1',
      name: 'Visa account',
      accountType: 'credit_card',
      currentBalance: '-3000.00',
      status: 'active',
    }],
    transactions: [{ id: 'tx_existing', amount: '500.00', linkedDebtId: 'debt_1' }],
  });

  const result = await unlinkDebtFromFinancialAccount({
    db,
    householdId: 'household_1',
    debtId: 'debt_1',
    confirmedManualBalance: '3000.00',
  });

  assert.equal(result.id, 'debt_1');
  assert.equal(result.financialAccountId, null);
  assert.equal(result.currentBalance, '3000.00');
  assert.equal(db.state.debts[0].financialAccountId, null);
  assert.equal(db.state.financialAccounts[0].currentBalance, '-3000.00');
  assert.equal(db.state.debtPayments.length, 1);
  assert.equal(db.state.transactions.length, 1);
  assert.deepEqual(db.state.debtAdjustments.map((adjustment) => ({
    amount: adjustment.amount,
    adjustmentType: adjustment.adjustmentType,
    effectiveDate: adjustment.effectiveDate,
    note: adjustment.note,
  })), [{
    amount: '-1500.00',
    adjustmentType: 'reconciliation',
    effectiveDate: '2026-03-31',
    note: 'Manual balance confirmed while unlinking financial account authority',
  }]);
});

test('unlinkDebtFromFinancialAccount uses the user-confirmed balance, not the account balance', async () => {
  const db = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      financialAccountId: 'acct_1',
      isActive: true,
    }],
    debtPayments: [{ debtId: 'debt_1', householdId: 'household_1', paymentDate: '2026-03-12', amount: '500.00' }],
    debtAdjustments: [{ debtId: 'debt_1', householdId: 'household_1', amount: '100.00', adjustmentType: 'correction', effectiveDate: '2026-03-14', note: 'Prior explicit correction' }],
    financialAccounts: [{
      id: 'acct_1',
      householdId: 'household_1',
      workspaceId: 'household_1',
      name: 'Visa account',
      accountType: 'credit_card',
      currentBalance: '-3000.00',
      status: 'active',
    }],
  });

  const result = await unlinkDebtFromFinancialAccount({
    db,
    householdId: 'household_1',
    debtId: 'debt_1',
    confirmedManualBalance: '2750.00',
  });

  assert.equal(result.currentBalance, '2750.00');
  assert.equal(db.state.debtAdjustments.length, 2);
  assert.equal(db.state.debtAdjustments[0].note, 'Prior explicit correction');
  assert.equal(db.state.debtAdjustments[1].amount, '-1850.00');
  assert.equal(db.state.financialAccounts[0].currentBalance, '-3000.00');
});

test('unlinkDebtFromFinancialAccount is atomic when clearing the link fails after reconciliation', async () => {
  const db = createDbDouble({
    failUpdateDebt: true,
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      financialAccountId: 'acct_1',
      isActive: true,
    }],
    debtPayments: [{ debtId: 'debt_1', householdId: 'household_1', paymentDate: '2026-03-12', amount: '500.00' }],
  });

  await assert.rejects(
    () => unlinkDebtFromFinancialAccount({
      db,
      householdId: 'household_1',
      debtId: 'debt_1',
      confirmedManualBalance: '3000.00',
    }),
    /forced update failure/,
  );

  assert.equal(db.state.debts[0].financialAccountId, 'acct_1');
  assert.equal(db.state.debtAdjustments.length, 0);
});

test('debt PATCH rejects unsafe unlink without a confirmed manual balance', async () => {
  const db = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      financialAccountId: 'acct_1',
      isActive: true,
    }],
  });

  const response = await PATCH(
    new Request('http://localhost/api/v1/debts/debt_1', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-household-id': 'household_1',
      },
      body: JSON.stringify({ financialAccountId: null }),
    }),
    { db, params: { id: 'debt_1' } },
  );

  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /confirmedManualBalance is required/);
  assert.equal(db.state.debts[0].financialAccountId, 'acct_1');
});

test('linked debt with missing account fails loud instead of falling back to manual ledger', async () => {
  const db = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      financial_account_id: 'acct_missing',
      isActive: true,
    }],
    debtPayments: [{ debtId: 'debt_1', householdId: 'household_1', paymentDate: '2026-03-12', amount: '500.00' }],
  });

  await assert.rejects(
    () => listDebts({ db, householdId: 'household_1' }),
    /linked debt requires a financial account/,
  );
});

test('second active debt cannot link to the same active liability account', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '250.00',
        financialAccountId: 'acct_1',
        isActive: true,
      },
      {
        id: 'debt_2',
        householdId: 'household_1',
        name: 'Duplicate Visa',
        startingBalance: '2000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '250.00',
        isActive: true,
      },
    ],
    financialAccounts: [{
      id: 'acct_1',
      householdId: 'household_1',
      workspaceId: 'household_1',
      name: 'Visa account',
      accountType: 'credit_card',
      currentBalance: '-4300.00',
      status: 'active',
    }],
  });

  await assert.rejects(
    () => linkDebtToFinancialAccount({ db, householdId: 'household_1', debtId: 'debt_2', financialAccountId: 'acct_1' }),
    /already linked to an active debt/,
  );
});

test('inactive historical debt does not block a new active debt for the same account', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_old',
        householdId: 'household_1',
        name: 'Old Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '250.00',
        financialAccountId: 'acct_1',
        isActive: false,
      },
      {
        id: 'debt_new',
        householdId: 'household_1',
        name: 'New Visa',
        startingBalance: '3000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '250.00',
        isActive: true,
      },
    ],
    financialAccounts: [{
      id: 'acct_1',
      householdId: 'household_1',
      workspaceId: 'household_1',
      name: 'Visa account',
      accountType: 'credit_card',
      currentBalance: '-3000.00',
      status: 'active',
    }],
  });

  const result = await linkDebtToFinancialAccount({
    db,
    householdId: 'household_1',
    debtId: 'debt_new',
    financialAccountId: 'acct_1',
  });

  assert.equal(result.financialAccountId, 'acct_1');
  assert.equal(result.id, 'debt_new');
});

test('payoff formula is unchanged when account authority supplies the same balance input', async () => {
  const manualDb = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      isActive: true,
    }],
    debtPayments: [{ debtId: 'debt_1', householdId: 'household_1', paymentDate: '2026-03-12', amount: '500.00' }],
  });
  const accountBackedDb = createDbDouble({
    debts: [{
      id: 'debt_1',
      householdId: 'household_1',
      name: 'Visa',
      startingBalance: '5000.00',
      apr: 19.99,
      minimumPayment: '100.00',
      monthlyPayment: '250.00',
      financialAccountId: 'acct_1',
      isActive: true,
    }],
    debtPayments: [{ debtId: 'debt_1', householdId: 'household_1', paymentDate: '2026-03-12', amount: '500.00' }],
    financialAccounts: [{
      id: 'acct_1',
      householdId: 'household_1',
      workspaceId: 'household_1',
      name: 'Visa account',
      accountType: 'credit_card',
      currentBalance: '-4500.00',
      status: 'active',
    }],
  });

  const manual = await listDebts({ db: manualDb, householdId: 'household_1' });
  const accountBacked = await listDebts({ db: accountBackedDb, householdId: 'household_1' });

  assert.equal(accountBacked.items[0].currentBalance, manual.items[0].currentBalance);
  assert.equal(accountBacked.items[0].estimatedPayoffDate, manual.items[0].estimatedPayoffDate);
  assert.equal(accountBacked.items[0].monthsRemaining, manual.items[0].monthsRemaining);
  assert.equal(accountBacked.items[0].totalInterestRemaining, manual.items[0].totalInterestRemaining);
});

test('updateDebt patches editable fields and keeps currentBalance derived from payments', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '200.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
    debtPayments: [
      {
        debtId: 'debt_1',
        paymentDate: '2026-03-12',
        amount: '250.00',
      },
    ],
    debtAdjustments: [
      {
        id: 'adj_1',
        debtId: 'debt_1',
        householdId: 'household_1',
        amount: '50.00',
        adjustmentType: 'interest',
        effectiveDate: '2026-03-13',
        note: 'Monthly interest',
        createdAt: '2026-03-13T00:00:00.000Z',
      },
    ],
  });

  const result = await updateDebt({
    db,
    householdId: 'household_1',
    debtId: 'debt_1',
    input: {
      monthlyPayment: '300.00',
      isActive: false,
    },
  });

  assert.equal(result.monthlyPayment, '300.00');
  assert.equal(result.isActive, false);
  assert.equal(result.currentBalance, '4800.00');
});

test('listDebts derives currentBalance and returns summary totals from live payment rows', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '200.00',
        sortOrder: 1,
        isActive: true,
      },
      {
        id: 'debt_2',
        householdId: 'household_1',
        name: 'Line of Credit',
        startingBalance: '2000.00',
        apr: 8.25,
        minimumPayment: '50.00',
        monthlyPayment: '150.00',
        sortOrder: 2,
        isActive: true,
      },
    ],
    debtPayments: [
      { debtId: 'debt_1', paymentDate: '2026-03-12', amount: '200.00' },
      { debtId: 'debt_1', paymentDate: '2026-03-26', amount: '300.00' },
      { debtId: 'debt_2', paymentDate: '2026-03-15', amount: '2000.00' },
    ],
    debtAdjustments: [
      { debtId: 'debt_1', householdId: 'household_1', amount: '100.00', adjustmentType: 'interest', effectiveDate: '2026-03-18', note: 'interest', createdAt: '2026-03-18T00:00:00.000Z' },
    ],
  });

  const result = await listDebts({
    db,
    householdId: 'household_1',
  });

  assert.deepEqual(result.summary, {
    totalStarting: '7000.00',
    totalRemaining: '4600.00',
    totalPaidAllTime: '2500.00',
  });
  assert.equal(result.items[0].currentBalance, '4600.00');
  assert.equal(result.items[0].paymentsThisMonth, '500.00');
  assert.equal(result.items[0].interestChargedThisMonth, '100.00');
  assert.equal(result.items[0].feesThisMonth, '0.00');
  assert.equal(result.items[0].principalReductionThisMonth, '400.00');
  assert.equal(result.items[0].paymentStatus, 'paying_down');
  assert.equal(result.items[1].currentBalance, '0.00');
  assert.equal(result.items[1].status, 'paid_off');
  assert.equal(result.items[1].paymentStatus, 'paid_off');
  assert.equal(result.items[1].monthsRemaining, 0);
  assert.equal(result.items[1].totalInterestRemaining, '0.00');
});

test('listDebts sorts by APR, then balance, then payoff speed instead of manual sort order', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_low_apr',
        householdId: 'household_1',
        name: 'Low APR',
        startingBalance: '6000.00',
        apr: 8.5,
        minimumPayment: '100.00',
        monthlyPayment: '300.00',
        sortOrder: 1,
        isActive: true,
      },
      {
        id: 'debt_high_apr',
        householdId: 'household_1',
        name: 'High APR',
        startingBalance: '2000.00',
        apr: 23.9,
        minimumPayment: '50.00',
        monthlyPayment: '200.00',
        sortOrder: 99,
        isActive: true,
      },
      {
        id: 'debt_same_apr_small',
        householdId: 'household_1',
        name: 'Same APR Small',
        startingBalance: '1500.00',
        apr: 8.5,
        minimumPayment: '50.00',
        monthlyPayment: '300.00',
        sortOrder: 0,
        isActive: true,
      },
    ],
  });

  const result = await listDebts({
    db,
    householdId: 'household_1',
  });

  assert.deepEqual(result.items.map((item) => item.id), [
    'debt_high_apr',
    'debt_low_apr',
    'debt_same_apr_small',
  ]);
});

test('listDebts returns null payoff estimates when monthly payment does not beat interest accrual', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 29.99,
        minimumPayment: '0.00',
        monthlyPayment: '50.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
  });

  const result = await listDebts({
    db,
    householdId: 'household_1',
  });

  assert.equal(result.items[0].estimatedPayoffDate, null);
  assert.equal(result.items[0].monthsRemaining, null);
  assert.equal(result.items[0].totalInterestRemaining, null);
  assert.equal(result.items[0].paymentStatus, 'missed_payment');
});

test('listDebts payoff forecast uses planned monthly payment only, not the minimum payment', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 12.00,
        minimumPayment: '300.00',
        monthlyPayment: '100.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
    debtPayments: [
      { debtId: 'debt_1', paymentDate: '2026-03-10', amount: '90.00' },
    ],
  });

  const result = await listDebts({
    db,
    householdId: 'household_1',
  });

  assert.equal(result.items[0].monthlyPayment, '100.00');
  assert.equal(result.items[0].paymentStatus, 'under_minimum');
  assert.ok(typeof result.items[0].monthsRemaining === 'number');
  assert.ok(typeof result.items[0].totalInterestRemaining === 'string');
});

test('listDebts marks debts under minimum when month payments are below the minimum payment', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '1200.00',
        apr: 12.5,
        minimumPayment: '100.00',
        monthlyPayment: '150.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
    debtPayments: [
      { debtId: 'debt_1', paymentDate: '2026-03-09', amount: '50.00' },
    ],
  });

  const result = await listDebts({ db, householdId: 'household_1' });

  assert.equal(result.items[0].paymentStatus, 'under_minimum');
  assert.equal(result.items[0].paymentsThisMonth, '50.00');
  assert.equal(result.items[0].principalReductionThisMonth, '50.00');
});

test('listDebts marks debts at risk when payments do not cover monthly interest and fees', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Store Card',
        startingBalance: '5000.00',
        apr: 29.99,
        minimumPayment: '80.00',
        monthlyPayment: '150.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
    debtPayments: [
      { debtId: 'debt_1', paymentDate: '2026-03-10', amount: '90.00' },
    ],
    debtAdjustments: [
      { debtId: 'debt_1', householdId: 'household_1', amount: '120.00', adjustmentType: 'interest', effectiveDate: '2026-03-12', note: 'interest', createdAt: '2026-03-12T00:00:00.000Z' },
      { debtId: 'debt_1', householdId: 'household_1', amount: '25.00', adjustmentType: 'fee', effectiveDate: '2026-03-13', note: 'late fee', createdAt: '2026-03-13T00:00:00.000Z' },
    ],
  });

  const result = await listDebts({ db, householdId: 'household_1' });

  assert.equal(result.items[0].paymentStatus, 'at_risk');
  assert.equal(result.items[0].interestChargedThisMonth, '120.00');
  assert.equal(result.items[0].feesThisMonth, '25.00');
  assert.equal(result.items[0].principalReductionThisMonth, '0.00');
});

test('listDebts auto-posts interest on the statement cycle when enabled', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Auto Interest Card',
        startingBalance: '1200.00',
        apr: 12,
        minimumPayment: '50.00',
        monthlyPayment: '100.00',
        statementDay: 10,
        paymentDueDay: 25,
        lateFeeAmount: '35.00',
        autoPostInterest: true,
        autoPostLateFee: false,
        sortOrder: 1,
        isActive: true,
        createdAt: '2026-03-01T00:00:00.000Z',
      },
    ],
  });

  const result = await listDebts({ db, householdId: 'household_1' });

  assert.equal(result.items[0].interestChargedThisMonth, '12.00');
  assert.equal(result.items[0].currentBalance, '1212.00');
  assert.equal(result.items[0].nextStatementDate, '2026-04-10');
  assert.equal(result.items[0].nextPaymentDueDate, '2026-03-25');
});

test('listDebts auto-posts late fee when due cycle is missed and auto late fee is enabled', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Late Fee Card',
        startingBalance: '2000.00',
        apr: 18,
        minimumPayment: '100.00',
        monthlyPayment: '125.00',
        statementDay: 5,
        paymentDueDay: 20,
        lateFeeAmount: '30.00',
        autoPostInterest: false,
        autoPostLateFee: true,
        sortOrder: 1,
        isActive: true,
        createdAt: '2026-03-01T00:00:00.000Z',
      },
    ],
  });

  const result = await listDebts({ db, householdId: 'household_1' });

  assert.equal(result.items[0].feesThisMonth, '30.00');
  assert.equal(result.items[0].currentBalance, '2030.00');
  assert.equal(result.items[0].paymentStatus, 'missed_payment');
});

test('listDebts handles a 12-month credit card stress dataset with interest, spend, missed payment, fee, and payoff shifts', async () => {
  const dataset = buildDebtStressDataset();

  const marchDb = createDbDouble({
    ...dataset,
    household: { id: 'household_1', activeMonth: '2026-03-01' },
  });
  const aprilDb = createDbDouble({
    ...dataset,
    household: { id: 'household_1', activeMonth: '2026-04-01' },
  });
  const juneDb = createDbDouble({
    ...dataset,
    household: { id: 'household_1', activeMonth: '2026-06-01' },
  });
  const augustDb = createDbDouble({
    ...dataset,
    household: { id: 'household_1', activeMonth: '2026-08-01' },
  });
  const decemberDb = createDbDouble({
    ...dataset,
    household: { id: 'household_1', activeMonth: '2026-12-01' },
  });

  const march = await listDebts({ db: marchDb, householdId: 'household_1' });
  assert.equal(march.items[0].paymentsThisMonth, '80.00');
  assert.equal(march.items[0].interestChargedThisMonth, '31.80');
  assert.equal(march.items[0].paymentStatus, 'paying_down');

  const april = await listDebts({ db: aprilDb, householdId: 'household_1' });
  assert.equal(april.items[0].paymentsThisMonth, '0.00');
  assert.equal(april.items[0].feesThisMonth, '35.00');
  assert.equal(april.items[0].paymentStatus, 'missed_payment');

  const june = await listDebts({ db: juneDb, householdId: 'household_1' });
  assert.equal(june.items[0].interestChargedThisMonth, '29.70');
  assert.equal(june.items[0].paymentsThisMonth, '120.00');
  assert.equal(june.items[0].currentBalance, '1950.82');
  assert.ok(Number(june.items[0].monthsRemaining) > 0);

  const august = await listDebts({ db: augustDb, householdId: 'household_1' });
  assert.equal(august.items[0].paymentsThisMonth, '45.00');
  assert.equal(august.items[0].paymentStatus, 'paying_down');
  assert.ok(Number(august.items[0].monthsRemaining) > Number(june.items[0].monthsRemaining));

  const december = await listDebts({ db: decemberDb, householdId: 'household_1' });
  assert.equal(december.items[0].interestChargedThisMonth, '12.20');
  assert.equal(december.items[0].paymentsThisMonth, '600.00');
  assert.equal(december.items[0].currentBalance, '700.22');
  assert.equal(december.items[0].status, 'current');
  assert.equal(december.items[0].paymentStatus, 'paying_down');
});

test('listDebts marks the debt paid off when the December payoff covers the final remaining balance', async () => {
  const dataset = buildDebtStressDatasetWithTruePayoff();
  const decemberDb = createDbDouble({
    ...dataset,
    household: { id: 'household_1', activeMonth: '2026-12-01' },
  });

  const december = await listDebts({ db: decemberDb, householdId: 'household_1' });

  assert.equal(december.items[0].paymentsThisMonth, '1300.22');
  assert.equal(december.items[0].interestChargedThisMonth, '12.20');
  assert.equal(december.items[0].currentBalance, '0.00');
  assert.equal(december.items[0].closingBalance, '0.00');
  assert.equal(december.items[0].status, 'paid_off');
  assert.equal(december.items[0].paymentStatus, 'paid_off');
  assert.equal(december.items[0].monthsRemaining, 0);
  assert.equal(december.items[0].totalInterestRemaining, '0.00');
});

test('createDebtAdjustment records an auditable balance adjustment and updates derived balance', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '200.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
  });

  const adjustment = await createDebtAdjustment({
    db,
    householdId: 'household_1',
    debtId: 'debt_1',
    input: {
      amount: '75.00',
      adjustment_type: 'interest',
      effective_date: '2026-03-15',
      note: 'March interest',
    },
  });

  assert.deepEqual(adjustment, {
    id: 'adj_1',
    debt_id: 'debt_1',
    household_id: 'household_1',
    amount: '75.00',
    adjustment_type: 'interest',
    effective_date: '2026-03-15',
    note: 'March interest',
    created_at: '2026-03-13T00:00:00.000Z',
  });

  const debts = await listDebts({ db, householdId: 'household_1' });
  assert.equal(debts.items[0].currentBalance, '5075.00');
  assert.equal(debts.items[0].totalAdjustments, '75.00');
});

test('listDebtAdjustments returns adjustment history for a debt', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '200.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
    debtAdjustments: [
      {
        id: 'adj_1',
        debtId: 'debt_1',
        householdId: 'household_1',
        amount: '75.00',
        adjustmentType: 'interest',
        effectiveDate: '2026-03-15',
        note: 'March interest',
        createdAt: '2026-03-13T00:00:00.000Z',
      },
    ],
  });

  const listed = await listDebtAdjustments({
    db,
    householdId: 'household_1',
    debtId: 'debt_1',
  });

  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].adjustment_type, 'interest');
});

test('deleteDebt blocks deletion when linked payments exist and suggests soft disable', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '200.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
    debtPayments: [
      { debtId: 'debt_1', paymentDate: '2026-03-12', amount: '200.00' },
    ],
  });

  await assert.rejects(
    () =>
      deleteDebt({
        db,
        householdId: 'household_1',
        debtId: 'debt_1',
      }),
    /set isActive=false instead/,
  );
});

test('createDebt rejects invalid negative money values', async () => {
  const db = createDbDouble();

  await assert.rejects(
    () =>
      createDebt({
        db,
        householdId: 'household_1',
        input: {
          name: 'Visa',
          startingBalance: '-5000.00',
          apr: '19.99',
          minimumPayment: '100.00',
          monthlyPayment: '200.00',
        },
      }),
    /startingBalance must be a non-negative decimal with up to 2 places/,
  );
});

test('updateDebt rejects manual edits to currentBalance as a business rule violation', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_1',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '200.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
  });

  await assert.rejects(
    () =>
      updateDebt({
        db,
        householdId: 'household_1',
        debtId: 'debt_1',
        input: {
          currentBalance: '4000.00',
        },
      }),
    /currentBalance is a derived or immutable balance field and cannot be edited/,
  );
});

test('debt routes cover POST, GET, PATCH, and DELETE', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_existing',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '200.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
  });

  const postResponse = await POST(
    new Request('http://localhost/api/v1/debts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-household-id': 'household_1',
      },
      body: JSON.stringify({
        name: 'LOC',
        startingBalance: '1200.00',
        apr: '8.25',
        minimumPayment: '25.00',
        monthlyPayment: '50.00',
      }),
    }),
    { db },
  );

  assert.equal(postResponse.status, 201);

  const getResponse = await GET(
    new Request('http://localhost/api/v1/debts', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db },
  );

  assert.equal(getResponse.status, 200);
  assert.equal((await getResponse.json()).summary.totalStarting, '6200.00');

  const patchResponse = await PATCH(
    new Request('http://localhost/api/v1/debts/debt_existing', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-household-id': 'household_1',
      },
      body: JSON.stringify({
        monthlyPayment: '225.00',
      }),
    }),
    { db, params: { id: 'debt_existing' } },
  );

  assert.equal(patchResponse.status, 200);
  assert.equal((await patchResponse.json()).monthlyPayment, '225.00');

  const deleteResponse = await DELETE(
    new Request('http://localhost/api/v1/debts/debt_existing', {
      method: 'DELETE',
      headers: {
        'x-household-id': 'household_1',
      },
    }),
    { db, params: { id: 'debt_existing' } },
  );

  assert.equal(deleteResponse.status, 204);
});

test('debt adjustment routes cover POST and GET', async () => {
  const db = createDbDouble({
    debts: [
      {
        id: 'debt_existing',
        householdId: 'household_1',
        name: 'Visa',
        startingBalance: '5000.00',
        apr: 19.99,
        minimumPayment: '100.00',
        monthlyPayment: '200.00',
        sortOrder: 1,
        isActive: true,
      },
    ],
  });

  const postResponse = await postAdjustmentRoute(
    new Request('http://localhost/api/v1/debts/debt_existing/adjustments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-household-id': 'household_1',
      },
      body: JSON.stringify({
        amount: '45.00',
        adjustment_type: 'fee',
        effective_date: '2026-03-20',
        note: 'Late fee',
      }),
    }),
    { db, params: { id: 'debt_existing' } },
  );
  assert.equal(postResponse.status, 201);

  const getResponse = await getAdjustmentsRoute(
    new Request('http://localhost/api/v1/debts/debt_existing/adjustments', {
      headers: { 'x-household-id': 'household_1' },
    }),
    { db, params: { id: 'debt_existing' } },
  );
  assert.equal(getResponse.status, 200);
  assert.equal((await getResponse.json()).items.length, 1);
});
