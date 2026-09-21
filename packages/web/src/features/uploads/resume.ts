export interface UploadResumeRecord {
  fingerprint: string;
  uploadId: string;
  capability: string;
  parentId: string;
  name: string;
  size: number;
  lastModified: number;
  expiresAt: number;
}

const DATABASE = "ncf-uploads";
const STORE = "resumable";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "fingerprint" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function loadResume(fingerprint: string): Promise<UploadResumeRecord | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(fingerprint);
    request.onsuccess = () => resolve((request.result as UploadResumeRecord | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function saveResume(record: UploadResumeRecord): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function removeResume(fingerprint: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(fingerprint);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function fileFingerprint(file: File): Promise<string> {
  const sampleSize = 64 * 1024;
  const first = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(0, file.size - sampleSize)).arrayBuffer());
  const metadata = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}|`);
  const input = new Uint8Array(metadata.length + first.length + last.length);
  input.set(metadata);
  input.set(first, metadata.length);
  input.set(last, metadata.length + first.length);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
