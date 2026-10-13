/**
 * Remi usage budget against real PostgreSQL: atomic reservation under concurrency, the
 * reconciliation floor, UTC-day separation, and workspace RLS.
 *
 * Gate: runs only when BOTH are set:
 *   RAF_RUN_POSTGRES_BUDGET_TESTS=true
 *   RAF_TEST_POSTGRES_URL=postgresql://<owner>@127.0.0.1:<port>/<disposable_db>   (localhost only)
 * The owner URL creates a non-superuser login role (raf_budget_test_app) so RLS really applies;
 * superusers bypass RLS. Never point this at a production or Neon database.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

import { createPostgresDb } from '../lib/server/postgresDb.js';

const ownerUrl = process.env.RAF_TEST_POSTGRES_URL ?? '';
const APP_ROLE = 'raf_budget_test_app';
const APP_PASSWORD = 'raf_budget_test_app';

function isLocalUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

const enabled = process.env.RAF_RUN_POSTGRES_BUDGET_TESTS === 'true' && ownerUrl !== '' && isLocalUrl(ownerUrl);
const maybeTest = enabled ? test : test.skip;

let owner;
let app;
const ids = {};

function appUrl() {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

before(async () => {
  if (!enabled) return;
  owner = new pg.Pool({ connectionString: ownerUrl, max: 4 });
  await owner.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} login password '${APP_PASSWORD}';
      end if;
    end
    $$;
  `);
  await owner.query(`grant usage on schema raf to ${APP_ROLE}`);
  await owner.query(`grant select, insert, update, delete on all tables in schema raf to ${APP_ROLE}`);
  await owner.query(`grant execute on all functions in schema raf to ${APP_ROLE}`);

  const user = async (label) => (await owner.query(
    'insert into raf.app_users (email) values ($1) returning id',
    [`budget-${label}-${crypto.randomUUID()}@example.test`],
  )).rows[0].id;
  ids.ownerA = await user('owner-a');
  ids.memberB = await user('member-b');

  const workspace = async (name, ownerId) => (await owner.query(
    'insert into raf.workspaces (name, owner_user_id) values ($1, $2) returning id',
    [name, ownerId],
  )).rows[0].id;
  ids.workspaceA = await workspace('Budget A', ids.ownerA);
  ids.workspaceB = await workspace('Budget B', ids.memberB);

  // ownerA belongs to A only; memberB belongs to B only.
  await owner.query(
    `insert into raf.workspace_members (workspace_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
    [ids.workspaceA, ids.ownerA],
  );
  await owner.query(
    `insert into raf.workspace_members (workspace_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
    [ids.workspaceB, ids.memberB],
  );

  app = createPostgresDb({ connectionString: appUrl(), ssl: false });
});

after(async () => {
  if (app) await app.close();
  if (owner) await owner.end();
});

// A fresh UTC day per test so counters never interfere across tests.
let dayOffset = 0;
function freshDay() {
  dayOffset += 1;
  return new Date(Date.UTC(2030, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);
}

function reserve(workspaceId, usageDay, { calls = 1, tokens, callLimit, tokenLimit, userId = ids.ownerA, ctxWorkspace = workspaceId }) {
  return app.transaction(
    (tx) => tx.reserveRemiBudget({
      householdId: workspaceId,
      usageDay,
      reserveCalls: calls,
      reserveTokens: tokens,
      callLimit,
      tokenLimit,
    }),
    { userId, workspaceId: ctxWorkspace },
  );
}

async function readRow(workspaceId, usageDay) {
  const { rows } = await owner.query(
    'select calls_used, tokens_used from raf.remi_usage_budgets where workspace_id = $1 and usage_day = $2::date',
    [workspaceId, usageDay],
  );
  return rows[0] ?? null;
}

// Reads as the app role, with RLS applied, in the given user and workspace context.
async function visibleBudgetRows({ userId, workspaceId, usageDay }) {
  const client = new pg.Client({ connectionString: appUrl() });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('raf.user_id', $1, true)", [userId]);
    await client.query("select set_config('raf.workspace_id', $1, true)", [workspaceId]);
    const { rows } = await client.query(
      'select workspace_id from raf.remi_usage_budgets where usage_day = $1::date',
      [usageDay],
    );
    await client.query('commit');
    return rows;
  } finally {
    await client.end();
  }
}

maybeTest('concurrency: 25 parallel call reservations against a call budget of 5 allow exactly 5', async () => {
  const day = freshDay();
  const results = await Promise.all(
    Array.from({ length: 25 }, () => reserve(ids.workspaceA, day, { tokens: 10, callLimit: 5, tokenLimit: 1e9 })),
  );
  assert.equal(results.filter((r) => r.allowed).length, 5);
  assert.equal(results.filter((r) => !r.allowed).length, 20);
  const row = await readRow(ids.workspaceA, day);
  assert.equal(row.calls_used, 5, 'denied reservations wrote nothing');
  assert.equal(row.tokens_used, 50);
});

maybeTest('concurrency: 30 parallel token reservations of 100 against a token budget of 1000 allow exactly 10', async () => {
  const day = freshDay();
  const results = await Promise.all(
    Array.from({ length: 30 }, () => reserve(ids.workspaceA, day, { tokens: 100, callLimit: 1000, tokenLimit: 1000 })),
  );
  assert.equal(results.filter((r) => r.allowed).length, 10);
  const row = await readRow(ids.workspaceA, day);
  assert.equal(row.tokens_used, 1000, 'never above the token limit');
  assert.equal(row.calls_used, 10);
});

maybeTest('a single reservation larger than the whole budget is denied and writes no row', async () => {
  const day = freshDay();
  const result = await reserve(ids.workspaceA, day, { tokens: 5000, callLimit: 10, tokenLimit: 1000 });
  assert.equal(result.allowed, false);
  assert.equal(await readRow(ids.workspaceA, day), null);
});

maybeTest('settle reconciles reserved tokens down to actual usage and never below zero', async () => {
  const day = freshDay();
  const reservation = await reserve(ids.workspaceA, day, { tokens: 100, callLimit: 10, tokenLimit: 1000 });
  assert.equal(reservation.allowed, true);
  await app.transaction((tx) => tx.settleRemiBudget({ householdId: ids.workspaceA, usageDay: day, deltaTokens: -60 }), { userId: ids.ownerA, workspaceId: ids.workspaceA });
  assert.equal((await readRow(ids.workspaceA, day)).tokens_used, 40);
  await app.transaction((tx) => tx.settleRemiBudget({ householdId: ids.workspaceA, usageDay: day, deltaTokens: -999 }), { userId: ids.ownerA, workspaceId: ids.workspaceA });
  assert.equal((await readRow(ids.workspaceA, day)).tokens_used, 0, 'clamped at zero');
});

maybeTest('each UTC day has its own budget', async () => {
  const day1 = freshDay();
  const day2 = freshDay();
  assert.equal((await reserve(ids.workspaceA, day1, { tokens: 10, callLimit: 1, tokenLimit: 1000 })).allowed, true);
  assert.equal((await reserve(ids.workspaceA, day1, { tokens: 10, callLimit: 1, tokenLimit: 1000 })).allowed, false);
  assert.equal((await reserve(ids.workspaceA, day2, { tokens: 10, callLimit: 1, tokenLimit: 1000 })).allowed, true);
});

maybeTest('RLS: a member of workspace B cannot reserve against workspace A (rejected, no row written)', async () => {
  const day = freshDay();
  await assert.rejects(
    reserve(ids.workspaceA, day, { tokens: 10, callLimit: 5, tokenLimit: 1000, userId: ids.memberB, ctxWorkspace: ids.workspaceB }),
  );
  assert.equal(await readRow(ids.workspaceA, day), null);
});

maybeTest('RLS: budget rows are visible to workspace members only', async () => {
  const day = freshDay();
  assert.equal((await reserve(ids.workspaceA, day, { tokens: 10, callLimit: 5, tokenLimit: 1000 })).allowed, true);
  const asOwnerA = await visibleBudgetRows({ userId: ids.ownerA, workspaceId: ids.workspaceA, usageDay: day });
  assert.equal(asOwnerA.length, 1, 'member of A sees A budget row');
  const asMemberB = await visibleBudgetRows({ userId: ids.memberB, workspaceId: ids.workspaceB, usageDay: day });
  assert.equal(asMemberB.length, 0, 'member of B sees nothing from A');
  const crossContext = await visibleBudgetRows({ userId: ids.ownerA, workspaceId: ids.workspaceB, usageDay: day });
  assert.equal(crossContext.length, 0, 'A member in a B session sees nothing from A');
});
