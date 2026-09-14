import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const migrationPath = path.join(repoRoot, 'db', 'migrations', '20260903090000_workspace_postgres_persistence.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const financialAccountsMigrationPath = path.join(repoRoot, 'db', 'migrations', '20260903120000_financial_accounts.sql');
const financialAccountsSql = fs.readFileSync(financialAccountsMigrationPath, 'utf8');
const tokenBlacklistMigrationPath = path.join(repoRoot, 'db', 'migrations', '20260905000000_add_token_blacklist.sql');
const tokenBlacklistSql = fs.readFileSync(tokenBlacklistMigrationPath, 'utf8');
const ownerBootstrapMigrationPath = path.join(repoRoot, 'db', 'migrations', '20260910000006_owner_scoped_signup_bootstrap.sql');
const ownerBootstrapSql = fs.readFileSync(ownerBootstrapMigrationPath, 'utf8');
const debtAccountLinkMigrationPath = path.join(repoRoot, 'db', 'migrations', '20260913000000_debt_financial_account_link.sql');
const debtAccountLinkSql = fs.readFileSync(debtAccountLinkMigrationPath, 'utf8');

const tenantTables = [
  'households',
  'allocation_categories',
  'surplus_split_rules',
  'income_entries',
  'income_allocations',
  'transactions',
  'debts',
  'debt_payments',
  'debt_adjustments',
  'fixed_bills',
  'goals',
  'import_batches',
  'imported_transaction_rows',
  'imported_transactions',
  'merchant_rules',
  'import_review_rules',
  'monthly_reviews',
  'pdf_import_quotas',
  'remi_conversations',
  'remi_messages',
  'email_preferences',
  'email_send_log',
];

test('Postgres migration creates workspace-first tenant tables with RLS', () => {
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS raf;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS raf\.workspaces/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS raf\.workspace_members/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION raf\.has_workspace_membership/);
  assert.match(sql, /SECURITY DEFINER/);

  for (const table of tenantTables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS raf\\.${table}[\\s\\S]*workspace_id uuid NOT NULL`), `${table} must be workspace-owned`);
    assert.match(sql, new RegExp(`ALTER TABLE raf\\.${table} ENABLE ROW LEVEL SECURITY`), `${table} must enable RLS`);
    assert.match(sql, new RegExp(`ALTER TABLE raf\\.${table} FORCE ROW LEVEL SECURITY`), `${table} must force RLS for table-owner connections`);
    assert.match(sql, new RegExp(`CREATE POLICY [\\s\\S]* ON raf\\.${table}[\\s\\S]*raf\\.has_workspace_membership\\(workspace_id\\)`), `${table} must derive RLS from workspace membership`);
  }
});

test('Postgres migration preserves decimal financial precision', () => {
  const moneyColumns = [
    'savings_floor',
    'monthly_essentials_baseline',
    'allocation_percent',
    'split_percent',
    'amount',
    'allocated_amount',
    'starting_balance',
    'minimum_payment',
    'monthly_payment',
    'target_amount',
    'expected_amount',
    'parsed_amount',
    'net_surplus',
  ];

  for (const column of moneyColumns) {
    assert.match(sql, new RegExp(`${column} numeric\\(`, 'i'), `${column} must use NUMERIC`);
  }

  assert.doesNotMatch(sql, /\b(double precision|real|float|money)\b/i);
});

test('Postgres migration keeps common tenant indexes workspace-led', () => {
  const indexExpectations = [
    /idx_transactions_workspace_transaction_date[\s\S]*\(workspace_id, transaction_date, id\)/,
    /idx_income_entries_workspace_received_date[\s\S]*\(workspace_id, received_date\)/,
    /idx_debts_workspace_active[\s\S]*\(workspace_id, is_active\)/,
    /idx_goals_workspace_active[\s\S]*\(workspace_id, active\)/,
    /idx_import_batches_workspace_status[\s\S]*\(workspace_id, status, created_at DESC\)/,
    /idx_monthly_reviews_workspace_month[\s\S]*\(workspace_id, review_month\)/,
    /idx_remi_conversations_workspace_user[\s\S]*\(workspace_id, user_id, created_at DESC\)/,
  ];

  for (const expectation of indexExpectations) {
    assert.match(sql, expectation);
  }
});

test('financial accounts migration adds account ownership, reconciliation audit, and RLS', () => {
  assert.match(financialAccountsSql, /CREATE TYPE raf\.financial_account_type AS ENUM \([\s\S]*'checking'[\s\S]*'credit_card'[\s\S]*'line_of_credit'[\s\S]*'investment'[\s\S]*'other'/);
  assert.match(financialAccountsSql, /CREATE TABLE IF NOT EXISTS raf\.financial_accounts[\s\S]*workspace_id uuid NOT NULL/);
  assert.match(financialAccountsSql, /current_balance numeric\(12,2\)/);
  assert.match(financialAccountsSql, /available_balance numeric\(12,2\)/);
  assert.match(financialAccountsSql, /CREATE TABLE IF NOT EXISTS raf\.account_reconciliations[\s\S]*recorded_balance numeric\(12,2\)[\s\S]*reported_balance numeric\(12,2\)[\s\S]*discrepancy numeric\(12,2\)/);
  assert.match(financialAccountsSql, /ALTER TABLE raf\.transactions[\s\S]*ADD COLUMN IF NOT EXISTS account_id uuid/);
  assert.match(financialAccountsSql, /idx_transactions_workspace_account_date[\s\S]*\(workspace_id, account_id, transaction_date, id\)/);
  assert.match(financialAccountsSql, /ALTER TABLE raf\.financial_accounts ENABLE ROW LEVEL SECURITY/);
  assert.match(financialAccountsSql, /ALTER TABLE raf\.financial_accounts FORCE ROW LEVEL SECURITY/);
  assert.match(financialAccountsSql, /CREATE POLICY financial_accounts_workspace_policy[\s\S]*raf\.has_workspace_membership\(workspace_id\)/);
  assert.match(financialAccountsSql, /CREATE POLICY account_reconciliations_workspace_policy[\s\S]*raf\.has_workspace_membership\(workspace_id\)/);
  assert.match(financialAccountsSql, /ALTER TABLE raf\.account_reconciliations FORCE ROW LEVEL SECURITY/);
});

test('financial accounts migration enforces same-workspace account references', () => {
  for (const constraintName of [
    'transactions_account_fk',
    'import_batches_account_fk',
    'imported_rows_account_fk',
    'imported_transactions_account_fk',
    'account_reconciliations_account_fk',
  ]) {
    assert.match(
      financialAccountsSql,
      new RegExp(`${constraintName}[\\s\\S]*FOREIGN KEY \\(account_id, workspace_id\\)[\\s\\S]*REFERENCES raf\\.financial_accounts\\(id, workspace_id\\)`),
      `${constraintName} must require account_id and workspace_id to match`,
    );
  }
});

test('debt financial account link migration is additive, workspace-safe, and active-unique', () => {
  assert.match(debtAccountLinkSql, /ALTER TABLE raf\.debts[\s\S]*ADD COLUMN IF NOT EXISTS financial_account_id uuid/);
  assert.match(debtAccountLinkSql, /FOREIGN KEY \(financial_account_id, workspace_id\)[\s\S]*REFERENCES raf\.financial_accounts\(id, workspace_id\)/);
  assert.match(debtAccountLinkSql, /ON DELETE SET NULL \(financial_account_id\)/);
  assert.match(debtAccountLinkSql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_debts_one_active_debt_per_financial_account[\s\S]*WHERE financial_account_id IS NOT NULL AND is_active = true/);
});

test('workspace RLS helper functions use provider-neutral transaction-local context', () => {
  for (const functionName of ['current_app_user_id', 'current_workspace_id', 'has_workspace_membership', 'has_workspace_role']) {
    assert.match(
      sql,
      new RegExp(`CREATE OR REPLACE FUNCTION raf\\.${functionName}[\\s\\S]*SECURITY DEFINER[\\s\\S]*SET search_path = raf, pg_catalog`),
      `${functionName} must have an explicit safe search_path`,
    );
    assert.match(
      sql,
      new RegExp(`REVOKE ALL ON FUNCTION raf\\.${functionName}\\(`),
      `${functionName} must revoke PUBLIC execute`,
    );
    assert.match(
      sql,
      new RegExp(`GRANT EXECUTE ON FUNCTION raf\\.${functionName}\\([\\s\\S]* TO PUBLIC`),
      `${functionName} must be callable from provider-neutral app roles`,
    );
  }

  assert.match(sql, /current_setting\('raf\.user_id', true\)/);
  assert.match(sql, /current_setting\('raf\.workspace_id', true\)/);
  assert.doesNotMatch(sql, /\bauth\.uid\(\)|\bauth\.jwt\(\)|request\.jwt/i);
  assert.doesNotMatch(sql, /SECURITY DEFINER\s+SET search_path = public/i);
  assert.doesNotMatch(sql, /SET search_path = raf, auth, pg_catalog/i);
});

test('token blacklist migration creates durable jti revocation storage and cleanup', () => {
  assert.match(tokenBlacklistSql, /create table if not exists raf\.token_blacklist/i);
  assert.match(tokenBlacklistSql, /jti\s+text\s+not null primary key/i);
  assert.match(tokenBlacklistSql, /expires_at\s+timestamptz\s+not null/i);
  assert.match(tokenBlacklistSql, /create or replace function raf\.cleanup_expired_tokens\(\)/i);
  assert.match(tokenBlacklistSql, /delete from raf\.token_blacklist where expires_at < now\(\)/i);
});

test('owner-scoped signup bootstrap migration avoids broad insert policies', () => {
  assert.match(ownerBootstrapSql, /CREATE OR REPLACE FUNCTION raf\.is_workspace_owner[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = raf, pg_catalog/);
  assert.match(ownerBootstrapSql, /CREATE POLICY workspaces_insert_policy[\s\S]*WITH CHECK \(owner_user_id = raf\.current_app_user_id\(\)\)/);
  assert.match(ownerBootstrapSql, /CREATE POLICY workspace_members_insert_policy[\s\S]*user_id = raf\.current_app_user_id\(\)[\s\S]*role = 'owner'[\s\S]*status = 'active'[\s\S]*raf\.is_workspace_owner\(workspace_id, user_id\)/);
  assert.match(ownerBootstrapSql, /CREATE POLICY households_insert_policy[\s\S]*raf\.has_workspace_role\(workspace_id, ARRAY\['owner', 'admin'\]::raf\.workspace_role\[\]\)/);
  assert.doesNotMatch(ownerBootstrapSql, /WITH CHECK\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(ownerBootstrapSql, /workspace_has_no_members/);
});
