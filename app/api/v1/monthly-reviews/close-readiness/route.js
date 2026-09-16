import { json, getHouseholdId, getDb } from '../../_shared/http.js';
import { getCloseReadiness, MonthlyReviewHttpError } from '../../../../../lib/monthlyReviews/monthlyLifecycle.js';

export async function GET(request, context = {}) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period');
    if (!period) {
      return json({ error: 'period query parameter is required' }, 400);
    }
    const result = await getCloseReadiness({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      period,
    });
    return json(result, 200);
  } catch (error) {
    if (error instanceof MonthlyReviewHttpError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: 'Internal Server Error' }, 500);
  }
}
