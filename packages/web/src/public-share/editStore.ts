import type { EditIntent } from "./client";

export interface PublicEditRecord {
  v: 1;
  id: string;
  shareId: string;
  expiresAt: number;
  label: string;
  kind: "folder" | "file";
  intent: EditIntent;
  operationId?: string;
}
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const name = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 255;
const fields = (value: object, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
export const editScope = (shareId: string, sessionId: string) => `${shareId}:${sessionId}`;
export const editLock = (scope: string) => `ncf-public-edit:${scope}`;
export function validPublicEdit(value: unknown): value is PublicEditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as PublicEditRecord,
    i = r.intent;
  if (
    !fields(r, ["v", "id", "shareId", "expiresAt", "label", "kind", "intent", "operationId"]) ||
    r.v !== 1 ||
    !id(r.shareId) ||
    !name(r.label) ||
    !["folder", "file"].includes(r.kind) ||
    !Number.isSafeInteger(r.expiresAt) ||
    r.expiresAt <= 0 ||
    !i ||
    typeof i !== "object" ||
    Array.isArray(i) ||
    !fields(i, ["key", "sessionId", "suffix", "method", "body"]) ||
    !id(i.key) ||
    !id(i.sessionId) ||
    r.id !== editScope(r.shareId, i.sessionId) ||
    (r.operationId !== undefined && !/^op_[a-f0-9]{64}$/.test(r.operationId)) ||
    !i.body ||
    typeof i.body !== "object" ||
    Array.isArray(i.body)
  )
    return false;
  const body = i.body as Record<string, unknown>;
  if (i.method === "POST")
    return (
      r.kind === "folder" &&
      i.suffix === "/nodes" &&
      fields(body, ["kind", "parentId", "name"]) &&
      body.kind === "folder" &&
      id(body.parentId) &&
      name(body.name)
    );
  if (!/^\/nodes\/[A-Za-z0-9_-]{1,128}$/.test(i.suffix)) return false;
  if (i.method === "PATCH") return fields(body, ["name"]) && name(body.name);
  return (
    i.method === "DELETE" &&
    fields(body, ["revision"]) &&
    Number.isSafeInteger(body.revision) &&
    (body.revision as number) > 0
  );
}
export function samePublicEdit(a: PublicEditRecord, b: PublicEditRecord) {
  const identity = (r: PublicEditRecord) =>
    JSON.stringify([
      r.v,
      r.id,
      r.shareId,
      r.expiresAt,
      r.label,
      r.kind,
      r.intent.key,
      r.intent.sessionId,
      r.intent.suffix,
      r.intent.method,
      Object.entries(r.intent.body).sort(([a], [b]) => a.localeCompare(b)),
    ]);
  return identity(a) === identity(b);
}
export function newPublicEdit(
  shareId: string,
  expiresAt: number,
  label: string,
  kind: "folder" | "file",
  intent: EditIntent,
): PublicEditRecord {
  const record: PublicEditRecord = {
    v: 1,
    id: editScope(shareId, intent.sessionId),
    shareId,
    expiresAt: Math.min(expiresAt, Date.now() + 7 * 86400000),
    label,
    kind,
    intent: structuredClone(intent),
  };
  if (!validPublicEdit(record)) throw new Error("操作と名前を確認してください。");
  return record;
}

const unavailable = () =>
  new Error("操作の確認記録を保存できません。ブラウザーの保存設定を確認してください。");
