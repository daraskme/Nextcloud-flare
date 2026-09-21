import type { Env } from "../env.js";
import type { DavPropertyChange } from "../dav/properties.js";
import {
  assertChanged,
  auditAndOutbox,
  finishMutation,
  mutationGuards,
  operationStep,
  type UserMutationContext,
} from "./mutation.js";

interface DavPropertyMutation extends UserMutationContext {
  nodeId: string;
  expectedRevision: number;
  changes: DavPropertyChange[];
}

export async function applyDavProperties(env: Env, input: DavPropertyMutation): Promise<void> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [...mutationGuards(env, input)];
  let step = 1;
  for (const change of input.changes) {
    if (change.action === "set") {
      statements.push(
        env.DB.prepare(
          "INSERT INTO node_props(node_id,namespace_uri,local_name,value_xml) VALUES(?1,?2,?3,?4) ON CONFLICT(node_id,namespace_uri,local_name) DO UPDATE SET value_xml=excluded.value_xml",
        ).bind(input.nodeId, change.namespace, change.localName, change.valueXml),
        assertChanged(env),
      );
    } else {
      statements.push(
        env.DB.prepare(
          "DELETE FROM node_props WHERE node_id=?1 AND namespace_uri=?2 AND local_name=?3",
        ).bind(input.nodeId, change.namespace, change.localName),
        assertChanged(env),
      );
    }
    statements.push(
      ...operationStep(env, input.operationId, step, `property.${change.action}`, input.nodeId),
    );
    step += 1;
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE (SELECT COUNT(*) FROM node_props WHERE node_id=?1)>100",
    ).bind(input.nodeId),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE (SELECT COUNT(*) FROM node_props p JOIN nodes n ON n.id=p.node_id WHERE n.owner_id=?1)>100000",
    ).bind(input.userId),
    env.DB.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND owner_id=?4 AND revision=?5 AND deleted_at IS NULL",
    ).bind(now, input.operationId, input.nodeId, input.userId, input.expectedRevision),
    assertChanged(env),
    ...operationStep(env, input.operationId, step, "node.properties", input.nodeId),
    ...auditAndOutbox(env, input, "node.properties.updated", input.nodeId, step + 1, now),
    ...finishMutation(
      env,
      input,
      { node_id: input.nodeId, revision: input.expectedRevision + 1 },
      now,
    ),
  );
  await env.DB.batch(statements);
}
