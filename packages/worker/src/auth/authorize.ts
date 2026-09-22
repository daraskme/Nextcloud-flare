import { assertExists, prepare, primary, type SqlStatement } from "../db/primary";
import type { VerifiedAccessService } from "./access";
import type { AccessSession } from "./sessions";

export type Principal =
  | {
      readonly kind: "user" | "app_password";
      readonly user_id: string;
      readonly credential_id: string;
      readonly epoch: number;
    }
  | {
      readonly kind: "link_share";
      readonly share_id: string;
      readonly share_version: number;
      readonly credential_id: string;
      readonly epoch: number;
    }
  | {
      readonly kind: "service";
      readonly service_principal_id: string;
      readonly user_id: string;
      readonly credential_id: string;
      readonly epoch: number;
      readonly token_expires_at: number;
      readonly access_iss: string;
      readonly common_name: string;
    };

export function accessPrincipal(session: AccessSession): Principal {
  return Object.freeze({
    kind: "user",
    user_id: session.user_id,
    credential_id: session.credential_id,
    epoch: session.epoch,
  });
}

export async function servicePrincipal(
  db: D1Database,
  claims: VerifiedAccessService,
  epoch: number,
): Promise<Principal> {
  const row = await primary(db)
    .prepare(`SELECT s.id,s.mapped_user_id,c.id AS credential_id
    FROM service_principals s JOIN credentials c ON c.service_principal_id=s.id AND c.kind='service'
    JOIN users u ON u.id=s.mapped_user_id JOIN control ctl ON ctl.singleton=1
    WHERE s.access_iss=? AND s.common_name=? AND s.disabled_at IS NULL AND u.disabled_at IS NULL
      AND ctl.epoch=? AND ?>strftime('%s','now')*1000`)
    .bind(claims.iss, claims.common_name, epoch, claims.exp * 1000)
    .first<{ id: string; mapped_user_id: string; credential_id: string }>();
  if (claims.kind !== "service" || !row) throw new Error("authorization_denied");
  return Object.freeze({
    kind: "service",
    service_principal_id: row.id,
    user_id: row.mapped_user_id,
    credential_id: row.credential_id,
    epoch,
    token_expires_at: claims.exp * 1000,
    access_iss: claims.iss,
    common_name: claims.common_name,
  });
}

export type NodeRequest =
  | {
      readonly operation:
        | "node.read"
        | "node.rename"
        | "node.trash"
        | "node.props.write"
        | "node.content.write"
        | "automation.list"
        | "automation.metadata.read";
      readonly nodeId: string;
      readonly spaceId: string;
    }
  | { readonly operation: "node.create"; readonly parentId: string; readonly spaceId: string };
export interface LiveNode {
  readonly id: string;
  readonly space_id: string;
  readonly owner_id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly kind: "root" | "folder" | "file";
  readonly revision: number;
  readonly current_blob_id: string | null;
  readonly tree_generation: number;
}
export type AuthorizedNode =
  | {
      readonly operation: "node.read" | "automation.list" | "automation.metadata.read";
      readonly principal: Principal;
      readonly node: LiveNode;
    }
  | {
      readonly operation: "node.rename";
      readonly principal: Principal;
      readonly node: LiveNode;
      readonly parentId: string;
    }
  | {
      readonly operation: "node.trash";
      readonly principal: Principal;
      readonly node: LiveNode;
      readonly parentId: string;
    }
  | {
      readonly operation: "node.props.write";
      readonly principal: Principal;
      readonly node: LiveNode;
    }
  | {
      readonly operation: "node.content.write";
      readonly principal: Principal;
      readonly node: LiveNode;
      readonly parentId: string;
    }
  | {
      readonly operation: "node.create";
      readonly principal: Principal;
      readonly parent: LiveNode;
      readonly spaceId: string;
    };

// An authorization result is a request-local proof. Mutation services must append its
// assertion to the SAME D1 batch as their writes, in addition to permit/operation/ledger guards.
const assertions = new WeakMap<AuthorizedNode, SqlStatement>();
export function authorizationAssertion(authorized: AuthorizedNode): SqlStatement {
  const statement = assertions.get(authorized);
  if (!statement) throw new Error("invalid_authorization_proof");
  return statement;
}

