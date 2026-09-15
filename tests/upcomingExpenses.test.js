/**
 * Upcoming expenses tests.
 *
 * Covers:
 *  1. CRUD — create valid upcoming expense
 *  2. CRUD — list returns only household's expenses
 *  3. CRUD — list filters by status
 *  4. CRUD — list sorted by expectedDate
 *  5. CRUD — get by id
 *  6. CRUD — get by id not found → 404
 *  7. CRUD — update patches fields
 *  8. CRUD — update validates schema (bad amount)
 *  9. CRUD — delete removes record
 * 10. Validation — missing name rejected
 * 11. Validation — missing amount rejected
 * 12. Validation — missing expectedDate rejected
 * 13. Validation — invalid date format rejected
 * 14. Validation — invalid priority rejected
 * 15. Validation — invalid confidence rejected
 * 16. Tenant isolation — workspace A cannot read B
 * 17. Tenant isolation — workspace A cannot update B
 * 18. Tenant isolation — workspace A cannot delete B
 * 19. Financial safety — create does not create a transaction
 * 20. Financial safety — create does not change allocation totals
 * 21. Financial safety — delete does not reverse any financial data
 * 22. Route — GET /upcoming-expenses returns items array
 * 23. Route — POST /upcoming-expenses returns 201
 * 24. Route — GET /upcoming-expenses/:id returns single record
 * 25. Route — PATCH /upcoming-expenses/:id updates and returns record
 * 26. Route — DELETE /upcoming-expenses/:id returns {deleted: true}
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listUpcomingExpenses,
  createUpcomingExpense,
  getUpcomingExpense,
  updateUpcomingExpense,
  deleteUpcomingExpense,
  UpcomingExpenseError,
} from '../lib/upcomingExpenses/upcomingExpenses.js';
import { GET as listRoute, POST as createRoute } from '../app/api/v1/upcoming-expenses/route.js';
import { GET as getRoute, PATCH as updateRoute, DELETE as deleteRoute } from '../app/api/v1/upcoming-expenses/[id]/route.js';

// ─── In-memory DB double ─────────────────────────────────────────────────────

function createDbDouble({ upcomingExpenses = [], transactions = [], incomeAllocations = [] } = {}) {
  const state = {
    upcomingExpenses: upcomingExpenses.map((r) => ({ ...r })),
    transactions: [...transactions],
    incomeAllocations: [...incomeAllocations],
  };

  let idCounter = 1;

  const tx = {
    async listUpcomingExpenses({ householdId, status = null }) {
      return state.upcomingExpenses
        .filter((r) => r.householdId === householdId || r.workspaceId === householdId)
        .filter((r) => (status ? r.status === status : true))
        .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate) || a.id.localeCompare(b.id))
        .map((r) => ({ ...r }));
    },
    async insertUpcomingExpense(payload) {
      const row = { id: `exp_${idCounter++}`, createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z', householdId: payload.householdId, workspaceId: payload.workspaceId ?? payload.householdId, ...payload };
      state.upcomingExpenses.push(row);
      return { ...row };
    },
    async getUpcomingExpenseById({ householdId, expenseId }) {
      return state.upcomingExpenses.find(
        (r) => (r.householdId === householdId || r.workspaceId === householdId) && r.id === expenseId,
      ) ?? null;
    },
    async updateUpcomingExpense({ householdId, expenseId, patch }) {
      const row = state.upcomingExpenses.find(
        (r) => (r.householdId === householdId || r.workspaceId === householdId) && r.id === expenseId,
      );
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: '2026-09-15T01:00:00Z' });
      return { ...row };
    },
    async deleteUpcomingExpense({ householdId, expenseId }) {
      const before = state.upcomingExpenses.length;
      state.upcomingExpenses = state.upcomingExpenses.filter(
        (r) => !((r.householdId === householdId || r.workspaceId === householdId) && r.id === expenseId),
      );
      return state.upcomingExpenses.length < before;
    },
  };

  return { state, transaction: (fn) => fn(tx) };
}

function makeRequest(url = 'http://localhost/api/v1/upcoming-expenses', body = null, method = 'GET') {
  return {
    url,
    method,
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  };
}

function makeContext(householdId = 'hh_1', params = {}) {
  return {
    db: null,
    householdId,
    params,
    trustedContext: { householdId },
  };
}

// ─── 1. Create valid upcoming expense ────────────────────────────────────────

test('1 — createUpcomingExpense inserts a valid expense', async () => {
  const db = createDbDouble();
  const result = await createUpcomingExpense({
    db,
    householdId: 'hh_1',
    input: { name: 'Car repair', amount: '850.00', expectedDate: '2026-10-15' },
  });
  assert.equal(result.name, 'Car repair');
  assert.equal(result.amount, '850.00');
  assert.equal(result.expectedDate, '2026-10-15');
  assert.equal(result.priority, 'planned');
  assert.equal(result.confidence, 'confirmed');
  assert.equal(result.status, 'active');
});

// ─── 2. List returns only household's expenses ────────────────────────────────

test('2 — listUpcomingExpenses scopes to householdId', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Car repair', amount: '850.00', expectedDate: '2026-10-15', status: 'active' },
      { id: 'exp_2', householdId: 'hh_2', workspaceId: 'hh_2', name: 'Other', amount: '100.00', expectedDate: '2026-10-16', status: 'active' },
    ],
  });
  const result = await listUpcomingExpenses({ db, householdId: 'hh_1' });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'exp_1');
});

// ─── 3. List filters by status ────────────────────────────────────────────────

test('3 — listUpcomingExpenses filters by status=archived', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_a', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Active', amount: '50.00', expectedDate: '2026-10-01', status: 'active' },
      { id: 'exp_b', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Archived', amount: '75.00', expectedDate: '2026-10-02', status: 'archived' },
    ],
  });
  const result = await listUpcomingExpenses({ db, householdId: 'hh_1', status: 'archived' });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'exp_b');
});

// ─── 4. List sorted by expectedDate ──────────────────────────────────────────

test('4 — listUpcomingExpenses returns expenses sorted by expectedDate asc', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_z', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Later', amount: '100.00', expectedDate: '2026-12-01', status: 'active' },
      { id: 'exp_a', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Earlier', amount: '50.00', expectedDate: '2026-10-01', status: 'active' },
    ],
  });
  const result = await listUpcomingExpenses({ db, householdId: 'hh_1' });
  assert.equal(result[0].expectedDate, '2026-10-01');
  assert.equal(result[1].expectedDate, '2026-12-01');
});

// ─── 5. Get by id ─────────────────────────────────────────────────────────────

test('5 — getUpcomingExpense returns the expense', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Car repair', amount: '850.00', expectedDate: '2026-10-15', status: 'active' },
    ],
  });
  const result = await getUpcomingExpense({ db, householdId: 'hh_1', expenseId: 'exp_1' });
  assert.equal(result.id, 'exp_1');
  assert.equal(result.name, 'Car repair');
});

// ─── 6. Get by id not found → 404 ────────────────────────────────────────────

test('6 — getUpcomingExpense throws 404 for unknown id', async () => {
  const db = createDbDouble();
  await assert.rejects(
    () => getUpcomingExpense({ db, householdId: 'hh_1', expenseId: 'exp_nonexistent' }),
    (err) => err instanceof UpcomingExpenseError && err.status === 404,
  );
});

// ─── 7. Update patches fields ─────────────────────────────────────────────────

test('7 — updateUpcomingExpense patches the specified fields', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Car repair', amount: '850.00', expectedDate: '2026-10-15', priority: 'planned', confidence: 'confirmed', status: 'active' },
    ],
  });
  const result = await updateUpcomingExpense({
    db, householdId: 'hh_1', expenseId: 'exp_1',
    input: { amount: '950.00', priority: 'essential' },
  });
  assert.equal(result.amount, '950.00');
  assert.equal(result.priority, 'essential');
  assert.equal(result.name, 'Car repair');
});

// ─── 8. Update validates schema ───────────────────────────────────────────────

test('8 — updateUpcomingExpense rejects invalid amount', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Car repair', amount: '850.00', expectedDate: '2026-10-15', status: 'active' },
    ],
  });
  await assert.rejects(
    () => updateUpcomingExpense({ db, householdId: 'hh_1', expenseId: 'exp_1', input: { amount: 'not-a-number' } }),
    (err) => err instanceof UpcomingExpenseError && err.status === 400,
  );
});

// ─── 9. Delete removes record ─────────────────────────────────────────────────

test('9 — deleteUpcomingExpense removes the expense', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Car repair', amount: '850.00', expectedDate: '2026-10-15', status: 'active' },
    ],
  });
  await deleteUpcomingExpense({ db, householdId: 'hh_1', expenseId: 'exp_1' });
  assert.equal(db.state.upcomingExpenses.length, 0);
});

// ─── 10–13. Validation ────────────────────────────────────────────────────────

test('10 — createUpcomingExpense rejects missing name', async () => {
  const db = createDbDouble();
  await assert.rejects(
    () => createUpcomingExpense({ db, householdId: 'hh_1', input: { amount: '100.00', expectedDate: '2026-10-01' } }),
    (err) => err instanceof UpcomingExpenseError && err.status === 400,
  );
});

test('11 — createUpcomingExpense rejects missing amount', async () => {
  const db = createDbDouble();
  await assert.rejects(
    () => createUpcomingExpense({ db, householdId: 'hh_1', input: { name: 'Test', expectedDate: '2026-10-01' } }),
    (err) => err instanceof UpcomingExpenseError && err.status === 400,
  );
});

test('12 — createUpcomingExpense rejects missing expectedDate', async () => {
  const db = createDbDouble();
  await assert.rejects(
    () => createUpcomingExpense({ db, householdId: 'hh_1', input: { name: 'Test', amount: '50.00' } }),
    (err) => err instanceof UpcomingExpenseError && err.status === 400,
  );
});

test('13 — createUpcomingExpense rejects invalid date format', async () => {
  const db = createDbDouble();
  await assert.rejects(
    () => createUpcomingExpense({ db, householdId: 'hh_1', input: { name: 'Test', amount: '50.00', expectedDate: '15/10/2026' } }),
    (err) => err instanceof UpcomingExpenseError && err.status === 400,
  );
});

test('14 — createUpcomingExpense rejects invalid priority', async () => {
  const db = createDbDouble();
  await assert.rejects(
    () => createUpcomingExpense({ db, householdId: 'hh_1', input: { name: 'Test', amount: '50.00', expectedDate: '2026-10-01', priority: 'critical' } }),
    (err) => err instanceof UpcomingExpenseError && err.status === 400,
  );
});

test('15 — createUpcomingExpense rejects invalid confidence', async () => {
  const db = createDbDouble();
  await assert.rejects(
    () => createUpcomingExpense({ db, householdId: 'hh_1', input: { name: 'Test', amount: '50.00', expectedDate: '2026-10-01', confidence: 'maybe' } }),
    (err) => err instanceof UpcomingExpenseError && err.status === 400,
  );
});

// ─── 16–18. Tenant isolation ─────────────────────────────────────────────────

test('16 — workspace A cannot read workspace B expenses', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_b', householdId: 'hh_B', workspaceId: 'hh_B', name: 'B expense', amount: '100.00', expectedDate: '2026-10-01', status: 'active' },
    ],
  });
  const result = await listUpcomingExpenses({ db, householdId: 'hh_A' });
  assert.equal(result.length, 0);
});

test('17 — workspace A cannot update workspace B expense', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_b', householdId: 'hh_B', workspaceId: 'hh_B', name: 'B expense', amount: '100.00', expectedDate: '2026-10-01', status: 'active' },
    ],
  });
  await assert.rejects(
    () => updateUpcomingExpense({ db, householdId: 'hh_A', expenseId: 'exp_b', input: { name: 'Hijacked' } }),
    (err) => err instanceof UpcomingExpenseError && err.status === 404,
  );
});

test('18 — workspace A cannot delete workspace B expense', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_b', householdId: 'hh_B', workspaceId: 'hh_B', name: 'B expense', amount: '100.00', expectedDate: '2026-10-01', status: 'active' },
    ],
  });
  await assert.rejects(
    () => deleteUpcomingExpense({ db, householdId: 'hh_A', expenseId: 'exp_b' }),
    (err) => err instanceof UpcomingExpenseError && err.status === 404,
  );
});

// ─── 19–21. Financial safety ─────────────────────────────────────────────────

test('19 — createUpcomingExpense does not create a transaction', async () => {
  const db = createDbDouble();
  await createUpcomingExpense({ db, householdId: 'hh_1', input: { name: 'Car repair', amount: '850.00', expectedDate: '2026-10-15' } });
  assert.equal(db.state.transactions.length, 0);
});

test('20 — createUpcomingExpense does not create income allocations', async () => {
  const db = createDbDouble();
  await createUpcomingExpense({ db, householdId: 'hh_1', input: { name: 'Car repair', amount: '850.00', expectedDate: '2026-10-15' } });
  assert.equal(db.state.incomeAllocations.length, 0);
});

test('21 — deleteUpcomingExpense does not touch transactions', async () => {
  const db = createDbDouble({
    upcomingExpenses: [
      { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Car repair', amount: '850.00', expectedDate: '2026-10-15', status: 'active' },
    ],
    transactions: [{ id: 'txn_1', householdId: 'hh_1' }],
  });
  await deleteUpcomingExpense({ db, householdId: 'hh_1', expenseId: 'exp_1' });
  assert.equal(db.state.transactions.length, 1, 'transaction must remain untouched');
});

// ─── 22–26. Route handlers ────────────────────────────────────────────────────

function createRouteDb(upcomingExpenses = []) {
  const db = createDbDouble({ upcomingExpenses });
  return db;
}

function routeContext(householdId, db, params = {}) {
  return { householdId, trustedContext: { householdId }, db, params };
}

test('22 — GET /upcoming-expenses returns {items: [...]}', async () => {
  const db = createRouteDb([
    { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Roof repair', amount: '2000.00', expectedDate: '2026-11-01', status: 'active' },
  ]);
  const req = makeRequest('http://localhost/api/v1/upcoming-expenses');
  const res = await listRoute(req, routeContext('hh_1', db));
  const body = await res.json();
  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].name, 'Roof repair');
});

test('23 — POST /upcoming-expenses returns 201 with new expense', async () => {
  const db = createRouteDb();
  const req = makeRequest('http://localhost/api/v1/upcoming-expenses', { name: 'New tires', amount: '600.00', expectedDate: '2026-10-20' }, 'POST');
  const res = await createRoute(req, routeContext('hh_1', db));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.name, 'New tires');
});

test('24 — GET /upcoming-expenses/:id returns single record', async () => {
  const db = createRouteDb([
    { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Dentist', amount: '350.00', expectedDate: '2026-10-05', status: 'active' },
  ]);
  const req = makeRequest('http://localhost/api/v1/upcoming-expenses/exp_1');
  const res = await getRoute(req, routeContext('hh_1', db, { id: 'exp_1' }));
  const body = await res.json();
  assert.equal(body.id, 'exp_1');
  assert.equal(body.name, 'Dentist');
});

test('25 — PATCH /upcoming-expenses/:id updates and returns record', async () => {
  const db = createRouteDb([
    { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Dentist', amount: '350.00', expectedDate: '2026-10-05', priority: 'planned', confidence: 'confirmed', status: 'active' },
  ]);
  const req = makeRequest('http://localhost/api/v1/upcoming-expenses/exp_1', { priority: 'essential' }, 'PATCH');
  const res = await updateRoute(req, routeContext('hh_1', db, { id: 'exp_1' }));
  const body = await res.json();
  assert.equal(body.priority, 'essential');
});

test('26 — DELETE /upcoming-expenses/:id returns {deleted: true}', async () => {
  const db = createRouteDb([
    { id: 'exp_1', householdId: 'hh_1', workspaceId: 'hh_1', name: 'Dentist', amount: '350.00', expectedDate: '2026-10-05', status: 'active' },
  ]);
  const req = makeRequest('http://localhost/api/v1/upcoming-expenses/exp_1', null, 'DELETE');
  const res = await deleteRoute(req, routeContext('hh_1', db, { id: 'exp_1' }));
  const body = await res.json();
  assert.equal(body.deleted, true);
  assert.equal(db.state.upcomingExpenses.length, 0);
});
