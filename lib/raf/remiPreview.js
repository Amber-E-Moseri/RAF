/**
 * Pure preview calculations for Remi tools.
 *
 * Remi may explain and preview a financial change, but these functions never write.
 * All money math goes through the canonical integer-cent helpers in ./reporting.js.
 * Inputs come from the model and are validated here: invalid or non-positive amounts throw.
 */

import { formatCents, parseMoneyToCents } from './reporting.js';

function requirePositiveCents(value, fieldName) {
  const cents = parseMoneyToCents(value);
  if (cents <= 0) {
    throw new Error(`${fieldName} must be a positive amount.`);
  }
  return cents;
}

export function buildScenarioPreview({
  description,
  amountDelta,
  bucketSlug,
  bucketLabel,
  allocated,
  used,
  available,
}) {
  const deltaCents = requirePositiveCents(amountDelta, 'amountDelta');
  const availableBefore = parseMoneyToCents(available ?? '0.00');
  const availableAfter = availableBefore - deltaCents;
  const canAfford = availableAfter >= 0;

  return {
    scenario: description,
    amount: amountDelta,
    bucket: bucketSlug,
    bucket_label: bucketLabel,
    before: {
      allocated,
      used,
      available,
    },
    after: {
      used: formatCents(parseMoneyToCents(used ?? '0.00') + deltaCents),
      available: formatCents(availableAfter),
    },
    can_afford: canAfford,
    shortfall: canAfford ? null : formatCents(Math.abs(availableAfter)),
    note: canAfford
      ? `This would leave ${formatCents(availableAfter)} remaining in ${bucketLabel}.`
      : `This exceeds the available ${bucketLabel} balance by ${formatCents(Math.abs(availableAfter))}.`,
  };
}

export function buildGoalContributionPreview({ goal, amount, rationale }) {
  const amountCents = requirePositiveCents(amount, 'amount');
  const currentCents = parseMoneyToCents(goal.current_amount ?? '0.00');
  const targetCents = parseMoneyToCents(goal.target_amount ?? '0.00');
  const newCurrentCents = currentCents + amountCents;
  const newPercent = targetCents > 0
    ? Number(((newCurrentCents / targetCents) * 100).toFixed(1))
    : 0;

  return {
    type: 'proposal',
    action: 'add_to_goal',
    rationale,
    amount,
    goal: {
      id: goal.goal_id,
      name: goal.goal_name,
      before: { current: goal.current_amount, progress_percent: goal.progress_percent },
      after: { current: formatCents(newCurrentCents), progress_percent: Math.min(newPercent, 100) },
      target: goal.target_amount,
    },
    confirmation_required: true,
    note: 'This is a preview only. No data has been changed. Ask the user to confirm before executing.',
  };
}

export function buildSurplusRedirectPreview({ incomeTotal, spendingTotal, amount, rationale }) {
  const amountCents = requirePositiveCents(amount, 'amount');
  const receivedCents = parseMoneyToCents(incomeTotal ?? '0.00');
  const spentCents = parseMoneyToCents(spendingTotal ?? '0.00');
  const surplusCents = Math.max(0, receivedCents - spentCents);

  return {
    type: 'proposal',
    action: 'redirect_surplus',
    rationale,
    amount,
    surplus: {
      current_surplus: formatCents(surplusCents),
      amount_to_redirect: amount,
      surplus_after: formatCents(Math.max(0, surplusCents - amountCents)),
    },
    confirmation_required: true,
    note: 'This is a preview only. No data has been changed. Ask the user to confirm before executing.',
  };
}