/** Pack current node proofs into ≤100 bindings per D1 statement. */
export function authorizationBatchAssertions(
  authorized: readonly AuthorizedNode[],
): readonly SqlStatement[] {
  if (authorized.length === 0 || authorized.length > 1_000)
    throw new Error("invalid_authorization_proofs");
  const statements: SqlStatement[] = [];
  for (let start = 0; start < authorized.length; start += 10) {
    const group = authorized.slice(start, start + 10);
    const values: (string | number | null)[] = [];
    const clauses = group.map((proof, index) => {
      const assertion = authorizationAssertion(proof);
      if (assertion.values?.length !== 10) throw new Error("invalid_authorization_proofs");
      values.push(...(assertion.values as (string | number | null)[]));
      const offset = index * 10;
      const query = NODE_AUTHORITY.replace(
        /\?(10|[1-9])\b/g,
        (_, number: string) => `?${offset + Number(number)}`,
      );
      return `EXISTS (${query})`;
    });
    statements.push({
      sql: `INSERT INTO _assert(v) SELECT 1 WHERE NOT (${clauses.join(" AND ")})`,
      values,
    });
  }
  return statements;
}

// All ancestry and authority reads below share one primary statement snapshot.
// app_admin is deliberately absent: a role does not confer another owner's content rights.
const NODE_AUTHORITY = `WITH RECURSIVE
  p AS (SELECT json_extract(?3,'$.kind') AS kind,json_extract(?3,'$.user_id') AS user_id,
    json_extract(?3,'$.credential_id') AS credential_id,json_extract(?3,'$.epoch') AS epoch,
    json_extract(?3,'$.share_id') AS share_id,json_extract(?3,'$.share_version') AS share_version,
    json_extract(?3,'$.service_principal_id') AS service_id,json_extract(?3,'$.token_expires_at') AS token_expiry,
    json_extract(?3,'$.access_iss') AS access_iss,json_extract(?3,'$.common_name') AS common_name),
  a(id,parent_id,space_id,owner_id,kind,deleted_at,depth,path) AS (
    SELECT id,parent_id,space_id,owner_id,kind,deleted_at,0,'/'||id||'/' FROM nodes WHERE id=?1 AND space_id=?2
    UNION ALL
    SELECT n.id,n.parent_id,n.space_id,n.owner_id,n.kind,n.deleted_at,a.depth+1,a.path||n.id||'/'
      FROM nodes n JOIN a ON n.id=a.parent_id
      WHERE a.depth<64 AND n.space_id=a.space_id AND n.owner_id=a.owner_id AND instr(a.path,'/'||n.id||'/')=0
  ),
  user_authority AS (
    SELECT u.id FROM p JOIN credentials c ON c.id=p.credential_id AND c.kind='access'
      JOIN sessions s ON s.id=c.session_id AND s.kind='access' JOIN users u ON u.id=s.user_id
      WHERE p.kind='user' AND u.id=p.user_id AND u.disabled_at IS NULL AND s.revoked_at IS NULL
        AND s.epoch=p.epoch AND s.expires_at>strftime('%s','now')*1000
    UNION ALL
    SELECT u.id FROM p JOIN credentials c ON c.id=p.credential_id AND c.kind='app_password'
      JOIN app_passwords ap ON ap.id=c.app_password_id JOIN users u ON u.id=ap.user_id
      WHERE p.kind='app_password' AND u.id=p.user_id AND u.disabled_at IS NULL AND ap.revoked_at IS NULL
        AND ap.expires_at>strftime('%s','now')*1000
        AND (ap.root_node_id IS NULL OR EXISTS(SELECT 1 FROM a WHERE id=ap.root_node_id))
        AND (?6 NOT IN ('node.rename','node.trash') OR ap.root_node_id IS NULL OR ap.root_node_id<>?1)
        AND EXISTS(SELECT 1 FROM credential_scopes WHERE credential_id=c.id AND scope=?4)
  ),
  live_shares AS (
    SELECT sh.* FROM shares sh JOIN users owner ON owner.id=sh.owner_id AND owner.disabled_at IS NULL
      JOIN a ON a.id=sh.root_node_id AND a.owner_id=sh.owner_id
      WHERE sh.disabled_at IS NULL AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
        AND (?6<>'node.rename' OR sh.root_node_id<>?1)
        AND EXISTS(SELECT 1 FROM share_actions WHERE share_id=sh.id AND action=?5)
  )
  SELECT n.id,n.space_id,n.owner_id,n.parent_id,n.name,n.kind,n.revision,n.current_blob_id,sp.tree_generation
    FROM nodes n JOIN spaces sp ON sp.id=n.space_id AND sp.owner_id=n.owner_id
    JOIN users owner ON owner.id=n.owner_id AND owner.disabled_at IS NULL
    JOIN control ctl ON ctl.singleton=1 JOIN p
    WHERE n.id=?1 AND n.space_id=?2 AND ctl.epoch=p.epoch
      AND (?7 IS NULL OR n.revision=?7) AND (?8 IS NULL OR sp.tree_generation=?8)
      AND (?9 IS NULL OR n.parent_id=?9)
      AND (?10 IS NULL OR n.current_blob_id=?10)
      AND EXISTS(SELECT COUNT(*) FROM a HAVING COUNT(*) BETWEEN 1 AND 65 AND MIN(deleted_at IS NULL)=1
        AND SUM(kind='root' AND parent_id IS NULL AND id=sp.root_node_id)=1)
      AND (?6 NOT IN ('node.create','node.rename','node.trash','node.props.write','node.content.write') OR ctl.maintenance=0)
      AND (?6<>'node.create' OR (n.kind IN ('root','folder') AND (SELECT MAX(depth) FROM a)<64))
      AND (?6 NOT IN ('node.rename','node.trash') OR n.parent_id IS NOT NULL)
      AND (?6<>'node.content.write' OR n.kind='file')
      AND (
        (p.kind IN ('user','app_password') AND ?6 IN ('node.read','node.create','node.rename','node.trash','node.props.write','node.content.write') AND EXISTS(
          SELECT 1 FROM user_authority u WHERE u.id=n.owner_id OR EXISTS(
            SELECT 1 FROM live_shares sh JOIN share_grants g ON g.share_id=sh.id
              WHERE ?6<>'node.trash' AND sh.kind='internal' AND g.user_id=u.id AND g.disabled_at IS NULL AND g.version=sh.version)))
        OR (p.kind='link_share' AND ?6 IN ('node.read','node.create','node.rename','node.props.write','node.content.write') AND EXISTS(
          SELECT 1 FROM credentials c JOIN share_sessions ss ON ss.id=c.share_session_id
            JOIN live_shares sh ON sh.id=ss.share_id
            WHERE c.id=p.credential_id AND c.kind='share' AND sh.kind='link'
              AND sh.id=p.share_id AND sh.version=p.share_version AND ss.share_version=sh.version
              AND ss.epoch=p.epoch AND ss.revoked_at IS NULL AND ss.expires_at>strftime('%s','now')*1000
              AND (ss.user_id IS NULL OR EXISTS(SELECT 1 FROM users WHERE id=ss.user_id AND disabled_at IS NULL))))
        OR (p.kind='service' AND ?6 IN ('automation.list','automation.metadata.read') AND EXISTS(
          SELECT 1 FROM credentials c JOIN service_principals svc ON svc.id=c.service_principal_id
            JOIN users u ON u.id=svc.mapped_user_id
            WHERE c.id=p.credential_id AND c.kind='service' AND svc.id=p.service_id
              AND svc.mapped_user_id=p.user_id AND u.id=n.owner_id AND u.disabled_at IS NULL
              AND svc.disabled_at IS NULL AND svc.space_id=n.space_id AND p.token_expiry>strftime('%s','now')*1000
              AND svc.access_iss=p.access_iss AND svc.common_name=p.common_name
              AND EXISTS(SELECT 1 FROM a WHERE id=svc.root_node_id)
              AND EXISTS(SELECT 1 FROM credential_scopes WHERE credential_id=c.id AND scope='node:read')))
      )`;

