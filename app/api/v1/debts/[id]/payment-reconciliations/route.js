import {
  ReconciliationError,
  confirmDebtPaymentReconciliation,
  rejectDebtPaymentReconciliation,
  listDebtPaymentReconciliations,
} from '../../../../../../lib/debts/debtPaymentReconciliation.js';

function json(body, status) {
  return Response.json(body, { status });
}

function getHouseholdId(request, context) {
  return (
    context?.householdId ??
    request.headers.get('x-household-id') ??
    request.headers.get('x-household_id')
  );
}

function getDb(context) {
  return context?.db ?? globalThis.__RAF_DB__;
}

export async function GET(request, context = {}) {
  try {
    const result = await listDebtPaymentReconciliations({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      debtId: context?.params?.id,
    });
    return json(result, 200);
  } catch (error) {
    if (error instanceof ReconciliationError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: 'Internal Server Error' }, 500);
  }
}

export async function POST(request, context = {}) {
  try {
    const input = await request.json();
    const { action, primaryPaymentId, duplicatePaymentId, matchType } = input;

    if (action === 'reject') {
      const result = await rejectDebtPaymentReconciliation({
        db: getDb(context),
        householdId: getHouseholdId(request, context),
        debtId: context?.params?.id,
        primaryPaymentId,
        duplicatePaymentId,
        matchType,
        userId: context?.user?.id ?? context?.userId ?? null,
      });
      return json(result, 200);
    }

    const result = await confirmDebtPaymentReconciliation({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      debtId: context?.params?.id,
      primaryPaymentId,
      duplicatePaymentId,
      matchType,
      userId: context?.user?.id ?? context?.userId ?? null,
    });
    return json(result, 200);
  } catch (error) {
    if (error instanceof ReconciliationError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: 'Internal Server Error' }, 500);
  }
}
