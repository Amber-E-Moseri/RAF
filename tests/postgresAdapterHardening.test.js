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

test('Postgres compatibility adapter serializes hydration/diff transactions with an advisory lock', () => {
  assert.match(
    postgresDbSource,
    /pg_advisory_xact_lock\(hashtext\('raf\.postgres_compatibility_adapter'\)\)/,
  );
});

test('Postgres compatibility adapter sets provider-neutral RLS context transaction-locally', () => {
  assert.match(postgresDbSource, /set_config\('raf\.user_id', \$1, true\)/);
  assert.match(postgresDbSource, /set_config\('raf\.workspace_id', \$1, true\)/);
});

test('Postgres compatibility adapter is still a transitional raw_json bridge', () => {
  assert.match(postgresDbSource, /select raw_json from/);
  assert.match(postgresDbSource, /overlayState\(memoryDb\.state, snapshot\)/);
  assert.match(postgresDbSource, /flushTableDiff/);
});

test('Postgres adapter exposes direct SQL methods before falling back to legacy hydration', () => {
  assert.match(postgresDbSource, /function buildDirectTransaction\(client\)/);
  assert.match(postgresDbSource, /function createHybridTransaction/);
  assert.match(postgresDbSource, /async insertTransaction\(payload\)/);
  assert.match(postgresDbSource, /async listTransactions\(\{ householdId/);
  assert.match(postgresDbSource, /async insertFinancialAccount\(payload\)/);
  assert.match(postgresDbSource, /async listFinancialAccounts\(\{ householdId \}\)/);
  assert.match(postgresDbSource, /async getUserWorkspaceAccess\(\{ userId, workspaceId \}\)/);
  assert.match(postgresDbSource, /async insertBlacklistedToken\(\{ jti, expiresAt \}\)/);
  assert.match(postgresDbSource, /from \$\{POSTGRES_SCHEMA\}\.token_blacklist/);
  assert.match(postgresDbSource, /if \(!memoryDb\)/);
});

test('Postgres adapter persists optional financial account ids on debts', () => {
  assert.match(postgresDbSource, /table: 'debts'[\s\S]*financial_account_id/);
  assert.match(postgresDbSource, /financial_account_id: r\.financialAccountId \?\? null/);
  assert.match(debtsRepositorySource, /INSERT INTO \$\{schema\}\.debts[\s\S]*financial_account_id/);
  assert.match(debtsRepositorySource, /SET financial_account_id = \$3/);
});
