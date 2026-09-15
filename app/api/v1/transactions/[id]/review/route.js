import { TransactionReviewError, markTransactionReviewed, markTransactionUnreviewed } from '../../../../../../lib/transactions/transactionReview.js';
import { json, getHouseholdId, getDb, respondWithHandledError } from '../../../_shared/http.js';

// POST /transactions/:id/review — mark reviewed; actor derived from trusted context only
export async function POST(request, context = {}) {
  try {
    const result = await markTransactionReviewed({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      transactionId: context?.params?.id,
      userId: context?.user?.id ?? context?.userId ?? null,
    });
    return json(result, 200);
  } catch (error) {
    return respondWithHandledError(error, TransactionReviewError);
  }
}

// DELETE /transactions/:id/review — undo review
export async function DELETE(request, context = {}) {
  try {
    const result = await markTransactionUnreviewed({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      transactionId: context?.params?.id,
    });
    return json(result, 200);
  } catch (error) {
    return respondWithHandledError(error, TransactionReviewError);
  }
}
