import { json, getHouseholdId, getDb } from '../../_shared/http.js';
import { applyBufferDisposition, MonthlyReviewHttpError } from '../../../../../lib/monthlyReviews/monthlyLifecycle.js';

function getUserId(context) {
  return context?.userId ?? null;
}

export async function POST(request, context = {}) {
  try {
    const input = await request.json().catch(() => ({}));
    const { period, disposition } = input ?? {};
    if (!period) {
      return json({ error: 'period is required' }, 400);
    }
    if (!disposition) {
      return json({ error: 'disposition is required' }, 400);
    }
    const result = await applyBufferDisposition({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      period,
      userId: getUserId(context),
      disposition,
    });
    return json(result, 200);
  } catch (error) {
    if (error instanceof MonthlyReviewHttpError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: 'Internal Server Error' }, 500);
  }
}
