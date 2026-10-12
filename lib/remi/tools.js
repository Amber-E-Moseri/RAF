/**
 * Typed tool definitions for Remi's domain service layer.
 *
 * Principle: RAF calculates. Remi understands, explains, compares, and helps
 * the user act. Every tool here is a window into the RAF plan engine — not an
 * independent calculator.
 */

export const REMI_TOOLS = [
  {
    name: 'get_current_plan',
    description:
      "Get the current month's allocation plan from the RAF engine — income received vs expected, spending and remaining balance per allocation bucket, surplus or deficit, and adjustment candidates. Call this first for any question about the current financial state.",
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description:
            'ISO date YYYY-MM-01 for the month to inspect. Omit for the current active month.',
        },
      },
    },
  },
  {
    name: 'get_available_resources',
    description:
      "Get what is actually available for discretionary spending right now: remaining balance in each flexible allocation bucket, unallocated income, savings floor headroom, and when the next income is expected. Always call this before answering any affordability question. Never reduce affordability to 'account balance > purchase amount'.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_upcoming_obligations',
    description:
      'Get confirmed fixed bills and scheduled debt payments due within a lookahead window. Use this to show the user what they are committed to before discretionary spending.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Lookahead in days. Default 14, max 90.',
        },
      },
    },
  },
  {
    name: 'get_goal_progress',
    description:
      'Get progress toward one or all savings goals — current amount saved, target, percentage complete, and implied monthly rate needed to meet the deadline.',
    input_schema: {
      type: 'object',
      properties: {
        goalId: {
          type: 'string',
          description: 'Specific goal ID. Omit to get all goals.',
        },
      },
    },
  },
  {
    name: 'get_debt_strategy',
    description:
      "Get all active debts with current balances, interest rates, minimum payments, payoff estimates, and RAF's priority ranking (avalanche by default). Uses RAF's deterministic debt engine.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_cashflow_forecast',
    description:
      "Get a 30, 60, or 90-day deterministic cash-flow forecast — projected balance, upcoming obligations, lowest balance date, and pressure points. Uses RAF's forecast engine with trailing 3-month baselines.",
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: '30, 60, or 90. Default 30.',
        },
      },
    },
  },
  {
    name: 'compare_periods',
    description:
      'Compare two months side-by-side: income received, total spending, per-bucket usage, and percentage variance. Returns deltas so Remi can explain what changed and why.',
    input_schema: {
      type: 'object',
      properties: {
        periodA: {
          type: 'string',
          description: 'ISO date YYYY-MM-01 for the earlier (baseline) period.',
        },
        periodB: {
          type: 'string',
          description:
            'ISO date YYYY-MM-01 for the later period. Defaults to the current active month.',
        },
      },
      required: ['periodA'],
    },
  },
  {
    name: 'explain_variance',
    description:
      'Explain why a specific allocation bucket went over or under its allocation in a given month: the full-month used total, the transactions that drove the variance, and whether the figures are complete (truncated flag).',
    input_schema: {
      type: 'object',
      properties: {
        categorySlug: {
          type: 'string',
          description:
            'Bucket slug, e.g. personal_spending, fixed_bills, savings, debt_payoff, buffer.',
        },
        period: {
          type: 'string',
          description: 'ISO date YYYY-MM-01. Defaults to the current active month.',
        },
      },
      required: ['categorySlug'],
    },
  },
  {
    name: 'get_transaction_summary',
    description:
      'Get a summary of transactions in a date range: top merchants by spend, category breakdown, and any uncategorized items. Use this to surface patterns, not to calculate financial truth.',
    input_schema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date YYYY-MM-DD.',
        },
        to: {
          type: 'string',
          description: 'End date YYYY-MM-DD.',
        },
        categorySlug: {
          type: 'string',
          description: 'Optional: restrict to one bucket slug.',
        },
      },
    },
  },
  {
    name: 'create_scenario',
    description:
      'Model the impact of a hypothetical spend or allocation change on the current plan. Returns a before/after comparison of the affected bucket and overall position. This is a read-only projection — it never modifies any data.',
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Plain-English description of what is being modelled, e.g. "spend $400 on a weekend trip".',
        },
        categorySlug: {
          type: 'string',
          description:
            'Which allocation bucket the spend would come from. If omitted, Remi selects the most appropriate flexible bucket.',
        },
        amountDelta: {
          type: 'string',
          description: 'Positive dollar amount as a decimal string, e.g. "400.00".',
        },
      },
      required: ['description', 'amountDelta'],
    },
  },
  {
    name: 'propose_allocation_change',
    description:
      "Produce a before/after preview of a proposed allocation change — e.g. putting extra money toward a goal or redirecting surplus. Returns a structured proposal for the user to review. No data is written until the user explicitly confirms and executes through an authorized RAF action.",
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add_to_goal', 'redirect_surplus'],
          description: 'The type of change being proposed.',
        },
        targetId: {
          type: 'string',
          description: 'Goal ID for add_to_goal proposals.',
        },
        amount: {
          type: 'string',
          description: 'Dollar amount as a decimal string.',
        },
        rationale: {
          type: 'string',
          description: 'One sentence explaining why this change is being proposed.',
        },
      },
      required: ['action', 'amount', 'rationale'],
    },
  },
];
