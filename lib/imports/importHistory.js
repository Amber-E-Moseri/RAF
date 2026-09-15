import { ImportHttpError } from './shared.js';

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Import history DB adapter must implement transaction().');
  }
}

function normalizeStatus(value, fallback = 'unknown') {
  return String(value ?? fallback).trim().toLowerCase() || fallback;
}

function countByStatus(rows, status) {
  return rows.reduce((count, row) => count + (normalizeStatus(row.status) === status ? 1 : 0), 0);
}

function accountSummary(account) {
  if (!account) return null;
  return {
    id: account.id,
    name: account.name ?? 'Unnamed account',
    institution: account.institution ?? null,
    account_type: account.accountType ?? account.account_type ?? 'other',
  };
}

function reconciliationSummary(rows) {
  if (!rows.length) return null;
  const latest = [...rows].sort((left, right) =>
    String(right.reportedAsOf ?? right.reported_as_of ?? '').localeCompare(String(left.reportedAsOf ?? left.reported_as_of ?? ''))
    || String(right.createdAt ?? right.created_at ?? '').localeCompare(String(left.createdAt ?? left.created_at ?? '')),
  )[0];

  return {
    count: rows.length,
    latest_status: latest.status ?? null,
    latest_reported_as_of: latest.reportedAsOf ?? latest.reported_as_of ?? null,
    latest_discrepancy: latest.discrepancy ?? null,
  };
}

function summarizeImportRows(rows) {
  return {
    imported_rows: rows.length,
    pending_rows: countByStatus(rows, 'pending'),
    approved_rows: countByStatus(rows, 'approved'),
    duplicate_rows: countByStatus(rows, 'duplicate'),
    skipped_rows: countByStatus(rows, 'skipped'),
    rejected_rows: countByStatus(rows, 'rejected'),
  };
}

function summarizeImportedTransactions(rows) {
  return {
    imported_rows: rows.length,
    pending_rows: countByStatus(rows, 'unreviewed'),
    approved_rows: countByStatus(rows, 'classified'),
    duplicate_rows: rows.filter((row) => row.classificationType === 'duplicate').length,
    skipped_rows: countByStatus(rows, 'ignored'),
    rejected_rows: 0,
  };
}

function linkedCount(rows) {
  return rows.filter((row) => row.linkedTransactionId || row.linked_transaction_id).length;
}

function formatLegacyRow(row) {
  return {
    id: row.id,
    date: row.parsedDate ?? null,
    description: row.parsedDescription ?? row.rawDescription ?? null,
    amount: row.parsedAmount ?? null,
    status: normalizeStatus(row.status, 'pending'),
    classification_type: row.suggestedDebtId ? 'debt_payment' : row.suggestedCategoryId ? 'transaction' : null,
    duplicate_of_id: row.duplicateOfId ?? null,
    linked_transaction_id: null,
  };
}

function formatBankImportRow(row) {
  return {
    id: row.id,
    date: row.date,
    description: row.description,
    amount: row.amount,
    status: normalizeStatus(row.status, 'unreviewed'),
    classification_type: row.classificationType ?? null,
    duplicate_of_id: null,
    linked_transaction_id: row.linkedTransactionId ?? null,
  };
}

function byCreatedAtDesc(left, right) {
  return String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''))
    || String(right.id ?? '').localeCompare(String(left.id ?? ''));
}

