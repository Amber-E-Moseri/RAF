import { clone, isoNow, uuid } from './utils.js';

function mapClaimRow(row) {
  return {
    id: row.id,
    accountId: row.account_id ?? null,
    eventKey: row.event_key,
    eventOrdinal: row.event_ordinal,
    transactionId: row.transaction_id ?? null,
    incomeEntryId: row.income_entry_id ?? null,
    claimType: row.claim_type,
    source: row.source,
    importBatchId: row.import_batch_id ?? null,
    importedTransactionId: row.imported_transaction_id ?? null,
  };
}

export function buildImportsRepository(client, schema) {
  return {
    // Batch operations
    async getImportBatchByFileHash({ householdId, fileHash }) {
      if (!fileHash) return null;
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.import_batches
         WHERE workspace_id = $1 AND file_hash = $2 LIMIT 1`,
        [householdId, fileHash],
      );
      return result.rows[0] ? clone(result.rows[0].raw_json) : null;
    },

    async insertImportBatch(payload) {
      const now = isoNow();
      const row = {
        id: payload.id ?? uuid(),
        createdAt: now,
        updatedAt: now,
        workspaceId: payload.workspaceId ?? payload.householdId,
        householdId: payload.householdId ?? payload.workspaceId,
        ...payload,
      };
      await client.query(
        `INSERT INTO ${schema}.import_batches (id, workspace_id, file_hash, raw_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, row.workspaceId, row.fileHash ?? null, row, now, now],
      );
      return clone(row);
    },

    async insertImportedTransactions({ rows, householdId }) {
      const now = isoNow();
      const inserted = rows.map((row) => {
        const resolvedHouseholdId = householdId ?? row.householdId;
        return {
          id: uuid(),
          createdAt: now,
          updatedAt: now,
          normalizedDescription: row.normalizedDescription ?? null,
          linkedIncomeEntryId: row.linkedIncomeEntryId ?? null,
          linkedGoalId: row.linkedGoalId ?? null,
          ...row,
          workspaceId: resolvedHouseholdId,
          householdId: resolvedHouseholdId,
        };
      });
      for (const row of inserted) {
        await client.query(
          `INSERT INTO ${schema}.imported_transactions
             (id, workspace_id, date, amount, description, status, raw_json, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            row.id,
            row.householdId,
            row.date,
            row.amount,
            row.description,
            row.status ?? 'unreviewed',
            row,
            row.createdAt,
            row.updatedAt,
          ],
        );
      }
      return clone(inserted);
    },

    async insertImportedRows({ rows, householdId }) {
      const now = isoNow();
      const inserted = rows.map((row) => ({
        id: uuid(),
        createdAt: now,
        workspaceId: householdId,
        householdId,
        ...row,
      }));
      for (const row of inserted) {
        await client.query(
          `INSERT INTO ${schema}.imported_transaction_rows (id, workspace_id, batch_id, raw_json, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.id, row.workspaceId, row.batchId, row, row.createdAt],
        );
      }
      return clone(inserted);
    },

    // Import review rules - maintained at compatibility layer for semantic matching
    // These methods require complex sorting and matching logic best implemented in-memory
    async listImportReviewRules({ householdId }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.import_review_rules
         WHERE workspace_id = $1`,
        [householdId],
      );
      const rows = result.rows.map((row) => clone(row.raw_json)).filter(Boolean);
      rows.sort((left, right) => {
        const compareValues = (a, b) => {
          if (a < b) return -1;
          if (a > b) return 1;
          return 0;
        };
        return compareValues(right.updatedAt ?? right.createdAt, left.updatedAt ?? left.createdAt)
          || compareValues(left.matchValue ?? left.normalizedDescription, right.matchValue ?? right.normalizedDescription)
          || compareValues(left.id, right.id);
      });
      return rows;
    },

    async getImportReviewRuleById({ householdId, ruleId }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.import_review_rules
         WHERE workspace_id = $1 AND id = $2
         LIMIT 1`,
        [householdId, ruleId],
      );
      return result.rows[0] ? clone(result.rows[0].raw_json) : null;
    },

    async findImportReviewRuleByMerchantKey({ householdId, normalizedMerchant }) {
      if (!normalizedMerchant) return null;
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.import_review_rules
         WHERE workspace_id = $1`,
        [householdId],
      );
      const rows = result.rows.map((row) => clone(row.raw_json)).filter(Boolean);
      const matches = rows
        .filter((row) => {
          const key = String(row.normalizedMerchant ?? '').trim();
          return key && key === normalizedMerchant;
        })
        .sort((left, right) =>
          Number(right.autoApply === true) - Number(left.autoApply === true)
          || (right.confirmationCount ?? 1) - (left.confirmationCount ?? 1)
          || (new Date(right.updatedAt ?? right.createdAt).getTime() - new Date(left.updatedAt ?? left.createdAt).getTime()));
      return matches[0] ?? null;
    },

    async findImportReviewRuleByNormalizedDescription({ householdId, normalizedDescription }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.import_review_rules
         WHERE workspace_id = $1`,
        [householdId],
      );
      const rows = result.rows.map((row) => clone(row.raw_json)).filter(Boolean);
      const matches = rows
        .filter((row) => {
          const matchType = row.matchType ?? 'contains';
          const matchValue = String(row.matchValue ?? row.normalizedDescription ?? '').trim();
          if (!matchValue) return false;
          if (matchType === 'contains') {
            return normalizedDescription.includes(matchValue);
          }
          return normalizedDescription === matchValue;
        })
        .sort((left, right) =>
          Number(right.autoApply === true) - Number(left.autoApply === true)
          || String(right.matchValue ?? right.normalizedDescription ?? '').length - String(left.matchValue ?? left.normalizedDescription ?? '').length
          || (new Date(right.updatedAt ?? right.createdAt).getTime() - new Date(left.updatedAt ?? left.createdAt).getTime()));
      return matches[0] ?? null;
    },

    async upsertImportReviewRule(payload) {
      const now = isoNow();
      const existing = await this.findImportReviewRuleByNormalizedDescription({
        householdId: payload.householdId ?? payload.workspaceId,
        normalizedDescription: payload.matchValue ?? payload.normalizedDescription ?? ''
      });

      const row = {
        id: payload.id ?? uuid(),
        createdAt: payload.createdAt ?? now,
        updatedAt: now,
        workspaceId: payload.workspaceId ?? payload.householdId,
        householdId: payload.householdId ?? payload.workspaceId,
        ...payload,
      };

      if (existing && existing.householdId === row.householdId) {
        const matchTypeMatch = (existing.matchType ?? 'contains') === (payload.matchType ?? 'contains');
        const matchValueMatch = String(existing.matchValue ?? existing.normalizedDescription ?? '') === String(payload.matchValue ?? payload.normalizedDescription ?? '');

        if (matchTypeMatch && matchValueMatch) {
          const isSameCategory = existing.categoryId === (payload.categoryId ?? null)
            && existing.classificationType === payload.classificationType;
          const confirmationCount = isSameCategory
            ? (existing.confirmationCount ?? 1) + 1
            : existing.confirmationCount ?? 1;
          const correctionCount = isSameCategory
            ? existing.correctionCount ?? 0
            : (existing.correctionCount ?? 0) + 1;

          row.id = existing.id;
          row.createdAt = existing.createdAt;
          row.confirmationCount = confirmationCount;
          row.correctionCount = correctionCount;
        }
      }

      // match_value is NOT NULL (no default); the indexed columns must be written with raw_json.
      await client.query(
        `INSERT INTO ${schema}.import_review_rules
           (id, workspace_id, rule_type, match_value, auto_apply, normalized_merchant,
            confirmation_count, correction_count, raw_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           rule_type = EXCLUDED.rule_type,
           match_value = EXCLUDED.match_value,
           auto_apply = EXCLUDED.auto_apply,
           normalized_merchant = EXCLUDED.normalized_merchant,
           confirmation_count = EXCLUDED.confirmation_count,
           correction_count = EXCLUDED.correction_count,
           raw_json = EXCLUDED.raw_json,
           updated_at = EXCLUDED.updated_at`,
        [
          row.id,
          row.workspaceId,
          row.ruleType ?? 'suggestion',
          String(row.matchValue ?? row.normalizedDescription ?? ''),
          row.autoApply === true,
          row.normalizedMerchant ?? null,
          row.confirmationCount ?? 1,
          row.correctionCount ?? 0,
          row,
          row.createdAt,
          row.updatedAt,
        ],
      );
      return clone(row);
    },

    async touchImportReviewRule({ householdId, ruleId, usedAt = isoNow() }) {
      const now = isoNow();
      const existing = await this.getImportReviewRuleById({ householdId, ruleId });
      if (!existing) return null;
      const updated = { ...existing, lastUsedAt: usedAt, updatedAt: now };
      await client.query(
        `UPDATE ${schema}.import_review_rules
         SET raw_json = $1, updated_at = $2
         WHERE workspace_id = $3 AND id = $4`,
        [updated, now, householdId, ruleId],
      );
      return clone(updated);
    },

    async updateImportReviewRule({ householdId, ruleId, patch }) {
      const existing = await this.getImportReviewRuleById({ householdId, ruleId });
      if (!existing) return null;
      const now = isoNow();
      const updated = { ...existing, ...patch, updatedAt: now };
      await client.query(
        `UPDATE ${schema}.import_review_rules
         SET raw_json = $1, updated_at = $2
         WHERE workspace_id = $3 AND id = $4`,
        [updated, now, householdId, ruleId],
      );
      return clone(updated);
    },

    async deleteImportReviewRule({ householdId, ruleId }) {
      const result = await client.query(
        `DELETE FROM ${schema}.import_review_rules
         WHERE workspace_id = $1 AND id = $2
         RETURNING id`,
        [householdId, ruleId],
      );
      return result.rows.length > 0;
    },

    // forUpdate serializes concurrent reviews of the same staged row: the second caller
    // blocks until the first commits, then sees status 'classified'.
    async getImportedTransactionById({ householdId, importedTransactionId, forUpdate = false }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.imported_transactions
         WHERE workspace_id = $1 AND id = $2
         LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
        [householdId, importedTransactionId],
      );
      return result.rows[0] ? clone(result.rows[0].raw_json) : null;
    },

    // One lock per workspace for the whole transaction: resolving imported events (classify or
    // CSV approve) is human-paced, so serializing it is cheap, and a single lock cannot exhaust
    // the lock table on large batches the way one lock per row could.
    async lockImportIdentity({ householdId }) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        ['import-identity:' + householdId],
      );
    },

    async findImportEventClaims({ householdId, eventKey, eventOrdinal }) {
      const result = await client.query(
        `SELECT id, account_id, event_key, event_ordinal, transaction_id, income_entry_id,
                claim_type, source, import_batch_id, imported_transaction_id
         FROM ${schema}.import_event_claims
         WHERE workspace_id = $1 AND event_key = $2 AND event_ordinal = $3`,
        [householdId, eventKey, eventOrdinal],
      );
      return result.rows.map(mapClaimRow);
    },

    // onConflictDoNothing is for reconciliation claims, which are best-effort metadata.
    // Claims for newly created records must conflict loudly (23505) so the whole
    // classification rolls back.
    async insertImportEventClaim({
      householdId,
      accountId = null,
      eventKey,
      eventOrdinal,
      transactionId = null,
      incomeEntryId = null,
      claimType,
      source,
      importBatchId = null,
      importedTransactionId = null,
      onConflictDoNothing = false,
    }) {
      const result = await client.query(
        `INSERT INTO ${schema}.import_event_claims
           (workspace_id, account_id, event_key, event_ordinal, transaction_id, income_entry_id,
            claim_type, source, import_batch_id, imported_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ${onConflictDoNothing ? 'ON CONFLICT DO NOTHING' : ''}
         RETURNING id`,
        [householdId, accountId, eventKey, eventOrdinal, transactionId, incomeEntryId,
          claimType, source, importBatchId, importedTransactionId],
      );
      return result.rows[0] ? { id: result.rows[0].id } : null;
    },

    async deleteImportEventClaimsForImportedTransaction({ householdId, importedTransactionId }) {
      await client.query(
        `DELETE FROM ${schema}.import_event_claims
         WHERE workspace_id = $1 AND imported_transaction_id = $2`,
        [householdId, importedTransactionId],
      );
    },

    async findLikelyDuplicateTransactions({ householdId, accountId = null, date, amount, direction, excludeImportBatchId = null }) {
      const result = await client.query(
        `SELECT t.id, t.transaction_date, t.amount, t.direction, t.description, t.source, t.account_id
         FROM ${schema}.transactions t
         WHERE t.workspace_id = $1
           AND t.transaction_date = $2
           AND t.amount = $3::numeric
           AND t.direction = $4
           AND ($5::uuid IS NULL OR t.account_id IS NULL OR t.account_id = $5::uuid)
           AND ($6::uuid IS NULL OR t.import_batch_id IS DISTINCT FROM $6::uuid)
           AND NOT EXISTS (
             SELECT 1 FROM ${schema}.import_event_claims c
             WHERE c.workspace_id = t.workspace_id
               AND c.transaction_id = t.id
               AND $6::uuid IS NOT NULL
               AND c.import_batch_id = $6::uuid
           )
         ORDER BY t.created_at, t.id
         LIMIT 5`,
        [householdId, date, amount, direction, accountId, excludeImportBatchId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        transactionDate: typeof row.transaction_date === 'string'
          ? row.transaction_date
          : row.transaction_date.toISOString().slice(0, 10),
        amount: String(row.amount),
        direction: row.direction,
        description: row.description,
        source: row.source,
        accountId: row.account_id ?? null,
      }));
    },

    async findLikelyDuplicateIncomeEntries({ householdId, date, amount, excludeImportBatchId = null }) {
      const result = await client.query(
        `SELECT i.id, i.received_date, i.amount, i.source_name
         FROM ${schema}.income_entries i
         WHERE i.workspace_id = $1
           AND i.received_date = $2
           AND i.amount = $3::numeric
           AND NOT EXISTS (
             SELECT 1 FROM ${schema}.import_event_claims c
             WHERE c.workspace_id = i.workspace_id
               AND c.income_entry_id = i.id
               AND $4::uuid IS NOT NULL
               AND c.import_batch_id = $4::uuid
           )
         ORDER BY i.created_at, i.id
         LIMIT 5`,
        [householdId, date, amount, excludeImportBatchId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        receivedDate: typeof row.received_date === 'string'
          ? row.received_date
          : row.received_date.toISOString().slice(0, 10),
        amount: String(row.amount),
        sourceName: row.source_name,
      }));
    },

    async listMerchantRules({ householdId }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.merchant_rules
         WHERE workspace_id = $1
         ORDER BY created_at NULLS FIRST, id`,
        [householdId],
      );
      return result.rows.map((row) => clone(row.raw_json)).filter(Boolean);
    },

    async findDuplicateTransaction({ householdId, parsedDate, parsedAmount, normalizedMerchant }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.transactions
         WHERE workspace_id = $1
           AND transaction_date = $2
           AND raw_json->>'amount' = $3
           AND trim(lower(regexp_replace(COALESCE(merchant, ''), '[[:space:]]+', ' ', 'g'))) = $4
         ORDER BY created_at NULLS FIRST, id
         LIMIT 1`,
        [householdId, parsedDate, parsedAmount, String(normalizedMerchant ?? '')],
      );
      return result.rows[0] ? clone(result.rows[0].raw_json) : null;
    },

    // Merchant rules
    async insertMerchantRule(payload) {
      const now = isoNow();
      const row = {
        id: uuid(),
        createdAt: now,
        updatedAt: now,
        workspaceId: payload.workspaceId ?? payload.householdId,
        householdId: payload.householdId ?? payload.workspaceId,
        ...payload,
      };
      await client.query(
        `INSERT INTO ${schema}.merchant_rules (id, workspace_id, raw_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.id, row.workspaceId, row, row.createdAt, row.updatedAt],
      );
      return clone(row);
    },

    async updateMerchantRule({ householdId, ruleId, patch }) {
      const existing = await this.getMerchantRuleById({ householdId, ruleId });
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: isoNow() };
      await client.query(
        `UPDATE ${schema}.merchant_rules
         SET raw_json = $1, updated_at = $2
         WHERE workspace_id = $3 AND id = $4`,
        [updated, updated.updatedAt, householdId, ruleId],
      );
      return clone(updated);
    },

    async deleteMerchantRule({ householdId, ruleId }) {
      await client.query(
        `DELETE FROM ${schema}.merchant_rules
         WHERE workspace_id = $1 AND id = $2`,
        [householdId, ruleId],
      );
      return true;
    },

    async getMerchantRuleById({ householdId, ruleId }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.merchant_rules
         WHERE workspace_id = $1 AND id = $2
         LIMIT 1`,
        [householdId, ruleId],
      );
      return result.rows[0] ? clone(result.rows[0].raw_json) : null;
    },
  };
}
