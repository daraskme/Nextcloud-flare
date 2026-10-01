import type { Operation } from "@next-cloud-flare/shared/contracts";
import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";

export const DURABLE_OPERATION_KINDS = [
  "node.create",
  "dav.mkcol",
  "dav.lock",
  "dav.put",
  "upload.complete",
  "dav.delete",
  "dav.copy",
  "dav.move",
  "node.copy",
  "node.move",
  "node.trash",
  "node.restore",
  "node.purge",
  "node.rename",
  "dav.proppatch",
] as const satisfies readonly Operation[];

export type DurableOperation = (typeof DURABLE_OPERATION_KINDS)[number];
type OperandName =
  | "parentId"
  | "uploadId"
  | "overwriteTargetId"
  | "sourceNodeId"
  | "sourceParentId"
  | "trashOpId"
  | "nodeId"
  | "name"
  | "depth";
type OperandType = "id" | "text" | "depth";
type AuthorityOperation =
  | "node.create"
  | "node.read"
  | "node.rename"
  | "node.trash"
  | "node.props.write"
  | "node.content.write";
type RuleCondition =
  | "always"
  | "node-present"
  | "node-absent"
  | "overwrite-present"
  | "committed"
  | "noncommitted";

interface AuthorityRule {
  readonly operation: AuthorityOperation;
  readonly operand: OperandName;
  readonly expectedParent?:
    | OperandName
    | { readonly committed: OperandName; readonly pending: OperandName };
  readonly when: RuleCondition;
}

type AuthorityAdapter =
  | "none"
  | "deleted-source-parent"
  | "trash-operation"
  | "trash-operation-pending"
  | "overwrite-deletion"
  | "upload-binding";

interface OperationAuthorityPolicy {
  readonly operands: Readonly<
    Partial<Record<OperandName, { readonly type: OperandType; readonly required: boolean }>>
  >;
  readonly claim: readonly AuthorityRule[];
  readonly lookup: readonly AuthorityRule[];
  readonly adapters: readonly AuthorityAdapter[];
  readonly terminalResult: "outbox" | "proppatch";
  readonly resultAuthority: "node.read";
}

const createPolicy = {
  operands: { parentId: { type: "id", required: true } },
  claim: [{ operation: "node.create", operand: "parentId", when: "always" }],
  lookup: [{ operation: "node.create", operand: "parentId", when: "always" }],
  adapters: ["none"],
  terminalResult: "outbox",
  resultAuthority: "node.read",
} as const satisfies OperationAuthorityPolicy;

const putPolicy = (upload: boolean) =>
  ({
    operands: {
      parentId: { type: "id", required: true },
      ...(upload ? { uploadId: { type: "id", required: true } } : {}),
      nodeId: { type: "id", required: false },
    },
    claim: [
      { operation: "node.create", operand: "parentId", when: "node-absent" },
      {
        operation: "node.content.write",
        operand: "nodeId",
        expectedParent: "parentId",
        when: "node-present",
      },
    ],
    lookup: [
      { operation: "node.create", operand: "parentId", when: "node-absent" },
      {
        operation: "node.content.write",
        operand: "nodeId",
        expectedParent: "parentId",
        when: "node-present",
      },
    ],
    adapters: upload ? ["upload-binding"] : ["none"],
    terminalResult: "outbox",
    resultAuthority: "node.read",
  }) as const satisfies OperationAuthorityPolicy;

const trashPolicy = {
  operands: {
    nodeId: { type: "id", required: true },
    parentId: { type: "id", required: true },
  },
  claim: [
    { operation: "node.trash", operand: "nodeId", expectedParent: "parentId", when: "always" },
  ],
  lookup: [],
  adapters: ["deleted-source-parent"],
  terminalResult: "outbox",
  resultAuthority: "node.read",
} as const satisfies OperationAuthorityPolicy;

const copyPolicy = {
  operands: {
    sourceNodeId: { type: "id", required: true },
    parentId: { type: "id", required: true },
    name: { type: "text", required: false },
    depth: { type: "depth", required: false },
    overwriteTargetId: { type: "id", required: false },
  },
  claim: [
    { operation: "node.read", operand: "sourceNodeId", when: "always" },
    { operation: "node.create", operand: "parentId", when: "always" },
    {
      operation: "node.trash",
      operand: "overwriteTargetId",
      expectedParent: "parentId",
      when: "overwrite-present",
    },
  ],
  lookup: [
    { operation: "node.read", operand: "sourceNodeId", when: "always" },
    { operation: "node.create", operand: "parentId", when: "always" },
  ],
  adapters: ["overwrite-deletion"],
  terminalResult: "outbox",
  resultAuthority: "node.read",
} as const satisfies OperationAuthorityPolicy;

