import { z } from 'zod';

export class TransactionHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TransactionHttpError';
    this.status = status;
  }
}

const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a valid ISO date')
  .transform((value, context) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a valid ISO date',
      });
      return z.NEVER;
    }

    return value;
  });

const moneySchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))
  .refine((value) => /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value), {
    message: 'must be a decimal with up to 2 places',
  })
  .transform((value) => {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    return `${negative ? '-' : ''}${whole}.${(fraction + '00').slice(0, 2)}`;
  })
  .refine((value) => value !== '0.00' && value !== '-0.00', {
    message: 'must not be 0',
  });

const directionSchema = z.enum(['debit', 'credit']);

const nullableTrimmedString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value == null) {
      return null;
    }

    const normalized = value.trim();
    return normalized || null;
  });

export const createTransactionSchema = z
  .object({
    transactionDate: isoDateSchema,
    description: z.string().trim().min(1, 'description is required'),
    merchant: nullableTrimmedString,
    amount: moneySchema,
    direction: directionSchema,
    categoryId: nullableTrimmedString,
    linkedDebtId: nullableTrimmedString,
    linkedGoalId: nullableTrimmedString,
  })
  .superRefine((value, context) => {
    const amountCents = parseMoneyToCents(value.amount);
    if (amountCents < 0 && value.direction !== 'credit') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'negative amounts are only allowed for credit transactions',
      });
    }

    if (value.linkedDebtId) {
      if (value.direction !== 'debit') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['linkedDebtId'],
          message: 'linkedDebtId requires a debit transaction',
        });
      }

      if (amountCents <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['linkedDebtId'],
          message: 'linkedDebtId requires a positive amount',
        });
      }
    }

    if (value.linkedGoalId && !value.categoryId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkedGoalId'],
        message: 'linkedGoalId requires a bucket',
      });
    }
  });

export const updateTransactionSchema = z
  .object({
    transactionDate: isoDateSchema.optional(),
    description: z.string().trim().min(1, 'description is required').optional(),
    merchant: z.union([z.string(), z.null()]).transform((value) => {
      if (value == null) {
        return null;
      }

      const normalized = value.trim();
      return normalized || null;
    }).optional(),
    amount: moneySchema.optional(),
    direction: directionSchema.optional(),
    categoryId: z.union([z.string(), z.null()]).transform((value) => {
      if (value == null) {
        return null;
      }

      const normalized = value.trim();
      return normalized || null;
    }).optional(),
    linkedDebtId: z.union([z.string(), z.null()]).transform((value) => {
      if (value == null) {
        return null;
      }

      const normalized = value.trim();
      return normalized || null;
    }).optional(),
    linkedGoalId: z.union([z.string(), z.null()]).transform((value) => {
      if (value == null) {
        return null;
      }

      const normalized = value.trim();
      return normalized || null;
    }).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
  });

const listTransactionsSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  categoryId: nullableTrimmedString,
  categorySlug: nullableTrimmedString,
  direction: z.union([directionSchema, z.null()]).optional().transform((value) => value ?? null),
  reviewed: z
    .union([z.string(), z.boolean(), z.null()])
    .optional()
    .transform((value) => {
      if (value == null || value === '') return null;
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return null;
    }),
  cursor: nullableTrimmedString,
  limit: z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((value) => {
      if (value == null || value === '') {
        return 50;
      }

      return typeof value === 'number' ? value : Number(value);
    })
    .refine((value) => Number.isInteger(value) && value > 0 && value <= 100, {
      message: 'must be an integer between 1 and 100',
    }),
});

function parseMoneyToCents(value) {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = '00'] = unsigned.split('.');
  const cents = Number(whole) * 100 + Number(fraction);
  return negative ? -cents : cents;
}

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Transaction DB adapter must implement transaction().');
  }
}

function parseWithSchema(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : 'request';
    throw new TransactionHttpError(400, `${path} ${issue.message}`);
  }

  return result.data;
}

function formatTransaction(transaction) {
  return {
    id: transaction.id,
    transactionDate: transaction.transactionDate,
    description: transaction.description,
    merchant: transaction.merchant ?? null,
    amount: transaction.amount,
    direction: transaction.direction,
    categoryId: transaction.categoryId ?? null,
    linkedDebtId: transaction.linkedDebtId ?? null,
    linkedGoalId: transaction.linkedGoalId ?? null,
    source: transaction.source ?? 'manual',
    reviewedAt: transaction.reviewedAt ?? null,
    reviewedBy: transaction.reviewedBy ?? null,
  };
}

