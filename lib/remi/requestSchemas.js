/**
 * Zod request schemas for the Remi routes. Validation runs before any entitlement,
 * database or upstream work.
 */

import { z } from 'zod';

export const REMI_MESSAGE_MAX_LENGTH = 4000;

export const remiChatBodySchema = z.object({
  message: z
    .string({ error: 'message is required' })
    .trim()
    .min(1, { error: 'message is required' })
    .max(REMI_MESSAGE_MAX_LENGTH, { error: `message must be ${REMI_MESSAGE_MAX_LENGTH} characters or fewer` }),
  conversationId: z.uuid({ error: 'conversationId must be a valid id' }).nullish(),
});

export const remiSummaryQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: 'month must be in YYYY-MM format' })
    .nullish(),
});

// Returns the first issue as a client-safe message. Zod's raw text is not echoed for unknown fields.
export function firstIssueMessage(zodError) {
  return zodError.issues[0]?.message ?? 'Invalid request';
}