function validId(value: unknown, max = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\x00-\x20/]/.test(value)
  );
}
export async function authorizeNode(
  db: D1Database,
  principal: Principal,
  request: NodeRequest,
): Promise<AuthorizedNode> {
  const nodeId = request.operation === "node.create" ? request.parentId : request.nodeId;
  if (
    ![
      "node.read",
      "node.create",
      "node.rename",
      "node.trash",
      "node.props.write",
      "node.content.write",
      "automation.list",
      "automation.metadata.read",
    ].includes(request.operation) ||
    !["user", "app_password", "link_share", "service"].includes(principal.kind) ||
    !validId(nodeId) ||
    !validId(request.spaceId) ||
    !validId(principal.credential_id, 256) ||
    !Number.isSafeInteger(principal.epoch) ||
    principal.epoch < 1 ||
    (principal.kind !== "link_share" && !validId(principal.user_id)) ||
    (principal.kind === "link_share" &&
      (!validId(principal.share_id) ||
        !Number.isSafeInteger(principal.share_version) ||
        principal.share_version < 1)) ||
    (principal.kind === "service" &&
      (!validId(principal.service_principal_id) ||
        !Number.isSafeInteger(principal.token_expires_at) ||
        typeof principal.access_iss !== "string" ||
        principal.access_iss.length > 2048 ||
        typeof principal.common_name !== "string" ||
        principal.common_name.length > 1024))
  )
    throw new Error("authorization_denied");
  const identity = Object.freeze({ ...principal });
  const values = [
    nodeId,
    request.spaceId,
    JSON.stringify(identity),
    request.operation === "node.create"
      ? "node:create"
      : request.operation === "node.trash"
        ? "node:delete"
        : request.operation === "node.rename" ||
            request.operation === "node.props.write" ||
            request.operation === "node.content.write"
          ? "node:write"
          : "node:read",
    request.operation === "node.create"
      ? "create"
      : request.operation === "node.trash"
        ? "edit"
        : request.operation === "node.rename" ||
            request.operation === "node.props.write" ||
            request.operation === "node.content.write"
          ? "edit"
          : "read",
    request.operation,
  ] as const;
  const node = await prepare(primary(db), {
    sql: NODE_AUTHORITY,
    values: [...values, null, null, null, null],
  }).first<LiveNode>();
  if (!node) throw new Error("authorization_denied");
  Object.freeze(node);
  const assertion = Object.freeze(
    assertExists(
      NODE_AUTHORITY,
      Object.freeze([
        ...values,
        node.revision,
        node.tree_generation,
        node.parent_id,
        node.current_blob_id,
      ]),
    ),
  );
  if (request.operation === "node.rename" || request.operation === "node.trash") {
    if (node.parent_id === null) throw new Error("authorization_denied");
    const authorized: AuthorizedNode = Object.freeze({
      operation: request.operation,
      principal: identity,
      node,
      parentId: node.parent_id,
    });
    assertions.set(authorized, assertion);
    return authorized;
  }
  if (request.operation === "node.content.write") {
    if (node.parent_id === null) throw new Error("authorization_denied");
    const authorized: AuthorizedNode = Object.freeze({
      operation: request.operation,
      principal: identity,
      node,
      parentId: node.parent_id,
    });
    assertions.set(authorized, assertion);
    return authorized;
  }
  if (request.operation === "node.props.write") {
    const authorized: AuthorizedNode = Object.freeze({
      operation: request.operation,
      principal: identity,
      node,
    });
    assertions.set(authorized, assertion);
    return authorized;
  }
  const authorized: AuthorizedNode = Object.freeze(
    request.operation === "node.create"
      ? {
          operation: request.operation,
          principal: identity,
          parent: node,
          spaceId: request.spaceId,
        }
      : { operation: request.operation, principal: identity, node },
  );
  assertions.set(authorized, assertion);
  return authorized;
}
