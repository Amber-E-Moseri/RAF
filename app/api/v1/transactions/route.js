import { TransactionHttpError, createTransaction, listTransactions } from '../../../../lib/transactions/createTransaction.js';

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
    const transaction = await createTransaction({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      userId: context?.user?.id ?? context?.userId ?? null,
      input,
    });

    return json(transaction, 201);
  } catch (error) {
    if (error instanceof TransactionHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}

export async function GET(request, context = {}) {
  try {
    const { searchParams } = new URL(request.url);
    const result = await listTransactions({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      query: {
        from: searchParams.get('from'),
        to: searchParams.get('to'),
        categoryId: searchParams.get('categoryId'),
        categorySlug: searchParams.get('categorySlug'),
        direction: searchParams.get('direction'),
        reviewed: searchParams.get('reviewed'),
        cursor: searchParams.get('cursor'),
        limit: searchParams.get('limit'),
      },
    });

    return json(result, 200);
  } catch (error) {
    if (error instanceof TransactionHttpError) {
      return json({ error: error.message }, error.status);
    }

    return json({ error: 'Internal Server Error' }, 500);
  }
}
