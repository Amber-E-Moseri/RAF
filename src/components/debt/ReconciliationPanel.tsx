import { useState } from "react";
import { confirmDebtReconciliation, rejectDebtReconciliation, unlinkDebtReconciliation } from "../../api/debtsApi";
import { ErrorState } from "../feedback/ErrorState";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Money } from "../ui/Money";
import { formatIsoDate } from "../../lib/format";
import type { DebtActivityFull, DebtMatchClassification, DebtPaymentMatch, DebtReconciliation } from "../../lib/types";
import { LoadingSpinner } from "../feedback/LoadingSpinner";

interface ReconciliationPanelProps {
  debtId: string;
  activityData: DebtActivityFull | null;
  onMutated: () => void;
}

function classificationLabel(c: DebtMatchClassification) {
  return c === "EXACT_MATCH" ? "Exact match" : "Possible match";
}

function classificationTone(c: DebtMatchClassification): "success" | "warning" {
  return c === "EXACT_MATCH" ? "success" : "warning";
}

interface MatchRowProps {
  match: DebtPaymentMatch;
  debtId: string;
  onMutated: () => void;
}

function MatchRow({ match, debtId, onMutated }: MatchRowProps) {
  const [pending, setPending] = useState<"confirm" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const manual = match.manualActivity;
  const bestCandidate = match.candidates[0];
  const imported = bestCandidate.importActivity;
  const classification = bestCandidate.classification;
  const primaryPaymentId = manual.provenance.recordId;
  const duplicatePaymentId = imported.provenance.recordId;

  async function handleConfirm() {
    setPending("confirm");
    setError(null);
    try {
      await confirmDebtReconciliation(debtId, { primaryPaymentId, duplicatePaymentId, matchType: classification });
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm match.");
    } finally {
      setPending(null);
    }
  }

  async function handleReject() {
    setPending("reject");
    setError(null);
    try {
      await rejectDebtReconciliation(debtId, { primaryPaymentId, duplicatePaymentId, matchType: classification });
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reject match.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--surface-elevated)] p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={classificationTone(classification)}>{classificationLabel(classification)}</Badge>
        {match.ambiguous ? (
          <span className="text-[10px] text-[var(--text-muted)]">Multiple candidates — review carefully</span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-[9px] font-black uppercase tracking-[0.1em] text-[var(--text-muted)]">Manual</p>
          <p className="text-sm font-semibold text-[var(--text-strong)]"><Money value={(manual.amountCents / 100).toFixed(2)} /></p>
          <p className="text-[11px] text-[var(--text-muted)]">{formatIsoDate(manual.effectiveDate)}</p>
        </div>
        <div className="space-y-1">
          <p className="text-[9px] font-black uppercase tracking-[0.1em] text-[var(--text-muted)]">Imported</p>
          <p className="text-sm font-semibold text-[var(--text-strong)]"><Money value={(imported.amountCents / 100).toFixed(2)} /></p>
          <p className="text-[11px] text-[var(--text-muted)]">{formatIsoDate(imported.effectiveDate)}</p>
        </div>
      </div>

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}

      <div className="flex gap-2 flex-wrap">
        <Button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={pending !== null}
        >
          {pending === "confirm" ? <LoadingSpinner inline size="sm" label="Confirming..." /> : "Confirm — same payment"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void handleReject()}
          disabled={pending !== null}
        >
          {pending === "reject" ? <LoadingSpinner inline size="sm" label="Rejecting..." /> : "Reject — separate payments"}
        </Button>
      </div>
    </div>
  );
}

interface ConfirmedRowProps {
  reconciliation: DebtReconciliation;
  debtId: string;
  onMutated: () => void;
}

function ConfirmedRow({ reconciliation, debtId, onMutated }: ConfirmedRowProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUnlink() {
    setPending(true);
    setError(null);
    try {
      await unlinkDebtReconciliation(debtId, {
        primaryPaymentId: reconciliation.primaryPaymentId,
        duplicatePaymentId: reconciliation.duplicatePaymentId,
      });
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlink.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 py-3 border-b border-[var(--border-color)] last:border-0">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">Confirmed duplicate</Badge>
          <span className="text-[10px] text-[var(--text-muted)]">{reconciliation.matchType === "EXACT_MATCH" ? "Exact match" : "Possible match"}</span>
        </div>
        {reconciliation.confirmedAt ? (
          <p className="text-[10px] text-[var(--text-muted)]">Confirmed {formatIsoDate(reconciliation.confirmedAt)}</p>
        ) : null}
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        onClick={() => void handleUnlink()}
        disabled={pending}
      >
        {pending ? <LoadingSpinner inline size="sm" label="Unlinking..." /> : "Undo"}
      </Button>
    </div>
  );
}

export function ReconciliationPanel({ debtId, activityData, onMutated }: ReconciliationPanelProps) {
  if (!activityData) {
    return null;
  }

  const matches = activityData.matches;
  const reconciliations = activityData.reconciliations ?? [];
  const confirmedReconciliations = reconciliations.filter((r) => r.status === "confirmed");

  const pendingMatches = matches?.matches ?? [];
  const unmatchedManual = matches?.unmatched.manual ?? [];
  const unmatchedImported = matches?.unmatched.imported ?? [];

  const hasContent = pendingMatches.length > 0 || confirmedReconciliations.length > 0
    || unmatchedManual.length > 0 || unmatchedImported.length > 0;

  if (!hasContent) {
    return (
      <p className="py-2 text-xs text-[var(--text-muted)]">No payment matching candidates found.</p>
    );
  }

  return (
    <div className="space-y-5">
      {pendingMatches.length > 0 ? (
        <div className="space-y-3">
          <p className="text-[9px] font-black uppercase tracking-[0.12em] text-[var(--text-muted)]">
            Possible duplicates — review required
          </p>
          {pendingMatches.map((match) => (
            <MatchRow
              key={match.manualActivity.id}
              match={match}
              debtId={debtId}
              onMutated={onMutated}
            />
          ))}
        </div>
      ) : null}

      {confirmedReconciliations.length > 0 ? (
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2">
            Confirmed reconciliations
          </p>
          {confirmedReconciliations.map((rec) => (
            <ConfirmedRow
              key={rec.id}
              reconciliation={rec}
              debtId={debtId}
              onMutated={onMutated}
            />
          ))}
        </div>
      ) : null}

      {(unmatchedManual.length > 0 || unmatchedImported.length > 0) ? (
        <div className="space-y-2">
          <p className="text-[9px] font-black uppercase tracking-[0.12em] text-[var(--text-muted)]">
            Unmatched payments
          </p>
          {unmatchedManual.map((a) => (
            <div key={a.id} className="flex items-center gap-2 py-1.5">
              <Badge tone="neutral">Manual</Badge>
              <span className="text-xs text-[var(--text-muted)]">{formatIsoDate(a.effectiveDate)}</span>
              <span className="text-xs font-semibold text-[var(--text-strong)] ml-auto">
                <Money value={(a.amountCents / 100).toFixed(2)} />
              </span>
            </div>
          ))}
          {unmatchedImported.map((a) => (
            <div key={a.id} className="flex items-center gap-2 py-1.5">
              <Badge tone="neutral">Import</Badge>
              <span className="text-xs text-[var(--text-muted)]">{formatIsoDate(a.effectiveDate)}</span>
              <span className="text-xs font-semibold text-[var(--text-strong)] ml-auto">
                <Money value={(a.amountCents / 100).toFixed(2)} />
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
