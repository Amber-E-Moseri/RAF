import { FinancialAttentionError, buildFinancialAttention } from '../../../../lib/raf/financialAttention.js';
import { getDb, getHouseholdId, json, respondWithHandledError } from '../_shared/http.js';

export async function GET(request, context = {}) {
  try {
    const result = await buildFinancialAttention({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
    });
    return json(result, 200);
  } catch (error) {
    return respondWithHandledError(error, FinancialAttentionError);
  }
}
