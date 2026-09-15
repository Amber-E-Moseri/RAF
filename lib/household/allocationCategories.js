import { z } from 'zod';

export class HouseholdAllocationCategoriesHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HouseholdAllocationCategoriesHttpError';
    this.status = status;
  }
}

const FRACTION_SCALE = 10000;
const SUM_TOLERANCE_BPS = 1;

const allocationPercentSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(4) : value.trim()))
  .refine((value) => /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value), {
    message: 'allocationPercent must be a decimal with up to 4 places',
  })
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${(fraction + '0000').slice(0, 4)}`;
  });

const replaceItemSchema = z.object({
  slug: z.string()
    .trim()
    .min(1, 'slug is required')
    .regex(/^[a-z0-9_]+$/, 'slug must use lowercase letters, numbers, or underscores'),
  label: z.string().optional().transform((value) => value == null ? undefined : value.trim()),
  name: z.string().optional().transform((value) => value == null ? undefined : value.trim()),
  sortOrder: z.number().int(),
  allocationPercent: allocationPercentSchema.optional(),
  percent: allocationPercentSchema.optional(),
  isActive: z.boolean(),
}).superRefine((value, context) => {
  if (!value.label && !value.name) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['label'],
      message: 'label is required',
    });
  }

  if (!value.allocationPercent && !value.percent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allocationPercent'],
      message: 'allocationPercent is required',
    });
  }
});

const replaceAllocationCategoriesSchema = z.object({
  items: z.array(replaceItemSchema).min(1, 'items is required'),
});

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Household allocation category DB adapter must implement transaction().');
  }
}

function todayIsoDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function normalizeAsOfDate(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new HouseholdAllocationCategoriesHttpError(400, 'asOf must be a valid ISO date');
  }

  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new HouseholdAllocationCategoriesHttpError(400, 'asOf must be a valid ISO date');
  }

  return normalized;
}

function parseFractionToBps(value) {
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * FRACTION_SCALE + Number((fraction + '0000').slice(0, 4));
}

function parseWithSchema(schema, input, status = 400) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : 'request';
    throw new HouseholdAllocationCategoriesHttpError(status, `${path} ${issue.message}`);
  }

  return result.data;
}

function formatCategoryResponse(category) {
  const response = {
    id: category.id,
    name: category.label,
    label: category.label,
    slug: category.slug,
    percent: category.allocationPercent,
    allocationPercent: category.allocationPercent,
    isActive: category.isActive !== false,
    active: category.isActive !== false,
    sortOrder: category.sortOrder ?? 0,
    isSystem: category.isSystem === true,
    isBuffer: category.slug === 'buffer',
  };
  if (category.snapshotId != null) response.snapshotId = category.snapshotId;
  if (category.effectiveFrom != null) response.effectiveFrom = category.effectiveFrom;
  if (category.supersededAt != null) response.supersededAt = category.supersededAt;
  return response;
}

function normalizeItems(items) {
  return items.map((item) => ({
    slug: item.slug,
    label: item.label ?? item.name,
    allocationPercent: item.allocationPercent ?? item.percent,
    sortOrder: item.sortOrder,
    isActive: item.isActive,
  }));
}

function validateNormalizedItems(items, existingCategories) {
  const existingBySlug = new Map(existingCategories.map((category) => [category.slug, category]));
  const incomingSlugs = new Set();

  for (const item of items) {
    if (incomingSlugs.has(item.slug)) {
      throw new HouseholdAllocationCategoriesHttpError(400, `items duplicate slug ${item.slug}`);
    }

    incomingSlugs.add(item.slug);
  }

  for (const existing of existingCategories) {
    if (!incomingSlugs.has(existing.slug)) {
      if (existing.slug === 'buffer' || existing.isSystem !== true) {
        continue;
      }

      throw new HouseholdAllocationCategoriesHttpError(
        422,
        `system allocation categories cannot be removed: ${existing.slug}`,
      );
    }
  }

  const merged = items.map((item) => {
    const existing = existingBySlug.get(item.slug);
    if (!existing) {
      return {
        id: null,
        slug: item.slug,
        label: item.label,
        allocationPercent: item.allocationPercent,
        sortOrder: item.sortOrder,
        isActive: item.isActive,
        isSystem: false,
      };
    }

    return {
      ...existing,
      label: item.label,
      allocationPercent: item.allocationPercent,
      sortOrder: item.sortOrder,
      isActive: item.isActive,
    };
  });

  const activeCategories = merged.filter((category) => category.isActive !== false);
  if (activeCategories.length === 0) {
    throw new HouseholdAllocationCategoriesHttpError(422, 'at least one active allocation category is required');
  }

  const totalBps = activeCategories.reduce((sum, category) => sum + parseFractionToBps(category.allocationPercent), 0);
  if (Math.abs(totalBps - FRACTION_SCALE) > SUM_TOLERANCE_BPS) {
    throw new HouseholdAllocationCategoriesHttpError(422, 'active allocation percentages must sum to 1.0000 +/- 0.0001');
  }

  return merged;
}

function formatHistoryItem(snapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    effectiveFrom: snapshot.effectiveFrom,
    supersededAt: snapshot.supersededAt,
    items: snapshot.items.map(formatCategoryResponse),
  };
}

export async function listHouseholdAllocationCategories({ db, householdId, asOf = null }) {
  if (!householdId) {
    throw new HouseholdAllocationCategoriesHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const normalizedAsOf = normalizeAsOfDate(asOf);

  return db.transaction(async (tx) => {
    const [items, history] = await Promise.all([
      tx.listAllocationCategories({ householdId, asOf: normalizedAsOf }),
      typeof tx.listAllocationCategorySnapshots === 'function'
        ? tx.listAllocationCategorySnapshots({ householdId })
        : [],
    ]);

    return {
      items: items.map(formatCategoryResponse),
      history: history.map(formatHistoryItem),
    };
  });
}

export async function replaceHouseholdAllocationCategories({ db, householdId, input, effectiveDate = todayIsoDate() }) {
  if (!householdId) {
    throw new HouseholdAllocationCategoriesHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedInput = parseWithSchema(replaceAllocationCategoriesSchema, input);
  const normalizedItems = normalizeItems(parsedInput.items);

  return db.transaction(async (tx) => {
    const existingCategories = await tx.listAllocationCategories({ householdId });
    const merged = validateNormalizedItems(normalizedItems, existingCategories);

    const updated = await tx.replaceAllocationCategories({
      householdId,
      effectiveFrom: effectiveDate,
      items: merged.map((category) => ({
        slug: category.slug,
        label: category.label,
        allocationPercent: category.allocationPercent,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
      })),
    });

    return {
      items: updated.map(formatCategoryResponse),
      history: typeof tx.listAllocationCategorySnapshots === 'function'
        ? (await tx.listAllocationCategorySnapshots({ householdId })).map(formatHistoryItem)
        : [],
      notes: [
        'Rounding remainder is routed to the active buffer slug when present, otherwise to the largest allocation category.',
      ],
    };
  });
}

export const __internal = {
  formatCategoryResponse,
  normalizeItems,
  replaceAllocationCategoriesSchema,
  validateNormalizedItems,
};
