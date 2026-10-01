import Anthropic from '@anthropic-ai/sdk';

function buildExtractionPrompt(allocationCategories) {
  const categoryContext = Array.isArray(allocationCategories) && allocationCategories.length > 0
    ? `\nThis household uses these allocation categories (buckets): ${allocationCategories.map((c) => `"${c.label ?? c.slug}"`).join(', ')}.\nFor each transaction, add a "suggested_category_slug" field with your best guess at which bucket the spending belongs to (use the slug, or null if it's income or unclear).\n`
    : '';

  return `Extract all financial transactions from the bank statement text below.
Return a JSON array with this exact structure for each transaction:
[
  {
    "date": "YYYY-MM-DD",
    "description": "merchant or description",
    "amount": "-50.00 or 100.50 (signed decimal)",
    "raw_description": "full description as shown"${allocationCategories?.length ? ',\n    "suggested_category_slug": "savings"' : ''}
  },
  ...
]

Rules:
- Dates must be in YYYY-MM-DD format. If the year is ambiguous, assume the current year.
- Amounts: negative for debits/withdrawals, positive for credits/deposits.
- Description: cleaned merchant name or transaction type (normalize abbreviations like "GOOGLE*PLAY" → "Google Play").
- Include all transactions, skip headers, footers, and summary lines.${categoryContext}
- Return ONLY valid JSON - no markdown fence, no explanation.

Bank statement text:
`;
}

export const AI_PARSER_MODEL = 'claude-sonnet-5';

function stripJsonFence(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

function coerceString(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export async function parseWithAI(text, options = {}) {
  const { apiKey = null, statementContext = null, allocationCategories = null, client: injectedClient = null } = options;

  if (!apiKey && !injectedClient) {
    return {
      rows: null,
      error: 'ANTHROPIC_API_KEY not configured',
    };
  }

  try {
    const client = injectedClient ?? new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: AI_PARSER_MODEL,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: buildExtractionPrompt(allocationCategories) + text,
        },
      ],
    });

    if (response.stop_reason === 'max_tokens') {
      return {
        rows: null,
        error: 'Claude response was truncated; the statement is too large for AI extraction',
      };
    }

    const content = response.content?.[0];
    if (!content || content.type !== 'text') {
      return {
        rows: null,
        error: 'Unexpected response format from Claude',
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(stripJsonFence(content.text));
    } catch (parseError) {
      return {
        rows: null,
        error: `Claude response was not valid JSON: ${parseError.message}`,
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        rows: null,
        error: 'Claude response was not a JSON array',
      };
    }

    const rows = parsed.map((item) => {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }

      const date = coerceString(item.date);
      const description = coerceString(item.description);
      const amount = coerceString(item.amount);
      const rawDescription = coerceString(item.raw_description) || description;
      const suggestedCategorySlug = item.suggested_category_slug != null
        ? coerceString(item.suggested_category_slug) || null
        : null;

      return {
        date,
        description,
        amount,
        rawDescription,
        suggestedCategorySlug,
        referenceNumber: null,
        balanceAfterTransaction: null,
      };
    });

    return {
      rows,
      error: null,
      model: AI_PARSER_MODEL,
    };
  } catch (error) {
    return {
      rows: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const __internal = {
  parseWithAI,
};