export async function listImportHistory({ db, householdId }) {
  if (!householdId) {
    throw new ImportHttpError(400, 'householdId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const batches = typeof tx.listImportBatches === 'function'
      ? await tx.listImportBatches({ householdId })
      : [];
    const batchIds = batches.map((batch) => batch.id);
    const batchRows = batchIds.length && typeof tx.listImportedRowsForBatches === 'function'
      ? await tx.listImportedRowsForBatches({ householdId, batchIds })
      : [];
    const batchTransactions = batchIds.length && typeof tx.listTransactionsByImportBatchIds === 'function'
      ? await tx.listTransactionsByImportBatchIds({ householdId, batchIds })
      : [];
    const importedTransactions = typeof tx.listImportedTransactions === 'function'
      ? await tx.listImportedTransactions({ householdId })
      : [];
    const accounts = typeof tx.listFinancialAccounts === 'function'
      ? await tx.listFinancialAccounts({ householdId })
      : [];
    const accountIds = [...new Set([
      ...batches.map((batch) => batch.accountId).filter(Boolean),
      ...importedTransactions.map((row) => row.accountId).filter(Boolean),
    ])];
    const reconciliations = accountIds.length && typeof tx.listAccountReconciliationsForAccounts === 'function'
      ? await tx.listAccountReconciliationsForAccounts({ householdId, accountIds })
      : [];

    const rowsByBatch = new Map();
    for (const row of batchRows) {
      const rows = rowsByBatch.get(row.batchId) ?? [];
      rows.push(row);
      rowsByBatch.set(row.batchId, rows);
    }

    const transactionsByBatch = new Map();
    for (const transaction of batchTransactions) {
      if (!transaction.importBatchId) continue;
      const rows = transactionsByBatch.get(transaction.importBatchId) ?? [];
      rows.push(transaction);
      transactionsByBatch.set(transaction.importBatchId, rows);
    }

    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const reconciliationsByAccount = new Map();
    for (const row of reconciliations) {
      const rows = reconciliationsByAccount.get(row.accountId) ?? [];
      rows.push(row);
      reconciliationsByAccount.set(row.accountId, rows);
    }

    const items = batches.map((batch) => {
      const rows = rowsByBatch.get(batch.id) ?? [];
      const linkedRows = transactionsByBatch.get(batch.id) ?? [];
      const accountId = batch.accountId ?? null;
      return {
        id: batch.id,
        source_kind: 'import_batch',
        filename: batch.filename ?? null,
        source: batch.source ?? null,
        status: normalizeStatus(batch.status),
        created_at: batch.createdAt ?? null,
        updated_at: batch.updatedAt ?? null,
        row_count: batch.rowCount ?? rows.length,
        counts: {
          ...summarizeImportRows(rows),
          canonical_transactions: linkedRows.length,
        },
        account: accountSummary(accountsById.get(accountId)),
        reconciliation: reconciliationSummary(accountId ? reconciliationsByAccount.get(accountId) ?? [] : []),
      };
    });

    if (importedTransactions.length > 0) {
      const createdAtValues = importedTransactions.map((row) => row.createdAt).filter(Boolean).sort();
      const updatedAtValues = importedTransactions.map((row) => row.updatedAt).filter(Boolean).sort();
      const accountIdsForRows = [...new Set(importedTransactions.map((row) => row.accountId).filter(Boolean))];
      const account = accountIdsForRows.length === 1 ? accountSummary(accountsById.get(accountIdsForRows[0])) : null;
      const reconciliation = accountIdsForRows.length === 1
        ? reconciliationSummary(reconciliationsByAccount.get(accountIdsForRows[0]) ?? [])
        : null;
      items.push({
        id: 'bank_import_rows',
        source_kind: 'bank_import_rows',
        filename: null,
        source: 'bank_import',
        status: 'mixed',
        created_at: createdAtValues[0] ?? null,
        updated_at: updatedAtValues.at(-1) ?? null,
        row_count: importedTransactions.length,
        counts: {
          ...summarizeImportedTransactions(importedTransactions),
          canonical_transactions: linkedCount(importedTransactions),
        },
        account,
        reconciliation,
      });
    }

    return { items: items.sort(byCreatedAtDesc) };
  });
}

export async function getImportHistoryDetail({ db, householdId, importId }) {
  if (!householdId) {
    throw new ImportHttpError(400, 'householdId is required');
  }
  if (!importId) {
    throw new ImportHttpError(400, 'importId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const history = await listImportHistory({
      db: { transaction: async (callback) => callback(tx) },
      householdId,
    });
    const summary = history.items.find((item) => item.id === importId);
    if (!summary) {
      throw new ImportHttpError(404, 'import history entry not found');
    }

    if (summary.source_kind === 'bank_import_rows') {
      const rows = typeof tx.listImportedTransactions === 'function'
        ? await tx.listImportedTransactions({ householdId })
        : [];
      return {
        ...summary,
        rows: rows.map(formatBankImportRow),
      };
    }

    const rows = typeof tx.listImportedRows === 'function'
      ? await tx.listImportedRows({ householdId, batchId: importId })
      : [];
    return {
      ...summary,
      rows: rows.map(formatLegacyRow),
    };
  });
}
