import { expect, it } from "vitest";
import type { Principal } from "../../src/auth/authorize";
import { freezePrincipal, storedPrincipal, storedSelection } from "../../src/auth/selectedShare";
import { digestJson, operationIntent } from "../../src/jobs/operations";

const user = { kind: "user" as const, user_id: "user", credential_id: "credential", epoch: 1 };
const saved = { selected_share_id: "share", selected_share_version: 2 };
it("restores durable share scope, rejects substitution and copies authority before awaits", async () => {
  const selection = { id: "share", version: 2 };
  const principal = { ...user, selected_share: selection };
  const frozen = freezePrincipal(principal);
  const pending = operationIntent(
    principal,
    "key",
    "space",
    "node.create",
    { name: "folder" },
    { parentId: "root" },
  );
  selection.version = 3;
  expect(frozen).toMatchObject({ selected_share: { id: "share", version: 2 } });
  expect(Object.isFrozen(frozen)).toBe(true);
  expect((await pending).principal).toEqual(frozen);
  expect(storedPrincipal(user, saved)).toEqual(frozen);
  expect(() => storedPrincipal(principal, saved)).toThrow("share_selection_mismatch");
  expect(() =>
    storedPrincipal(frozen, { selected_share_id: null, selected_share_version: null }),
  ).toThrow();
  expect(storedPrincipal({ ...user, kind: "app_password" }, saved)).toEqual({
    ...frozen,
    kind: "app_password",
  });
});
it.each([
  { selected_share_id: "share", selected_share_version: null },
  { selected_share_id: null, selected_share_version: 2 },
  { selected_share_id: "share", selected_share_version: 0 },
  { selected_share_id: "", selected_share_version: 2 },
  { selected_share_id: "share", selected_share_version: 1.5 },
])("fails closed on malformed durable scope %j", (row) => {
  expect(() => storedSelection(row)).toThrow();
});
it("preserves legacy operation IDs and digests while separating selected request digests", async () => {
  const body = { name: "folder" },
    operands = { parentId: "root" };
  const legacy = await operationIntent(user, "key", "space", "node.create", body, operands);
  expect(legacy.digest).toBe(await digestJson({ spaceId: "space", kind: "node.create", body }));
  const selected = await operationIntent(
    { ...user, selected_share: { id: "share", version: 2 } },
    "key",
    "space",
    "node.create",
    body,
    operands,
  );
  expect(selected.id).toBe(legacy.id);
  expect(selected.digest).not.toBe(legacy.digest);
  expect(() =>
    freezePrincipal({
      ...user,
      kind: "link_share",
      selected_share: { id: "share", version: 2 },
    } as unknown as Principal),
  ).toThrow();
});
