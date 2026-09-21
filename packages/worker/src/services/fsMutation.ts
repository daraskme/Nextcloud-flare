import type { Env } from "../env.js";
import { upsertSearchStatements } from "../search/sync.js";
import { mutationGuards, type UserMutationContext } from "./mutation.js";

const RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

export function normalizePortableName(name: string): { name: string; nameCi: string } {
  const normalized = name.normalize("NFC");
  const bytes = new TextEncoder().encode(normalized);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > 255 ||
    /\p{Cc}/u.test(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    /^[.\s]|[.\s]$/u.test(normalized) ||
    /[:/\\]/u.test(normalized) ||
    RESERVED_NAMES.test(normalized)
  ) {
    throw new RangeError("invalid_name");
  }
  return { name: normalized, nameCi: normalized.toLowerCase().normalize("NFC") };
}

export interface CreateFolderMutation extends UserMutationContext {
  parentId: string;
  nodeId: string;
  name: string;
  expectedParentRevision: number;
  expectedTreeGeneration: number;
}

export async function createFolder(env: Env, input: CreateFolderMutation): Promise<void> {
  const normalized = normalizePortableName(input.name);
  const now = Date.now();
  const step = (number: number, kind: string, affectedId: string) => [
    env.DB.prepare(
      "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?1,?2,?3,?4)",
    ).bind(input.operationId, number, kind, affectedId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ];
  const statements = [
    ...mutationGuards(env, input),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(WITH RECURSIVE a(id,parent_id,space_id,owner_id,kind,deleted_at,depth,path) AS (SELECT id,parent_id,space_id,owner_id,kind,deleted_at,0,'/'||id||'/' FROM nodes WHERE id=?1 UNION ALL SELECT p.id,p.parent_id,p.space_id,p.owner_id,p.kind,p.deleted_at,a.depth+1,a.path||p.id||'/' FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.depth<64 AND p.space_id=a.space_id AND instr(a.path,'/'||p.id||'/')=0) SELECT 1 FROM a JOIN spaces s ON s.id=?2 WHERE (SELECT COUNT(*) FROM a) BETWEEN 1 AND 65 AND (SELECT MIN(deleted_at IS NULL) FROM a)=1 AND (SELECT MAX(CASE WHEN kind='root' AND parent_id IS NULL THEN id END) FROM a)=s.root_node_id AND (SELECT MIN(space_id=?2 AND owner_id=?3) FROM a)=1)",
    ).bind(input.parentId, input.spaceId, input.userId),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES(?1,?2,?3,?4,?5,?6,'folder',NULL,1,NULL,?7,?7,NULL,NULL,NULL,0,?8)",
    ).bind(
      input.nodeId,
      input.spaceId,
      input.userId,
      input.parentId,
      normalized.name,
      normalized.nameCi,
      now,
      input.operationId,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ...upsertSearchStatements(env, {
      nodeId: input.nodeId,
      spaceId: input.spaceId,
      text: normalized.name,
      revision: 1,
    }),
    ...step(1, "node.insert", input.nodeId),
    env.DB.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND revision=?4 AND deleted_at IS NULL",
    ).bind(now, input.operationId, input.parentId, input.expectedParentRevision),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ...step(2, "parent.revision", input.parentId),
    env.DB.prepare(
      "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?1 AND tree_generation=?2",
    ).bind(input.spaceId, input.expectedTreeGeneration),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ...step(3, "space.generation", input.spaceId),
    env.DB.prepare(
      "INSERT INTO audit(audit_id,op_id,actor_id,kind,target_id,created_at) VALUES(?1,?2,?3,'node.create',?4,?5)",
    ).bind(input.auditId, input.operationId, input.userId, input.nodeId, now),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ...step(4, "audit.insert", input.auditId),
    env.DB.prepare(
      "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,dispatch_token,dispatch_expires_at,epoch,created_at,updated_at) VALUES(?1,?2,'node.created',?3,'pending',NULL,NULL,?4,?5,?5)",
    ).bind(input.outboxId, input.operationId, input.nodeId, input.epoch, now),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ...step(5, "outbox.insert", input.outboxId),
    env.DB.prepare(
      "UPDATE operations SET state='committed',result_json=?1,updated_at=?2 WHERE op_id=?3 AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?3)=expected_steps",
    ).bind(JSON.stringify({ node_id: input.nodeId, revision: 1 }), now, input.operationId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ];
  await env.DB.batch(statements);
}
