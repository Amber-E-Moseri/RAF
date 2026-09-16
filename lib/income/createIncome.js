import { z } from 'zod';

import { logAuditEvent } from '../audit/auditLog.js';
import { computeDepositAllocations } from '../raf/computeDepositAllocations.js';
import { formatCents, parseMoneyToCents } from '../raf/reporting.js';

export class IncomeHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'IncomeHttpError';
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

const moneyStringSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))
  .refine((value) => /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value), {
    message: 'must be a positive decimal with up to 2 places',
  })
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${(fraction + '00').slice(0, 2)}`;
  })
  .refine((value) => value !== '0.00', {
    message: 'must be greater than 0',
  });

export const createIncomeSchema = z.object({
  sourceName: z.string().trim().min(1, 'sourceName is required'),
  amount: moneyStringSchema,
  receivedDate: isoDateSchema,
  notes: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value == null) {
        return null;
      }

      const normalized = value.trim();
      return normalized || null;
    }),
});

export const updateIncomeSchema = z
  .object({
    sourceName: z.string().trim().min(1, 'sourceName is required').optional(),
    amount: moneyStringSchema.optional(),
    receivedDate: isoDateSchema.optional(),
    notes: z
      .union([z.string(), z.null()])
      .transform((value) => {
        if (value == null) {
          return null;
        }

        const normalized = value.trim();
        return normalized || null;
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
  });

const listIncomeQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
});

function parseWithSchema(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? `${issue.path.join('.')}` : 'request';
    throw new IncomeHttpError(400, `${path} ${issue.message}`);
  }

  return result.data;
}

function normalizeIdempotencyKey(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function formatAllocationResponse(allocation) {
  return {
    category: allocation.label,
    slug: allocation.slug,
    amount: allocation.amount,
  };
}

function formatIncomeEntryResponse(entry, allocations = []) {
  return {
    incomeId: entry.id,
    sourceName: entry.sourceName,
    amount: entry.amount,
    receivedDate: entry.receivedDate,
    notes: entry.notes ?? null,
    allocations,
  };
}

function matchesExistingIncome(existingIncome, input) {
  return (
    existingIncome.sourceName === input.sourceName &&
    existingIncome.amount === input.amount &&
    existingIncome.receivedDate === input.receivedDate &&
    (existingIncome.notes ?? null) === input.notes
  );
}

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Income DB adapter must implement transaction().');
  }
}

function buildAllocationInsertRows({ householdId, incomeEntryId, allocationPlan }) {
  return allocationPlan.map((allocation) => ({
    householdId,
    incomeEntryId,
    allocationCategoryId: allocation.categoryId,
    allocationPercent: allocation.allocationPercent,
    allocatedAmount: allocation.allocatedAmount,
  }));
}

function buildAllocationResponse({ allocationPlan, categories }) {
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  return allocationPlan.map((allocation) => {
    const category = categoriesById.get(allocation.categoryId);
    return formatAllocationResponse({
      label: category?.label ?? allocation.slug,
      slug: allocation.slug,
      amount: allocation.allocatedAmount,
    });
  });
}

async function computeIncomeAllocations({ tx, householdId, amount, asOf }) {
  const categories = await tx.listAllocationCategories({ householdId, asOf });
  const allocationPlan = computeDepositAllocations(
    amount,
    categories.map((category) => ({
      id: category.id,
        slug: category.slug,
        allocationPercent: category.allocationPercent,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
      })),
    );

  return {
    categories,
    allocationPlan,
  };
}

export async function getIncome({ db, householdId, incomeId }) {
  if (!householdId) {
    throw new IncomeHttpError(400, 'householdId is required');
  }

  if (!incomeId) {
    throw new IncomeHttpError(400, 'incomeId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const entry = await tx.getIncomeEntryById({ householdId, incomeId });
    if (!entry) {
      throw new IncomeHttpError(404, 'income entry not found');
    }

    return formatIncomeEntryResponse(entry);
  });
}

export async function createIncome({ db, householdId, userId, input, idempotencyKey }) {
  if (!householdId) {
    throw new IncomeHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedInput = parseWithSchema(createIncomeSchema, input);
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);

  return db.transaction(async (tx) => {
    if (normalizedIdempotencyKey) {
      const existingIncome = await tx.findIncomeByIdempotencyKey({
        householdId,
        idempotencyKey: normalizedIdempotencyKey,
      });

      if (existingIncome) {
        if (!matchesExistingIncome(existingIncome, parsedInput)) {
          throw new IncomeHttpError(409, 'Idempotency-Key already exists for a different income payload');
        }

        const existingAllocations = await tx.listIncomeAllocations({
          householdId,
          incomeEntryId: existingIncome.id,
        });

        return {
          ...formatIncomeEntryResponse(existingIncome, existingAllocations.map(formatAllocationResponse)),
          created: false,
        };
      }
    }

    const { categories, allocationPlan } = await computeIncomeAllocations({
      tx,
      householdId,
      amount: parsedInput.amount,
      asOf: parsedInput.receivedDate,
    });

    const incomeEntry = await tx.insertIncomeEntry({
      householdId,
      sourceName: parsedInput.sourceName,
      amount: parsedInput.amount,
      receivedDate: parsedInput.receivedDate,
      notes: parsedInput.notes,
      idempotencyKey: normalizedIdempotencyKey,
    });

    await tx.insertIncomeAllocations(
      buildAllocationInsertRows({
        householdId,
        incomeEntryId: incomeEntry.id,
        allocationPlan,
      }),
    );

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'income.created',
      entityId: incomeEntry.id,
    });

    return {
      ...formatIncomeEntryResponse(incomeEntry, buildAllocationResponse({ allocationPlan, categories })),
      created: true,
    };
  });
}

export async function listIncome({ db, householdId, query }) {
  if (!householdId) {
    throw new IncomeHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedQuery = parseWithSchema(listIncomeQuerySchema, query);

  if (parsedQuery.from > parsedQuery.to) {
    throw new IncomeHttpError(400, 'from must be before or equal to to');
  }

  return db.transaction(async (tx) => {
    const items = await tx.listIncomeEntries({
      householdId,
      from: parsedQuery.from,
      to: parsedQuery.to,
    });

    const totalCents = items.reduce((sum, item) => sum + parseMoneyToCents(item.amount), 0);
    return {
      items: items.map((item) => ({
        incomeId: item.id,
        sourceName: item.sourceName,
        amount: item.amount,
        receivedDate: item.receivedDate,
        notes: item.notes ?? null,
      })),
      total: formatCents(totalCents),
    };
  });
}

export async function updateIncome({ db, householdId, incomeId, userId, input }) {
  if (!householdId) {
    throw new IncomeHttpError(400, 'householdId is required');
  }

  if (!incomeId) {
    throw new IncomeHttpError(400, 'incomeId is required');
  }

  requireDbContract(db);
  const parsedInput = parseWithSchema(updateIncomeSchema, input);

  return db.transaction(async (tx) => {
    const existing = await tx.getIncomeEntryById({
      householdId,
      incomeId,
    });

    if (!existing) {
      throw new IncomeHttpError(404, 'income entry not found');
    }

    const nextEntry = {
      sourceName: parsedInput.sourceName ?? existing.sourceName,
      amount: parsedInput.amount ?? existing.amount,
      receivedDate: parsedInput.receivedDate ?? existing.receivedDate,
      notes: Object.prototype.hasOwnProperty.call(parsedInput, 'notes') ? parsedInput.notes : existing.notes ?? null,
    };

    const { categories, allocationPlan } = await computeIncomeAllocations({
      tx,
      householdId,
      amount: nextEntry.amount,
      asOf: nextEntry.receivedDate,
    });

    const updatedEntry = await tx.updateIncomeEntry({
      householdId,
      incomeId,
      patch: nextEntry,
    });

    await tx.deleteIncomeAllocationsByIncomeEntryId({
      householdId,
      incomeEntryId: incomeId,
    });

    await tx.insertIncomeAllocations(
      buildAllocationInsertRows({
        householdId,
        incomeEntryId: incomeId,
        allocationPlan,
      }),
    );

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'income.updated',
      entityId: incomeId,
    });

    return formatIncomeEntryResponse(updatedEntry, buildAllocationResponse({ allocationPlan, categories }));
  });
}

export async function deleteIncome({ db, householdId, incomeId, userId }) {
  if (!householdId) {
    throw new IncomeHttpError(400, 'householdId is required');
  }

  if (!incomeId) {
    throw new IncomeHttpError(400, 'incomeId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const existing = await tx.getIncomeEntryById({
      householdId,
      incomeId,
    });

    if (!existing) {
      throw new IncomeHttpError(404, 'income entry not found');
    }

    await tx.deleteIncomeEntry({
      householdId,
      incomeId,
    });

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'income.deleted',
      entityId: incomeId,
    });
  });
}

export const __internal = {
  createIncomeSchema,
  listIncomeQuerySchema,
  updateIncomeSchema,
};
