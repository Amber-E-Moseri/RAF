import { json, getHouseholdId, getDb } from '../../_shared/http.js';
import { closeMonth, MonthlyReviewHttpError } from '../../../../../lib/monthlyReviews/monthlyLifecycle.js';

const CLOSE_ROLES = new Set(['owner', 'admin', 'member']);

function getUserId(context) {
  return context?.userId ?? null;
}

function getRole(context) {
  return context?.role ?? context?.workspaceRole ?? null;
}

export async function POST(request, context = {}) {
  try {
    const role = getRole(context);
    if (role && !CLOSE_ROLES.has(role)) {
      return json({ error: 'Insufficient permissions to close month.' }, 403);
    }
    const input = await request.json().catch(() => ({}));
    const { period, bufferDisposition = null } = input ?? {};
    if (!period) {
      return json({ error: 'period is required' }, 400);
    }
    const result = await closeMonth({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      period,
      userId: getUserId(context),
      bufferDispositionInput: bufferDisposition,
    });
    return json(result, 201);
  } catch (error) {
    if (error instanceof MonthlyReviewHttpError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: 'Internal Server Error' }, 500);
  }
}
