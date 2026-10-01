import { z } from 'zod';

import { evaluateDuplicateEvidence } from './duplicateEvidence.js';
import { matchMerchantRule, normalizeMerchant } from './merchantRules.js';
import {
  IMPORT_BATCH_STATUS,
  ImportHttpError,
  assertImportBatchStatus,
  assertImportBatchTransition,
  formatImportRow,
  normalizeIsoDate,
  normalizeMoney,
  parseDirection,
} from './shared.js';
import {
  DUPLICATE_STATE,
  assignEventOrdinals,
  buildEventKey,
  signedCentsFromAmountAndDirection,
} from './transactionIdentity.js';

const columnMapSchema = z.object({
  columnMap: z.object({
    date: z.string().trim().min(1, 'is required'),
    description: z.string().trim().min(1, 'is required'),
    merchant: z.string().trim().optional().nullable(),
    amount: z.string().trim().min(1, 'is required'),
    direction: z.string().trim().optional().nullable(),
  }),
});

function parseWithSchema(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : 'request';
    throw new ImportHttpError(400, `${path} ${issue.message}`);
  }

  return result.data;
}

export function parseColumnMap(input) {
  const parsed = parseWithSchema(columnMapSchema, input);
  return {
    date: parsed.columnMap.date,
    description: parsed.columnMap.description,
    merchant: parsed.columnMap.merchant || null,
    amount: parsed.columnMap.amount,
    direction: parsed.columnMap.direction || null,
  };
}

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Import DB adapter must implement transaction().');
  }
}

function getMappedRawRow(row, columnMap) {
  const rawData = row.rawData ?? row.raw_data ?? null;
  if (rawData && typeof rawData === 'object') {
    return {
      rawDate: rawData[columnMap.date] ?? null,
      rawDescription: rawData[columnMap.description] ?? null,
      rawMerchant: columnMap.merchant ? rawData[columnMap.merchant] ?? null : null,
      rawAmount: rawData[columnMap.amount] ?? null,
      rawDirection: columnMap.direction ? rawData[columnMap.direction] ?? null : null,
    };
  }

  return {
    rawDate: row.rawDate,
    rawDescription: row.rawDescription,
    rawMerchant: row.rawMerchant,
    rawAmount: row.rawAmount,
    rawDirection: row.rawDirection,
  };
}

function parseRow(row, columnMap, merchantRules) {
  const mappedRow = getMappedRawRow(row, columnMap);
  const parsedDate = normalizeIsoDate(mappedRow.rawDate, 'rawDate');
  const parsedDescription = String(mappedRow.rawDescription ?? '').trim();
  if (!parsedDescription) {
    throw new ImportHttpError(422, 'rawDescription is required');
  }

  const parsedAmount = normalizeMoney(mappedRow.rawAmount, 'rawAmount');
  const parsedMerchant = String(mappedRow.rawMerchant ?? '').trim() || null;
  const parsedDirection = parseDirection(mappedRow.rawDirection);
  const rule = matchMerchantRule(merchantRules, parsedMerchant);

  return {
    rawDate: mappedRow.rawDate == null ? null : String(mappedRow.rawDate).trim(),
    rawDescription: parsedDescription,
    rawMerchant: parsedMerchant,
    rawAmount: mappedRow.rawAmount == null ? null : String(mappedRow.rawAmount).trim(),
    rawDirection: mappedRow.rawDirection == null ? null : String(mappedRow.rawDirection).trim() || null,
    parsedDate,
    parsedDescription,
    parsedMerchant,
    parsedAmount,
    parsedDirection,
    suggestedCategoryId: rule?.categoryId ?? null,
    suggestedByRuleId: rule?.id ?? null,
    suggestionReason: rule ? `merchant_rule:${rule.matchType}:${rule.matchValue}` : null,
    normalizedMerchant: normalizeMerchant(parsedMerchant),
  };
}

