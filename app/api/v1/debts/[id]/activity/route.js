import { DebtHttpError, listDebtActivity } from '../../../../../../lib/debts/debts.js';

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
    const url = new URL(request.url);
    const month = url.searchParams.get('month') ?? null;
    const view = url.searchParams.get('view') ?? 'economic';

    const result = await listDebtActivity({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      debtId: context?.params?.id,
      month,
      view,
    });

    return json(result, 200);
  } catch (error) {
    if (error instanceof DebtHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}