const changed = () => new Error("確認記録が更新されました。保存済みの操作を確認してください。");
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ncf-public-edits", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("edits", { keyPath: "id" });
      request.result.createObjectStore("closed_sessions");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = request.onblocked = () => reject(unavailable());
  }).catch(() => {
    database = undefined;
    throw unavailable();
  }));
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (
    edits: IDBObjectStore,
    closed: IDBObjectStore,
    result: (value: T) => void,
    fail: (error: Error) => void,
  ) => void,
): Promise<T> {
  const database = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(["edits", "closed_sessions"], mode);
    let value: T, error: Error | undefined;
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () => reject(error ?? unavailable());
    action(
      tx.objectStore("edits"),
      tx.objectStore("closed_sessions"),
      (v) => {
        value = v;
      },
      (reason) => {
        error = reason;
        tx.abort();
      },
    );
  }).catch((error: unknown) => {
    throw error instanceof Error && error.name === "Error" ? error : unavailable();
  });
}
export const publicEditStore = {
  read(scope: string) {
    return transaction<PublicEditRecord | undefined>("readonly", (edits, _closed, result, fail) => {
      const get = edits.get(scope);
      get.onsuccess = () => {
        if (get.result !== undefined && !validPublicEdit(get.result))
          return fail(new Error("保存された操作の確認記録を読み取れません。"));
        result(get.result);
      };
    });
  },
  save(record: PublicEditRecord, create = false) {
    if (!validPublicEdit(record)) throw new Error("保存された操作の確認記録を読み取れません。");
    const copy = structuredClone(record);
    return transaction<void>("readwrite", (edits, closed, _result, fail) => {
      const ending = closed.get(copy.id);
      ending.onsuccess = () => {
        if (ending.result !== undefined || copy.expiresAt <= Date.now())
          return fail(new Error("共有の有効期限が切れました。"));
        const get = edits.get(copy.id);
        get.onsuccess = () => {
          const previous: unknown = get.result;
          if (
            create
              ? previous !== undefined
              : !validPublicEdit(previous) ||
                !samePublicEdit(previous, copy) ||
                (previous.operationId !== undefined && previous.operationId !== copy.operationId)
          )
            return fail(changed());
          if (create) {
            const count = edits.count();
            count.onsuccess = () => {
              if (count.result >= 128)
                return fail(
                  new Error("保存できる確認記録の上限です。先の操作を確認してください。"),
                );
              edits.add(copy);
            };
          } else edits.put(copy);
        };
      };
    });
  },
  remove(record: PublicEditRecord) {
    return transaction<void>("readwrite", (edits, _closed, _result, fail) => {
      const get = edits.get(record.id);
      get.onsuccess = () => {
        if (get.result === undefined) return;
        if (!validPublicEdit(get.result) || !samePublicEdit(get.result, record))
          return fail(changed());
        edits.delete(record.id);
      };
    });
  },
  discard(scope: string) {
    return transaction<void>("readwrite", (edits, _closed, _result, fail) => {
      const get = edits.get(scope);
      get.onsuccess = () => {
        if (validPublicEdit(get.result)) return fail(changed());
        edits.delete(scope);
      };
    });
  },
};
async function clean(shareId: string, closingSession?: string) {
  await transaction<void>("readwrite", (edits, closed) => {
    const now = Date.now(),
      close = (scope: string) => closed.put(now + 7 * 86400000, scope);
    if (closingSession) close(editScope(shareId, closingSession));
    const ending = closed.openCursor();
    ending.onsuccess = () => {
      const cursor = ending.result;
      if (!cursor) return;
      if (cursor.value <= now) cursor.delete();
      cursor.continue();
    };
    const rows = edits.openCursor();
    rows.onsuccess = () => {
      const cursor = rows.result;
      if (!cursor) return;
      const r: unknown = cursor.value;
      // A corrupt current record remains visible as an error until explicitly discarded.
      if (closingSession && cursor.key === editScope(shareId, closingSession)) {
        close(cursor.key);
        cursor.delete();
      } else if (validPublicEdit(r) && r.expiresAt <= now) {
        close(r.id);
        cursor.delete();
      }
      cursor.continue();
    };
  });
}
export async function loadPublicEdit(shareId: string, sessionId: string) {
  // A stale tab must never erase a different, newer live session's pending operation.
  await clean(shareId);
  return publicEditStore.read(editScope(shareId, sessionId));
}
export const forgetPublicEdits = (shareId: string, sessionId?: string) => clean(shareId, sessionId);
