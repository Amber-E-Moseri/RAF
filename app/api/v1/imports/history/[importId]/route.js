import { getImportHistoryDetail } from '../../../../../../lib/imports/importHistory.js';
import { ImportHttpError } from '../../../../../../lib/imports/shared.js';
import { getDb, getHouseholdId, json, respondWithHandledError } from '../../../_shared/http.js';

export async function GET(request, context = {}) {
  try {
    const result = await getImportHistoryDetail({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      importId: context?.params?.importId,
    });
    return json(result, 200);
  } catch (error) {
    return respondWithHandledError(error, ImportHttpError);
  }
}