async function ensureDebtExists(tx, householdId, linkedDebtId) {
  if (!linkedDebtId) {
    return null;
  }

  const debt = await tx.findDebtById({
    householdId,
    debtId: linkedDebtId,
  });

  if (!debt) {
    throw new TransactionHttpError(404, 'linked debt not found');
  }

  return debt;
}

async function ensureGoalExists(tx, householdId, linkedGoalId, categoryId) {
  if (!linkedGoalId) {
    return null;
  }

  const goal = await tx.getGoalById({
    householdId,
    goalId: linkedGoalId,
  });

  if (!goal || goal.active === false) {
    throw new TransactionHttpError(404, 'linked goal not found');
  }

  if (categoryId && goal.bucketId !== categoryId) {
    throw new TransactionHttpError(422, 'linked goal must match the selected bucket');
  }

  return goal;
}

async function syncDebtPayment({ tx, householdId, transaction }) {
  await tx.deleteDebtPaymentByTransactionId({
    householdId,
    transactionId: transaction.id,
  });

  if (!transaction.linkedDebtId) {
    return;
  }

  await tx.insertDebtPayment({
    householdId,
    debtId: transaction.linkedDebtId,
    transactionId: transaction.id,
    paymentDate: transaction.transactionDate,
    amount: transaction.amount,
  });
}

async function enforceSplitParentUpdateInvariant({ tx, householdId, transactionId, nextTransaction }) {
  if (typeof tx.listTransactionSplits !== 'function') {
    return;
  }

  const splits = await tx.listTransactionSplits({ householdId, transactionId });
  if (!Array.isArray(splits) || splits.length === 0) {
    return;
  }

  if (nextTransaction.direction !== 'debit') {
    throw new TransactionHttpError(409, 'Clear transaction splits before changing a split transaction to credit');
  }

  const splitTotalCents = splits.reduce((sum, split) => sum + parseMoneyToCents(split.amount), 0);
  const parentAmountCents = parseMoneyToCents(nextTransaction.amount);
  if (parentAmountCents !== splitTotalCents) {
    throw new TransactionHttpError(409, 'Split transaction amount must equal the current split total; clear or edit splits first');
  }
}

async function reopenImportedRowForDeletedTransaction({ tx, householdId, transactionId }) {
  if (typeof tx.listImportedTransactions !== 'function' || typeof tx.updateImportedTransaction !== 'function') {
    return;
  }

  const importedTransactions = await tx.listImportedTransactions({ householdId });
  const linkedImportedRow = importedTransactions.find((row) => row.linkedTransactionId === transactionId);
  if (!linkedImportedRow) {
    return;
  }

  await tx.updateImportedTransaction({
    householdId,
    importedTransactionId: linkedImportedRow.id,
    patch: {
      status: 'unreviewed',
      classificationType: null,
      linkedTransactionId: null,
      linkedDebtId: null,
      linkedFixedBillId: null,
      linkedGoalId: null,
      reviewedAt: null,
      reviewNote: null,
    },
  });
}

