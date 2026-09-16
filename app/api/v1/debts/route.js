import { DebtHttpError, createDebt, listDebts } from '../../../../lib/debts/debts.js';

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
    const result = await createDebt({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      userId: context?.user?.id ?? context?.userId ?? null,
      input,
    });

    return json(result, 201);
  } catch (error) {
    if (error instanceof DebtHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}

export async function GET(request, context = {}) {
  try {
    const result = await listDebts({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
    });

    return json(result, 200);
  } catch (error) {
    if (error instanceof DebtHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}
