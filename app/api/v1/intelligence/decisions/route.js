import { IntelligenceHttpError, getFinancialDecisions } from '../../../../../lib/intelligence/intelligenceService.js';
import { getDb, getHouseholdId, json, respondWithHandledError } from '../../../_shared/http.js';

export async function GET(request, context = {}) {
  try {
    const { searchParams } = new URL(request.url);
    const result = await getFinancialDecisions({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      limit: searchParams.get('limit'),
    });
    return json(result, 200);
  } catch (error) {
    return respondWithHandledError(error, IntelligenceHttpError);
  }
}
