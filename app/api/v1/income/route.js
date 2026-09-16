import { IncomeHttpError, createIncome, listIncome } from '../../../../lib/income/createIncome.js';

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
    const result = await createIncome({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      userId: context?.user?.id ?? context?.userId ?? null,
      input,
      idempotencyKey: request.headers.get('Idempotency-Key'),
    });

    return json(
      {
        incomeId: result.incomeId,
        allocations: result.allocations,
      },
      result.created ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof IncomeHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}

export async function GET(request, context = {}) {
  try {
    const { searchParams } = new URL(request.url);
    const result = await listIncome({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      query: {
        from: searchParams.get('from'),
        to: searchParams.get('to'),
      },
    });

    return json(result, 200);
  } catch (error) {
    if (error instanceof IncomeHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}
