import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../src/auth/httpAuth.js";
import { app } from "../../src/index.js";
import { createAppPassword, revokeAppPassword } from "../../src/services/appPasswords.js";
import { seedFoundation } from "../helpers/foundation.js";

const user: AuthenticatedUser = {
  email: "user@test.invalid",
  role: "member",
  principal: {
    kind: "user",
    principalId: "user",
    userId: "user",
    sessionId: "session",
    credentialId: "as:session",
    scopes: ["credential:manage"],
  },
};

function authorization(id: string, secret: string): string {
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

async function dav(
  credentials: { id: string; secret: string },
  path: string,
  method: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  return app.request(
    `https://app.test.invalid/dav${path}`,
    {
      method,
      headers: { Authorization: authorization(credentials.id, credentials.secret), ...headers },
      ...(body === undefined ? {} : { body }),
    },
    env,
  );
}

beforeEach(async () => {
  await seedFoundation();
});

describe("WebDAV Class 1/2", () => {
  it("serves all methods with app-password identity, conditions, properties and locks", async () => {
    const credentials = await createAppPassword(env, user, {
      label: "Test DAV",
      expiresInDays: 30,
    });

    const options = await dav(credentials, "", "OPTIONS");
    expect(options.status).toBe(204);
    expect(options.headers.get("DAV")).toBe("1, 2");

    const folder = await dav(credentials, "/Documents", "MKCOL");
    expect(folder.status).toBe(201);

    const created = await dav(
      credentials,
      "/Documents/hello.txt",
      "PUT",
      { "Content-Length": "5", "Content-Type": "text/plain" },
      "hello",
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("ETag")).toMatch(/^"b-blob_/u);

    const read = await dav(credentials, "/Documents/hello.txt", "GET", {
      Range: "bytes=1-3",
    });
    expect(read.status).toBe(206);
    await expect(read.text()).resolves.toBe("ell");

    const missingPrecondition = await dav(
      credentials,
      "/Documents/hello.txt",
      "PUT",
      { "Content-Length": "5" },
      "world",
    );
    expect(missingPrecondition.status).toBe(428);

    const propfind = await dav(credentials, "/Documents", "PROPFIND", { Depth: "1" });
    expect(propfind.status).toBe(207);
    const propfindXml = await propfind.text();
    expect(propfindXml).toContain("hello.txt");
    expect(propfindXml).toContain(created.headers.get("ETag")?.slice(1, -1));

    const patchXml =
      '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:color>blue&#33;</X:color></D:prop></D:set></D:propertyupdate>';
    const patched = await dav(
      credentials,
      "/Documents/hello.txt",
      "PROPPATCH",
      { "Content-Length": String(new TextEncoder().encode(patchXml).byteLength) },
      patchXml,
    );
    expect(patched.status).toBe(207);
    expect(await patched.text()).toContain("200 OK");

    const rejectedXml =
      '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><D:getetag>bad</D:getetag><X:other>no</X:other></D:prop></D:set></D:propertyupdate>';
    const rejected = await dav(
      credentials,
      "/Documents/hello.txt",
      "PROPPATCH",
      { "Content-Length": String(new TextEncoder().encode(rejectedXml).byteLength) },
      rejectedXml,
    );
    const rejectedBody = await rejected.text();
    expect(rejected.status).toBe(207);
    expect(rejectedBody).toContain("403 Forbidden");
    expect(rejectedBody).toContain("424 Failed Dependency");

    const lockXml =
      '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>test</D:owner></D:lockinfo>';
    const locked = await dav(
      credentials,
      "/Documents/hello.txt",
      "LOCK",
      {
        Depth: "0",
        Timeout: "Second-99999",
        "Content-Length": String(new TextEncoder().encode(lockXml).byteLength),
      },
      lockXml,
    );
    expect(locked.status).toBe(200);
    expect(await locked.text()).toContain("Second-3600");
    const lockToken = locked.headers.get("Lock-Token");
    expect(lockToken).toMatch(/^<opaquelocktoken:/u);

    const lockedPut = await dav(
      credentials,
      "/Documents/hello.txt",
      "PUT",
      {
        "Content-Length": "5",
        If: `(${lockToken ?? ""})`,
      },
      "world",
    );
    expect(lockedPut.status).toBe(204);
    expect(lockedPut.headers.get("ETag")).toMatch(/^"b-blob_/u);

    const unlocked = await dav(credentials, "/Documents/hello.txt", "UNLOCK", {
      "Lock-Token": lockToken ?? "",
    });
    expect(unlocked.status).toBe(204);

    const copied = await dav(credentials, "/Documents/hello.txt", "COPY", {
      Destination: "https://app.test.invalid/dav/Documents/copy.txt",
      Depth: "0",
      Overwrite: "F",
    });
    expect(copied.status).toBe(201);

    const moved = await dav(credentials, "/Documents/copy.txt", "MOVE", {
      Destination: "https://app.test.invalid/dav/Documents/moved.txt",
      Depth: "infinity",
      Overwrite: "F",
    });
    expect(moved.status).toBe(201);

    const removed = await dav(credentials, "/Documents/moved.txt", "DELETE");
    expect(removed.status).toBe(204);
    expect((await dav(credentials, "/Documents/moved.txt", "GET")).status).toBe(404);

    expect(
      (await dav(credentials, "/Documents/target.txt", "PUT", { "Content-Length": "3" }, "old"))
        .status,
    ).toBe(201);
    expect(
      (
        await dav(credentials, "/Documents/hello.txt", "COPY", {
          Destination: "https://app.test.invalid/dav/Documents/target.txt",
          Depth: "0",
          Overwrite: "T",
        })
      ).status,
    ).toBe(204);
    await expect((await dav(credentials, "/Documents/target.txt", "GET")).text()).resolves.toBe(
      "world",
    );
    expect(
      (
        await dav(
          credentials,
          "/Documents/move-target.txt",
          "PUT",
          { "Content-Length": "3" },
          "old",
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await dav(credentials, "/Documents/target.txt", "MOVE", {
          Destination: "https://app.test.invalid/dav/Documents/move-target.txt",
          Depth: "infinity",
          Overwrite: "T",
        })
      ).status,
    ).toBe(204);
    await expect(
      (await dav(credentials, "/Documents/move-target.txt", "GET")).text(),
    ).resolves.toBe("world");

    await revokeAppPassword(env, user, credentials.id);
    expect((await dav(credentials, "", "OPTIONS")).status).toBe(401);
  }, 15_000);

  it("applies the Unicode portable-name validator to PUT, MKCOL, and MOVE", async () => {
    const credentials = await createAppPassword(env, user, { label: "Unicode DAV" });
    expect((await dav(credentials, "/%E6%9B%B8%E9%A1%9E", "MKCOL")).status).toBe(201);
    expect(
      (
        await dav(
          credentials,
          "/%E6%9B%B8%E9%A1%9E/%E5%90%8C%E4%BA%BA%E8%AA%8C%20vol.1.cbz",
          "PUT",
          { "Content-Length": "0" },
          "",
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await dav(
          credentials,
          "/%E6%9B%B8%E9%A1%9E/%E5%90%8C%E4%BA%BA%E8%AA%8C%20vol.1.cbz",
          "MOVE",
          {
            Destination: "https://app.test.invalid/dav/%E6%9B%B8%E9%A1%9E/%F0%9F%93%9A.cbz",
            Overwrite: "F",
          },
        )
      ).status,
    ).toBe(201);
    expect((await dav(credentials, "/bad.", "MKCOL")).status).toBe(400);
    expect((await dav(credentials, "/bad.", "PUT", { "Content-Length": "0" }, "")).status).toBe(
      400,
    );
    expect(
      (
        await dav(credentials, "/%E6%9B%B8%E9%A1%9E/%F0%9F%93%9A.cbz", "MOVE", {
          Destination: "https://app.test.invalid/dav/%E6%9B%B8%E9%A1%9E/bad.",
          Overwrite: "F",
        })
      ).status,
    ).toBe(400);
  });

  it("creates a locked empty resource for a missing LOCK URL", async () => {
    const credentials = await createAppPassword(env, user, { label: "Lock null" });
    const lockXml =
      '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';
    const response = await dav(
      credentials,
      "/new-empty.txt",
      "LOCK",
      { "Content-Length": String(new TextEncoder().encode(lockXml).byteLength) },
      lockXml,
    );
    expect(response.status).toBe(201);
    const head = await dav(credentials, "/new-empty.txt", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("0");
  });
});
