/** Historical attribution only: revocation cannot erase who initiated a committed deletion. */
export const ANONYMOUS_TRASH_PROVENANCE = `SELECT 1 FROM operations o
 JOIN credentials cred ON cred.id=o.credential_id JOIN share_sessions ss ON ss.id=cred.share_session_id
 JOIN shares sh ON sh.id=ss.share_id JOIN spaces sp ON sp.id=o.space_id
 WHERE t.actor_id IS NULL AND t.reason='node.trash' AND o.op_id=t.op_id
   AND (o.kind='node.trash' AND o.principal_kind='link_share' AND o.state='committed'
     AND o.space_id=t.space_id AND o.epoch=t.epoch AND o.expected_steps=13)
   AND (cred.kind='share' AND o.principal_id=sh.id AND o.credential_version=ss.share_version
     AND ss.epoch=o.epoch AND sh.kind='link' AND sh.owner_id=sp.owner_id
     AND o.credential_version BETWEEN 1 AND sh.version)
   AND json_extract(o.operands_json,'$.nodeId')=t.root_node_id
   AND EXISTS(SELECT 1 FROM activity a WHERE a.op_id=t.op_id AND a.actor_id IS NULL
     AND a.kind='node.trash' AND a.affected_id=t.root_node_id)`;
