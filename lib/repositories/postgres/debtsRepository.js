import { clone, isoNow, uuid } from './utils.js';

export function buildDebtsRepository(client, schema) {
  return {
    async findDebtById({ householdId, debtId }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.debts
         WHERE workspace_id = $1 AND id = $2
         LIMIT 1`,
        [householdId, debtId],
      );
      return result.rows[0] ? clone(result.rows[0].raw_json) : null;
    },

    async insertDebt(payload) {
      const now = isoNow();
      const row = {
        id: uuid(),
        createdAt: now,
        updatedAt: now,
        ...payload,
        workspaceId: payload.workspaceId ?? payload.householdId,
        householdId: payload.householdId ?? payload.workspaceId,
      };
      await client.query(
        `INSERT INTO ${schema}.debts
         (id, workspace_id, financial_account_id, name, starting_balance, apr, minimum_payment, monthly_payment, sort_order, is_active, created_at, updated_at, raw_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [row.id, row.workspaceId, row.financialAccountId ?? null, row.name, row.startingBalance, row.apr ?? '0', row.minimumPayment ?? '0.00', row.monthlyPayment ?? '0.00', row.sortOrder ?? 0, row.isActive !== false, row.createdAt, row.updatedAt, row],
      );
      return clone(row);
    },

    async listDebts({ householdId }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.debts
         WHERE workspace_id = $1
         ORDER BY sort_order, id`,
        [householdId],
      );
      return result.rows.map((row) => clone(row.raw_json));
    },

    async getDebtById({ householdId, debtId }) {
      return this.findDebtById({ householdId, debtId });
    },

    async updateDebt({ householdId, debtId, patch }) {
      const existing = await this.getDebtById({ householdId, debtId });
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: isoNow() };
      await client.query(
        `UPDATE ${schema}.debts
         SET financial_account_id = $3, name = $4, starting_balance = $5, apr = $6, minimum_payment = $7, monthly_payment = $8, sort_order = $9, is_active = $10, updated_at = $11, raw_json = $12
         WHERE workspace_id = $1 AND id = $2`,
        [householdId, debtId, updated.financialAccountId ?? null, updated.name, updated.startingBalance, updated.apr ?? '0', updated.minimumPayment ?? '0.00', updated.monthlyPayment ?? '0.00', updated.sortOrder ?? 0, updated.isActive !== false, updated.updatedAt, updated],
      );
      return clone(updated);
    },

    async countDebtPaymentsForDebt({ householdId, debtId }) {
      const result = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM ${schema}.debt_payments
         WHERE workspace_id = $1 AND debt_id = $2`,
        [householdId, debtId],
      );
      return result.rows[0]?.cnt ?? 0;
    },

    async deleteDebt({ householdId, debtId }) {
      await client.query(
        `DELETE FROM ${schema}.debts WHERE workspace_id = $1 AND id = $2`,
        [householdId, debtId],
      );
    },

    async listDebtPayments({ householdId, debtId = null, from = null, to = null }) {
      const params = [householdId];
      const filters = ['workspace_id = $1'];

      if (debtId) {
        params.push(debtId);
        filters.push(`debt_id = $${params.length}`);
      }
      if (from && to) {
        params.push(from, to);
        filters.push(`payment_date >= $${params.length - 1}`, `payment_date <= $${params.length}`);
      }

      const result = await client.query(
        `SELECT raw_json FROM ${schema}.debt_payments
         WHERE ${filters.join(' AND ')}
         ORDER BY payment_date, id`,
        params,
      );
      return result.rows.map((row) => clone(row.raw_json));
    },

    async insertDebtAdjustment(payload) {
      const row = {
        id: uuid(),
        createdAt: isoNow(),
        ...payload,
        workspaceId: payload.workspaceId ?? payload.householdId,
        householdId: payload.householdId ?? payload.workspaceId,
      };
      await client.query(
        `INSERT INTO ${schema}.debt_adjustments
         (id, workspace_id, debt_id, amount, adjustment_type, effective_date, note, created_at, raw_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [row.id, row.workspaceId, row.debtId, row.amount, row.adjustmentType, row.effectiveDate, row.note ?? null, row.createdAt, row],
      );
      return clone(row);
    },

    async listDebtAdjustments({ householdId, debtId = null }) {
      const params = [householdId];
      const filters = ['workspace_id = $1'];

      if (debtId) {
        params.push(debtId);
        filters.push(`debt_id = $${params.length}`);
      }

      const result = await client.query(
        `SELECT raw_json FROM ${schema}.debt_adjustments
         WHERE ${filters.join(' AND ')}
         ORDER BY effective_date, id`,
        params,
      );
      return result.rows.map((row) => clone(row.raw_json));
    },

    async insertPaymentPaceAcknowledgement({ householdId, debtId, paymentPeriodMonth, action }) {
      const now = isoNow();
      const row = {
        id: uuid(),
        workspaceId: householdId,
        householdId,
        debtId,
        paymentPeriodMonth,
        action,
        acknowledgementDate: now,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `INSERT INTO ${schema}.debt_payment_pace_acknowledgements
         (id, workspace_id, debt_id, payment_period_month, action, acknowledgement_date, raw_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workspace_id, debt_id, payment_period_month, action)
         DO UPDATE SET acknowledgement_date = EXCLUDED.acknowledgement_date, raw_json = EXCLUDED.raw_json`,
        [row.id, householdId, debtId, paymentPeriodMonth, action, now, row],
      );
      return clone(row);
    },

    async getPaymentPaceAcknowledgement({ householdId, debtId, paymentPeriodMonth }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.debt_payment_pace_acknowledgements
         WHERE workspace_id = $1 AND debt_id = $2 AND payment_period_month = $3
         ORDER BY acknowledgement_date DESC, id DESC
         LIMIT 1`,
        [householdId, debtId, paymentPeriodMonth],
      );
      return result.rows[0] ? clone(result.rows[0].raw_json) : null;
    },

    async insertDebtPaymentReconciliation({ householdId, primaryPaymentId, duplicatePaymentId, status, matchType, confirmedBy = null }) {
      const now = isoNow();
      const row = {
        id: uuid(),
        workspaceId: householdId,
        householdId,
        primaryPaymentId,
        duplicatePaymentId,
        status,
        matchType,
        confirmedAt: status === 'confirmed' ? now : null,
        confirmedBy,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `INSERT INTO ${schema}.debt_payment_reconciliations
         (id, workspace_id, primary_payment_id, duplicate_payment_id, status, match_type, confirmed_at, confirmed_by, created_at, updated_at, raw_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [row.id, householdId, primaryPaymentId, duplicatePaymentId, status, matchType, row.confirmedAt, confirmedBy, now, now, row],
      );
      return clone(row);
    },

    async getDebtPaymentReconciliation({ householdId, primaryPaymentId, duplicatePaymentId }) {
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.debt_payment_reconciliations
         WHERE workspace_id = $1
           AND (
             (primary_payment_id = $2 AND duplicate_payment_id = $3)
             OR (primary_payment_id = $3 AND duplicate_payment_id = $2)
           )
         LIMIT 1`,
        [householdId, primaryPaymentId, duplicatePaymentId],
      );
      return result.rows[0] ? clone(result.rows[0].raw_json) : null;
    },

    async listDebtPaymentReconciliations({ householdId, debtId = null }) {
      if (debtId) {
        const result = await client.query(
          `SELECT r.raw_json
           FROM ${schema}.debt_payment_reconciliations r
           JOIN ${schema}.debt_payments p
             ON p.workspace_id = r.workspace_id
             AND (p.id = r.primary_payment_id OR p.id = r.duplicate_payment_id)
           WHERE r.workspace_id = $1
             AND p.debt_id = $2
           GROUP BY r.id, r.raw_json`,
          [householdId, debtId],
        );
        return result.rows.map((row) => clone(row.raw_json));
      }
      const result = await client.query(
        `SELECT raw_json FROM ${schema}.debt_payment_reconciliations
         WHERE workspace_id = $1
         ORDER BY created_at`,
        [householdId],
      );
      return result.rows.map((row) => clone(row.raw_json));
    },
  };
}
