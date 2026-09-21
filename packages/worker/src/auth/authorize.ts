import type { Operation, Principal, Scope } from "@ncf/shared";

const operationScopes: Readonly<Partial<Record<Operation, readonly Scope[]>>> = {
  "account.read": ["account:read"],
  "node.read": ["node:read"],
  "node.create": ["node:create"],
  "node.content.write": ["node:write"],
  "node.rename": ["node:write"],
  "node.move": ["node:write"],
  "node.copy": ["node:read", "node:create"],
  "node.trash": ["node:delete"],
  "node.restore": ["node:create"],
  "node.purge": ["node:delete"],
  "upload.create": ["upload:create"],
  "upload.read": ["upload:write"],
  "upload.write": ["upload:write"],
  "upload.abort": ["upload:write"],
  "upload.complete": ["upload:write"],
  "share.manage": ["share:manage"],
  "credential.read": ["credential:manage"],
  "credential.create": ["credential:manage"],
  "credential.revoke": ["credential:manage"],
  "job.read": ["job:read"],
  "job.cancel": ["job:cancel"],
  "admin.user.disable": ["admin:user"],
  "admin.transfer": ["admin:user"],
  "admin.lock.force_unlock": ["admin:lock"],
  "admin.dlq": ["admin:dlq"],
  "admin.repair": ["admin:repair"],
  "automation.list": ["node:read"],
  "automation.metadata.read": ["node:read"],
};

export function hasOperationScopes(principal: Principal, operation: Operation): boolean {
  const required = operationScopes[operation] ?? [];
  if (principal.kind === "service" && !operation.startsWith("automation.")) {
    return false;
  }
  if (principal.kind !== "service" && operation.startsWith("automation.")) {
    return false;
  }
  return required.every((scope) => principal.scopes.includes(scope));
}

export function canReadOwnerContent(principal: Principal, ownerId: string): boolean {
  if (principal.kind === "user" || principal.kind === "app_password") {
    return principal.userId === ownerId && principal.scopes.includes("node:read");
  }
  if (principal.kind === "service") {
    return principal.mappedUserId === ownerId && principal.scopes.includes("node:read");
  }
  return principal.kind === "share" && principal.scopes.includes("node:read");
}
