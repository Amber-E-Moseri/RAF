import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { resolveInvitation, acceptInvitation, declineInvitation } from "../api/collaborationApi";
import type { InvitationPreview } from "../api/collaborationApi";
import { useAuth } from "../context/AuthContext";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

type Phase = "loading" | "preview" | "accepting" | "declined" | "done" | "error";

export function AcceptInvitation() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();

  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setPhase("error");
      setErrorMsg("Invalid invitation link.");
      return;
    }

    resolveInvitation(token)
      .then((data) => {
        setPreview(data);
        setPhase("preview");
      })
      .catch((err: Error) => {
        setPhase("error");
        setErrorMsg(err.message ?? "This invitation is no longer valid.");
      });
  }, [token]);

  async function handleAccept() {
    if (!token) return;
    setPhase("accepting");
    try {
      await acceptInvitation(token);
      setPhase("done");
      setTimeout(() => navigate("/dashboard", { replace: true }), 1500);
    } catch (err) {
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : "Failed to accept invitation.");
    }
  }

  async function handleDecline() {
    if (!token) return;
    try {
      await declineInvitation(token);
    } catch {}
    setPhase("declined");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-base)] p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--brand-primary)] text-white text-[20px] font-bold">
            R
          </div>
          <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-secondary)]">NOMI</p>
        </div>

        {phase === "loading" ? (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-8 text-center">
            <p className="text-[14px] text-[var(--text-secondary)]">Checking your invitation…</p>
          </div>
        ) : null}

        {phase === "preview" && preview ? (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 shadow-lg">
            <h1 className="text-[18px] font-bold text-[var(--text-primary)]">You&apos;re invited</h1>
            <p className="mt-1.5 text-[13px] text-[var(--text-secondary)]">
              You&apos;ve been invited to join{" "}
              <span className="font-semibold text-[var(--text-primary)]">{preview.workspace.name}</span>{" "}
              as{" "}
              <span className="font-semibold text-[var(--text-primary)]">
                {ROLE_LABELS[preview.invitation.role] ?? preview.invitation.role}
              </span>
              .
            </p>

            {!session ? (
              <p className="mt-4 rounded-lg bg-[var(--surface-raised)] px-4 py-3 text-[12px] text-[var(--text-secondary)]">
                You&apos;ll need to sign in or create an account to join this household.
              </p>
            ) : session.email !== preview.invitation.email ? (
              <p className="mt-4 rounded-lg bg-[var(--surface-raised)] px-4 py-3 text-[12px] text-[var(--text-danger,#ef4444)]">
                This invitation was sent to <strong>{preview.invitation.email}</strong>. You&apos;re currently signed in as <strong>{session.email}</strong>.
              </p>
            ) : null}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className="ui-button-ghost flex-1"
                onClick={() => void handleDecline()}
              >
                Decline
              </button>
              {session ? (
                <button
                  type="button"
                  className="ui-button-primary flex-1"
                  onClick={() => void handleAccept()}
                  disabled={session.email !== preview.invitation.email}
                >
                  Accept & join
                </button>
              ) : (
                <button
                  type="button"
                  className="ui-button-primary flex-1"
                  onClick={() => navigate(`/login?next=/invite/${token ?? ""}`)}
                >
                  Sign in to join
                </button>
              )}
            </div>
          </div>
        ) : null}

        {phase === "accepting" ? (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-8 text-center">
            <p className="text-[14px] text-[var(--text-secondary)]">Joining your household…</p>
          </div>
        ) : null}

        {phase === "done" ? (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-8 text-center">
            <p className="text-[24px]">✓</p>
            <p className="mt-2 text-[16px] font-bold text-[var(--text-primary)]">You&apos;re in</p>
            <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
              Welcome to {preview?.workspace.name ?? "your household"}.
            </p>
          </div>
        ) : null}

        {phase === "declined" ? (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-8 text-center">
            <p className="text-[15px] font-medium text-[var(--text-primary)]">Invitation declined</p>
            <p className="mt-1 text-[13px] text-[var(--text-secondary)]">You can close this page.</p>
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center">
            <p className="text-[15px] font-medium text-[var(--text-primary)]">Invitation unavailable</p>
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
              {errorMsg ?? "This link may have expired or already been used."}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
