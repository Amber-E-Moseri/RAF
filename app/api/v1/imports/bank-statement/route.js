import { importBankStatement } from '../../../../../lib/imports/bankStatementImports.js';
import { ImportHttpError } from '../../../../../lib/imports/shared.js';
import { buildErrorBody, getDb, getHouseholdId, json } from '../../_shared/http.js';

export async function POST(request, context = {}) {
  try {
    let file = null;
    let accountId = request.headers.get('x-account-id') || null;
    const contentType = request.headers.get('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const uploaded = formData.get('file');
      if (!(uploaded instanceof File)) {
        throw new ImportHttpError(400, 'file is required');
      }
      file = uploaded;
      const formAccountId = formData.get('account_id') ?? formData.get('accountId');
      if (typeof formAccountId === 'string' && formAccountId.trim()) {
        accountId = formAccountId.trim();
      }
    } else {
      const buffer = new Uint8Array(await request.arrayBuffer());
      if (buffer.length === 0) {
        throw new ImportHttpError(400, 'file is required');
      }

      file = new File(
        [buffer],
        request.headers.get('x-filename') ?? 'bank-statement.pdf',
        { type: contentType || 'application/pdf' },
      );
    }

    const result = await importBankStatement({
      db: getDb(context),
      householdId: getHouseholdId(request, context),
      pdfTextExtractor: context?.pdfTextExtractor,
      input: {
        filename: file.name,
        contentType: file.type,
        pdfBuffer: new Uint8Array(await file.arrayBuffer()),
        accountId,
      },
    });

    return json(result, 201);
  } catch (error) {
    if (error instanceof ImportHttpError) {
      return json(
        {
          ...buildErrorBody({
            status: error.status,
            message: error.message,
            details: error.details,
          }),
          ...(error.details ? error.details : {}),
        },
        error.status,
      );
    }

    return json(buildErrorBody({ status: 500, message: 'Internal Server Error' }), 500);
  }
}
