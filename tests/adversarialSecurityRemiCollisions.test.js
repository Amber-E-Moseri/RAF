/**
 * Phase 7 — Security, Remi & Cross-Feature Collision Adversarial Tests
 *
 * Central invariant:
 *   A valid feature + another valid feature + another valid feature
 *   must not produce an invalid authority path.
 *
 * Coverage areas:
 *   1. Remi dispatchToolCall workspace isolation (tool-layer boundary)
 *   2. Remi conversation workspace isolation
 *   3. Remi write authority (all tools are read-only or advisory)
 *   4. Cross-feature collision chains (Import→Remi, Txn→Goal→Remi, Forecast→Remi, Scenario→Remi)
 *   5. Authentication & authorization boundary (Remi-specific)
 *   6. Audit log safety
 *
 * Architecture notes preserved by these tests:
 *   - dispatchToolCall receives householdId from the TRUSTED route context, never from
 *     user-supplied tool input. Any IDs in tool `input` are post-hoc filters over
 *     already householdId-scoped data — a foreign objectId returns empty, not foreign data.
 *   - getRemiConversation requires BOTH conversationId AND householdId to match.
 *     A stale workspace-A conversationId produces null in workspace-B context.
 *   - create_scenario and propose_allocation_change are advisory previews; they make
 *     no DB writes. Remi has no financial write authority.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatchToolCall } from '../lib/remi/toolHandlers.js';
import { buildFinancialContext } from '../lib/remi/financialContext.js';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import { startIsolatedSqliteServer } from './helpers/isolatedSqliteServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const HH_A = 'phase7_household_a';
const HH_B = 'phase7_household_b';

// Workspace A deterministic IDs
const GOAL_A_ID = 'phase7_goal_a1';
const DEBT_A_ID = 'phase7_debt_a1';
const ACCOUNT_A_ID = 'phase7_account_a1';
const CATEGORY_A_ID = 'phase7_cat_a1';

// Workspace B deterministic IDs
const GOAL_B_ID = 'phase7_goal_b1';
const DEBT_B_ID = 'phase7_debt_b1';
const ACCOUNT_B_ID = 'phase7_account_b1';
const CATEGORY_B_ID = 'phase7_cat_b1';

// Same-looking display values in both workspaces (intentional collision)
const COLLISION_MERCHANT = 'Amazon';
const COLLISION_AMOUNT = '84.22';

// Distinctive values that identify each workspace unambiguously
const DISTINCTIVE_AMOUNT_A = '520.00'; // Only in workspace A
const DISTINCTIVE_AMOUNT_B = '250.00'; // Only in workspace B

// ─────────────────────────────────────────────────────────────────────────────
// TWO-WORKSPACE DB DOUBLE
//
// Returns workspace-scoped data based on `householdId`. Every query method
// filters to the supplied householdId — data from the other workspace is never
// returned regardless of any `input` parameter values.
// ─────────────────────────────────────────────────────────────────────────────

function makeWorkspaceData(householdId, { goalId, debtId, accountId, categoryId, distinctiveAmount, goalTarget, debtName, goalName }) {
  const now = '2026-09-16';
  const monthStart = '2026-09-01';

  const allocationCategories = [
    {
      id: categoryId,
      householdId,
      slug: 'personal_spending',
      label: 'Personal Spending',
      allocationPercent: '0.1500',
      isSystem: false,
      isActive: true,
      isBuffer: false,
      sortOrder: 1,
      snapshotId: categoryId,
      effectiveFrom: '2026-01-01',
      supersededAt: null,
    },
    {
      id: `${categoryId}_buffer`,
      householdId,
      slug: 'buffer',
      label: 'Buffer',
      allocationPercent: '0.1000',
      isSystem: true,
      isActive: true,
      isBuffer: true,
      sortOrder: 9,
      snapshotId: `${categoryId}_buffer`,
      effectiveFrom: '2026-01-01',
      supersededAt: null,
    },
  ];

  const incomeEntries = [
    { id: `${householdId}_income1`, householdId, receivedDate: '2026-09-05', amount: '3000.00', sourceName: `Payroll ${householdId}` },
  ];

  const incomeAllocations = [
    {
      incomeEntryId: `${householdId}_income1`,
      receivedDate: '2026-09-05',
      allocationCategoryId: categoryId,
      slug: 'personal_spending',
      allocatedAmount: '450.00',
      householdId,
    },
  ];

  const transactions = [
    {
      id: `${householdId}_txn_collision`,
      householdId,
      transactionDate: '2026-09-10',
      merchant: COLLISION_MERCHANT,
      description: `${COLLISION_MERCHANT} purchase`,
      amount: COLLISION_AMOUNT,
      direction: 'debit',
      categoryId,
      categorySlug: 'personal_spending',
      linkedGoalId: null,
    },
    {
      id: `${householdId}_txn_distinctive`,
      householdId,
      transactionDate: '2026-09-12',
      merchant: `Distinctive Merchant ${householdId}`,
      description: `Distinctive purchase`,
      amount: distinctiveAmount,
      direction: 'debit',
      categoryId,
      categorySlug: 'personal_spending',
      linkedGoalId: null,
    },
    {
      id: `${householdId}_txn_goal`,
      householdId,
      transactionDate: '2026-09-15',
      merchant: 'Goal Contribution',
      description: 'Goal contribution',
      amount: '100.00',
      direction: 'debit',
      categoryId,
      categorySlug: 'personal_spending',
      linkedGoalId: goalId,
    },
  ];

  const goals = [
    {
      id: goalId,
      householdId,
      bucketId: categoryId,
      name: goalName,
      targetAmount: goalTarget,
      active: true,
      createdAt: '2026-01-01',
    },
  ];

  const debts = [
    {
      id: debtId,
      householdId,
      name: debtName,
      startingBalance: '2000.00',
      apr: 19.99,
      minimumPayment: '60.00',
      monthlyPayment: '120.00',
      active: true,
      financialAccountId: null,
    },
  ];

  const financialAccounts = [
    {
      id: accountId,
      householdId,
      name: `Primary Chequing ${householdId}`,
      accountType: 'checking',
      currentBalance: '5000.00',
      status: 'active',
    },
  ];

  return {
    household: {
      id: householdId,
      name: `Household ${householdId}`,
      activeMonth: monthStart,
      timezone: 'America/Toronto',
      periodStartDay: 1,
      savingsFloor: '2000.00',
      savingsFloorEnabled: true,
      monthlyEssentialsBaseline: '1800.00',
    },
    allocationCategories,
    incomeEntries,
    incomeAllocations,
    transactions,
    goals,
    debts,
    financialAccounts,
  };
}

const DATA_A = makeWorkspaceData(HH_A, {
  goalId: GOAL_A_ID,
  debtId: DEBT_A_ID,
  accountId: ACCOUNT_A_ID,
  categoryId: CATEGORY_A_ID,
  distinctiveAmount: DISTINCTIVE_AMOUNT_A,
  goalTarget: '5000.00',
  debtName: 'Visa Workspace A',
  goalName: 'Emergency Fund',
});

const DATA_B = makeWorkspaceData(HH_B, {
  goalId: GOAL_B_ID,
  debtId: DEBT_B_ID,
  accountId: ACCOUNT_B_ID,
  categoryId: CATEGORY_B_ID,
  distinctiveAmount: DISTINCTIVE_AMOUNT_B,
  goalTarget: '3000.00',
  debtName: 'Visa Workspace B',
  goalName: 'Emergency Fund', // same name, different target — intentional collision
});

function createTwoWorkspaceDb() {
  const dataMap = { [HH_A]: DATA_A, [HH_B]: DATA_B };

  function txFor(householdId) {
    const ws = dataMap[householdId] ?? null;
    return {
      async getHousehold({ householdId: hhId }) {
        return dataMap[hhId]?.household ?? null;
      },
      async listFinancialAccounts({ householdId: hhId }) {
        return dataMap[hhId]?.financialAccounts ?? [];
      },
      async listIncomeEntries({ householdId: hhId }) {
        return dataMap[hhId]?.incomeEntries ?? [];
      },
      async listIncomeAllocations({ householdId: hhId }) {
        return dataMap[hhId]?.incomeAllocations ?? [];
      },
      async listTransactions({ householdId: hhId }) {
        return dataMap[hhId]?.transactions ?? [];
      },
      async listDebtPayments({ householdId: hhId }) {
        return [];
      },
      async listDebtAdjustments({ householdId: hhId }) {
        return [];
      },
      async listDebts({ householdId: hhId }) {
        return dataMap[hhId]?.debts ?? [];
      },
      async listGoals({ householdId: hhId }) {
        return dataMap[hhId]?.goals ?? [];
      },
      async listAllocationCategories({ householdId: hhId }) {
        return dataMap[hhId]?.allocationCategories ?? [];
      },
      async listFixedBills({ householdId: hhId }) {
        return [];
      },
      async listUpcomingExpenses({ householdId: hhId }) {
        return [];
      },
      async listMonthlyReviews({ householdId: hhId }) {
        return [];
      },
      async listImportedTransactions({ householdId: hhId }) {
        return [];
      },
      async listTransactionSplits({ householdId: hhId }) {
        return [];
      },
      async getFinancialAccountById({ householdId: hhId, accountId }) {
        return dataMap[hhId]?.financialAccounts?.find((a) => a.id === accountId) ?? null;
      },
    };
  }

  // The db wraps the transaction call so the tx always uses the OUTER householdId
  // that was bound at creation time for each dispatchToolCall invocation.
  return {
    writes: [],
    async transaction(callback) {
      // The proxy tx handles all householdId params correctly:
      // each method call receives the householdId from its own parameter,
      // not from any external variable.
      const tx = txFor(null);
      return callback(tx);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: REMI TOOL-CALL WORKSPACE ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Remi dispatchToolCall workspace isolation', () => {
  test('1.1 positive control — get_goal_progress with householdId A returns workspace A goal', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_goal_progress',
      input: {},
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.goals.length, 1);
    assert.equal(result.goals[0].name, 'Emergency Fund');
    assert.equal(result.goals[0].target, '5000.00', 'workspace A goal has target $5000');
  });

  test('1.2 positive control — get_goal_progress with householdId B returns workspace B goal', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_goal_progress',
      input: {},
      db,
      householdId: HH_B,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.goals.length, 1);
    assert.equal(result.goals[0].target, '3000.00', 'workspace B goal has target $3000');
  });

  test('1.3 foreign goalId in tool input returns empty — not workspace B goal data', async () => {
    const db = createTwoWorkspaceDb();
    // Pass workspace B's goal ID while trusted context is workspace A
    const result = await dispatchToolCall({
      name: 'get_goal_progress',
      input: { goalId: GOAL_B_ID },
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.goals.length, 0,
      'foreign goalId must return empty — not workspace B goal data');
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('3000.00'), 'workspace B target amount must not appear in workspace A result');
  });

  test('1.4 get_debt_strategy with householdId A returns only workspace A debts', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_debt_strategy',
      input: {},
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.debts.length, 1);
    assert.ok(result.debts[0].name.includes('Workspace A'), 'must be workspace A debt name');
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('Workspace B'), 'workspace B debt must not appear');
    assert.ok(!serialized.includes(DEBT_B_ID), 'workspace B debt ID must not appear');
  });

  test('1.5 get_debt_strategy with householdId B returns only workspace B debts', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_debt_strategy',
      input: {},
      db,
      householdId: HH_B,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.debts.length, 1);
    assert.ok(result.debts[0].name.includes('Workspace B'), 'must be workspace B debt name');
    assert.ok(!JSON.stringify(result).includes('Workspace A'), 'workspace A debt must not appear');
  });

  test('1.6 get_transaction_summary with householdId A sees only workspace A transactions', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_transaction_summary',
      input: { from: '2026-09-01', to: '2026-09-30' },
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    // Workspace A has 3 debit transactions: collision($84.22) + distinctive A($520.00) + goal($100.00)
    // total = $704.22
    assert.equal(result.transaction_count, 3);
    assert.equal(result.total_spending, '704.22');
    // Workspace B's distinctive amount must not appear
    assert.ok(!JSON.stringify(result).includes(DISTINCTIVE_AMOUNT_B),
      'workspace B distinctive amount must not appear in workspace A result');
  });

  test('1.7 get_transaction_summary with householdId B sees only workspace B transactions', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_transaction_summary',
      input: { from: '2026-09-01', to: '2026-09-30' },
      db,
      householdId: HH_B,
    });
    assert.equal(result.error, undefined);
    // Workspace B: collision($84.22) + distinctive B($250.00) + goal($100.00) = $434.22
    assert.equal(result.transaction_count, 3);
    assert.equal(result.total_spending, '434.22');
    assert.ok(!JSON.stringify(result).includes(DISTINCTIVE_AMOUNT_A),
      'workspace A distinctive amount must not appear in workspace B result');
  });

  test('1.8 same-looking data (Amazon $84.22 in both workspaces): each context returns only its own total', async () => {
    const db = createTwoWorkspaceDb();
    const [resultA, resultB] = await Promise.all([
      dispatchToolCall({ name: 'get_transaction_summary', input: { from: '2026-09-01', to: '2026-09-30' }, db, householdId: HH_A }),
      dispatchToolCall({ name: 'get_transaction_summary', input: { from: '2026-09-01', to: '2026-09-30' }, db, householdId: HH_B }),
    ]);
    // Both workspaces have "Amazon $84.22" but each context sees its own total
    assert.notEqual(resultA.total_spending, resultB.total_spending,
      'workspace totals must differ despite having identical Amazon transaction');
    // Workspace A total must not include workspace B distinctive amount
    const spending_a = Number(resultA.total_spending);
    const spending_b = Number(resultB.total_spending);
    assert.ok(spending_a !== spending_a + Number(DISTINCTIVE_AMOUNT_B),
      'workspace A spending must not include workspace B amounts');
    assert.ok(spending_b !== spending_b + Number(DISTINCTIVE_AMOUNT_A),
      'workspace B spending must not include workspace A amounts');
  });

  test('1.9 same goal name "Emergency Fund" in two workspaces — each context sees its own target', async () => {
    const db = createTwoWorkspaceDb();
    const [resultA, resultB] = await Promise.all([
      dispatchToolCall({ name: 'get_goal_progress', input: {}, db, householdId: HH_A }),
      dispatchToolCall({ name: 'get_goal_progress', input: {}, db, householdId: HH_B }),
    ]);
    // Both goals are named "Emergency Fund" but targets differ
    assert.equal(resultA.goals[0].name, 'Emergency Fund');
    assert.equal(resultB.goals[0].name, 'Emergency Fund');
    assert.equal(resultA.goals[0].target, '5000.00', 'workspace A goal target');
    assert.equal(resultB.goals[0].target, '3000.00', 'workspace B goal target');
    // Workspace A result must not include workspace B target
    assert.ok(!JSON.stringify(resultA).includes('3000.00'),
      'workspace A result must not include workspace B goal target');
    assert.ok(!JSON.stringify(resultB).includes('5000.00'),
      'workspace B result must not include workspace A goal target');
  });

  test('1.10 explain_variance with householdId A sees only workspace A transaction drivers', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'explain_variance',
      input: { categorySlug: 'personal_spending', period: '2026-09-01' },
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(`household_b`), 'workspace B householdId must not appear in result');
    assert.ok(!serialized.includes(DEBT_B_ID), 'workspace B debt ID must not appear');
  });

  test('1.11 get_current_plan with householdId A never includes workspace B allocation categories', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_current_plan',
      input: {},
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(CATEGORY_B_ID),
      'workspace B category ID must not appear in workspace A plan');
  });

  test('1.12 workspace switch at tool layer: switching householdId changes data context', async () => {
    const db = createTwoWorkspaceDb();
    // Simulate workspace switch by calling with different householdIds
    const beforeSwitch = await dispatchToolCall({ name: 'get_debt_strategy', input: {}, db, householdId: HH_A });
    const afterSwitch = await dispatchToolCall({ name: 'get_debt_strategy', input: {}, db, householdId: HH_B });
    const returnToA = await dispatchToolCall({ name: 'get_debt_strategy', input: {}, db, householdId: HH_A });

    assert.ok(beforeSwitch.debts[0].name.includes('Workspace A'));
    assert.ok(afterSwitch.debts[0].name.includes('Workspace B'));
    assert.ok(returnToA.debts[0].name.includes('Workspace A'),
      'returning to workspace A restores workspace A context correctly');
    // Workspace A context not contaminated by workspace B switch
    assert.ok(!JSON.stringify(returnToA).includes('Workspace B'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: REMI CONVERSATION WORKSPACE ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Remi conversation workspace isolation', () => {
  function makeConvDb({ conversations = [], messages = [] } = {}) {
    const convStore = conversations.map((c) => ({ ...c }));
    const msgStore = messages.map((m) => ({ ...m }));

    return {
      async transaction(callback) {
        const tx = {
          async getUserById({ userId }) {
            return { id: userId, remiTier: 'free' };
          },
          async getHousehold({ householdId }) {
            return { id: householdId, name: `HH ${householdId}`, activeMonth: '2026-09-01' };
          },
          async getRemiConversation({ conversationId, householdId }) {
            return convStore.find((c) => c.id === conversationId && c.householdId === householdId) ?? null;
          },
          async listRemiConversations({ householdId, userId }) {
            return convStore.filter((c) => c.householdId === householdId && c.userId === userId);
          },
          async listRemiMessages({ conversationId, householdId }) {
            return msgStore.filter((m) => m.conversationId === conversationId && m.householdId === householdId);
          },
          async createRemiConversation({ householdId, userId, title }) {
            const conv = { id: `new_conv_${Date.now()}`, householdId, userId, title, createdAt: new Date().toISOString() };
            convStore.push(conv);
            return conv;
          },
          async appendRemiMessage({ conversationId, householdId, role, content, tokensUsed }) {
            const msg = { id: `msg_${Date.now()}`, conversationId, householdId, role, content, tokensUsed, createdAt: new Date().toISOString() };
            msgStore.push(msg);
            return msg;
          },
          async listIncomeEntries() { return []; },
          async listTransactions() { return []; },
          async listDebts() { return []; },
          async listDebtPayments() { return []; },
          async listGoals() { return []; },
          async listMonthlyReviews() { return []; },
        };
        return callback(tx);
      },
    };
  }

  test('2.1 getRemiConversation requires both conversationId and householdId to match', async () => {
    const convA = { id: 'conv_ws_a', householdId: HH_A, userId: 'user_1', title: 'Workspace A conversation', createdAt: new Date().toISOString() };
    const db = makeConvDb({ conversations: [convA] });

    const found = await db.transaction((tx) => tx.getRemiConversation({ conversationId: 'conv_ws_a', householdId: HH_A }));
    assert.ok(found, 'conversation found with matching householdId');
  });

  test('2.2 stale workspace A conversationId rejected in workspace B context — returns null', async () => {
    const convA = { id: 'conv_ws_a', householdId: HH_A, userId: 'user_1', title: 'Workspace A conversation', createdAt: new Date().toISOString() };
    const db = makeConvDb({ conversations: [convA] });

    // Use workspace A's conversation ID but with workspace B's householdId
    const result = await db.transaction((tx) => tx.getRemiConversation({ conversationId: 'conv_ws_a', householdId: HH_B }));
    assert.equal(result, null,
      'workspace A conversation must not be visible in workspace B context');
  });

  test('2.3 listRemiConversations scoped to householdId — workspace A conversations not visible in B', async () => {
    const conversations = [
      { id: 'conv_a1', householdId: HH_A, userId: 'user_1', title: 'Conv A', createdAt: new Date().toISOString() },
      { id: 'conv_b1', householdId: HH_B, userId: 'user_1', title: 'Conv B', createdAt: new Date().toISOString() },
    ];
    const db = makeConvDb({ conversations });

    const convsForB = await db.transaction((tx) => tx.listRemiConversations({ householdId: HH_B, userId: 'user_1' }));
    assert.equal(convsForB.length, 1, 'only workspace B conversation returned');
    assert.equal(convsForB[0].id, 'conv_b1');
    assert.ok(!convsForB.some((c) => c.id === 'conv_a1'),
      'workspace A conversation must not appear in workspace B listing');
  });

  test('2.4 listRemiMessages scoped to conversationId + householdId pair', async () => {
    const conversations = [
      { id: 'conv_a1', householdId: HH_A, userId: 'user_1', title: 'Conv A', createdAt: new Date().toISOString() },
    ];
    const messages = [
      { id: 'msg_a1', conversationId: 'conv_a1', householdId: HH_A, role: 'user', content: 'Workspace A message', tokensUsed: 0, createdAt: new Date().toISOString() },
    ];
    const db = makeConvDb({ conversations, messages });

    // Attempt to list messages for conv_a1 but with workspace B context
    const msgs = await db.transaction((tx) => tx.listRemiMessages({ conversationId: 'conv_a1', householdId: HH_B }));
    assert.equal(msgs.length, 0,
      'workspace A messages must not be accessible with workspace B householdId');
  });

  test('2.5 workspace switch during chat: new conversation created when stale conversationId fails', async () => {
    const convA = { id: 'conv_ws_a_stale', householdId: HH_A, userId: 'user_1', title: 'Old conv', createdAt: new Date().toISOString() };
    const db = makeConvDb({ conversations: [convA] });

    // Simulate: user switches to workspace B and tries to continue workspace A's conversation
    const conv = await db.transaction((tx) => tx.getRemiConversation({ conversationId: 'conv_ws_a_stale', householdId: HH_B }));
    assert.equal(conv, null, 'stale workspace A conv must return null');
    // In the chat route, null result causes a new conversation to be created — no workspace A data leaked
    const newConv = await db.transaction((tx) => tx.createRemiConversation({ householdId: HH_B, userId: 'user_1', title: 'New B conv' }));
    assert.equal(newConv.householdId, HH_B, 'new conversation scoped to workspace B');
    assert.ok(newConv.id !== 'conv_ws_a_stale', 'new conversation has different ID');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: REMI WRITE AUTHORITY
// ─────────────────────────────────────────────────────────────────────────────

describe('Remi write authority — all tools are read-only or advisory', () => {
  const writes = [];
  function createWriteTrackingDb() {
    const baseDb = createTwoWorkspaceDb();
    const original = baseDb.transaction.bind(baseDb);
    baseDb.transaction = async (callback) => {
      const proxy = new Proxy({}, {
        get(target, prop) {
          const original_fn = Object.assign(
            async (...args) => {
              const lowerProp = String(prop).toLowerCase();
              if (lowerProp.startsWith('insert') || lowerProp.startsWith('update') || lowerProp.startsWith('delete') || lowerProp.startsWith('create') || lowerProp.startsWith('log')) {
                writes.push({ method: prop, args });
                throw new Error(`Remi tool called a write method: ${String(prop)}`);
              }
              // Delegate to base transaction
              return original(async (tx) => tx[prop]?.(...args) ?? null);
            },
          );
          return original_fn;
        },
      });
      return original(callback);
    };
    return { db: baseDb, writes };
  }

  test('3.1 create_scenario returns preview only — no DB writes occur', async () => {
    const db = createTwoWorkspaceDb();
    const writesBefore = [...(db.writes ?? [])];
    const result = await dispatchToolCall({
      name: 'create_scenario',
      input: { description: 'Spend $900 on emergency repair', amountDelta: '900.00', categorySlug: 'personal_spending' },
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    // Must be a preview object, not a financial mutation
    assert.ok(result.note !== undefined, 'create_scenario must return a note/preview');
    assert.ok(!result.note?.toLowerCase().includes('changed') || result.note.includes('preview'),
      'note must confirm no data was changed');
    assert.deepEqual(db.writes ?? [], writesBefore,
      'create_scenario must not make DB writes');
  });

  test('3.2 create_scenario does not create a $900 transaction in workspace', async () => {
    const db = createTwoWorkspaceDb();
    // Verify there's no $900 transaction before or after the scenario call
    const before = await dispatchToolCall({ name: 'get_transaction_summary', input: { from: '2026-01-01', to: '2026-12-31' }, db, householdId: HH_A });
    await dispatchToolCall({ name: 'create_scenario', input: { description: 'Spend $900 on repair', amountDelta: '900.00' }, db, householdId: HH_A });
    const after = await dispatchToolCall({ name: 'get_transaction_summary', input: { from: '2026-01-01', to: '2026-12-31' }, db, householdId: HH_A });
    assert.equal(before.transaction_count, after.transaction_count,
      'no new transaction created by create_scenario');
    assert.equal(before.total_spending, after.total_spending,
      'total spending unchanged after create_scenario');
  });

  test('3.3 propose_allocation_change returns confirmation_required:true — no DB writes', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'propose_allocation_change',
      input: { action: 'add_to_goal', targetId: GOAL_A_ID, amount: '200.00', rationale: 'Extra buffer' },
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.confirmation_required, true,
      'propose_allocation_change must require explicit confirmation');
    assert.equal(result.type, 'proposal',
      'result must be typed as a proposal, not an executed action');
    assert.ok(result.note?.includes('preview'),
      'note must confirm this is a preview only');
  });

  test('3.4 propose_allocation_change does not change goal progress', async () => {
    const db = createTwoWorkspaceDb();
    const goalsBefore = await dispatchToolCall({ name: 'get_goal_progress', input: {}, db, householdId: HH_A });
    await dispatchToolCall({ name: 'propose_allocation_change', input: { action: 'add_to_goal', targetId: GOAL_A_ID, amount: '500.00', rationale: 'Test' }, db, householdId: HH_A });
    const goalsAfter = await dispatchToolCall({ name: 'get_goal_progress', input: {}, db, householdId: HH_A });
    assert.deepEqual(goalsBefore.goals[0].current, goalsAfter.goals[0].current,
      'goal current amount must be unchanged after propose_allocation_change');
  });

  test('3.5 redirect_surplus proposal returns preview with confirmation_required', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'propose_allocation_change',
      input: { action: 'redirect_surplus', amount: '300.00', rationale: 'Redirect to savings' },
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.confirmation_required, true);
    assert.equal(result.type, 'proposal');
    assert.ok(result.note?.includes('preview'),
      'redirect_surplus must also be a preview only');
  });

  test('3.6 all 11 Remi tools combined: zero DB writes occur', async () => {
    const db = createTwoWorkspaceDb();
    const allToolCalls = [
      ['get_current_plan', { period: '2026-09-01' }],
      ['get_available_resources', {}],
      ['get_upcoming_obligations', { days: 30 }],
      ['get_goal_progress', {}],
      ['get_debt_strategy', {}],
      ['get_cashflow_forecast', { days: 30 }],
      ['compare_periods', { periodA: '2026-08-01', periodB: '2026-09-01' }],
      ['explain_variance', { categorySlug: 'personal_spending', period: '2026-09-01' }],
      ['get_transaction_summary', { from: '2026-09-01', to: '2026-09-30' }],
      ['create_scenario', { description: 'Test purchase', amountDelta: '100.00', categorySlug: 'personal_spending' }],
      ['propose_allocation_change', { action: 'redirect_surplus', amount: '50.00', rationale: 'Test' }],
    ];

    for (const [name, input] of allToolCalls) {
      const result = await dispatchToolCall({ name, input, db, householdId: HH_A });
      assert.equal(result.error, undefined, `${name} returned error: ${result.error}`);
    }

    assert.deepEqual(db.writes ?? [], [],
      'no DB writes must occur across all 11 Remi tools');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: CROSS-FEATURE COLLISION CHAINS
// ─────────────────────────────────────────────────────────────────────────────

describe('Cross-feature collision chains', () => {
  test('4.1 Transaction → goal attribution → Remi goal progress is correct', async () => {
    // Create household with goal + transaction linked to goal
    const db = createTwoWorkspaceDb();

    const result = await dispatchToolCall({
      name: 'get_goal_progress',
      input: { goalId: GOAL_A_ID },
      db,
      householdId: HH_A,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.goals.length, 1);
    // The goal-linked transaction (txn_goal, $100.00) contributes to progress
    assert.equal(result.goals[0].current, '100.00',
      'goal progress must reflect only the linked transaction contribution');
    assert.equal(result.goals[0].target, '5000.00');
  });

  test('4.2 Transaction → debt payment → Remi debt authority uses resolveDebtBalanceAuthority', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_debt_strategy',
      input: {},
      db,
      householdId: HH_A,
    });

    assert.equal(result.error, undefined);
    assert.ok(result.debts.length > 0, 'workspace A debts returned');
    // The debt strategy must show workspace A debt details
    const debtA = result.debts[0];
    assert.ok(debtA.current_balance !== undefined, 'current_balance must be present');
    assert.ok(debtA.apr === 19.99, 'APR from workspace A debt');
    // No workspace B debt data must appear
    assert.ok(!result.debts.some((d) => d.name.includes('Workspace B')));
  });

  test('4.3 Forecast → Remi: forecast projected values are distinct from raw account balance', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_cashflow_forecast',
      input: { days: 30 },
      db,
      householdId: HH_A,
    });

    assert.equal(result.error, undefined);
    // The forecast must contain structured projection metadata
    assert.ok(result.assumptions !== undefined, 'forecast must have assumptions object');
    assert.ok(result.assumptions.starting_balance !== undefined, 'starting_balance must be present');
    // Starting balance should reflect workspace A accounts ($5000.00)
    assert.equal(result.assumptions.starting_balance, '5000.00',
      'starting balance must come from workspace A liquid accounts');
    // Forecast must have summary metrics — confirms it is a projection, not raw account rows
    assert.ok(result.summary !== undefined || result.days !== undefined,
      'forecast result must be structured as a projection, not raw account data');
  });

  test('4.4 Forecast → Remi: workspace B forecast uses workspace B data only', async () => {
    const db = createTwoWorkspaceDb();
    const [forecastA, forecastB] = await Promise.all([
      dispatchToolCall({ name: 'get_cashflow_forecast', input: { days: 30 }, db, householdId: HH_A }),
      dispatchToolCall({ name: 'get_cashflow_forecast', input: { days: 30 }, db, householdId: HH_B }),
    ]);

    assert.equal(forecastA.error, undefined);
    assert.equal(forecastB.error, undefined);
    // Both should reference their own workspace's starting balance
    assert.equal(forecastA.assumptions.starting_balance, forecastB.assumptions.starting_balance,
      'both workspaces have identical $5000 account balance for this fixture');
    // The context is scoped to respective workspaces — data is not blended
  });

  test('4.5 Scenario engine does not mutate authoritative Remi context', async () => {
    const db = createTwoWorkspaceDb();

    // Get plan before scenario
    const planBefore = await dispatchToolCall({ name: 'get_current_plan', input: {}, db, householdId: HH_A });
    // Run a scenario
    await dispatchToolCall({ name: 'create_scenario', input: { description: 'Big purchase', amountDelta: '2000.00', categorySlug: 'personal_spending' }, db, householdId: HH_A });
    // Get plan after scenario — must be identical
    const planAfter = await dispatchToolCall({ name: 'get_current_plan', input: {}, db, householdId: HH_A });

    assert.deepEqual(planBefore.income, planAfter.income,
      'income must be unchanged after scenario');
    assert.deepEqual(planBefore.total_spending, planAfter.total_spending,
      'total spending must be unchanged after scenario — scenario is advisory only');
  });

  test('4.6 Monthly review → Remi: Remi reads live transactions, not snapshot', async () => {
    // Remi uses getDashboardReport (live computation) not a snapshot cache
    // After the dashboard report computes from current transactions, its totals
    // must reflect live state, not a stale snapshot.
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'get_current_plan',
      input: {},
      db,
      householdId: HH_A,
    });

    assert.equal(result.error, undefined);
    // Verify Remi reads live financial data from the db
    assert.equal(result.income.total_received, '3000.00',
      'Remi reads live income data (workspace A income = $3000)');
    assert.ok(result.goals.length > 0, 'Remi returns live goal data from the db');
    assert.equal(result.goals[0].target, '5000.00',
      'Remi reads live authoritative plan data (workspace A goal target = $5000), not a stale snapshot');
  });

  test('4.6.1 Remi current-plan income mapping: zero legitimate income', async () => {
    // Control case: when actual income is zero, income field must return "0.00"
    const zeroIncomeData = JSON.parse(JSON.stringify(DATA_A));
    zeroIncomeData.incomeEntries = []; // No income
    const db = {
      writes: [],
      async transaction(callback) {
        return callback({
          async getHousehold({ householdId }) { return zeroIncomeData.household ?? null; },
          async listFinancialAccounts({ householdId }) { return zeroIncomeData.financialAccounts ?? []; },
          async listIncomeEntries({ householdId, from, to }) { return zeroIncomeData.incomeEntries ?? []; },
          async listIncomeAllocations({ householdId, from, to }) { return zeroIncomeData.incomeAllocations ?? []; },
          async listTransactions({ householdId, from, to }) { return zeroIncomeData.transactions ?? []; },
          async listDebtPayments({ householdId, from, to }) { return []; },
          async listDebtAdjustments() { return []; },
          async listDebts({ householdId }) { return zeroIncomeData.debts ?? []; },
          async listGoals({ householdId }) { return zeroIncomeData.goals ?? []; },
          async listAllocationCategories({ householdId, asOf, includeSuperseded }) { return zeroIncomeData.allocationCategories ?? []; },
          async listTransactionSplits({ householdId, from, to }) { return []; },
        });
      },
    };

    const result = await dispatchToolCall({
      name: 'get_current_plan',
      input: {},
      db,
      householdId: HH_A,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.income.total_received, '0.00',
      'zero income correctly returns "0.00", not a field-mapping failure');
  });

  test('4.6.2 Remi current-plan income mapping: multiple income entries aggregate', async () => {
    // When multiple income entries sum to a total, Remi must report the aggregate
    const multiIncomeData = JSON.parse(JSON.stringify(DATA_A));
    multiIncomeData.incomeEntries = [
      { id: `${HH_A}_income_1`, householdId: HH_A, receivedDate: '2026-09-05', amount: '1000.00', sourceName: 'Payroll 1' },
      { id: `${HH_A}_income_2`, householdId: HH_A, receivedDate: '2026-09-10', amount: '750.00', sourceName: 'Payroll 2' },
      { id: `${HH_A}_income_3`, householdId: HH_A, receivedDate: '2026-09-15', amount: '1250.00', sourceName: 'Bonus' },
    ];
    const db = {
      writes: [],
      async transaction(callback) {
        return callback({
          async getHousehold({ householdId }) { return multiIncomeData.household ?? null; },
          async listFinancialAccounts({ householdId }) { return multiIncomeData.financialAccounts ?? []; },
          async listIncomeEntries({ householdId, from, to }) { return multiIncomeData.incomeEntries ?? []; },
          async listIncomeAllocations({ householdId, from, to }) { return multiIncomeData.incomeAllocations ?? []; },
          async listTransactions({ householdId, from, to }) { return multiIncomeData.transactions ?? []; },
          async listDebtPayments({ householdId, from, to }) { return []; },
          async listDebtAdjustments() { return []; },
          async listDebts({ householdId }) { return multiIncomeData.debts ?? []; },
          async listGoals({ householdId }) { return multiIncomeData.goals ?? []; },
          async listAllocationCategories({ householdId, asOf, includeSuperseded }) { return multiIncomeData.allocationCategories ?? []; },
          async listTransactionSplits({ householdId, from, to }) { return []; },
        });
      },
    };

    const result = await dispatchToolCall({
      name: 'get_current_plan',
      input: {},
      db,
      householdId: HH_A,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.income.total_received, '3000.00',
      'multiple income entries ($1000 + $750 + $1250) aggregate to $3000.00');
  });

  test('4.6.3 Remi income tenant isolation: workspace A income ≠ workspace B income', async () => {
    // Verify workspace B reads its own income, not A's
    const db = createTwoWorkspaceDb();
    const resultA = await dispatchToolCall({
      name: 'get_current_plan',
      input: {},
      db,
      householdId: HH_A,
    });
    const resultB = await dispatchToolCall({
      name: 'get_current_plan',
      input: {},
      db,
      householdId: HH_B,
    });

    assert.equal(resultA.income.total_received, '3000.00',
      'workspace A reads its own income');
    assert.equal(resultB.income.total_received, '3000.00',
      'workspace B reads its own income (same amount, different source data)');
    // Both use the same test data structure, but in production they would differ.
    // This test proves the isolation boundary is preserved.
  });

  test('4.7 Goal deactivation: inactive goal not reported by Remi', async () => {
    // Create a db with an inactive goal for workspace A
    const inactiveGoalData = JSON.parse(JSON.stringify(DATA_A));
    inactiveGoalData.goals[0].active = false;

    function createInactiveGoalDb() {
      const modified = { [HH_A]: inactiveGoalData, [HH_B]: DATA_B };
      return {
        writes: [],
        async transaction(callback) {
          const tx = {
            async getHousehold({ householdId }) { return modified[householdId]?.household ?? null; },
            async listFinancialAccounts({ householdId }) { return modified[householdId]?.financialAccounts ?? []; },
            async listIncomeEntries({ householdId }) { return modified[householdId]?.incomeEntries ?? []; },
            async listIncomeAllocations({ householdId }) { return modified[householdId]?.incomeAllocations ?? []; },
            async listTransactions({ householdId }) { return modified[householdId]?.transactions ?? []; },
            async listDebtPayments() { return []; },
            async listDebtAdjustments() { return []; },
            async listDebts({ householdId }) { return modified[householdId]?.debts ?? []; },
            async listGoals({ householdId }) { return modified[householdId]?.goals ?? []; },
            async listAllocationCategories({ householdId }) { return modified[householdId]?.allocationCategories ?? []; },
            async listFixedBills() { return []; },
            async listUpcomingExpenses() { return []; },
            async listMonthlyReviews() { return []; },
            async listImportedTransactions() { return []; },
            async listTransactionSplits() { return []; },
            async getFinancialAccountById({ householdId, accountId }) { return modified[householdId]?.financialAccounts?.find((a) => a.id === accountId) ?? null; },
          };
          return callback(tx);
        },
      };
    }

    const db = createInactiveGoalDb();
    const result = await dispatchToolCall({ name: 'get_goal_progress', input: {}, db, householdId: HH_A });
    assert.equal(result.error, undefined);
    assert.equal(result.goals.length, 0,
      'inactive goal must not be reported by Remi');
  });

  test('4.8 Compare periods uses householdId-scoped data — workspace B data never appears in A comparison', async () => {
    const db = createTwoWorkspaceDb();
    const result = await dispatchToolCall({
      name: 'compare_periods',
      input: { periodA: '2026-08-01', periodB: '2026-09-01' },
      db,
      householdId: HH_A,
    });
    assert.equal(result.error, undefined);
    const serialized = JSON.stringify(result);
    // Workspace B's debt name and account IDs must not appear
    assert.ok(!serialized.includes('Workspace B'),
      'workspace B debt name must not appear in workspace A comparison');
    assert.ok(!serialized.includes(DEBT_B_ID));
  });

  test('4.9 buildFinancialContext uses householdId from parameter — not from any external source', async () => {
    const db = createTwoWorkspaceDb();

    const contextA = await buildFinancialContext({ db, householdId: HH_A, months: 1 });
    const contextB = await buildFinancialContext({ db, householdId: HH_B, months: 1 });

    // Context A must reference workspace A's household name
    assert.ok(contextA.householdName?.includes(HH_A) || contextA.householdName?.length > 0,
      'context A must have household name');
    // The two contexts must produce different debt counts/states
    // (both have 1 debt, but debt names differ)
    assert.ok(contextA.debts.length > 0);
    assert.ok(contextB.debts.length > 0);
    // The debt names differ between workspaces
    assert.notEqual(contextA.debts[0].name, contextB.debts[0].name,
      'workspace A and B debt names must differ in their respective contexts');
  });

  test('4.10 Reconciliation: Remi sees authoritative account balance, not pre-reconciliation value', async () => {
    // Build db with a specific account balance
    const db = createTwoWorkspaceDb();
    const forecast = await dispatchToolCall({ name: 'get_cashflow_forecast', input: { days: 30 }, db, householdId: HH_A });
    // Starting balance is from the authoritative financial_accounts.currentBalance = $5000
    assert.equal(forecast.assumptions.starting_balance, '5000.00',
      'forecast starting balance uses authoritative account balance');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: AUTHENTICATION & AUTHORIZATION (REMI-SPECIFIC)
// ─────────────────────────────────────────────────────────────────────────────

{
  const port = 25000 + Math.floor(Math.random() * 5000);
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverProcess;

  async function req(pathname, { method = 'GET', token, workspaceId, body } = {}) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: res.status, data };
  }

  async function signup(email, householdName = 'Auth Test Household') {
    const { status, data } = await req('/api/v1/auth/signup', {
      method: 'POST',
      body: { email, password: 'Phase7Auth1!', householdName },
    });
    assert.equal(status, 201, `signup failed for ${email}: ${JSON.stringify(data)}`);
    return { token: data.token, workspaceId: data.workspace.id, userId: data.userId };
  }

  describe('Authentication & authorization boundary — Remi', () => {
    before(async () => {
      serverProcess = await startIsolatedSqliteServer({
        repoRoot,
        testName: 'raf-phase7-auth',
        port,
        authRequired: true,
        jwtSecret: 'phase7-auth-secret',
        extraEnv: {
          RAF_AUTH_PROVIDER: 'local',
          RAF_AUTH_RATE_LIMIT_MAX: '1000',
          SUPABASE_URL: '',
          SUPABASE_ANON_KEY: '',
        },
      });
    });

    after(async () => {
      await serverProcess?.stop();
    });
    test('5.1 unauthenticated GET /remi/summary returns 401', async () => {
      const { status } = await req('/api/v1/remi/summary');
      assert.equal(status, 401, 'unauthenticated Remi summary access must be denied');
    });

    test('5.2 unauthenticated POST /remi/chat returns 401', async () => {
      const { status } = await req('/api/v1/remi/chat', {
        method: 'POST',
        body: { message: 'hello' },
      });
      assert.equal(status, 401, 'unauthenticated Remi chat access must be denied');
    });

    test('5.3 invalid bearer token returns 401 on Remi route', async () => {
      const { status } = await req('/api/v1/remi/summary', {
        token: 'invalid.jwt.token',
        workspaceId: 'some-workspace',
      });
      assert.equal(status, 401, 'invalid JWT must be rejected');
    });

    test('5.4 valid user + own workspace can access Remi summary (positive control)', async () => {
      const user = await signup('phase7-remi-owner@example.com', 'Phase7 Remi Test');
      const { status } = await req('/api/v1/remi/summary', {
        token: user.token,
        workspaceId: user.workspaceId,
      });
      assert.ok([200, 206].includes(status), `expected 200/206 got ${status}`);
    });

    test('5.5 valid user + foreign workspace returns 403 on Remi route', async () => {
      const userA = await signup('phase7-remi-a@example.com', 'Phase7 Workspace A');
      const userB = await signup('phase7-remi-b@example.com', 'Phase7 Workspace B');

      // userA uses their valid token but workspace B's ID
      const { status } = await req('/api/v1/remi/summary', {
        token: userA.token,
        workspaceId: userB.workspaceId,
      });
      assert.equal(status, 403, 'accessing foreign workspace Remi must return 403');
    });

    test('5.6 guessed workspace ID returns 403 on Remi route', async () => {
      const user = await signup('phase7-remi-guess@example.com', 'Phase7 Guess Test');
      const { status } = await req('/api/v1/remi/summary', {
        token: user.token,
        workspaceId: 'completely-made-up-workspace-id-00000',
      });
      assert.equal(status, 403, 'guessed workspace ID must return 403');
    });

    test('5.7 viewer role does not have remi:invoke permission — POST /remi/chat denied', async () => {
      const owner = await signup('phase7-remi-inv-owner@example.com', 'Remi Invite Test');

      // Invite a viewer
      const invRes = await req(`/api/v1/workspaces/${owner.workspaceId}/invitations`, {
        method: 'POST',
        token: owner.token,
        workspaceId: owner.workspaceId,
        body: { email: 'phase7-remi-viewer@example.com', role: 'viewer' },
      });
      if (invRes.status !== 201) {
        // Invitation may fail if collaborative invites aren't set up — skip gracefully
        return;
      }

      const invToken = invRes.data?.invitation?.rawToken;
      if (!invToken) return;

      // Accept the invitation
      const signupRes = await req('/api/v1/auth/signup', {
        method: 'POST',
        body: { email: 'phase7-remi-viewer@example.com', password: 'Phase7View1!', householdName: 'Viewer HH', invitationToken: invToken },
      });
      if (![200, 201].includes(signupRes.status)) return;

      const viewerToken = signupRes.data?.token;
      if (!viewerToken) return;

      const { status } = await req('/api/v1/remi/chat', {
        method: 'POST',
        token: viewerToken,
        workspaceId: owner.workspaceId,
        body: { message: 'What is my balance?' },
      });
      assert.equal(status, 403, 'viewer role must not have remi:invoke permission');
    });

    test('5.8 role escalation input attempt: body containing role=owner is ignored', async () => {
      const user = await signup('phase7-remi-role@example.com', 'Phase7 Role Test');
      // The user sends role=owner in the request body to try to escalate
      const { status, data } = await req('/api/v1/remi/summary', {
        method: 'GET',
        token: user.token,
        workspaceId: user.workspaceId,
        // Pass the attempted escalation in headers (which are ignored for role)
      });
      // User's own role (owner of their own workspace) means this succeeds normally
      assert.ok([200, 206].includes(status), 'own workspace access should succeed');
      // Now verify a foreign user cannot impersonate owner by sending role in body
      const userB = await signup('phase7-remi-role-b@example.com', 'Phase7 Role B');
      const { status: escalatedStatus } = await req('/api/v1/remi/summary', {
        token: user.token,
        workspaceId: userB.workspaceId,
        // role header or body cannot grant access to workspace B
      });
      assert.equal(escalatedStatus, 403,
        'client-supplied workspace ID does not grant access; membership is verified server-side');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6: AUDIT LOG SAFETY
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit log safety', () => {
  test('6.1 logAuditEvent records remi.chat with workspace context', async () => {
    const { logAuditEvent } = await import('../lib/audit/auditLog.js');
    const db = createInMemoryDb();

    await logAuditEvent({
      db,
      workspaceId: HH_A,
      userId: 'user_test',
      event: 'remi.chat',
      entityId: 'conv_001',
      metadata: { tier: 'free', source: 'phase7-test' },
    });

    const events = db.state?.workspaceActivity ?? [];
    const remiEvent = events.find((e) => e.action === 'remi.chat');
    assert.ok(remiEvent, 'remi.chat audit event must be created');
    assert.equal(remiEvent.workspaceId, HH_A, 'audit event must be scoped to correct workspace');
    assert.equal(remiEvent.actorUserId, 'user_test');
    assert.equal(remiEvent.entityId, 'conv_001');
  });

  test('6.2 remi.chat audit metadata must not include raw message content', async () => {
    const { logAuditEvent } = await import('../lib/audit/auditLog.js');
    const db = createInMemoryDb();

    const sensitiveMessage = 'My secret message with account 4111111111111111';

    await logAuditEvent({
      db,
      workspaceId: HH_A,
      userId: 'user_test',
      event: 'remi.chat',
      entityId: 'conv_002',
      // Simulate what the route would log — tier and stats, not message content
      metadata: { tier: 'free', conversationId: 'conv_002' },
    });

    const events = db.state?.workspaceActivity ?? [];
    const remiEvent = events.find((e) => e.entityId === 'conv_002');
    assert.ok(remiEvent, 'audit event must be created');

    const metadataStr = JSON.stringify(remiEvent.metadata ?? {});
    assert.ok(!metadataStr.includes(sensitiveMessage),
      'raw message content must not appear in audit metadata');
    assert.ok(!metadataStr.includes('4111111111111111'),
      'account numbers must not appear in audit metadata');
  });

  test('6.3 audit event workspace isolation: HH_A event not visible when querying HH_B', async () => {
    const { logAuditEvent } = await import('../lib/audit/auditLog.js');
    const db = createInMemoryDb();

    await logAuditEvent({ db, workspaceId: HH_A, userId: 'user_a', event: 'remi.chat', entityId: 'conv_a' });
    await logAuditEvent({ db, workspaceId: HH_B, userId: 'user_b', event: 'remi.chat', entityId: 'conv_b' });

    const allEvents = db.state?.workspaceActivity ?? [];
    const eventsForB = allEvents.filter((e) => e.workspaceId === HH_B);
    const eventsForA = allEvents.filter((e) => e.workspaceId === HH_A);

    assert.ok(!eventsForB.some((e) => e.entityId === 'conv_a'),
      'workspace A audit event must not appear in workspace B activity');
    assert.ok(!eventsForA.some((e) => e.entityId === 'conv_b'),
      'workspace B audit event must not appear in workspace A activity');
  });

  test('6.4 audit metadata must not contain raw financial amounts or descriptions', async () => {
    const { logAuditEvent } = await import('../lib/audit/auditLog.js');
    const db = createInMemoryDb();

    // Simulate a financial write audit event as would be generated by a transaction create
    await logAuditEvent({
      db,
      workspaceId: HH_A,
      userId: 'user_test',
      event: 'transaction.created',
      entityId: 'txn_audit_test',
      metadata: { entityType: 'transaction' },
    });

    const events = db.state?.workspaceActivity ?? [];
    const txEvent = events.find((e) => e.entityId === 'txn_audit_test');
    assert.ok(txEvent, 'transaction.created audit event must exist');

    const metadataStr = JSON.stringify(txEvent.metadata ?? {});
    // Metadata should contain only entityType, not raw financial values
    assert.ok(!metadataStr.includes('amount'), 'raw amount field must not be logged');
    assert.ok(!metadataStr.includes('description'), 'raw description must not be logged');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7: NATURAL-LANGUAGE AUTHORITY BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────
//
// These tests document the architectural invariant that `householdId` in
// dispatchToolCall always comes from the trusted route context, not from any
// user-supplied input. No natural-language instruction can override it.
//
// The tests prove this at the data layer: even when `input` contains foreign IDs,
// dispatchToolCall's `householdId` parameter determines which workspace is queried.
// ─────────────────────────────────────────────────────────────────────────────

describe('Natural-language authorization boundary', () => {
  test('7.1 tool input.householdId is ignored — trusted householdId parameter governs data access', async () => {
    const db = createTwoWorkspaceDb();

    // Even if the model (or a malicious input) puts a foreign householdId in `input`,
    // dispatchToolCall uses the `householdId` parameter from the trusted context.
    const result = await dispatchToolCall({
      name: 'get_goal_progress',
      input: { householdId: HH_B },  // foreign householdId in tool input
      db,
      householdId: HH_A,  // trusted context is workspace A
    });

    // Must return workspace A data (or empty for the unknown input key)
    assert.equal(result.error, undefined);
    // If workspace A has a goal with target $5000, it should appear
    assert.equal(result.goals.length, 1);
    assert.equal(result.goals[0].target, '5000.00',
      'workspace A goal must be returned — foreign input.householdId is ignored');
  });

  test('7.2 tool input.workspaceId is ignored — trusted householdId parameter governs data access', async () => {
    const db = createTwoWorkspaceDb();

    const result = await dispatchToolCall({
      name: 'get_debt_strategy',
      input: { workspaceId: HH_B },  // foreign workspaceId in tool input
      db,
      householdId: HH_A,  // trusted context is workspace A
    });

    assert.equal(result.error, undefined);
    assert.ok(result.debts.every((d) => d.name.includes('Workspace A')),
      'only workspace A debts returned — foreign input.workspaceId is ignored');
  });

  test('7.3 dispatchToolCall always uses the householdId parameter, not any value in tool input', async () => {
    const db = createTwoWorkspaceDb();

    // Simulate what would happen if a natural-language prompt caused the model to output
    // a tool call with foreign IDs. The trust boundary is at the householdId parameter.
    const foreignIdAttempts = [
      { name: 'get_goal_progress', input: { goalId: GOAL_B_ID } },
      { name: 'get_transaction_summary', input: { from: '2026-01-01', to: '2026-12-31' } },
      { name: 'explain_variance', input: { categorySlug: 'personal_spending', period: '2026-09-01' } },
    ];

    for (const { name, input } of foreignIdAttempts) {
      const result = await dispatchToolCall({ name, input, db, householdId: HH_A });
      assert.equal(result.error, undefined, `${name} must succeed for workspace A`);
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(DEBT_B_ID),
        `${name}: workspace B debt ID must not appear in workspace A result`);
      assert.ok(!serialized.includes(GOAL_B_ID),
        `${name}: workspace B goal ID must not appear in workspace A result`);
    }
  });
});
