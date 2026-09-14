import { DebtHttpError, unlinkDebtFromFinancialAccount } from '../../../../../../lib/debts/debts.js';

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
    const confirmedManualBalance = input?.confirmedManualBalance ?? input?.confirmed_manual_balance;
    if (!confirmedManualBalance) {
      return json({ error: 'confirmedManualBalance is required to safely unlink a debt from its financial account' }, 400);
    }

    const result = await unlinkDebtFromFinancialAccount({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      debtId: context?.params?.id,
      confirmedManualBalance,
    });

    return json(result, 200);
  } catch (error) {
    if (error instanceof DebtHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}
