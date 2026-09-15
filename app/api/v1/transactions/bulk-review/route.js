import { TransactionReviewError, bulkMarkTransactionsReviewed } from '../../../../../lib/transactions/transactionReview.js';
import { json, getHouseholdId, getDb, respondWithHandledError, readJsonBody, buildErrorBody } from '../../_shared/http.js';

// POST /transactions/bulk-review
// Body: { transactionIds: string[] }  — max 50; workspace and actor come from trusted context only
export async function POST(request, context = {}) {
  let body;
  try {
    body = await readJsonBody(request, () => new TransactionReviewError(400, 'Invalid JSON body'));
  } catch (error) {
    return respondWithHandledError(error, TransactionReviewError);
  }

  const transactionIds = body?.transactionIds;
  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    return json(buildErrorBody({ status: 400, message: 'transactionIds must be a non-empty array' }), 400);
  }

  try {
    const result = await bulkMarkTransactionsReviewed({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      transactionIds,
      userId: context?.user?.id ?? context?.userId ?? null,
    });
    return json(result, 200);
  } catch (error) {
    return respondWithHandledError(error, TransactionReviewError);
  }
}
