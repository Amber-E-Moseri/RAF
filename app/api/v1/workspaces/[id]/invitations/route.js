import { json, getDb, assertWorkspaceParam } from '../../../_shared/http.js';
import { createInvitation, listPendingInvitations, InvitationError } from '../../../../../../lib/collaboration/invitations.js';

export async function GET(_request, context = {}) {
  const guard = assertWorkspaceParam(context, context.params);
  if (guard) return guard;
  try {
    const workspaceId = context.params.id;
    const db = getDb(context);
    const items = await listPendingInvitations({
      db,
      workspaceId,
      requestingRole: context.workspace?.role ?? context.role,
      userId: context.userId,
    });
    return json({ items }, 200);
  } catch (error) {
    if (error instanceof InvitationError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal Server Error' }, 500);
  }
}

export async function POST(request, context = {}) {
  const guard = assertWorkspaceParam(context, context.params);
  if (guard) return guard;
  try {
    const workspaceId = context.params.id;
    const db = getDb(context);
    const body = await request.json();
    const invitation = await createInvitation({
      db,
      workspaceId,
      invitedByUserId: context.userId,
      invitedByRole: context.workspace?.role ?? context.role,
      email: body.email,
      role: body.role ?? 'member',
    });
    return json({ invitation }, 201);
  } catch (error) {
    if (error instanceof InvitationError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal Server Error' }, 500);
  }
}
