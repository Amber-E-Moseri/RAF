import { DebtHttpError, linkDebtToFinancialAccount } from '../../../../../../lib/debts/debts.js';

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

export async function POST(request, context = {}) {
  try {
    const input = await request.json();
    const financialAccountId = input?.financialAccountId ?? input?.financial_account_id;
    if (!financialAccountId) {
      return json({ error: 'financialAccountId is required' }, 400);
    }

    const result = await linkDebtToFinancialAccount({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      debtId: context?.params?.id,
      financialAccountId,
    });

    return json(result, 200);
  } catch (error) {
    if (error instanceof DebtHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}
