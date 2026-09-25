import { updateImportedRow } from '../../../../../../lib/imports/updateImportedRow.js';
import { ImportHttpError } from '../../../../../../lib/imports/shared.js';
import { getDb, getHouseholdId, json, respondWithHandledError } from '../../../_shared/http.js';

// Mark a duplicate candidate row as explicitly KEPT by user.
// This allows the row to be approved in the next batch approval,
// overriding the heuristic candidate detection.
export async function POST(request, context = {}) {
  try {
    const db = getDb(context);
    const householdId = getHouseholdId(request, context);
    const rowId = context?.params?.rowId;

    if (!householdId) {
      throw new ImportHttpError(400, 'householdId is required');
    }

    if (!rowId) {
      throw new ImportHttpError(400, 'rowId is required');
    }

    return db.transaction(async (tx) => {
      const row = await tx.getImportedRow({ householdId, rowId });
      if (!row) {
        throw new ImportHttpError(404, 'import row not found');
      }

      // Update raw_json to mark this as explicitly kept by user.
      const currentRawJson = row.raw_json ?? {};
      const updated = await tx.updateImportedRow({
        householdId,
        rowId,
        patch: {
          raw_json: {
            ...currentRawJson,
            isDuplicateCandidateKeep: true,
          },
        },
      });

      return json({
        id: updated.id,
        isDuplicateCandidateKeep: updated.raw_json?.isDuplicateCandidateKeep ?? false,
        isDuplicateCandidate: updated.raw_json?.isDuplicateCandidate ?? false,
      }, 200);
    });
  } catch (error) {
    return respondWithHandledError(error, ImportHttpError);
  }
}