export async function parseImportBatch({ db, householdId, batchId, input }) {
  if (!householdId) {
    throw new ImportHttpError(400, 'householdId is required');
  }

  if (!batchId) {
    throw new ImportHttpError(400, 'batchId is required');
  }

  requireDbContract(db);
  const columnMap = parseColumnMap(input);

  try {
    return await db.transaction(async (tx) => {
      const batch = await tx.getImportBatch({ householdId, batchId });
      if (!batch) {
        throw new ImportHttpError(404, 'import batch not found');
      }

      const batchStatus = assertImportBatchStatus(
        batch,
        new Set([IMPORT_BATCH_STATUS.UPLOADED, IMPORT_BATCH_STATUS.REVIEW, IMPORT_BATCH_STATUS.FAILED]),
        'import batch must be uploaded, review, or failed before parsing',
      );
      assertImportBatchTransition({
        currentStatus: batchStatus,
        nextStatus: IMPORT_BATCH_STATUS.PARSING,
        action: 'parse',
      });

      await tx.updateImportBatch({
        householdId,
        batchId,
        status: IMPORT_BATCH_STATUS.PARSING,
      });

      const rawRows = await tx.listImportedRows({ householdId, batchId });
      const merchantRules = await tx.listMerchantRules({ householdId });

      const parsedList = rawRows.map((row) => ({ row, parsed: parseRow(row, columnMap, merchantRules) }));
      const signedCentsList = parsedList.map(({ parsed }) =>
        signedCentsFromAmountAndDirection(parsed.parsedAmount, parsed.parsedDirection));
      const eventKeys = parsedList.map(({ parsed }, index) => buildEventKey({
        date: parsed.parsedDate,
        signedCents: signedCentsList[index],
        description: parsed.parsedDescription,
      }));
      const eventOrdinals = assignEventOrdinals(eventKeys);

      const parsedPatches = [];
      for (const [index, { row, parsed }] of parsedList.entries()) {
        let evidence = await evaluateDuplicateEvidence({
          tx,
          householdId,
          accountId: row.accountId ?? batch.accountId ?? null,
          date: parsed.parsedDate,
          signedCents: signedCentsList[index],
          eventKey: eventKeys[index],
          eventOrdinal: eventOrdinals[index],
          importBatchId: batchId,
          kind: 'transaction',
          lock: false,
        });
        if (evidence.state === DUPLICATE_STATE.NONE && typeof tx.findDuplicateTransaction === 'function') {
          const legacyMatch = await tx.findDuplicateTransaction({
            householdId,
            parsedDate: parsed.parsedDate,
            parsedAmount: parsed.parsedAmount,
            normalizedMerchant: parsed.normalizedMerchant,
          });
          if (legacyMatch) {
            evidence = {
              state: DUPLICATE_STATE.LIKELY,
              matches: [{ kind: 'transaction', id: legacyMatch.id, via: 'merchant_date_amount' }],
            };
          }
        }
        const flagged = evidence.state !== DUPLICATE_STATE.NONE;
        const firstMatch = evidence.matches[0] ?? null;

        parsedPatches.push({
          rowId: row.id,
          patch: {
            rawDate: parsed.rawDate,
            rawDescription: parsed.rawDescription,
            rawMerchant: parsed.rawMerchant,
            rawAmount: parsed.rawAmount,
            rawDirection: parsed.rawDirection,
            parsedDate: parsed.parsedDate,
            parsedDescription: parsed.parsedDescription,
            parsedMerchant: parsed.parsedMerchant,
            parsedAmount: parsed.parsedAmount,
            parsedDirection: parsed.parsedDirection,
            suggestedCategoryId: parsed.suggestedCategoryId,
            suggestedDebtId: null,
            suggestedByRuleId: parsed.suggestedByRuleId,
            suggestionReason: parsed.suggestionReason,
            status: flagged ? 'duplicate' : 'pending',
            duplicateOfId: firstMatch?.id ?? null,
            duplicateReason: firstMatch
              ? (firstMatch.via === 'merchant_date_amount'
                ? `matched_existing_transaction:${firstMatch.id}`
                : `${evidence.state}_match:${firstMatch.kind}:${firstMatch.id}`)
              : null,
            duplicateState: evidence.state,
            duplicateMatches: evidence.matches,
            eventKey: eventKeys[index],
            eventOrdinal: eventOrdinals[index],
          },
        });
      }

      const parsedRows = [];
      for (const { rowId, patch } of parsedPatches) {
        const persisted = await tx.updateImportedRow({
          householdId,
          rowId,
          patch,
        });
        parsedRows.push(formatImportRow(persisted));
      }

      assertImportBatchTransition({
        currentStatus: IMPORT_BATCH_STATUS.PARSING,
        nextStatus: IMPORT_BATCH_STATUS.REVIEW,
        action: 'parse',
      });

      await tx.updateImportBatch({
        householdId,
        batchId,
        status: IMPORT_BATCH_STATUS.REVIEW,
        rowCount: parsedRows.length,
      });

      return {
        batchId,
        rows: parsedRows,
      };
    });
  } catch (error) {
    if (!(error instanceof ImportHttpError)) {
      throw error;
    }

    await db.transaction(async (tx) => {
      const batch = await tx.getImportBatch({ householdId, batchId });
      if (!batch) {
        return;
      }

      const currentStatus = String(batch.status ?? '').trim().toLowerCase();
      if (!['approved', 'failed'].includes(currentStatus)) {
        await tx.updateImportBatch({
          householdId,
          batchId,
          status: IMPORT_BATCH_STATUS.FAILED,
        });
      }
    }).catch(() => {});

    throw error;
  }
}
