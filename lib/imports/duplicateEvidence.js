import { DUPLICATE_STATE, splitSignedCents } from './transactionIdentity.js';

function hasEvidenceSupport(tx) {
  return typeof tx.findImportEventClaims === 'function'
    && typeof tx.findLikelyDuplicateTransactions === 'function';
}

function claimTarget(claim) {
  return claim.transactionId
    ? { kind: 'transaction', id: claim.transactionId }
    : { kind: 'income_entry', id: claim.incomeEntryId };
}

function matchKey(match) {
  return `${match.kind}:${match.id}`;
}

// Deterministic evidence only:
//   exact  - the same account-bound event identity (key + ordinal) already resolved to a RAF record.
//   likely - same date and signed amount on a compatible account (or an identity match where the
//            account is unknown on either side) from a different source. Requires explicit user resolution.
//   none   - no evidence.
export async function evaluateDuplicateEvidence({
  tx,
  householdId,
  accountId = null,
  date,
  signedCents,
  eventKey,
  eventOrdinal,
  importBatchId = null,
  kind = 'transaction',
  lock = true,
}) {
  if (!hasEvidenceSupport(tx)) {
    return { state: DUPLICATE_STATE.NONE, matches: [] };
  }

  if (lock && typeof tx.lockImportIdentity === 'function') {
    await tx.lockImportIdentity({ householdId });
  }

  const matches = new Map();

  if (eventKey && eventOrdinal != null) {
    const claims = await tx.findImportEventClaims({ householdId, eventKey, eventOrdinal });
    for (const claim of claims) {
      const bothAccountsKnown = Boolean(claim.accountId) && Boolean(accountId);
      if (bothAccountsKnown && claim.accountId !== accountId) {
        continue;
      }

      const target = claimTarget(claim);
      if (bothAccountsKnown && claim.accountId === accountId) {
        return {
          state: DUPLICATE_STATE.EXACT,
          matches: [{ ...target, via: 'event_identity', claimType: claim.claimType }],
        };
      }

      if (importBatchId && claim.importBatchId === importBatchId) {
        continue;
      }
      matches.set(matchKey(target), { ...target, via: 'event_identity_unscoped_account' });
    }
  }

  const { direction, amount } = splitSignedCents(signedCents);

  const transactions = await tx.findLikelyDuplicateTransactions({
    householdId,
    accountId,
    date,
    amount,
    direction,
    excludeImportBatchId: importBatchId,
  });
  for (const row of transactions) {
    matches.set(`transaction:${row.id}`, {
      kind: 'transaction',
      id: row.id,
      via: 'date_amount_direction',
      date: row.transactionDate ?? date,
      amount: row.amount,
      direction: row.direction,
      description: row.description ?? null,
      source: row.source ?? null,
    });
  }

  if (kind === 'income' && direction === 'credit' && typeof tx.findLikelyDuplicateIncomeEntries === 'function') {
    const incomeEntries = await tx.findLikelyDuplicateIncomeEntries({
      householdId,
      date,
      amount,
      excludeImportBatchId: importBatchId,
    });
    for (const row of incomeEntries) {
      matches.set(`income_entry:${row.id}`, {
        kind: 'income_entry',
        id: row.id,
        via: 'date_amount_direction',
        date: row.receivedDate ?? date,
        amount: row.amount,
        description: row.sourceName ?? null,
      });
    }
  }

  const list = [...matches.values()];
  return {
    state: list.length > 0 ? DUPLICATE_STATE.LIKELY : DUPLICATE_STATE.NONE,
    matches: list,
  };
}
