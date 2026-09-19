import { clone, isoNow, uuid } from './utils.js';

export function buildImportsRepository(client, schema) {
  return {
    // Batch operations
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
        `INSERT INTO ${schema}.import_batches (id, workspace_id, raw_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.id, row.workspaceId, row, now, now],
      );
      return clone(row);
    },

    async insertImportedTransactions({ rows, householdId }) {
      const now = isoNow();
      const inserted = rows.map((row) => ({
        id: uuid(),
        createdAt: now,
        updatedAt: now,
        workspaceId: householdId,
        householdId,
        normalizedDescription: row.normalizedDescription ?? null,
        linkedIncomeEntryId: row.linkedIncomeEntryId ?? null,
        linkedGoalId: row.linkedGoalId ?? null,
        ...row,
      }));
      for (const row of inserted) {
        await client.query(
          `INSERT INTO ${schema}.imported_transactions (id, workspace_id, batch_id, raw_json, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.id, row.workspaceId, row.batchId, row, row.createdAt, row.updatedAt],
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

      await client.query(
        `INSERT INTO ${schema}.import_review_rules (id, workspace_id, raw_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
         raw_json = EXCLUDED.raw_json, updated_at = EXCLUDED.updated_at`,
        [row.id, row.workspaceId, row, row.createdAt, row.updatedAt],
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

    async getImportedTransactionById({ householdId, importedTransactionId }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.imported_transactions
         WHERE workspace_id = $1 AND id = $2
         LIMIT 1`,
        [householdId, importedTransactionId],
      );
      return result.rows[0] ? clone(result.rows[0].raw_json) : null;
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
