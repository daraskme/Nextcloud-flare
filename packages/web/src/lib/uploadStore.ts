export interface UploadRecord {
  localId: string;
  accountId: string;
  epoch: number;
  spaceId: string;
  parentId: string;
  name: string;
  sourceName?: string;
  target?: { id: string; revision: number; blobId: string };
  size: number;
  modified: number;
  sample: string;
  expiresAt: number;
  createKey: string;
  completeKey: string;
  mode: "single" | "multipart";
  uploadId?: string;
  capability?: string;
  singleDispatched?: boolean;
  attempts: Record<string, string>;
}

let database: Promise<IDBDatabase> | undefined;
let writes: Promise<unknown> = Promise.resolve();
function db(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("ncf-uploads", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("uploads", { keyPath: "localId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("upload_storage_unavailable"));
  }));
}
function write(action: (store: IDBObjectStore) => void) {
  const result = writes
    .catch(() => {})
    .then(async () => {
      const database = await db();
      return new Promise<void>((resolve, reject) => {
        const tx = database.transaction("uploads", "readwrite");
        action(tx.objectStore("uploads"));
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error("upload_storage_unavailable"));
      });
    });
  writes = result;
  return result;
}
export const saveUpload = (record: UploadRecord) => {
  const copy = structuredClone(record);
  return write((store) => {
    store.put(copy);
  });
};
export const removeUpload = (id: string) =>
  write((store) => {
    store.delete(id);
  });
export const clearUploads = () =>
  write((store) => {
    store.clear();
  });
export async function storedUploads(): Promise<UploadRecord[]> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("uploads", "readonly").objectStore("uploads").getAll();
    request.onsuccess = () => resolve(request.result as UploadRecord[]);
    request.onerror = () => reject(new Error("upload_storage_unavailable"));
  });
}
export async function fingerprint(file: File): Promise<string> {
  const first = new Uint8Array(await file.slice(0, 65_536).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(65_536, file.size - 65_536)).arrayBuffer());
  const bytes = new Uint8Array(first.length + last.length);
  bytes.set(first);
  bytes.set(last, first.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
