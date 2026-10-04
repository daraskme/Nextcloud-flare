import { base64url } from "jose";
import type { ContentKeyRing } from "./contentTokens";

export interface AdminCursor {
  kind: "users" | "audit";
  credentialId: string;
  epoch: number;
  lastId: string;
  lastTime: number;
  expiresAt: number;
}

export class AdminCursorTokens {
  constructor(readonly ring: ContentKeyRing) {}

  async issue(cursor: Omit<AdminCursor, "expiresAt">): Promise<string> {
    const kid = this.ring.activeKid;
    const key = this.ring.keys.get(kid);
    if (!key) throw new Error("invalid_admin_cursor");
    const body = base64url.encode(JSON.stringify({ ...cursor, expiresAt: Date.now() + 600_000 }));
    const message = `${kid}.${body}`;
    const signature = base64url.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))),
    );
    return `${message}.${signature}`;
  }

  async verify(
    token: string,
    kind: AdminCursor["kind"],
    credentialId: string,
    epoch: number,
  ): Promise<AdminCursor> {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        throw new Error();
      const [kid, body, signature] = token.split(".") as [string, string, string];
      const key = this.ring.keys.get(kid);
      if (
        !key ||
        base64url.encode(base64url.decode(body)) !== body ||
        base64url.encode(base64url.decode(signature)) !== signature
      )
        throw new Error();
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          key,
          base64url.decode(signature),
          new TextEncoder().encode(`${kid}.${body}`),
        ))
      )
        throw new Error();
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(base64url.decode(body)),
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const cursor = value as AdminCursor;
      if (
        Object.keys(cursor).sort().join(",") !==
          "credentialId,epoch,expiresAt,kind,lastId,lastTime" ||
        cursor.kind !== kind ||
        cursor.credentialId !== credentialId ||
        cursor.epoch !== epoch ||
        typeof cursor.lastId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(cursor.lastId) ||
        !Number.isSafeInteger(cursor.lastTime) ||
        cursor.lastTime < 0 ||
        !Number.isSafeInteger(cursor.expiresAt) ||
        cursor.expiresAt <= Date.now() ||
        cursor.expiresAt > Date.now() + 600_000 ||
        base64url.encode(JSON.stringify(cursor)) !== body
      )
        throw new Error();
      return cursor;
    } catch {
      throw new Error("invalid_admin_cursor");
    }
  }
}
