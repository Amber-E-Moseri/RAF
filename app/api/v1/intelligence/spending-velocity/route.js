import { IntelligenceHttpError, getSpendingVelocity } from '../../../../../lib/intelligence/intelligenceService.js';
import { getDb, getHouseholdId, json, respondWithHandledError } from '../../_shared/http.js';

const ISO_DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

function isValidIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function GET(request, context = {}) {
  try {
    const { searchParams } = new URL(request.url);
    const isoMonth = searchParams.get('isoMonth');
    const today = searchParams.get('today');

    if (isoMonth && !isValidIsoDate(isoMonth)) {
      throw new IntelligenceHttpError(400, 'isoMonth must be a valid ISO date (YYYY-MM-DD)');
    }
    if (today && !isValidIsoDate(today)) {
      throw new IntelligenceHttpError(400, 'today must be a valid ISO date (YYYY-MM-DD)');
    }

    const result = await getSpendingVelocity({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      isoMonth,
      today,
    });
    return json(result, 200);
  } catch (error) {
    return respondWithHandledError(error, IntelligenceHttpError);
  }
}
