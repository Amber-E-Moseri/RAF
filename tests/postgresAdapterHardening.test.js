import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const postgresDbSource = fs.readFileSync(path.join(repoRoot, 'lib', 'server', 'postgresDb.js'), 'utf8');
const debtsRepositorySource = fs.readFileSync(path.join(repoRoot, 'lib', 'repositories', 'postgres', 'debtsRepository.js'), 'utf8');

test('Postgres adapter uses direct SQL dispatch — no advisory lock, no compat fallback', () => {
  assert.doesNotMatch(
    postgresDbSource,
    /pg_advisory_xact_lock/,
    'advisory lock must not be present after compat removal',
  );
  assert.doesNotMatch(postgresDbSource, /createHybridTransaction/, 'hybrid proxy must be gone');
  assert.doesNotMatch(postgresDbSource, /getLegacyTx/, 'getLegacyTx must be gone');
  assert.doesNotMatch(postgresDbSource, /flushTableDiff/, 'flushTableDiff must be gone');
  assert.doesNotMatch(postgresDbSource, /overlayState/, 'overlayState must be gone');
});

test('Postgres adapter sets provider-neutral RLS context transaction-locally', () => {
  assert.match(postgresDbSource, /set_config\('raf\.user_id', \$1, true\)/);
  assert.match(postgresDbSource, /set_config\('raf\.workspace_id', \$1, true\)/);
});

test('Postgres adapter uses raw_json bridge for raw table pass-through only (not hydration)', () => {
  assert.match(postgresDbSource, /select raw_json from/);
  assert.doesNotMatch(postgresDbSource, /overlayState/, 'hydration overlay must be gone');
  assert.doesNotMatch(postgresDbSource, /flushTableDiff/, 'diff flush must be gone');
});

test('Postgres adapter exposes only direct SQL methods — no compat hybrid layer', () => {
  assert.match(postgresDbSource, /function buildDirectTransaction\(client\)/);
  assert.doesNotMatch(postgresDbSource, /function createHybridTransaction/, 'hybrid proxy must be removed');
  assert.match(postgresDbSource, /async insertTransaction\(payload\)/);
  assert.match(postgresDbSource, /async listTransactions\(\{ householdId/);
  assert.match(postgresDbSource, /async insertFinancialAccount\(payload\)/);
  assert.match(postgresDbSource, /async listFinancialAccounts\(\{ householdId \}\)/);
  assert.match(postgresDbSource, /async getUserWorkspaceAccess\(\{ userId, workspaceId \}\)/);
  assert.match(postgresDbSource, /async insertBlacklistedToken\(\{ jti, expiresAt \}\)/);
  assert.match(postgresDbSource, /from \$\{POSTGRES_SCHEMA\}\.token_blacklist/);
  assert.doesNotMatch(postgresDbSource, /if \(!memoryDb\)/, 'memoryDb guard must be gone');
});

test('Postgres adapter persists optional financial account ids on debts', () => {
  assert.match(postgresDbSource, /table: 'debts'[\s\S]*financial_account_id/);
  assert.match(postgresDbSource, /financial_account_id: r\.financialAccountId \?\? null/);
  assert.match(debtsRepositorySource, /INSERT INTO \$\{schema\}\.debts[\s\S]*financial_account_id/);
  assert.match(debtsRepositorySource, /SET financial_account_id = \$3/);
});
