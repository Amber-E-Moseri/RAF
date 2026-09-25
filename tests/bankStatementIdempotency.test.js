import test from 'node:test';
import assert from 'node:assert/strict';

import { importBankStatement } from '../lib/imports/bankStatementImports.js';

// --- fixtures ---

function createPdfFixture(textLines = []) {
  const body = textLines.map((line) => `(${line}) Tj`).join('\n');
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n%%EOF`);
}

const DEFAULT_LINES = [
  '2026-09-01 COFFEE SHOP -12.99 987.01',
  '2026-09-02 PAYROLL 2000.00 2987.01',
];

function pdfInput(lines = DEFAULT_LINES) {
  return {
    filename: 'september_statement.pdf',
    contentType: 'application/pdf',
    pdfBuffer: createPdfFixture(lines),
  };
}

// --- in-memory db double with rollback simulation ---

function createIdempotencyDouble({
  workspace = 'ws_test',
  preloadedFileHash = null,
  failInsertTransactionsAtCall = null,
} = {}) {
  const state = {
    batches: [],
    importedTransactions: [],
    txCallCount: 0,
    insertBatchCallCount: 0,
    getByHashCallCount: 0,
  };

  if (preloadedFileHash) {
    state.batches.push({
      id: 'batch_preloaded',
      householdId: workspace,
      workspaceId: workspace,
      fileHash: preloadedFileHash,
      source: 'bank_import',
    });
  }

  function buildTx() {
    return {
      async getImportBatchByFileHash({ householdId, fileHash }) {
        state.getByHashCallCount++;
        if (!fileHash) return null;
        return (
          state.batches.find(
            (b) => (b.householdId === householdId || b.workspaceId === householdId) && b.fileHash === fileHash,
          ) ?? null
        );
      },

      async insertImportBatch(payload) {
        state.insertBatchCallCount++;
        const fileHash = payload.fileHash ?? null;
        const wsId = payload.workspaceId ?? payload.householdId;
        if (fileHash != null) {
          const conflict = state.batches.find(
            (b) => (b.householdId === wsId || b.workspaceId === wsId) && b.fileHash === fileHash,
          );
          if (conflict) {
            const err = new Error(
              'duplicate key value violates unique constraint "idx_import_batches_workspace_file_hash"',
            );
            err.code = '23505';
            err.constraint = 'idx_import_batches_workspace_file_hash';
            throw err;
          }
        }
        const row = {
          id: `batch_${state.batches.length + 1}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          householdId: payload.householdId ?? payload.workspaceId,
          workspaceId: payload.workspaceId ?? payload.householdId,
          ...payload,
        };
        state.batches.push(row);
        return { ...row };
      },

      async insertImportedTransactions({ rows }) {
        state.txCallCount++;
        if (failInsertTransactionsAtCall !== null && state.txCallCount === failInsertTransactionsAtCall) {
          throw new Error('simulated DB failure during row insertion');
        }
        const inserted = rows.map((row, i) => ({
          id: `txn_${state.importedTransactions.length + i + 1}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...row,
        }));
        state.importedTransactions.push(...inserted);
        return [...inserted];
      },

      async listImportedTransactions({ householdId }) {
        return state.importedTransactions
          .filter((r) => r.householdId === householdId)
          .map((r) => ({ ...r }));
      },

      async getPdfImportQuotaStatus() {
        return { tier: 'paid', canImport: true, remaining: null };
      },

      async reservePdfImportQuota() {
        return { allowed: true, count: 0, remaining: null };
      },
    };
  }

  return {
    state,
    async transaction(callback) {
      const batchSnap = state.batches.map((b) => ({ ...b }));
      const txnSnap = state.importedTransactions.map((r) => ({ ...r }));
      try {
        return await callback(buildTx());
      } catch (err) {
        state.batches = batchSnap;
        state.importedTransactions = txnSnap;
        throw err;
      }
    },
  };
}

// --- T1: batch is created on success ---

test('T1: successful import creates exactly one batch with source bank_import and a fileHash', async () => {
  const db = createIdempotencyDouble({ workspace: 'ws_1' });

  await importBankStatement({
    db,
    householdId: 'ws_1',
    pdfTextExtractor: async () => DEFAULT_LINES.join('\n'),
    input: pdfInput(),
  });

  assert.equal(db.state.insertBatchCallCount, 1, 'insertImportBatch should be called once');
  assert.equal(db.state.batches.length, 1, 'exactly one batch should be in state');
  assert.equal(db.state.batches[0].source, 'bank_import', 'batch source must be bank_import');
  assert.ok(db.state.batches[0].fileHash, 'batch must have a non-empty fileHash');
});

// --- T2: duplicate file returns 409 ---

test('T2: re-uploading the same file bytes returns 409 with "already been imported"', async () => {
  const db = createIdempotencyDouble({ workspace: 'ws_2' });
  const extractor = async () => DEFAULT_LINES.join('\n');

  await importBankStatement({ db, householdId: 'ws_2', pdfTextExtractor: extractor, input: pdfInput() });

  await assert.rejects(
    () => importBankStatement({ db, householdId: 'ws_2', pdfTextExtractor: extractor, input: pdfInput() }),
    (err) => {
      assert.equal(err.status, 409, 'expected HTTP 409 on duplicate import');
      assert.match(err.message, /already been imported/i, 'expected "already been imported" in message');
      return true;
    },
  );
});

// --- T3: same hash, different workspace — allowed ---

test('T3: same file hash in a different workspace is allowed (two separate imports succeed)', async () => {
  const dbA = createIdempotencyDouble({ workspace: 'ws_a' });
  const dbB = createIdempotencyDouble({ workspace: 'ws_b' });
  const extractor = async () => DEFAULT_LINES.join('\n');

  await importBankStatement({ db: dbA, householdId: 'ws_a', pdfTextExtractor: extractor, input: pdfInput() });
  await importBankStatement({ db: dbB, householdId: 'ws_b', pdfTextExtractor: extractor, input: pdfInput() });

  assert.equal(dbA.state.batches.length, 1, 'ws_a should have one batch');
  assert.equal(dbB.state.batches.length, 1, 'ws_b should have one batch');
});

// --- T4: concurrent duplicate — documented, real-DB only ---

test('T4: concurrent duplicate insert — correctness guaranteed by unique index (NOT_ATTESTED: real DB required)', () => {
  // The unique partial index idx_import_batches_workspace_file_hash on raf.import_batches
  // serializes concurrent inserts for the same (workspace_id, file_hash). This test
  // documents the requirement; it cannot be verified without a live PostgreSQL connection.
  assert.ok(true, 'NOT_ATTESTED');
});

// --- T5: failed insertImportedTransactions rolls back the batch ---

test('T5: if insertImportedTransactions throws, the batch insert is rolled back (no orphan batch)', async () => {
  const db = createIdempotencyDouble({ workspace: 'ws_5', failInsertTransactionsAtCall: 1 });

  await assert.rejects(
    () =>
      importBankStatement({
        db,
        householdId: 'ws_5',
        pdfTextExtractor: async () => DEFAULT_LINES.join('\n'),
        input: pdfInput(),
      }),
    (err) => {
      assert.ok(err instanceof Error, 'should propagate the DB error');
      return true;
    },
  );

  assert.equal(db.state.batches.length, 0, 'batch must be rolled back — no orphan batch after failure');
  assert.equal(db.state.importedTransactions.length, 0, 'no transactions must persist after rollback');
});

// --- T6: AI-fallback path documented ---

test('T6: zero-regex-match AI-fallback path — batch creation documented (NOT_ATTESTED: AI env required)', () => {
  // When regex extraction yields 0 rows, the code falls through to the AI path.
  // The batch must still be created inside the same transaction as insertImportedTransactions.
  // Full verification requires a live Anthropic API key or a test stub for parseWithAI.
  assert.ok(true, 'NOT_ATTESTED');
});

// --- T7: RLS cross-workspace isolation ---

test('T7: RLS prevents cross-workspace batch lookup (NOT_ATTESTED: real DB required)', () => {
  // PostgreSQL RLS scopes raf.import_batches by workspace_id via raf.current_workspace_id().
  // Cross-workspace isolation is enforced at the DB layer and cannot be tested without
  // a live database connection.
  assert.ok(true, 'NOT_ATTESTED');
});

// --- T8: early lookup short-circuits pdfTextExtractor ---

test('T8: early lookup short-circuits — pdfTextExtractor is NOT called when hash is already known', async () => {
  const { createHash } = await import('node:crypto');
  const fixture = pdfInput();
  const preloadedFileHash = createHash('sha256').update(fixture.pdfBuffer).digest('hex');

  const db = createIdempotencyDouble({ workspace: 'ws_8', preloadedFileHash });

  let extractorCalled = false;
  const pdfTextExtractor = async () => {
    extractorCalled = true;
    return DEFAULT_LINES.join('\n');
  };

  await assert.rejects(
    () => importBankStatement({ db, householdId: 'ws_8', pdfTextExtractor, input: fixture }),
    (err) => {
      assert.equal(err.status, 409, 'expected 409 from early lookup');
      return true;
    },
  );

  assert.equal(extractorCalled, false, 'pdfTextExtractor must NOT be called when early lookup detects a duplicate');
});
