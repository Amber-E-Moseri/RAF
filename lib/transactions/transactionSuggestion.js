import { resolveSuggestion } from '../imports/reviewImportedTransactions.js';
import { TransactionHttpError } from './createTransaction.js';

export async function getTransactionSuggestion({ db, householdId, transactionId }) {
  if (!householdId) throw new TransactionHttpError(400, 'householdId is required');
  if (!transactionId) throw new TransactionHttpError(400, 'transactionId is required');

  return db.transaction(async (tx) => {
    const transaction = await tx.getTransactionById({ householdId, transactionId });
    if (!transaction) throw new TransactionHttpError(404, 'Transaction not found');

    const suggestion = await resolveSuggestion(tx, householdId, {
      description: transaction.description,
      rawDescription: transaction.merchant ?? transaction.description,
    });

    return { suggestion };
  });
}
