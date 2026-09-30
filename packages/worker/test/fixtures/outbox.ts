import { env } from "cloudflare:workers";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "./foundation";
import { grantPermit } from "./mutationAdmission";

export async function outboxFixture(result?: { status: number; nodeId?: string }, epoch = 1) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(
    env.DB,
    f.statements.map((statement) =>
      statement.sql.startsWith("INSERT INTO sessions")
        ? {
            ...statement,
            sql: statement.sql.replace("'access',?,1,", "'access',?,?,"),
            values: [...statement.values!.slice(0, 3), epoch, ...statement.values!.slice(3)],
          }
        : statement,
    ),
  );
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, epoch);
  const id = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,operands_json,result_json)
      VALUES(?,'user',?,?,?,'node.create','committed','digest',?,?,?,?,0,1,1,?,?)`,
      values: [
        id,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        epoch,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
        JSON.stringify({ parentId: f.ids.root }),
        JSON.stringify({ status: result?.status ?? 201, nodeId: result?.nodeId ?? f.ids.folder }),
      ],
    },
    {
      sql: "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',?,1,1)",
      values: [id, id, f.ids.folder, epoch],
    },
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      values: [id, f.ids.folder],
    },
  ]);
  await env.DB.prepare("UPDATE permits SET state='released' WHERE permit_id=? AND state='open'")
    .bind(permit.permit_id)
    .run();
  return { ...f, id, epoch };
}
