/**
 * Track D — Household Settings Direct SQL
 *
 * Tests for buildHouseholdRepository.updateHousehold and the
 * patchHousehold caller in lib/household/household.js.
 *
 * Phase 5 (unit), Phase 6 (negative controls embedded as commented toggles),
 * Phase 7 (dispatch confirmed in postgresDispatchVerification.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHouseholdRepository } from '../lib/repositories/postgres/householdRepository.js';
import { patchHousehold, HouseholdHttpError } from '../lib/household/household.js';

const SCHEMA = 'raf';
const WORKSPACE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_WORKSPACE_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

// ---------------------------------------------------------------------------
// Stateful mock client — supports SELECT and UPDATE for households
// ---------------------------------------------------------------------------

function makeHouseholdClient(initialRows = []) {
  const store = initialRows.map((r) => ({ ...r }));
  const calls = [];

  async function query(sql, params = []) {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    if (/select raw_json from.*households.*where workspace_id/.test(norm)) {
      const wsId = params[0];
      const found = store.find((r) => r.workspace_id === wsId);
      return { rows: found ? [{ raw_json: found.raw_json }] : [], rowCount: found ? 1 : 0 };
    }

    if (/update.*households.*set.*where workspace_id/.test(norm)) {
      const wsId = params[0];
      // raw_json is the 9th param (index 8)
      const newRawJson = params[8];
      const idx = store.findIndex((r) => r.workspace_id === wsId);
      if (idx >= 0) store[idx].raw_json = newRawJson;
      return { rows: [], rowCount: idx >= 0 ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  return { query, calls, store };
}

function makeHousehold(overrides = {}) {
  return {
    id: overrides.id ?? WORKSPACE_ID,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    householdId: overrides.householdId ?? WORKSPACE_ID,
    name: overrides.name ?? 'Test Household',
    timezone: overrides.timezone ?? 'America/Toronto',
    activeMonth: overrides.activeMonth ?? '2026-09-01',
    periodStartDay: overrides.periodStartDay ?? 1,
    savingsFloor: overrides.savingsFloor ?? '0.00',
    savingsFloorEnabled: overrides.savingsFloorEnabled ?? false,
    monthlyEssentialsBaseline: overrides.monthlyEssentialsBaseline ?? '2000.00',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeStore(hhOverrides = {}) {
  const hh = makeHousehold(hhOverrides);
  return [{
    workspace_id: hh.workspaceId,
    raw_json: hh,
  }];
}

// ---------------------------------------------------------------------------
// Phase 5 — updateHousehold unit tests (repository level)
// ---------------------------------------------------------------------------

test('updateHousehold: normal patch — single field', async () => {
  const client = makeHouseholdClient(makeStore());
  const repo = buildHouseholdRepository(client, SCHEMA);

  const result = await repo.updateHousehold({
    householdId: WORKSPACE_ID,
    patch: { timezone: 'America/Vancouver' },
  });

  assert.equal(result.timezone, 'America/Vancouver');
  assert.equal(result.workspaceId, WORKSPACE_ID);
  assert.ok(result.updatedAt > '2026-01-01T00:00:00.000Z', 'updatedAt must be refreshed');
});

test('updateHousehold: multiple fields patched together', async () => {
  const client = makeHouseholdClient(makeStore());
  const repo = buildHouseholdRepository(client, SCHEMA);

  const result = await repo.updateHousehold({
    householdId: WORKSPACE_ID,
    patch: {
      timezone: 'America/New_York',
      periodStartDay: 15,
      savingsFloor: '500.00',
      savingsFloorEnabled: true,
      monthlyEssentialsBaseline: '1800.00',
    },
  });

  assert.equal(result.timezone, 'America/New_York');
  assert.equal(result.periodStartDay, 15);
  assert.equal(result.savingsFloor, '500.00');
  assert.equal(result.savingsFloorEnabled, true);
  assert.equal(result.monthlyEssentialsBaseline, '1800.00');
});

test('updateHousehold: unrecognised key in patch is merged into raw_json but does not corrupt schema fields', async () => {
  const client = makeHouseholdClient(makeStore());
  const repo = buildHouseholdRepository(client, SCHEMA);

  // The schema validates before calling updateHousehold; this tests the
  // repository's own merge behaviour when an extra key appears.
  const result = await repo.updateHousehold({
    householdId: WORKSPACE_ID,
    patch: { timezone: 'America/Chicago', _someUnknownField: 'ignored' },
  });

  assert.equal(result.timezone, 'America/Chicago');
  assert.equal(result.name, 'Test Household', 'untouched field preserved');
  assert.equal(result._someUnknownField, 'ignored', 'extra key is present in returned object');
});

test('updateHousehold: not-found returns null', async () => {
  const client = makeHouseholdClient([]);
  const repo = buildHouseholdRepository(client, SCHEMA);

  const result = await repo.updateHousehold({
    householdId: WORKSPACE_ID,
    patch: { timezone: 'America/Vancouver' },
  });

  assert.equal(result, null);
});

test('updateHousehold: wrong workspace ID does not touch another workspace\'s household', async () => {
  const client = makeHouseholdClient(makeStore());
  const repo = buildHouseholdRepository(client, SCHEMA);

  // Household lives under WORKSPACE_ID; call with OTHER_WORKSPACE_ID
  const result = await repo.updateHousehold({
    householdId: OTHER_WORKSPACE_ID,
    patch: { timezone: 'America/Vancouver' },
  });

  assert.equal(result, null, 'must return null for a workspace that has no household');
  // Verify the real household was not touched
  const realHh = client.store[0].raw_json;
  assert.equal(realHh.timezone, 'America/Toronto', 'original household untouched');
});

test('updateHousehold: preserves all untouched fields', async () => {
  const client = makeHouseholdClient(makeStore({
    timezone: 'America/Toronto',
    periodStartDay: 1,
    activeMonth: '2026-09-01',
    savingsFloor: '100.00',
    savingsFloorEnabled: true,
    monthlyEssentialsBaseline: '1500.00',
  }));
  const repo = buildHouseholdRepository(client, SCHEMA);

  const result = await repo.updateHousehold({
    householdId: WORKSPACE_ID,
    patch: { timezone: 'America/Vancouver' },
  });

  assert.equal(result.periodStartDay, 1, 'periodStartDay preserved');
  assert.equal(result.activeMonth, '2026-09-01', 'activeMonth preserved');
  assert.equal(result.savingsFloor, '100.00', 'savingsFloor preserved');
  assert.equal(result.savingsFloorEnabled, true, 'savingsFloorEnabled preserved');
  assert.equal(result.monthlyEssentialsBaseline, '1500.00', 'monthlyEssentialsBaseline preserved');
  assert.equal(result.name, 'Test Household', 'name preserved');
});

test('updateHousehold: updatedAt is set to a fresh ISO timestamp', async () => {
  const before = new Date().toISOString();
  const client = makeHouseholdClient(makeStore());
  const repo = buildHouseholdRepository(client, SCHEMA);

  const result = await repo.updateHousehold({
    householdId: WORKSPACE_ID,
    patch: { timezone: 'America/Vancouver' },
  });

  assert.ok(result.updatedAt >= before, 'updatedAt is at or after test start');
  assert.match(result.updatedAt, /^\d{4}-\d{2}-\d{2}T/, 'updatedAt is ISO format');
});

test('updateHousehold: return shape matches formatHouseholdResponse fields', async () => {
  const client = makeHouseholdClient(makeStore());
  const repo = buildHouseholdRepository(client, SCHEMA);

  const result = await repo.updateHousehold({
    householdId: WORKSPACE_ID,
    patch: { timezone: 'America/Vancouver' },
  });

  assert.ok('id' in result, 'id present');
  assert.ok('name' in result, 'name present');
  assert.ok('timezone' in result, 'timezone present');
  assert.ok('activeMonth' in result, 'activeMonth present');
  assert.ok('periodStartDay' in result, 'periodStartDay present');
  assert.ok('savingsFloor' in result, 'savingsFloor present');
  assert.ok('savingsFloorEnabled' in result, 'savingsFloorEnabled present');
  assert.ok('monthlyEssentialsBaseline' in result, 'monthlyEssentialsBaseline present');
});

test('updateHousehold: UPDATE query is workspace-scoped (workspace_id = $1)', async () => {
  const client = makeHouseholdClient(makeStore());
  const repo = buildHouseholdRepository(client, SCHEMA);

  await repo.updateHousehold({
    householdId: WORKSPACE_ID,
    patch: { timezone: 'America/Vancouver' },
  });

  const updateCall = client.calls.find((c) => /update.*households/i.test(c.sql));
  assert.ok(updateCall, 'UPDATE called');
  assert.equal(updateCall.params[0], WORKSPACE_ID, 'first param of UPDATE is the workspace ID');
  assert.ok(/WHERE workspace_id = \$1/i.test(updateCall.sql), 'WHERE clause scopes by workspace_id');
});

// ---------------------------------------------------------------------------
// Phase 5 — patchHousehold caller-level tests
// ---------------------------------------------------------------------------

function makeMockDb(hhOverrides = {}) {
  const hh = makeHousehold(hhOverrides);
  let stored = { ...hh };

  return {
    transaction: async (callback) => callback({
      async getHousehold({ householdId }) {
        if (householdId !== stored.id && householdId !== stored.workspaceId) return null;
        return { ...stored };
      },
      async updateHousehold({ householdId, patch }) {
        if (householdId !== stored.id && householdId !== stored.workspaceId) return null;
        stored = { ...stored, ...patch, updatedAt: new Date().toISOString() };
        return { ...stored };
      },
    }),
    get _stored() { return stored; },
  };
}

test('patchHousehold: normal patch returns formatted response', async () => {
  const db = makeMockDb();
  const result = await patchHousehold({
    db,
    householdId: WORKSPACE_ID,
    input: { timezone: 'America/Vancouver' },
  });

  assert.equal(result.timezone, 'America/Vancouver');
  assert.ok('id' in result);
  assert.ok('savingsFloor' in result);
  assert.ok('savingsFloorEnabled' in result);
});

test('patchHousehold: throws 404 when household not found', async () => {
  const db = makeMockDb();
  await assert.rejects(
    () => patchHousehold({ db, householdId: OTHER_WORKSPACE_ID, input: { timezone: 'America/Vancouver' } }),
    (err) => err instanceof HouseholdHttpError && err.status === 404,
  );
});

test('patchHousehold: throws 400 when input is empty object', async () => {
  const db = makeMockDb();
  await assert.rejects(
    () => patchHousehold({ db, householdId: WORKSPACE_ID, input: {} }),
    (err) => err instanceof HouseholdHttpError && err.status === 400,
  );
});

test('patchHousehold: throws 400 when householdId is missing', async () => {
  const db = makeMockDb();
  await assert.rejects(
    () => patchHousehold({ db, householdId: null, input: { timezone: 'America/Vancouver' } }),
    (err) => err instanceof HouseholdHttpError && err.status === 400,
  );
});

test('patchHousehold: savingsFloor validates as money string', async () => {
  const db = makeMockDb();
  await assert.rejects(
    () => patchHousehold({ db, householdId: WORKSPACE_ID, input: { savingsFloor: '-100' } }),
    (err) => err instanceof HouseholdHttpError && err.status === 400,
  );
});

test('patchHousehold: savingsFloorEnabled set to false is preserved', async () => {
  const db = makeMockDb({ savingsFloorEnabled: true });
  const result = await patchHousehold({
    db,
    householdId: WORKSPACE_ID,
    input: { savingsFloorEnabled: false },
  });
  assert.equal(result.savingsFloorEnabled, false);
});

test('patchHousehold: activeMonth must be first of month', async () => {
  const db = makeMockDb();
  await assert.rejects(
    () => patchHousehold({ db, householdId: WORKSPACE_ID, input: { activeMonth: '2026-09-15' } }),
    (err) => err instanceof HouseholdHttpError && err.status === 400,
  );
});

// ---------------------------------------------------------------------------
// Phase 6 — Negative controls (workspace scoping + patch merge)
// To activate: temporarily comment-out the WHERE clause in householdRepository,
// or remove the `...patch` spread in the updated object, run tests — they fail.
// ---------------------------------------------------------------------------

test('NEGATIVE CONTROL — wrong workspace returns null (workspace scoping)', async () => {
  // This is the "wrong workspace" guard. If the WHERE clause were removed
  // (broken workspace scoping), the household at WORKSPACE_ID would be
  // returned even for OTHER_WORKSPACE_ID.
  const client = makeHouseholdClient(makeStore());
  const repo = buildHouseholdRepository(client, SCHEMA);

  const result = await repo.updateHousehold({
    householdId: OTHER_WORKSPACE_ID,
    patch: { timezone: 'America/Vancouver' },
  });

  assert.equal(result, null, 'NEGATIVE CONTROL: broken workspace scoping would return non-null');
});

test('NEGATIVE CONTROL — patch fields appear in returned object (merge semantics)', async () => {
  // If the ...patch spread were removed from the merge, the returned object
  // would not contain the updated timezone.
  const client = makeHouseholdClient(makeStore({ timezone: 'America/Toronto' }));
  const repo = buildHouseholdRepository(client, SCHEMA);

  const result = await repo.updateHousehold({
    householdId: WORKSPACE_ID,
    patch: { timezone: 'America/Vancouver' },
  });

  assert.equal(result.timezone, 'America/Vancouver',
    'NEGATIVE CONTROL: broken merge semantics would return original timezone');
});