const movePolicy = {
  operands: {
    nodeId: { type: "id", required: true },
    sourceParentId: { type: "id", required: true },
    parentId: { type: "id", required: true },
    name: { type: "text", required: false },
    overwriteTargetId: { type: "id", required: false },
  },
  claim: [
    {
      operation: "node.rename",
      operand: "nodeId",
      expectedParent: "sourceParentId",
      when: "always",
    },
    { operation: "node.create", operand: "parentId", when: "always" },
    {
      operation: "node.trash",
      operand: "overwriteTargetId",
      expectedParent: "parentId",
      when: "overwrite-present",
    },
  ],
  lookup: [
    {
      operation: "node.rename",
      operand: "nodeId",
      expectedParent: { committed: "parentId", pending: "sourceParentId" },
      when: "always",
    },
    { operation: "node.create", operand: "parentId", when: "always" },
  ],
  adapters: ["overwrite-deletion"],
  terminalResult: "outbox",
  resultAuthority: "node.read",
} as const satisfies OperationAuthorityPolicy;

export const OPERATION_AUTHORITY_POLICIES = {
  "node.create": createPolicy,
  "dav.mkcol": createPolicy,
  "dav.lock": createPolicy,
  "dav.put": putPolicy(false),
  "upload.complete": putPolicy(true),
  "dav.delete": trashPolicy,
  "dav.copy": copyPolicy,
  "dav.move": movePolicy,
  "node.copy": copyPolicy,
  "node.move": movePolicy,
  "node.trash": trashPolicy,
  "node.restore": {
    operands: {
      trashOpId: { type: "id", required: true },
      nodeId: { type: "id", required: true },
      parentId: { type: "id", required: true },
    },
    claim: [{ operation: "node.create", operand: "parentId", when: "always" }],
    lookup: [
      { operation: "node.create", operand: "parentId", when: "noncommitted" },
      {
        operation: "node.rename",
        operand: "nodeId",
        expectedParent: "parentId",
        when: "committed",
      },
    ],
    adapters: ["trash-operation-pending"],
    terminalResult: "outbox",
    resultAuthority: "node.read",
  },
  "node.purge": {
    operands: {
      trashOpId: { type: "id", required: true },
      nodeId: { type: "id", required: true },
      parentId: { type: "id", required: true },
    },
    claim: [{ operation: "node.read", operand: "parentId", when: "always" }],
    lookup: [{ operation: "node.read", operand: "parentId", when: "always" }],
    adapters: ["trash-operation"],
    terminalResult: "outbox",
    resultAuthority: "node.read",
  },
  "node.rename": {
    operands: {
      nodeId: { type: "id", required: true },
      parentId: { type: "id", required: true },
    },
    claim: [
      {
        operation: "node.rename",
        operand: "nodeId",
        expectedParent: "parentId",
        when: "always",
      },
    ],
    lookup: [
      {
        operation: "node.rename",
        operand: "nodeId",
        expectedParent: "parentId",
        when: "always",
      },
    ],
    adapters: ["none"],
    terminalResult: "outbox",
    resultAuthority: "node.read",
  },
  "dav.proppatch": {
    operands: { nodeId: { type: "id", required: true } },
    claim: [{ operation: "node.props.write", operand: "nodeId", when: "always" }],
    lookup: [{ operation: "node.props.write", operand: "nodeId", when: "always" }],
    adapters: ["none"],
    terminalResult: "proppatch",
    resultAuthority: "node.read",
  },
} as const satisfies Record<DurableOperation, OperationAuthorityPolicy>;

export interface OperationAuthorityRow {
  readonly op_id: string;
  readonly credential_id: string;
  readonly space_id: string;
  readonly kind: Operation;
  readonly state: "claimed" | "committed" | "failed";
  readonly epoch: number;
  readonly operands_json: string;
}

export interface OperationAuthorityPlan {
  readonly kind: DurableOperation;
  readonly operands: Readonly<Record<string, string>>;
  readonly claim: readonly AuthorityRule[];
  readonly lookup: readonly AuthorityRule[];
  readonly adapters: readonly AuthorityAdapter[];
  readonly terminalResult: OperationAuthorityPolicy["terminalResult"];
  readonly resultAuthority: OperationAuthorityPolicy["resultAuthority"];
}

function isDurableOperation(kind: Operation): kind is DurableOperation {
  return (DURABLE_OPERATION_KINDS as readonly Operation[]).includes(kind);
}

