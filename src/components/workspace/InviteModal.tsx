import { useState } from "react";

import { sendInvitation } from "../../api/collaborationApi";
import { Button } from "../ui/Button";

const ROLES = [
  { value: "admin", label: "Admin", description: "Can manage members, view everything" },
  { value: "member", label: "Member", description: "Can add income, transactions, and plans" },
  { value: "viewer", label: "Viewer", description: "Can view plans and reports only" },
];

interface Props {
  workspaceId: string;
  onSent: () => void;
  onClose: () => void;
}

export function InviteModal({ workspaceId, onSent, onClose }: Props) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await sendInvitation(workspaceId, email.trim().toLowerCase(), role);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send invitation");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 shadow-xl">
        <div className="mb-5">
          <h2 className="text-[16px] font-bold text-[var(--text-primary)]">Invite someone</h2>
          <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
            They&apos;ll receive a link to join your household.
          </p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label className="ui-label" htmlFor="invite-email">Email address</label>
            <input
              id="invite-email"
              type="email"
              className="ui-field"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div>
            <label className="ui-label">Role</label>
            <div className="mt-1.5 space-y-1.5">
              {ROLES.map((r) => (
                <label
                  key={r.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${role === r.value ? "border-[var(--theme-primary)] bg-[var(--theme-soft)]" : "border-[var(--border-subtle)]"}`}
                >
                  <input
                    type="radio"
                    name="invite-role"
                    value={r.value}
                    checked={role === r.value}
                    onChange={() => setRole(r.value)}
                    className="mt-0.5 shrink-0 accent-[var(--theme-primary)]"
                  />
                  <div>
                    <span className="text-[13px] font-semibold text-[var(--text-primary)]">{r.label}</span>
                    <p className="text-[11px] text-[var(--text-secondary)]">{r.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {error ? (
            <p className="text-[12px] text-[var(--status-danger)]">{error}</p>
          ) : null}

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={busy || !email.trim()}
            >
              {busy ? "Sending…" : "Send invite"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
