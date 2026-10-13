/**
 * Remi daily message cap against real PostgreSQL.
 *
 * Regression: the Postgres adapter had no countRemiUserMessagesSince, so checkRemiDailyCap
 * logged a warning and allowed every request. The cap was silently disabled in production.
 *
 * Gate: runs only when BOTH are set:
 *   RAF_CONFIRM_NON_PRODUCTION_DB=true
 *   POSTGRES_CONNECTION_STRING=postgresql://<owner>@127.0.0.1:<port>/<disposable_db_name_containing_test>
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

import { createPostgresDb } from '../lib/server/postgresDb.js';
import { checkRemiDailyCap } from '../lib/remi/remiGuards.js';

const adminUrl = process.env.POSTGRES_CONNECTION_STRING ?? '';

function isDisposableLocalUrl(value) {
  try {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return local && /(test|_ci)$/i.test(dbName);
  } catch {
    return false;
  }
}

const shouldRun = process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true'
  && adminUrl !== ''
  && isDisposableLocalUrl(adminUrl);
const maybeTest = shouldRun ? test : test.skip;

let owner;
let db;
let workspaceId;
let alice;
let bob;
let aliceConversation;
let bobConversation;

before(async () => {
  if (!shouldRun) return;
  owner = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const userRow = async (label) => (await owner.query(
    'insert into raf.app_users (email) values ($1) returning id',
    [`daily-cap-${label}-${crypto.randomUUID()}@example.test`],
  )).rows[0].id;
  alice = await userRow('alice');
  bob = await userRow('bob');
  workspaceId = (await owner.query(
    "insert into raf.workspaces (name, owner_user_id) values ('Daily cap', $1) returning id",
    [alice],
  )).rows[0].id;

  db = createPostgresDb({ connectionString: adminUrl, ssl: false });
  await db.transaction(async (tx) => {
    aliceConversation = (await tx.createRemiConversation({ householdId: workspaceId, userId: alice, title: 'A' })).id;
    bobConversation = (await tx.createRemiConversation({ householdId: workspaceId, userId: bob, title: 'B' })).id;
  });
});

after(async () => {
  if (db?.close) await db.close();
  if (owner) await owner.end();
});

const since = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

maybeTest('daily count includes only the caller\'s user turns, not assistant turns or other members', async () => {
  await db.transaction(async (tx) => {
    await tx.appendRemiMessage({ conversationId: aliceConversation, householdId: workspaceId, userId: alice, role: 'user', content: 'a1', tokensUsed: 0 });
    await tx.appendRemiMessage({ conversationId: aliceConversation, householdId: workspaceId, userId: alice, role: 'user', content: 'a2', tokensUsed: 0 });
    await tx.appendRemiMessage({ conversationId: aliceConversation, householdId: workspaceId, userId: alice, role: 'assistant', content: 'r', tokensUsed: 5 });
    await tx.appendRemiMessage({ conversationId: bobConversation, householdId: workspaceId, userId: bob, role: 'user', content: 'b1', tokensUsed: 0 });
    await tx.appendRemiMessage({ conversationId: bobConversation, householdId: workspaceId, userId: bob, role: 'user', content: 'b2', tokensUsed: 0 });
    await tx.appendRemiMessage({ conversationId: bobConversation, householdId: workspaceId, userId: bob, role: 'user', content: 'b3', tokensUsed: 0 });
  });
  const aliceCount = await db.transaction((tx) => tx.countRemiUserMessagesSince({ householdId: workspaceId, userId: alice, since: since() }));
  const bobCount = await db.transaction((tx) => tx.countRemiUserMessagesSince({ householdId: workspaceId, userId: bob, since: since() }));
  assert.equal(aliceCount, 2);
  assert.equal(bobCount, 3);
});

maybeTest('turns before the window are not counted', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const count = await db.transaction((tx) => tx.countRemiUserMessagesSince({ householdId: workspaceId, userId: alice, since: future }));
  assert.equal(count, 0);
});

maybeTest('an unknown or malformed user id counts as zero, never as the whole workspace', async () => {
  const count = await db.transaction((tx) => tx.countRemiUserMessagesSince({ householdId: workspaceId, userId: 'local-user', since: since() }));
  assert.equal(count, 0);
});

maybeTest('the daily cap denies once the caller reaches the limit and allows below it', async () => {
  const config = { dailyMessageLimit: 2 };
  const decision = await checkRemiDailyCap({ db, householdId: workspaceId, userId: alice, config, route: 'chat' });
  assert.equal(decision.allowed, false, 'alice already has 2 user turns in the window');
  const bobDecision = await checkRemiDailyCap({ db, householdId: workspaceId, userId: bob, config: { dailyMessageLimit: 5 }, route: 'chat' });
  assert.equal(bobDecision.allowed, true, 'bob has 3 turns against a limit of 5');
});