function validOperand(value: unknown, type: OperandType): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (type === "depth") return value === "0" || value === "infinity";
  if (type === "text") return new TextEncoder().encode(value).byteLength <= 255;
  return value.length <= 256 && !/[\x00-\x20/]/.test(value);
}

function active(
  rule: AuthorityRule,
  operands: Readonly<Record<string, string>>,
  state: OperationAuthorityRow["state"],
): boolean {
  if (rule.when === "always") return true;
  if (rule.when === "node-present") return operands.nodeId !== undefined;
  if (rule.when === "node-absent") return operands.nodeId === undefined;
  if (rule.when === "overwrite-present") return operands.overwriteTargetId !== undefined;
  if (rule.when === "committed") return state === "committed";
  return state !== "committed";
}

export function operationAuthorityPlan(
  kind: Operation,
  encodedOperands: string,
  state: OperationAuthorityRow["state"],
): OperationAuthorityPlan | null {
  if (!isDurableOperation(kind)) return null;
  const policy = OPERATION_AUTHORITY_POLICIES[kind];
  try {
    const parsed = JSON.parse(encodedOperands) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const declared = Object.keys(policy.operands);
    if (Object.keys(record).some((key) => !declared.includes(key))) return null;
    const operands: Record<string, string> = {};
    for (const [name, declaration] of Object.entries(policy.operands)) {
      const value = record[name];
      if (value === undefined) {
        if (declaration.required) return null;
        continue;
      }
      if (!validOperand(value, declaration.type)) return null;
      operands[name] = value;
    }
    return Object.freeze({
      kind,
      operands: Object.freeze(operands),
      claim: Object.freeze(policy.claim.filter((rule) => active(rule, operands, state))),
      lookup: Object.freeze(policy.lookup.filter((rule) => active(rule, operands, state))),
      adapters: policy.adapters,
      terminalResult: policy.terminalResult,
      resultAuthority: policy.resultAuthority,
    });
  } catch {
    return null;
  }
}

function proofNode(proof: AuthorizedNode): string {
  return proof.operation === "node.create" ? proof.parent.id : proof.node.id;
}

function proofParent(proof: AuthorizedNode): string | null {
  return proof.operation === "node.rename" ||
    proof.operation === "node.trash" ||
    proof.operation === "node.content.write"
    ? proof.parentId
    : null;
}

function expectedParent(
  rule: AuthorityRule,
  plan: OperationAuthorityPlan,
  state: OperationAuthorityRow["state"],
): string | null {
  if (!rule.expectedParent) return null;
  const operand =
    typeof rule.expectedParent === "string"
      ? rule.expectedParent
      : state === "committed"
        ? rule.expectedParent.committed
        : rule.expectedParent.pending;
  return plan.operands[operand] ?? null;
}

export function claimAuthorityAssertions(
  plan: OperationAuthorityPlan,
  authorization: AuthorizedNode | readonly AuthorizedNode[],
  spaceId: string,
): readonly SqlStatement[] {
  const authorized = Array.isArray(authorization) ? authorization : [authorization];
  if (authorized.length !== plan.claim.length) throw new Error("invalid_operation_claim");
  for (const [index, rule] of plan.claim.entries()) {
    const proof = authorized[index];
    if (
      !proof ||
      proof.operation !== rule.operation ||
      proofNode(proof) !== plan.operands[rule.operand] ||
      ("spaceId" in proof ? proof.spaceId : proof.node.space_id) !== spaceId ||
      (rule.expectedParent !== undefined &&
        proofParent(proof) !== expectedParent(rule, plan, "claimed"))
    )
      throw new Error("invalid_operation_claim");
  }
  return authorized.map(authorizationAssertion);
}

async function assertLookupRule(
  db: D1Database,
  principal: Principal,
  row: OperationAuthorityRow,
  plan: OperationAuthorityPlan,
  rule: AuthorityRule,
): Promise<void> {
  const operand = plan.operands[rule.operand];
  if (!operand) throw new Error("authorization_denied");
  const proof = await authorizeNode(
    db,
    principal,
    rule.operation === "node.create"
      ? { operation: rule.operation, parentId: operand, spaceId: row.space_id }
      : { operation: rule.operation, nodeId: operand, spaceId: row.space_id },
  );
  if (
    proof.operation !== rule.operation ||
    (rule.expectedParent !== undefined &&
      proofParent(proof) !== expectedParent(rule, plan, row.state))
  )
    throw new Error("authorization_denied");
}

