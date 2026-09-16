import { DebtHttpError, deleteDebt, getDebt, updateDebt } from '../../../../../lib/debts/debts.js';

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
    const result = await getDebt({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      debtId: context?.params?.id,
    });

    return json(result, 200);
  } catch (error) {
    if (error instanceof DebtHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}

export async function PATCH(request, context = {}) {
  try {
    const input = await request.json();
    const result = await updateDebt({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      debtId: context?.params?.id,
      input,
    });

    return json(result, 200);
  } catch (error) {
    if (error instanceof DebtHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}

export async function DELETE(request, context = {}) {
  try {
    await deleteDebt({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      debtId: context?.params?.id,
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof DebtHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}