export async function createTransaction({ db, householdId, input }) {
  if (!householdId) {
    throw new TransactionHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedInput = parseWithSchema(createTransactionSchema, input);

  return db.transaction(async (tx) => {
    await ensureDebtExists(tx, householdId, parsedInput.linkedDebtId);
    await ensureGoalExists(tx, householdId, parsedInput.linkedGoalId, parsedInput.categoryId);

    const transaction = await tx.insertTransaction({
      householdId,
      transactionDate: parsedInput.transactionDate,
      description: parsedInput.description,
      merchant: parsedInput.merchant,
      amount: parsedInput.amount,
      direction: parsedInput.direction,
      categoryId: parsedInput.categoryId,
      linkedDebtId: parsedInput.linkedDebtId,
      linkedGoalId: parsedInput.linkedGoalId,
      source: 'manual',
    });

    await syncDebtPayment({
      tx,
      householdId,
      transaction: {
        ...transaction,
        ...parsedInput,
      },
    });

    return formatTransaction({
      ...transaction,
      ...parsedInput,
    });
  });
}

export async function listTransactions({ db, householdId, query }) {
  if (!householdId) {
    throw new TransactionHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedQuery = parseWithSchema(listTransactionsSchema, query);
  if (parsedQuery.from > parsedQuery.to) {
    throw new TransactionHttpError(400, 'from must be before or equal to to');
  }

  return db.transaction(async (tx) => {
    let categoryId = parsedQuery.categoryId;

    if (!categoryId && parsedQuery.categorySlug) {
      const categories = typeof tx.listAllocationCategories === 'function'
        ? await tx.listAllocationCategories({ householdId, includeSuperseded: true })
        : [];
      const categoryIdsForSlug = categories
        .filter((category) => category.slug === parsedQuery.categorySlug)
        .map((category) => category.id);

      const result = await tx.listTransactions({
        householdId,
        from: parsedQuery.from,
        to: parsedQuery.to,
        categoryId: null,
        categoryIds: categoryIdsForSlug,
        direction: parsedQuery.direction,
        reviewed: parsedQuery.reviewed ?? null,
        cursor: parsedQuery.cursor,
        limit: parsedQuery.limit,
      });

      return {
        items: result.items.map(formatTransaction),
        nextCursor: result.nextCursor ?? null,
      };
    }

    const result = await tx.listTransactions({
      householdId,
      from: parsedQuery.from,
      to: parsedQuery.to,
      categoryId,
      direction: parsedQuery.direction,
      reviewed: parsedQuery.reviewed ?? null,
      cursor: parsedQuery.cursor,
      limit: parsedQuery.limit,
    });

    return {
      items: result.items.map(formatTransaction),
      nextCursor: result.nextCursor ?? null,
    };
  });
}

export async function updateTransaction({ db, householdId, transactionId, input }) {
  if (!householdId) {
    throw new TransactionHttpError(400, 'householdId is required');
  }

  if (!transactionId) {
    throw new TransactionHttpError(400, 'transactionId is required');
  }

  requireDbContract(db);
  const parsedInput = parseWithSchema(updateTransactionSchema, input);

  return db.transaction(async (tx) => {
    const existing = await tx.getTransactionById({
      householdId,
      transactionId,
    });

    if (!existing) {
      throw new TransactionHttpError(404, 'transaction not found');
    }

    const nextTransaction = {
      transactionDate: parsedInput.transactionDate ?? existing.transactionDate,
      description: parsedInput.description ?? existing.description,
      merchant: Object.prototype.hasOwnProperty.call(parsedInput, 'merchant') ? parsedInput.merchant : existing.merchant ?? null,
      amount: parsedInput.amount ?? existing.amount,
      direction: parsedInput.direction ?? existing.direction,
      categoryId: Object.prototype.hasOwnProperty.call(parsedInput, 'categoryId') ? parsedInput.categoryId : existing.categoryId ?? null,
      linkedDebtId: Object.prototype.hasOwnProperty.call(parsedInput, 'linkedDebtId') ? parsedInput.linkedDebtId : existing.linkedDebtId ?? null,
      linkedGoalId: Object.prototype.hasOwnProperty.call(parsedInput, 'linkedGoalId') ? parsedInput.linkedGoalId : existing.linkedGoalId ?? null,
    };

    const validation = parseWithSchema(createTransactionSchema, nextTransaction);
    await enforceSplitParentUpdateInvariant({
      tx,
      householdId,
      transactionId,
      nextTransaction: validation,
    });
    await ensureDebtExists(tx, householdId, validation.linkedDebtId);
    await ensureGoalExists(tx, householdId, validation.linkedGoalId, validation.categoryId);

    const updated = await tx.updateTransaction({
      householdId,
      transactionId,
      patch: validation,
    });

    await syncDebtPayment({
      tx,
      householdId,
      transaction: {
        ...updated,
        ...validation,
        id: transactionId,
      },
    });

    return formatTransaction({
      ...updated,
      ...validation,
      id: transactionId,
    });
  });
}

export async function deleteTransaction({ db, householdId, transactionId }) {
  if (!householdId) {
    throw new TransactionHttpError(400, 'householdId is required');
  }

  if (!transactionId) {
    throw new TransactionHttpError(400, 'transactionId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const existing = await tx.getTransactionById({
      householdId,
      transactionId,
    });

    if (!existing) {
      throw new TransactionHttpError(404, 'transaction not found');
    }

    await tx.deleteDebtPaymentByTransactionId({
      householdId,
      transactionId,
    });

    await tx.deleteTransaction({
      householdId,
      transactionId,
    });

    await reopenImportedRowForDeletedTransaction({
      tx,
      householdId,
      transactionId,
    });
  });
}

export const __internal = {
  createTransactionSchema,
  listTransactionsSchema,
  parseMoneyToCents,
  updateTransactionSchema,
};
