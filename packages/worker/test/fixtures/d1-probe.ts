import { env } from "cloudflare:workers";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  type SqlStatement,
} from "../../src/db/primary";
import schema from "./d1-schema.sql?raw";
import seed from "./d1-seed.sql?raw";

export const probeTables = [
  "operation_steps",
  "audit",
  "outbox",
  "operations",
  "permits",
  "nodes",
  "blobs",
  "spaces",
  "sessions",
  "users",
  "control",
  "trash_ops",
  "_assert",
] as const;

export function statements(sql: string): SqlStatement[] {
  // Fixture SQL contains neither triggers nor embedded semicolons.
  return sql
    .split(";")
    .map((sql) => ({ sql: sql.trim() }))
    .filter((item) => item.sql);
}

export async function createProbeSchema() {
  await atomicBatch(env.DB, statements(schema));
}

export async function resetProbe() {
  await atomicBatch(env.DB, [
    ...probeTables.map((table) => ({ sql: `DELETE FROM ${table}` })),
    ...statements(seed),
  ]);
}

export async function snapshot() {
  const results = await atomicBatch(
    env.DB,
    probeTables.map((table) => ({
      sql: `SELECT * FROM ${table} ORDER BY rowid`,
    })),
  );
  return results.map((result) => result.results);
}

export const stepNames = [
  "node",
  "tree",
  "quota",
  "refs",
  "audit",
  "outbox",
  "step",
  "terminal",
] as const;
export type StepName = (typeof stepNames)[number];
export type AssertionMode = "changes" | "exists";

const steps: { name: StepName; before: string; write: string; after: string }[] = [
  {
    name: "node",
    before: "SELECT 1 FROM nodes WHERE id='node' AND revision=1 AND deleted_at IS NULL",
    write:
      "UPDATE nodes SET revision=2,last_op_id='op' WHERE id='node' AND revision=1 AND deleted_at IS NULL",
    after: "SELECT 1 FROM nodes WHERE id='node' AND revision=2 AND last_op_id='op'",
  },
  {
    name: "tree",
    before: "SELECT 1 FROM spaces WHERE id='space' AND tree_generation=1",
    write: "UPDATE spaces SET tree_generation=2 WHERE id='space' AND tree_generation=1",
    after: "SELECT 1 FROM spaces WHERE id='space' AND tree_generation=2",
  },
  {
    name: "quota",
    before: "SELECT 1 FROM users WHERE id='user' AND reserved_bytes=10 AND used_bytes=0",
    write:
      "UPDATE users SET reserved_bytes=0,used_bytes=10 WHERE id='user' AND reserved_bytes=10 AND used_bytes=0",
    after: "SELECT 1 FROM users WHERE id='user' AND reserved_bytes=0 AND used_bytes=10",
  },
  {
    name: "refs",
    before: "SELECT 1 FROM blobs WHERE id='blob' AND ref_count=0 AND state='committed'",
    write: "UPDATE blobs SET ref_count=1 WHERE id='blob' AND ref_count=0 AND state='committed'",
    after: "SELECT 1 FROM blobs WHERE id='blob' AND ref_count=1 AND state='committed'",
  },
  {
    name: "audit",
    before: "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM audit WHERE id='audit')",
    write: "INSERT INTO audit SELECT 'audit','op' WHERE 1",
    after: "SELECT 1 FROM audit WHERE id='audit' AND op_id='op'",
  },
  {
    name: "outbox",
    before: "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM outbox WHERE id='outbox')",
    write: "INSERT INTO outbox SELECT 'outbox','op','pending' WHERE 1",
    after: "SELECT 1 FROM outbox WHERE id='outbox' AND op_id='op'",
  },
  {
    name: "step",
    before: "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id='op')",
    write: "INSERT INTO operation_steps SELECT 'op',1 WHERE 1",
    after: "SELECT 1 FROM operation_steps WHERE op_id='op' AND step_no=1",
  },
  {
    name: "terminal",
    before:
      "SELECT 1 FROM operations WHERE op_id='op' AND state='claimed' AND expected_steps=(SELECT COUNT(*) FROM operation_steps WHERE op_id='op')",
    write:
      "UPDATE operations SET state='committed',result_json='{}' WHERE op_id='op' AND state='claimed' AND expected_steps=(SELECT COUNT(*) FROM operation_steps WHERE op_id='op')",
    after: "SELECT 1 FROM operations WHERE op_id='op' AND state='committed' AND result_json='{}'",
  },
];

export function mutationProbe(mode: AssertionMode, failStep?: StepName): SqlStatement[] {
  return [
    assertExists(`SELECT 1 FROM permits p JOIN operations o ON o.permit_id=p.permit_id
      WHERE p.permit_id='permit' AND p.space_id='space' AND p.state='open'
      AND p.epoch=1 AND p.epoch=(SELECT epoch FROM control WHERE singleton=1)
      AND p.expires_at > (strftime('%s','now')*1000) AND o.op_id='op' AND o.state='claimed'`),
    assertExists(`SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
      WHERE u.id='user' AND u.disabled_at IS NULL AND s.id='session'
      AND s.revoked_at IS NULL AND s.expires_at > (strftime('%s','now')*1000)`),
    ...steps.flatMap((step) => [
      ...(mode === "exists" ? [assertExists(step.before)] : []),
      { sql: step.write + (failStep === step.name ? " AND 0" : "") },
      mode === "changes" ? assertOneChange : assertExists(step.after),
    ]),
  ];
}
