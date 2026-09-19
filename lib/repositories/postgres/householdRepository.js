import { clone, isoNow } from './utils.js';

export function buildHouseholdRepository(client, schema) {
  return {
    async updateHousehold({ householdId, patch }) {
      const existing = await client.query(
        `SELECT raw_json FROM ${schema}.households WHERE workspace_id = $1 LIMIT 1`,
        [householdId],
      );
      const row = existing.rows[0]?.raw_json ?? null;
      if (!row) return null;

      const now = isoNow();
      const updated = { ...row, ...patch, updatedAt: now };

      await client.query(
        `UPDATE ${schema}.households
         SET timezone = $2,
             active_month = $3,
             period_start_day = $4,
             savings_floor = $5,
             savings_floor_enabled = $6,
             monthly_essentials_baseline = $7,
             updated_at = $8,
             raw_json = $9
         WHERE workspace_id = $1`,
        [
          householdId,
          updated.timezone ?? 'America/Toronto',
          updated.activeMonth ?? null,
          updated.periodStartDay ?? 1,
          updated.savingsFloor ?? '0.00',
          updated.savingsFloorEnabled === true,
          updated.monthlyEssentialsBaseline ?? '0.00',
          now,
          updated,
        ],
      );

      return clone(updated);
    },
  };
}
