import { useState } from "react";

import { revokeInvitation, listMembers, listPendingInvitations, listWorkspaceActivity } from "../api/collaborationApi";
import type { WorkspaceInvitation } from "../api/collaborationApi";
import { ActivityFeed } from "../components/workspace/ActivityFeed";
import { InviteModal } from "../components/workspace/InviteModal";
import { MemberRow } from "../components/workspace/MemberRow";
import { PageShell } from "../components/layout/PageShell";
import { Button } from "../components/ui/Button";
import { useAuth } from "../context/AuthContext";
import { usePermission } from "../hooks/usePermission";
import { useAsyncData } from "../hooks/useAsyncData";

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function PendingInvitationRow({
  invitation,
  canManage,
  onRevoked,
}: {
  invitation: WorkspaceInvitation;
  canManage: boolean;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleRevoke() {
    setBusy(true);
    try {
      await revokeInvitation(invitation.workspaceId, invitation.id);
      onRevoked();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-[var(--border-subtle)] text-[var(--text-secondary)]">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
          <circle cx="12" cy="8" r="4" />
          <path d="M6 20a6 6 0 0 1 12 0" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">{invitation.email}</p>
        <p className="text-[11px] text-[var(--text-secondary)]">
          Invited as {invitation.role} · expires {formatExpiry(invitation.expiresAt)}
        </p>
      </div>
      {canManage ? (
        <Button
          type="button"
          variant="ghost"
          className="text-[11px]"
          disabled={busy}
          onClick={() => void handleRevoke()}
        >
          Revoke
        </Button>
      ) : null}
    </div>
  );
}

export function Members({ bare }: { bare?: boolean } = {}) {
  const { session } = useAuth();
  const workspaceId = session?.workspaceId ?? session?.householdId ?? "";
  const canManage = usePermission("members:manage");
  const [showInvite, setShowInvite] = useState(false);
  const [activeTab, setActiveTab] = useState<"members" | "activity">("members");

  const members = useAsyncData(() => listMembers(workspaceId), [workspaceId]);
  const invitations = useAsyncData(() => listPendingInvitations(workspaceId), [workspaceId]);
  const activity = useAsyncData(
    () => listWorkspaceActivity(workspaceId, { limit: 50 }),
    [workspaceId],
  );

  const memberList = members.data ?? [];
  const pendingList = invitations.data ?? [];
  const activityList = activity.data ?? [];

  const isPersonalWorkspace = session?.workspaces?.find((w) => w.id === workspaceId)?.type === "personal";

  function handleUpdated() {
    void members.reload();
    void invitations.reload();
    void activity.reload();
  }

  function handleInviteSent() {
    setShowInvite(false);
    void invitations.reload();
    void activity.reload();
  }

  const inviteButton = canManage && !isPersonalWorkspace ? (
    <Button type="button" onClick={() => setShowInvite(true)}>
      Invite someone
    </Button>
  ) : null;

  const content = (
    <div className="space-y-6">
      {bare && inviteButton ? (
        <div className="flex justify-end">{inviteButton}</div>
      ) : null}

      <div className="flex gap-1 border-b border-[var(--border-subtle)]">
        {(["members", "activity"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-[13px] font-semibold capitalize transition-colors ${
              activeTab === tab
                ? "border-b-2 border-[var(--theme-primary)] text-[var(--theme-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "members" ? (
        <div className="space-y-3">
          {members.isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-[var(--surface-muted)]" />
              ))}
            </div>
          ) : (
            memberList.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                workspaceId={workspaceId}
                isCurrentUser={m.userId === session?.userId}
                isPersonalWorkspace={isPersonalWorkspace ?? false}
                onUpdated={handleUpdated}
              />
            ))
          )}

          {pendingList.length > 0 ? (
            <div className="pt-2">
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-secondary)]">
                Pending invitations
              </h2>
              <div className="space-y-2">
                {pendingList.map((inv) => (
                  <PendingInvitationRow
                    key={inv.id}
                    invitation={inv}
                    canManage={canManage}
                    onRevoked={() => void invitations.reload()}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {members.error ? (
            <p className="text-[13px] text-[var(--status-danger)]">{members.error}</p>
          ) : null}
        </div>
      ) : (
        <ActivityFeed entries={activityList} isLoading={activity.isLoading} />
      )}
    </div>
  );

  if (bare) {
    return (
      <>
        {content}
        {showInvite ? (
          <InviteModal
            workspaceId={workspaceId}
            onSent={handleInviteSent}
            onClose={() => setShowInvite(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <PageShell
      title={session?.workspaceName ?? session?.householdName ?? "Your household"}
      description={memberList.length > 0 ? `${memberList.length} steward${memberList.length === 1 ? "" : "s"}` : undefined}
      actions={inviteButton}
    >
      {content}
      {showInvite ? (
        <InviteModal
          workspaceId={workspaceId}
          onSent={handleInviteSent}
          onClose={() => setShowInvite(false)}
        />
      ) : null}
    </PageShell>
  );
}
