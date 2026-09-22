import test from 'node:test';
import assert from 'node:assert/strict';

import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL ?? process.env.SUPABASE_DATABASE_URL;
const shouldRun = Boolean(connectionString)
  && process.env.RAF_RUN_POSTGRES_RLS_TESTS === 'true'
  && process.env.RAF_CONFIRM_NON_PRODUCTION_DB === 'true';

const maybeTest = shouldRun ? test : test.skip;

async function asAuthenticated(client, { userId, workspaceId }, callback) {
  await client.query("SELECT set_config('raf.user_id', $1, true)", [userId]);
  await client.query("SELECT set_config('raf.workspace_id', $1, true)", [workspaceId]);
  return callback();
}

async function expectRejectsInSavepoint(client, run) {
  await client.query('SAVEPOINT rls_expected_rejection');
  try {
    await assert.rejects(run);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT rls_expected_rejection');
    await client.query('RELEASE SAVEPOINT rls_expected_rejection');
  }
}

maybeTest('Postgres RLS blocks cross-workspace reads, writes, joins, and guessed UUID access', async () => {
  const pool = new Pool({
    connectionString,
    ssl: process.env.RAF_POSTGRES_SSL === 'false' || process.env.RAF_POSTGRES_SSL === '0'
      ? false
      : { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  const ownerA = '10000000-0000-4000-8000-000000000001';
  const memberA = '10000000-0000-4000-8000-000000000002';
  const ownerB = '20000000-0000-4000-8000-000000000001';
  const workspaceA = '30000000-0000-4000-8000-000000000001';
  const workspaceB = '40000000-0000-4000-8000-000000000001';
  const accountA = '60000000-0000-4000-8000-000000000002';
  const transactionB = '50000000-0000-4000-8000-000000000001';
  const accountB = '60000000-0000-4000-8000-000000000001';
  const categoryA = '70000000-0000-4000-8000-000000000001';
  const categoryB = '70000000-0000-4000-8000-000000000002';
  const incomeB = '80000000-0000-4000-8000-000000000001';
  const conversationB = '90000000-0000-4000-8000-000000000001';
  const batchB = 'a0000000-0000-4000-8000-000000000001';
  const invitationB = 'b0000000-0000-4000-8000-000000000001';

  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO raf.app_users (id, email, raw_json) VALUES
        ($1, 'owner-a@example.test', '{}'::jsonb),
        ($2, 'member-a@example.test', '{}'::jsonb),
        ($3, 'owner-b@example.test', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [ownerA, memberA, ownerB]);
    await client.query(`
      INSERT INTO raf.workspaces (id, name, type, owner_user_id, raw_json) VALUES
        ($1, 'Workspace A', 'household', $2, '{}'::jsonb),
        ($3, 'Workspace B', 'household', $4, '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [workspaceA, ownerA, workspaceB, ownerB]);
    await client.query(`
      INSERT INTO raf.workspace_members (workspace_id, user_id, role, status, raw_json) VALUES
        ($1, $2, 'owner', 'active', '{}'::jsonb),
        ($1, $3, 'member', 'active', '{}'::jsonb),
        ($4, $5, 'owner', 'active', '{}'::jsonb)
      ON CONFLICT (workspace_id, user_id) DO NOTHING
    `, [workspaceA, ownerA, memberA, workspaceB, ownerB]);

    await asAuthenticated(client, { userId: ownerA, workspaceId: workspaceA }, async () => {
      await client.query(`
        INSERT INTO raf.allocation_categories (id, workspace_id, snapshot_id, slug, label, allocation_percent, is_active, raw_json)
        VALUES ($1, $2, $1, 'buffer', 'Buffer', 1.0000, true, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING
      `, [categoryA, workspaceA]);
      await client.query(`
        INSERT INTO raf.financial_accounts (id, workspace_id, name, account_type, current_balance, raw_json)
        VALUES ($1, $2, 'A Checking', 'checking', 100.00, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING
      `, [accountA, workspaceA]);
    });

    await asAuthenticated(client, { userId: ownerB, workspaceId: workspaceB }, async () => {
    await client.query(`
      INSERT INTO raf.allocation_categories (id, workspace_id, snapshot_id, slug, label, allocation_percent, is_active, raw_json)
      VALUES ($1, $2, $1, 'buffer', 'Buffer', 1.0000, true, '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [categoryB, workspaceB]);
    await client.query(`
      INSERT INTO raf.financial_accounts (id, workspace_id, name, account_type, current_balance, raw_json)
      VALUES ($1, $2, 'B Checking', 'checking', 100.00, '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [accountB, workspaceB]);
    await client.query(`
      INSERT INTO raf.transactions (id, workspace_id, account_id, transaction_date, description, amount, direction, raw_json)
      VALUES ($1, $2, $3, '2026-03-10', 'B private transaction', 42.00, 'debit', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [transactionB, workspaceB, accountB]);
    await client.query(`
      INSERT INTO raf.income_entries (id, workspace_id, source_name, amount, received_date, raw_json)
      VALUES ($1, $2, 'B payroll', 1000.00, '2026-03-10', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [incomeB, workspaceB]);
    await client.query(`
      INSERT INTO raf.income_allocations (workspace_id, income_entry_id, allocation_category_id, allocated_amount, allocation_percent, raw_json)
      VALUES ($1, $2, $3, 1000.00, 1.0000, '{}'::jsonb)
    `, [workspaceB, incomeB, categoryB]);
    await client.query(`
      INSERT INTO raf.debts (workspace_id, name, starting_balance, raw_json)
      VALUES ($1, 'B Visa', 500.00, '{}'::jsonb)
    `, [workspaceB]);
    await client.query(`
      INSERT INTO raf.fixed_bills (workspace_id, name, expected_amount, due_day_of_month, category_slug, raw_json)
      VALUES ($1, 'B Rent', 900.00, 1, 'fixed_bills', '{}'::jsonb)
    `, [workspaceB]);
    await client.query(`
      INSERT INTO raf.goals (workspace_id, bucket_id, name, target_amount, raw_json)
      VALUES ($1, $2, 'B Goal', 1000.00, '{}'::jsonb)
    `, [workspaceB, categoryB]);
    await client.query(`
      INSERT INTO raf.monthly_reviews (workspace_id, review_month, status, net_surplus, raw_json)
      VALUES ($1, '2026-03-01', 'closed', 10.00, '{}'::jsonb)
    `, [workspaceB]);
    await client.query(`
      INSERT INTO raf.import_batches (id, workspace_id, account_id, filename, status, raw_json)
      VALUES ($1, $2, $3, 'b.csv', 'uploaded', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [batchB, workspaceB, accountB]);
    await client.query(`
      INSERT INTO raf.imported_transaction_rows (workspace_id, account_id, batch_id, status, parsed_date, parsed_amount, raw_json)
      VALUES ($1, $2, $3, 'unreviewed', '2026-03-10', 42.00, '{}'::jsonb)
    `, [workspaceB, accountB, batchB]);
    await client.query(`
      INSERT INTO raf.imported_transactions (workspace_id, account_id, date, amount, description, status, raw_json)
      VALUES ($1, $2, '2026-03-10', 42.00, 'B imported row', 'unreviewed', '{}'::jsonb)
    `, [workspaceB, accountB]);
    await client.query(`
      INSERT INTO raf.merchant_rules (workspace_id, match_type, match_value, category_id, raw_json)
      VALUES ($1, 'contains', 'private merchant', $2, '{}'::jsonb)
    `, [workspaceB, categoryB]);
    await client.query(`
      INSERT INTO raf.import_review_rules (workspace_id, rule_type, match_value, raw_json)
      VALUES ($1, 'merchant', 'private merchant', '{}'::jsonb)
    `, [workspaceB]);
    await client.query(`
      INSERT INTO raf.account_reconciliations (workspace_id, account_id, recorded_balance, reported_balance, discrepancy, reported_as_of, raw_json)
      VALUES ($1, $2, 100.00, 95.00, -5.00, now(), '{}'::jsonb)
    `, [workspaceB, accountB]);
    await client.query(`
      INSERT INTO raf.remi_conversations (id, workspace_id, user_id, title, raw_json)
      VALUES ($1, $2, $3, 'B private Remi', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [conversationB, workspaceB, ownerB]);
    await client.query(`
      INSERT INTO raf.remi_messages (workspace_id, conversation_id, role, content, raw_json)
      VALUES ($1, $2, 'user', 'B private prompt', '{}'::jsonb)
    `, [workspaceB, conversationB]);
      await client.query(`
        INSERT INTO raf.workspace_invitations (id, workspace_id, invited_by, email, role, token, expires_at)
        VALUES ($1, $2, $3, 'invitee-b@example.test', 'member', 'hashed-token-b', now() + interval '1 day')
        ON CONFLICT (id) DO NOTHING
      `, [invitationB, workspaceB, ownerB]);
      await client.query(`
        INSERT INTO raf.workspace_activity (workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, $2, 'test.private_action', 'workspace', $3, '{}'::jsonb)
      `, [workspaceB, ownerB, String(workspaceB)]);
    });

    await asAuthenticated(client, { userId: ownerA, workspaceId: workspaceA }, async () => {
      const ownWorkspace = await client.query('SELECT count(*)::int AS count FROM raf.workspaces WHERE id = $1', [workspaceA]);
      assert.equal(ownWorkspace.rows[0].count, 1);

      for (const table of [
        'financial_accounts',
        'account_reconciliations',
        'transactions',
        'income_entries',
        'income_allocations',
        'debts',
        'fixed_bills',
        'goals',
        'monthly_reviews',
        'import_batches',
        'imported_transaction_rows',
        'imported_transactions',
        'merchant_rules',
        'import_review_rules',
        'remi_conversations',
        'remi_messages',
        'workspace_invitations',
        'workspace_activity',
      ]) {
        const selected = await client.query(`SELECT count(*)::int AS count FROM raf.${table} WHERE workspace_id = $1`, [workspaceB]);
        assert.equal(selected.rows[0].count, 0, `${table} should not expose workspace B rows`);
      }

      const joined = await client.query(`
        SELECT count(*)::int AS count
        FROM raf.transactions t
        JOIN raf.financial_accounts a ON a.id = t.account_id
        WHERE a.workspace_id = $1
      `, [workspaceB]);
      assert.equal(joined.rows[0].count, 0);

      await expectRejectsInSavepoint(
        client,
        () => client.query(`
          INSERT INTO raf.transactions (workspace_id, transaction_date, description, amount, direction, raw_json)
          VALUES ($1, '2026-03-11', 'cross insert', 1.00, 'debit', '{}'::jsonb)
        `, [workspaceB]),
      );
      await expectRejectsInSavepoint(
        client,
        () => client.query(`
          INSERT INTO raf.financial_accounts (workspace_id, name, account_type, current_balance, raw_json)
          VALUES ($1, 'cross account', 'checking', 1.00, '{}'::jsonb)
        `, [workspaceB]),
      );
      await expectRejectsInSavepoint(
        client,
        () => client.query('UPDATE raf.financial_accounts SET name = $1 WHERE id = $2', ['cross account update', accountB]),
      );
      await expectRejectsInSavepoint(
        client,
        () => client.query(`
          INSERT INTO raf.transactions (workspace_id, account_id, transaction_date, description, amount, direction, raw_json)
          VALUES ($1, $2, '2026-03-11', 'cross account association', 1.00, 'debit', '{}'::jsonb)
        `, [workspaceA, accountB]),
      );
      await expectRejectsInSavepoint(
        client,
        () => client.query(`
          INSERT INTO raf.account_reconciliations (workspace_id, account_id, recorded_balance, reported_balance, discrepancy, reported_as_of, raw_json)
          VALUES ($1, $2, 100.00, 95.00, -5.00, now(), '{}'::jsonb)
        `, [workspaceB, accountB]),
      );
      await expectRejectsInSavepoint(
        client,
        () => client.query(`
          INSERT INTO raf.import_batches (workspace_id, account_id, filename, status, raw_json)
          VALUES ($1, $2, 'cross.csv', 'uploaded', '{}'::jsonb)
        `, [workspaceB, accountB]),
      );
      await expectRejectsInSavepoint(
        client,
        () => client.query('UPDATE raf.transactions SET description = $1 WHERE id = $2', ['cross update', transactionB]),
      );
      await expectRejectsInSavepoint(
        client,
        () => client.query('DELETE FROM raf.transactions WHERE id = $1', [transactionB]),
      );
      await expectRejectsInSavepoint(
        client,
        () => client.query('UPDATE raf.workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3', ['owner', workspaceB, memberA]),
      );

      const guessed = await client.query('SELECT count(*)::int AS count FROM raf.transactions WHERE id = $1', [transactionB]);
      assert.equal(guessed.rows[0].count, 0);
    });

    await asAuthenticated(client, { userId: ownerB, workspaceId: workspaceB }, async () => {
      const ownAccount = await client.query('SELECT count(*)::int AS count FROM raf.financial_accounts WHERE id = $1', [accountB]);
      assert.equal(ownAccount.rows[0].count, 1);

      const otherAccount = await client.query('SELECT count(*)::int AS count FROM raf.financial_accounts WHERE id = $1', [accountA]);
      assert.equal(otherAccount.rows[0].count, 0);
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

maybeTest('Postgres transaction-local RLS context does not leak through a reused pooled connection', async () => {
  const pool = new Pool({
    connectionString,
    max: 1,
    ssl: process.env.RAF_POSTGRES_SSL === 'false' || process.env.RAF_POSTGRES_SSL === '0'
      ? false
      : { rejectUnauthorized: false },
  });

  try {
    const firstClient = await pool.connect();
    try {
      await firstClient.query('BEGIN');
      await firstClient.query("SELECT set_config('raf.user_id', $1, true)", ['10000000-0000-4000-8000-000000000001']);
      await firstClient.query("SELECT set_config('raf.workspace_id', $1, true)", ['30000000-0000-4000-8000-000000000001']);
      await firstClient.query('COMMIT');
    } finally {
      firstClient.release();
    }

    const secondClient = await pool.connect();
    try {
      const result = await secondClient.query(`
        SELECT
          NULLIF(current_setting('raf.user_id', true), '') AS user_id,
          NULLIF(current_setting('raf.workspace_id', true), '') AS workspace_id
      `);
      assert.equal(result.rows[0].user_id, null);
      assert.equal(result.rows[0].workspace_id, null);
    } finally {
      secondClient.release();
    }
  } finally {
    await pool.end();
  }
});
