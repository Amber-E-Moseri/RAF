export function buildWorkspaceActivityRepository(client, schema) {
  return {
    async listWorkspaceActivity({ workspaceId, actorUserId = null, limit = 50, before = null }) {
      const params = [workspaceId];
      const filters = ['a.workspace_id = $1'];

      if (actorUserId != null) {
        params.push(actorUserId);
        filters.push(`a.actor_user_id = $${params.length}`);
      }
      if (before != null) {
        params.push(before);
        filters.push(`a.created_at < $${params.length}`);
      }
      params.push(limit);

      const result = await client.query(
        `select a.id, a.workspace_id, a.actor_user_id, a.action, a.entity_type, a.entity_id,
                a.metadata, a.created_at, a.event_category,
                u.email as actor_email, u.raw_json as actor_raw_json
         from ${schema}.workspace_activity a
         left join ${schema}.app_users u on u.id = a.actor_user_id
         where ${filters.join(' and ')}
         order by a.created_at desc, a.id desc
         limit $${params.length}`,
        params,
      );

      return result.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        actorUserId: row.actor_user_id ?? null,
        actorEmail: row.actor_email ?? null,
        actorName: row.actor_raw_json?.name ?? null,
        action: row.action,
        entityType: row.entity_type ?? null,
        entityId: row.entity_id ?? null,
        metadata: row.metadata ?? {},
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at ?? null),
        eventCategory: row.event_category ?? 'collaboration',
      }));
    },
  };
}