async function hasCredentialScope(
  db: D1Database,
  principal: Principal,
  scope: string,
): Promise<boolean> {
  if (principal.kind === "user") return true;
  if (principal.kind !== "app_password") return false;
  return (
    (await primary(db)
      .prepare("SELECT 1 FROM credential_scopes WHERE credential_id=? AND scope=?")
      .bind(principal.credential_id, scope)
      .first<number>()) !== null
  );
}

async function applyAdapter(
  db: D1Database,
  principal: Principal,
  row: OperationAuthorityRow,
  plan: OperationAuthorityPlan,
  adapter: AuthorityAdapter,
): Promise<void> {
  if (adapter === "none") return;
  if (adapter === "trash-operation-pending" && row.state === "committed") return;
  if (adapter === "upload-binding") {
    const bound = await primary(db)
      .prepare(`SELECT 1 FROM uploads WHERE id=? AND completion_op_id=?
        AND credential_id=? AND epoch=? AND space_id=? AND parent_id=? AND target_id IS ?
        AND (?<>'committed' OR state='completed')`)
      .bind(
        plan.operands.uploadId,
        row.op_id,
        row.credential_id,
        row.epoch,
        row.space_id,
        plan.operands.parentId,
        plan.operands.nodeId ?? null,
        row.state,
      )
      .first();
    if (!bound) throw new Error("authorization_denied");
    return;
  }
  if (adapter === "trash-operation" || adapter === "trash-operation-pending") {
    if (principal.kind !== "user") throw new Error("authorization_denied");
    const visible = await primary(db)
      .prepare(
        `SELECT 1 AS ok FROM trash_ops WHERE op_id=? AND space_id=? AND actor_id=?
          AND state IN ('trashed','purged')`,
      )
      .bind(plan.operands.trashOpId, row.space_id, principal.user_id)
      .first<number>("ok");
    if (visible !== 1) throw new Error("authorization_denied");
    return;
  }
  if (adapter === "deleted-source-parent") {
    const parent = await authorizeNode(db, principal, {
      operation: "node.read",
      nodeId: plan.operands.parentId!,
      spaceId: row.space_id,
    });
    if (principal.kind === "app_password" && principal.internal_share)
      await atomicBatch(db, [
        authorizationAssertion(parent),
        assertExists(
          `SELECT 1 FROM current_internal_shares current
            JOIN share_actions a ON a.share_id=current.share_id
            JOIN credential_scopes cs
            ON cs.credential_id=? AND cs.scope='node:delete'
            WHERE current.share_id=? AND current.version=? AND a.action='edit'`,
          [
            principal.credential_id,
            principal.internal_share.share_id,
            principal.internal_share.share_version,
          ],
        ),
      ]);
    else if (!(await hasCredentialScope(db, principal, "node:delete")))
      throw new Error("authorization_denied");
    return;
  }
  if (!plan.operands.overwriteTargetId) return;
  if (principal.kind !== "user" && principal.kind !== "app_password")
    throw new Error("authorization_denied");
  const overwrite = await primary(db)
    .prepare(`SELECT 1 FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id
      JOIN spaces s ON s.id=t.space_id AND s.owner_id=n.owner_id
      WHERE t.op_id=? AND t.actor_id=? AND t.space_id=? AND t.root_node_id=?
        AND t.state IN ('trashed','purging','purged') AND t.epoch=?
        AND n.deleted_op_id=t.op_id AND n.deleted_at IS NOT NULL AND n.orig_parent_id=?
        AND (?<>'app_password' OR EXISTS(SELECT 1 FROM credential_scopes
          WHERE credential_id=? AND scope='node:delete'))`)
    .bind(
      row.op_id,
      principal.user_id,
      row.space_id,
      plan.operands.overwriteTargetId,
      row.epoch,
      plan.operands.parentId,
      principal.kind,
      principal.credential_id,
    )
    .first();
  if (!overwrite) throw new Error("authorization_denied");
  if (
    principal.kind === "app_password" &&
    principal.internal_share &&
    !(await primary(db)
      .prepare(`SELECT 1 FROM current_internal_shares current
        JOIN share_actions action ON action.share_id=current.share_id AND action.action='edit'
        WHERE current.share_id=? AND current.version=?`)
      .bind(principal.internal_share.share_id, principal.internal_share.share_version)
      .first())
  )
    throw new Error("authorization_denied");
}

export async function authorizeOperationLookup(
  db: D1Database,
  principal: Principal,
  row: OperationAuthorityRow,
  plan: OperationAuthorityPlan,
): Promise<void> {
  for (const rule of plan.lookup) await assertLookupRule(db, principal, row, plan, rule);
  for (const adapter of plan.adapters) await applyAdapter(db, principal, row, plan, adapter);
}
