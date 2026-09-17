import { useState } from "react";

import type { WorkspaceMember } from "../../api/collaborationApi";
import { removeMember, updateMemberRole, leaveWorkspace } from "../../api/collaborationApi";
import { Button } from "../ui/Button";
import { usePermission, useRole, roleMeetsMinimum } from "../../hooks/usePermission";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

const ROLE_COLORS: Record<string, string> = {
  owner: "bg-[var(--theme-primary)] text-white",
  admin: "bg-[var(--accent-blue,#3b82f6)] text-white",
  member: "bg-[var(--surface-muted)] text-[var(--text-primary)]",
  viewer: "bg-[var(--surface-muted)] text-[var(--text-secondary)]",
};

const ASSIGNABLE_ROLES = ["admin", "member", "viewer"];

function initials(member: WorkspaceMember): string {
  const name = member.name ?? member.email ?? "?";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

interface Props {
  member: WorkspaceMember;
  workspaceId: string;
  isCurrentUser: boolean;
  isPersonalWorkspace: boolean;
  onUpdated: () => void;
}

export function MemberRow({ member, workspaceId, isCurrentUser, isPersonalWorkspace, onUpdated }: Props) {
  const myRole = useRole();
  const canManage = usePermission("members:manage");
  const isOwner = member.role === "owner";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canChangeRole = canManage && !isOwner && !isCurrentUser && roleMeetsMinimum(myRole, "admin");
  const canRemove = canManage && !isOwner && !isCurrentUser;
  const canLeave = isCurrentUser && !isOwner && !isPersonalWorkspace;

  async function handleRoleChange(newRole: string) {
    if (!canChangeRole) return;
    setBusy(true);
    setError(null);
    try {
      await updateMemberRole(workspaceId, member.userId, newRole);
      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update role");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!canRemove) return;
    if (!window.confirm(`Remove ${member.email ?? member.name ?? "this person"} from your household?`)) return;
    setBusy(true);
    setError(null);
    try {
      await removeMember(workspaceId, member.userId);
      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove member");
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    if (!canLeave) return;
    if (!window.confirm("Leave this household? You will lose access until re-invited.")) return;
    setBusy(true);
    setError(null);
    try {
      await leaveWorkspace(workspaceId);
      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to leave");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[13px] font-semibold text-[var(--text-primary)]">
        {initials(member)}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
          {member.name ?? member.email ?? member.userId}
          {isCurrentUser ? <span className="ml-1.5 text-[var(--text-secondary)]">(you)</span> : null}
        </p>
        {member.name && member.email ? (
          <p className="truncate text-[11px] text-[var(--text-secondary)]">{member.email}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {canChangeRole ? (
          <select
            className="ui-field py-1 text-[11px] font-semibold"
            value={member.role}
            disabled={busy}
            onChange={(e) => void handleRoleChange(e.target.value)}
            aria-label={`Role for ${member.email ?? member.name}`}
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
        ) : (
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${ROLE_COLORS[member.role] ?? ROLE_COLORS.member}`}>
            {ROLE_LABELS[member.role] ?? member.role}
          </span>
        )}

        {canRemove ? (
          <Button
            type="button"
            variant="ghost"
            className="text-[11px] text-rose-600 hover:text-rose-700 hover:bg-rose-50"
            disabled={busy}
            onClick={() => void handleRemove()}
          >
            Remove
          </Button>
        ) : null}

        {canLeave ? (
          <Button
            type="button"
            variant="ghost"
            className="text-[11px] text-rose-600 hover:text-rose-700 hover:bg-rose-50"
            disabled={busy}
            onClick={() => void handleLeave()}
          >
            Leave
          </Button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-1 w-full text-[11px] text-[var(--text-danger,#ef4444)]">{error}</p>
      ) : null}
    </div>
  );
}
