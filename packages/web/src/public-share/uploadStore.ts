import type { SharedNode } from "./client";

export interface PublicUploadRecord {
  id: string;
  shareId: string;
  sessionId: string;
  expiresAt: number;
  parentId: string | null;
  name: string;
  sourceName: string;
  size: number;
  modified: number;
  sample: string;
  mode: "single" | "multipart";
  uploadOnly?: true;
  target?: { id: string; revision: number; blobId: string };
  createKey: string;
  completeKey: string;
  uploadId?: string;
  capability?: string;
  singleDispatched: boolean;
  completeRequested: boolean;
  operationId?: string;
  attempts: Record<string, string>;
}
const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function validPublicUpload(value: unknown): value is PublicUploadRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as PublicUploadRecord;
  return (
    id(r.id) &&
    id(r.shareId) &&
    id(r.sessionId) &&
    id(r.createKey) &&
    id(r.completeKey) &&
    Number.isSafeInteger(r.expiresAt) &&
    r.expiresAt > 0 &&
    (r.uploadOnly === undefined || r.uploadOnly === true) &&
    (r.uploadOnly
      ? r.parentId === null && r.target === undefined && r.operationId === undefined
      : r.parentId === null
        ? !!r.target
        : id(r.parentId)) &&
    typeof r.name === "string" &&
    r.name.length > 0 &&
    r.name.length <= 255 &&
    typeof r.sourceName === "string" &&
    r.sourceName.length > 0 &&
    r.sourceName.length <= 255 &&
    Number.isSafeInteger(r.size) &&
    r.size >= 0 &&
    r.size <= 536870912000 &&
    Number.isSafeInteger(r.modified) &&
    r.modified >= 0 &&
    /^[a-f0-9]{64}$/.test(r.sample) &&
    (r.mode === "single" ? r.size <= 95000000 : r.mode === "multipart" && r.size > 0) &&
    (!r.target ||
      (id(r.target.id) &&
        id(r.target.blobId) &&
        Number.isSafeInteger(r.target.revision) &&
        r.target.revision > 0)) &&
    (r.uploadId === undefined
      ? r.capability === undefined
      : /^up_[a-f0-9]{64}$/.test(r.uploadId) &&
        typeof r.capability === "string" &&
        /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$/.test(r.capability)) &&
    (r.operationId === undefined || /^op_[a-f0-9]{64}$/.test(r.operationId)) &&
    typeof r.singleDispatched === "boolean" &&
    typeof r.completeRequested === "boolean" &&
    !!r.attempts &&
    typeof r.attempts === "object" &&
    !Array.isArray(r.attempts) &&
    Object.keys(r.attempts).length <= 10000 &&
    Object.entries(r.attempts).every(
      ([number, attempt]) =>
        /^[1-9][0-9]{0,4}$/.test(number) && Number(number) <= 10000 && id(attempt),
    )
  );
}
export async function fileSample(file: File): Promise<string> {
  const first = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(65536, file.size - 65536)).arrayBuffer());
  const bytes = new Uint8Array(first.length + last.length);
  bytes.set(first);
  bytes.set(last, first.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function newPublicUpload(
  shareId: string,
  sessionId: string,
  expiresAt: number,
  parentId: string | null,
  file: File,
  target?: SharedNode,
  uploadOnly = false,
): Promise<PublicUploadRecord> {
  const record: PublicUploadRecord = {
    id: crypto.randomUUID(),
    shareId,
    sessionId,
    expiresAt: Math.min(expiresAt, Date.now() + (file.size <= 95000000 ? 86400000 : 6 * 86400000)),
    parentId,
    name: target?.name ?? file.name,
    sourceName: file.name,
    size: file.size,
    modified: file.lastModified,
    sample: await fileSample(file),
    mode: file.size <= 95000000 ? "single" : "multipart",
    ...(uploadOnly ? { uploadOnly: true as const } : {}),
    ...(target
      ? { target: { id: target.id, revision: target.revision, blobId: target.currentBlobId! } }
      : {}),
    createKey: crypto.randomUUID(),
    completeKey: crypto.randomUUID(),
    singleDispatched: false,
    completeRequested: false,
    attempts: {},
  };
  if (!validPublicUpload(record))
    throw new Error("ファイルと保存先を確認してください。1ファイルの上限は500 GiBです。");
  return record;
}

let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ncf-public-uploads", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("uploads"))
        request.result.createObjectStore("uploads", { keyPath: "id" });
      request.result.createObjectStore("closed_sessions");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = request.onblocked = () => {
      database = undefined;
      reject(new Error("転送記録を保存できません。ブラウザーの保存設定を確認してください。"));
    };
  }));
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(["uploads", "closed_sessions"], mode),
      request = action(tx.objectStore("uploads"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () =>
      reject(new Error("転送記録を保存できません。時間をおいて再確認してください。"));
  });
}
let writes: Promise<unknown> = Promise.resolve();
function write<T>(action: (store: IDBObjectStore) => IDBRequest<T>) {
  const next = writes.catch(() => {}).then(() => transaction("readwrite", action));
  writes = next;
  return next.then(() => {});
}
export const publicUploadStore = {
  async read(id: string) {
    await writes.catch(() => {});
    const value: unknown = await transaction("readonly", (store) => store.get(id));
    if (value !== undefined && !validPublicUpload(value))
      throw new Error("保存された転送記録を確認できません。");
    return value as PublicUploadRecord | undefined;
  },
  save(record: PublicUploadRecord) {
    if (!validPublicUpload(record)) throw new Error("保存された転送記録を確認できません。");
    const copy = structuredClone(record);
    return write((store) => {
      const closed = store.transaction.objectStore("closed_sessions").get(copy.sessionId);
      closed.onsuccess = () => {
        // Atomic across tabs: logout wins even when a suspended tab receives a late response.
        if (closed.result !== undefined || copy.expiresAt <= Date.now()) store.transaction.abort();
        else store.put(copy);
      };
      return closed;
    });
  },
  remove(id: string) {
    return write((store) => store.delete(id));
  },
};
async function cleanPublicUploads(shareId: string, sessionId?: string, closingSession?: string) {
  const result: PublicUploadRecord[] = [];
  await write((store) => {
    const closed = store.transaction.objectStore("closed_sessions"),
      now = Date.now();
    // The server's maximum unlock lifetime is seven days; no file/capability is retained here.
    const close = (session: string) => closed.put(now + 7 * 86400000, session);
    const expired = closed.openCursor();
    expired.onsuccess = () => {
      const cursor = expired.result;
      if (!cursor) return;
      if (cursor.value <= now) cursor.delete();
      cursor.continue();
    };
    if (closingSession) close(closingSession);
    const rows = store.getAll();
    rows.onsuccess = () => {
      for (const row of rows.result as unknown[]) {
        if (!validPublicUpload(row)) {
          if (row && typeof row === "object" && "id" in row && typeof row.id === "string")
            store.delete(row.id);
        } else if (row.shareId === shareId && row.sessionId !== sessionId) {
          close(row.sessionId);
          store.delete(row.id);
        } else if (row.expiresAt <= now) store.delete(row.id);
        else if (row.shareId === shareId) result.push(row);
      }
    };
    return rows;
  });
  return result;
}
export const listPublicUploads = (shareId: string, sessionId: string) =>
  cleanPublicUploads(shareId, sessionId);
/** Called only after server logout or expiration; a page reload keeps the transfer receipts. */
export const forgetPublicUploads = (shareId: string, sessionId?: string) =>
  cleanPublicUploads(shareId, undefined, sessionId).then(() => {});
