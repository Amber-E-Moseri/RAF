import { getTransactionSuggestion } from '../../../../../../lib/transactions/transactionSuggestion.js';
import { TransactionHttpError } from '../../../../../../lib/transactions/createTransaction.js';
import { json, getHouseholdId, getDb, respondWithHandledError } from '../../../_shared/http.js';

// GET /transactions/:id/suggestion — read-only; returns matched categorization rule or null
export async function GET(request, context = {}) {
  try {
    const result = await getTransactionSuggestion({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      transactionId: context?.params?.id,
    });
    return json(result, 200);
  } catch (error) {
    return respondWithHandledError(error, TransactionHttpError);
  }
}
