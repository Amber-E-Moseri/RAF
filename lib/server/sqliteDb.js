import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import Database from 'better-sqlite3';

import { createInMemoryDb } from './inMemoryDb.js';

const TABLES = [
  { table: 'users', stateKey: 'users' },
  { table: 'workspace_members', stateKey: 'workspaceMembers' },
  { table: 'workspace_invitations', stateKey: 'workspaceInvitations' },
  { table: 'workspace_activity', stateKey: 'workspaceActivity' },
  { table: 'financial_accounts', stateKey: 'financialAccounts' },
  { table: 'account_reconciliations', stateKey: 'accountReconciliations' },
  { table: 'token_blacklist', stateKey: 'tokenBlacklist' },
  { table: 'households', stateKey: 'households' },
  { table: 'allocation_categories', stateKey: 'allocationCategories' },
  { table: 'surplus_split_rules', stateKey: 'surplusSplitRules' },
  { table: 'income_entries', stateKey: 'incomeEntries' },
  { table: 'income_allocations', stateKey: 'incomeAllocations' },
  { table: 'transactions', stateKey: 'transactions' },
  { table: 'debts', stateKey: 'debts' },
  { table: 'debt_payments', stateKey: 'debtPayments' },
  { table: 'debt_payment_pace_acknowledgements', stateKey: 'debtPaymentPaceAcknowledgements' },
  { table: 'debt_adjustments', stateKey: 'debtAdjustments' },
  { table: 'import_batches', stateKey: 'importBatches' },
  { table: 'imported_transaction_rows', stateKey: 'importedRows' },
  { table: 'merchant_rules', stateKey: 'merchantRules' },
  { table: 'fixed_bills', stateKey: 'fixedBills' },
  { table: 'goals', stateKey: 'goals' },
  { table: 'imported_transactions', stateKey: 'importedTransactions' },
  { table: 'import_review_rules', stateKey: 'importReviewRules' },
  { table: 'monthly_reviews', stateKey: 'monthlyReviews' },
  { table: 'upcoming_expenses', stateKey: 'upcomingExpenses' },
];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function ensureSqliteSchema(db) {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  for (const { table } of TABLES) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        household_id TEXT,
        raw_json TEXT NOT NULL
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_household_id ON ${table}(household_id);`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const migrationStamp = [
    '20260313120000_create_raf_schema.sql',
    '20260313133000_add_import_workflow_tables.sql',
    '20260313143000_add_monthly_reviews.sql',
    '20260313150000_extend_import_review_metadata.sql',
    '20260313152000_update_merchant_rules_shape.sql',
    '20260313170000_harden_backend_integrity.sql',
  ].join(',');

  db.prepare('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)')
    .run('migration_lineage', migrationStamp);
}

function loadStateFromSqlite(db) {
  const state = {};

  for (const { table, stateKey } of TABLES) {
    const rows = db.prepare(`SELECT raw_json FROM ${table}`).all();
    state[stateKey] = rows.map((row) => JSON.parse(row.raw_json));
  }

  return state;
}

function hasPersistedRows(state) {
  return Array.isArray(state.households) && state.households.length > 0;
}

function persistStateToSqlite(db, state) {
  const write = db.transaction(() => {
    for (const { table, stateKey } of TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();

      const insert = db.prepare(`INSERT INTO ${table} (id, household_id, raw_json) VALUES (?, ?, ?)`);
      const rows = Array.isArray(state[stateKey]) ? state[stateKey] : [];

      for (const row of rows) {
        const id = String(row.id ?? crypto.randomUUID());
        insert.run(id, row.householdId ?? null, JSON.stringify(row));
      }
    }
  });

  write();
}

function replaceState(target, source) {
  for (const { stateKey } of TABLES) {
    target[stateKey] = clone(source[stateKey] ?? []);
  }
}

export function createSqliteDb({ dbPath }) {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('SQLite dbPath is required.');
  }

  const resolvedPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const sqlite = new Database(resolvedPath);
  ensureSqliteSchema(sqlite);

  const memoryDb = createInMemoryDb();
  const persistedState = loadStateFromSqlite(sqlite);

  if (hasPersistedRows(persistedState)) {
    replaceState(memoryDb.state, persistedState);
  } else {
    persistStateToSqlite(sqlite, memoryDb.state);
  }

  return {
    defaultHouseholdId: memoryDb.defaultHouseholdId,
    state: memoryDb.state,
    async transaction(callback) {
      const snapshot = clone(memoryDb.state);
      try {
        const result = await memoryDb.transaction(callback);
        persistStateToSqlite(sqlite, memoryDb.state);
        return result;
      } catch (error) {
        replaceState(memoryDb.state, snapshot);
        throw error;
      }
    },
    async ping() {
      sqlite.prepare('SELECT 1').get();
    },

    close() {
      sqlite.close();
    },
  };
}
