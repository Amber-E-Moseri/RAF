import { getIncomeResilience } from '../../../../../lib/intelligence/intelligenceService.js';
import { json } from '../../../_shared/http.js';

export async function GET(_request, _context = {}) {
  // Phase 7 is BLOCKED pending product-semantic approval.
  // Returns the sentinel immediately; no DB access required.
  const result = await getIncomeResilience();
  return json(result, 200);
}
