import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { type BootstrapPolicy, bootstrapOwner } from "../../src/auth/bootstrap";
import { loginAccessUser } from "../../src/auth/login";
import { revokeAccessSession } from "../../src/auth/sessions";
import { accessFixture } from "../fixtures/access";
import { mutationEnv } from "../fixtures/mutationAdmission";

let access: Awaited<ReturnType<typeof accessFixture>>;
const policy: BootstrapPolicy = {
  ownerEmails: ["owner@example.invalid", "second@example.invalid"],
  ownerIdentities: [],
  quotaBytes: 1_000_000,
};
beforeAll(async () => {
  access = await accessFixture();
  for (const db of [
    env.TEST_BOOTSTRAP_RACE,
    env.TEST_BOOTSTRAP_FAILURE,
    env.TEST_BOOTSTRAP_LOGIN,
    env.TEST_BOOTSTRAP_LOST,
  ]) {
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    await db.prepare("UPDATE control SET maintenance=0").run();
  }
});

it("selects exactly one bootstrap identity under competing owner logins, with one complete personal space", async () => {
  const db = env.TEST_BOOTSTRAP_RACE;
  const one = await access.verifier.verify(await access.sign(), "user");
  const two = await access.verifier.verify(
    await access.sign({ sub: "second", email: "second@example.invalid" }),
    "user",
  );
  const results = await Promise.allSettled([
    bootstrapOwner(mutationEnv(db, db), one, 1, policy),
    bootstrapOwner(mutationEnv(db, db), two, 1, policy),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const winner = await db.prepare("SELECT bootstrap_sub FROM control").first("bootstrap_sub");
  const claims = winner === one.sub ? one : two;
  const result = await bootstrapOwner(mutationEnv(db, db), claims, 1, policy);
  expect(result.id).toBeTruthy();
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='app_admin'").first("n"),
  ).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM spaces").first("n")).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind='root'").first("n")).toBe(1);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("rejects outsiders, maintenance, old epoch and expired tokens without partially consuming bootstrap", async () => {
  const db = env.TEST_BOOTSTRAP_FAILURE;
  const claims = await access.verifier.verify(await access.sign(), "user");
  const outsider = await access.verifier.verify(
    await access.sign({ sub: "stranger", email: "stranger@example.invalid" }),
    "user",
  );
  await expect(bootstrapOwner(mutationEnv(db, db), outsider, 1, policy)).rejects.toThrow(
    "bootstrap_not_allowed",
  );
  await expect(bootstrapOwner(mutationEnv(db, db), claims, 2, policy)).rejects.toThrow(
    "bootstrap_unavailable",
  );
  await db.prepare("UPDATE control SET maintenance=1").run();
  await expect(bootstrapOwner(mutationEnv(db, db), claims, 1, policy)).rejects.toThrow();
  await db.prepare("UPDATE control SET maintenance=0").run();
  await expect(
    bootstrapOwner(mutationEnv(db, db), { ...claims, exp: 1 }, 1, policy),
  ).rejects.toThrow();
  // Force the final assertion to fail after user/space/root insertion.
  await db.prepare("UPDATE settings SET signup_enabled=1").run();
  await expect(bootstrapOwner(mutationEnv(db, db), claims, 1, policy)).rejects.toThrow();
  expect(
    await db.prepare("SELECT bootstrap_done_at FROM control").first("bootstrap_done_at"),
  ).toBeNull();
  expect(await db.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
  await db.prepare("UPDATE settings SET signup_enabled=0").run();
  await expect(
    bootstrapOwner(mutationEnv(db, db), claims, 1, {
      ...policy,
      ownerEmails: [],
      ownerIdentities: [{ iss: claims.iss, sub: claims.sub }],
    }),
  ).resolves.toMatchObject({ id: expect.any(String) });
});

it("connects verified JWT, bootstrap and durable sessions without implicit signup or email identity merge", async () => {
  const db = env.TEST_BOOTSTRAP_LOGIN;
  const request = await access.sign();
  const sessions = await Promise.all([
    loginAccessUser(mutationEnv(db, db), access.verifier, request, 1, policy),
    loginAccessUser(mutationEnv(db, db), access.verifier, request, 1, policy),
  ]);
  expect(sessions[0]?.credential_id).toBe(sessions[1]?.credential_id);
  await expect(
    loginAccessUser(
      mutationEnv(db, db),
      access.verifier,
      await access.sign({ sub: "other-identity" }),
      1,
      policy,
    ),
  ).rejects.toThrow();
  const session = sessions[0];
  if (!session) throw new Error("missing_session");
  await revokeAccessSession(mutationEnv(db, db), session.credential_id, 1);
  await expect(
    loginAccessUser(mutationEnv(db, db), access.verifier, request, 1, policy),
  ).rejects.toThrow();
});

it("reconciles a committed bootstrap after its batch response is lost", async () => {
  const db = env.TEST_BOOTSTRAP_LOST;
  const lossy = {
    prepare: db.prepare.bind(db),
    async batch(statements: D1PreparedStatement[]) {
      await db.batch(statements);
      throw new Error("response_lost");
    },
  } as unknown as D1Database;
  const claims = await access.verifier.verify(await access.sign(), "user");
  await expect(bootstrapOwner(mutationEnv(lossy, db), claims, 1, policy)).resolves.toMatchObject({
    id: expect.any(String),
  });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(1);
  expect(
    (await db.prepare("SELECT space_id,state,committed_at FROM mutation_admissions").all()).results,
  ).toEqual([{ space_id: null, state: "closed", committed_at: expect.any(Number) }]);
});
