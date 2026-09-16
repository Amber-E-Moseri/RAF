import { json, getHouseholdId, getDb } from '../../_shared/http.js';
import { reopenMonth, MonthlyReviewHttpError } from '../../../../../lib/monthlyReviews/monthlyLifecycle.js';

const REOPEN_ROLES = new Set(['owner', 'admin']);

function getUserId(context) {
  return context?.userId ?? null;
}

function getRole(context) {
  return context?.role ?? context?.workspaceRole ?? null;
}

export async function POST(request, context = {}) {
  try {
    const role = getRole(context);
    if (role && !REOPEN_ROLES.has(role)) {
      return json({ error: 'Insufficient permissions to reopen month.' }, 403);
    }
    const input = await request.json().catch(() => ({}));
    const { period, reason = null } = input ?? {};
    if (!period) {
      return json({ error: 'period is required' }, 400);
    }
    const result = await reopenMonth({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      period,
      userId: getUserId(context),
      reason,
    });
    return json(result, 200);
  } catch (error) {
    if (error instanceof MonthlyReviewHttpError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: 'Internal Server Error' }, 500);
  }
}
