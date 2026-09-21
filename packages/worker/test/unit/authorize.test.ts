import type { Principal } from "@ncf/shared";
import { describe, expect, it } from "vitest";

import { canReadOwnerContent, hasOperationScopes } from "../../src/auth/authorize.js";

describe("principal authorization matrix", () => {
  it("does not grant app_admin another owner's content", () => {
    const admin: Principal = {
      kind: "user",
      principalId: "admin",
      credentialId: "as:admin-session",
      scopes: ["node:read"],
      userId: "admin",
      sessionId: "admin-session",
    };
    expect(canReadOwnerContent(admin, "other-user")).toBe(false);
  });

  it("keeps service principals on automation routes", () => {
    const service: Principal = {
      kind: "service",
      principalId: "service",
      credentialId: "service:credential",
      scopes: ["node:read"],
      serviceId: "service",
      mappedUserId: "user",
      spaceId: "space",
    };
    expect(hasOperationScopes(service, "automation.list")).toBe(true);
    expect(hasOperationScopes(service, "node.read")).toBe(false);
    expect(hasOperationScopes(service, "node.create")).toBe(false);
  });

  it("requires every scope for copy", () => {
    const principal: Principal = {
      kind: "user",
      principalId: "user",
      credentialId: "as:session",
      scopes: ["node:read"],
      userId: "user",
      sessionId: "session",
    };
    expect(hasOperationScopes(principal, "node.copy")).toBe(false);
  });
});
