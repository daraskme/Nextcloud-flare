import {
  type Account,
  ApiError,
  api,
  errorMessage,
  type FileNode,
  type Operation,
  type Part,
  type UploadReceipt,
} from "../../lib/api";
import {
  clearUploads,
  fingerprint,
  removeUpload,
  saveUpload,
  storedUploads,
  type UploadRecord,
} from "../../lib/uploadStore";

export interface UploadTask {
  record: UploadRecord;
  phase: "queued" | "uploading" | "checking" | "completing" | "paused" | "completed" | "cancelled";
  bytes: number;
  message: string;
}
const terminal = new Set(["failed", "aborting", "aborted", "expired"]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 1000));

export class UploadManager {
  #tasks: UploadTask[] = [];
  #listeners = new Set<() => void>();
  #controllers = new Map<string, AbortController>();
  #generation = 0;
  #loaded: string | undefined;
  onCompleted: () => void = () => {};
  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };
  snapshot = () => this.#tasks;
  #notify() {
    this.#tasks = [...this.#tasks];
    for (const fn of this.#listeners) fn();
  }
  #update(task: UploadTask, values: Partial<Omit<UploadTask, "record">>) {
    if (!this.#tasks.includes(task)) return;
    Object.assign(task, values);
    this.#notify();
  }
  get active() {
    return this.#controllers.size > 0;
  }

  async #assertTarget(record: UploadRecord) {
    if (!record.target) return;
    const current = await api.request<FileNode & { parentId: string; spaceId: string }>(
      `/api/v1/nodes/${encodeURIComponent(record.target.id)}`,
    );
    if (
      current.id !== record.target.id ||
      current.kind !== "file" ||
      current.spaceId !== record.spaceId ||
      current.parentId !== record.parentId ||
      current.name !== record.name ||
      current.revision !== record.target.revision ||
      current.currentBlobId !== record.target.blobId
    )
      throw new Error(
        "上書き先が変更されています。この送信を中止し、一覧を更新して選び直してください。",
      );
  }

  async load(account: Account) {
    const scope = `${account.id}:${account.epoch}`;
    if (this.#loaded === scope) return;
    const generation = ++this.#generation;
    this.#loaded = scope;
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
    this.#tasks = [];
    this.#notify();
    let records: UploadRecord[];
    try {
      records = await storedUploads();
    } catch (error) {
      if (generation === this.#generation) this.#loaded = undefined;
      throw error;
    }
    if (generation !== this.#generation) return;
    for (const record of records) {
      if (generation !== this.#generation) return;
      if (
        record.accountId !== account.id ||
        record.epoch !== account.epoch ||
        record.expiresAt < Date.now()
      ) {
        await removeUpload(record.localId);
        continue;
      }
      if (!this.#tasks.some((task) => task.record.localId === record.localId))
        this.#tasks.push({
          record,
          phase: "paused",
          bytes: 0,
          message: "同じファイルを選び直して続けられます",
        });
    }
    this.#notify();
  }

  async enqueue(file: File, account: Account, parentId: string, replacement?: FileNode) {
    if (this.#tasks.filter((task) => !["completed", "cancelled"].includes(task.phase)).length >= 32)
      throw new Error("同時に待機できるファイルは32件までです。");
    if (file.size > 536_870_912_000) throw new Error("1ファイルの上限は500 GBです。");
    if (
      replacement &&
      (replacement.kind !== "file" ||
        !replacement.currentBlobId ||
        !Number.isSafeInteger(replacement.revision) ||
        replacement.revision < 1)
    )
      throw new Error("上書き先を確認できません。一覧を更新して選び直してください。");
    const generation = this.#generation;
    const record: UploadRecord = {
      localId: crypto.randomUUID(),
      accountId: account.id,
      epoch: account.epoch,
      spaceId: account.spaceId,
      parentId,
      name: replacement?.name ?? file.name,
      sourceName: file.name,
      ...(replacement
        ? {
            target: {
              id: replacement.id,
              revision: replacement.revision,
              blobId: replacement.currentBlobId!,
            },
          }
        : {}),
      size: file.size,
      modified: file.lastModified,
      sample: await fingerprint(file),
      expiresAt: Date.now() + 86_400_000,
      createKey: crypto.randomUUID(),
      completeKey: crypto.randomUUID(),
      mode: file.size <= 95_000_000 ? "single" : "multipart",
      attempts: {},
    };
    if (generation !== this.#generation) return;
    // Early feedback only. The server still fences every transfer and final commit.
    await this.#assertTarget(record);
    if (generation !== this.#generation) return;
    await saveUpload(record);
    if (generation !== this.#generation) {
      await removeUpload(record.localId);
      return;
    }
    const task: UploadTask = { record, phase: "queued", bytes: 0, message: "送信を準備しています" };
    this.#tasks.push(task);
    this.#notify();
    void this.resume(task, file);
  }

  async resume(task: UploadTask, file: File) {
    const record = task.record;
    const generation = this.#generation;
    if (this.#controllers.has(record.localId)) return;
    if (
      file.name !== (record.sourceName ?? record.name) ||
      file.size !== record.size ||
      file.lastModified !== record.modified ||
      (await fingerprint(file)) !== record.sample
    ) {
      this.#update(task, {
        phase: "paused",
        message: "名前・サイズ・更新日時・内容が一致する元のファイルを選んでください",
      });
      return;
    }
    if (generation !== this.#generation || !this.#tasks.includes(task)) return;
    const controller = new AbortController();
    this.#controllers.set(record.localId, controller);
    const current = () => {
      controller.signal.throwIfAborted();
      if (generation !== this.#generation) throw new DOMException("Session ended", "AbortError");
    };
    try {
      if (!navigator.locks) throw new Error("このブラウザーでは安全な再開に対応していません。");
      await navigator.locks.request("ncf-transfer-lane", { signal: controller.signal }, async () =>
        navigator.locks.request(
          `ncf-upload:${record.localId}`,
          { ifAvailable: true },
          async (lock) => {
            current();
            if (!lock) throw new Error("別のタブでアップロードしています。");
            this.#update(task, { phase: "checking", message: "保存済みの状態を確認しています" });
            if (!record.uploadId || !record.capability) {
              const receipt = await api.json<UploadReceipt & { capability: string }>(
                "/api/v1/uploads",
                "POST",
                {
                  mode: record.mode,
                  spaceId: record.spaceId,
                  parentId: record.parentId,
                  name: record.name,
                  declared_size: record.size,
                  ...(record.target
                    ? { targetId: record.target.id, targetRevision: record.target.revision }
                    : {}),
                },
                record.createKey,
              );
              if (generation !== this.#generation) return;
              record.uploadId = receipt.id;
              record.capability = receipt.capability;
              record.expiresAt = receipt.expiresAt;
              await saveUpload(record);
            }
            current();
            const headers = { "Upload-Capability": record.capability };
            const contentHeaders = record.target
              ? { ...headers, "If-Match": `"b-${record.target.blobId}"` }
              : headers;
            const base = `/api/v1/uploads/${encodeURIComponent(record.uploadId)}`;
            let receipt = await api.request<UploadReceipt>(base, { headers });
            current();
            if (terminal.has(receipt.state))
              throw new Error(
                "この送信は停止済みです。中止を確認してから新しくアップロードしてください。",
              );
            if (receipt.state === "completed") return this.#complete(task);
            await this.#assertTarget(record);
            current();
            if (controller.signal.aborted) return;
            this.#update(task, { phase: "uploading", message: "アップロード中" });
            if (record.mode === "single") {
              if (receipt.state === "created" && !record.singleDispatched) {
                record.singleDispatched = true;
                await saveUpload(record);
                current();
                try {
                  await api.request<UploadReceipt>(
                    `${base}/content`,
                    {
                      method: "PUT",
                      headers: contentHeaders,
                      body: file,
                      signal: controller.signal,
                    },
                    900_000,
                  );
                } catch (error) {
                  if (controller.signal.aborted) throw error;
                  if (
                    record.target &&
                    error instanceof ApiError &&
                    [409, 412, 423, 428].includes(error.status)
                  )
                    throw error;
                }
              }
              current();
              receipt = await api.request<UploadReceipt>(base, { headers });
              if (!["uploading", "completing", "completed"].includes(receipt.state))
                throw new Error(
                  "送信結果が未確認です。ファイルを再送せず、時間をおいて再確認してください。",
                );
              this.#update(task, { bytes: file.size });
            } else if (receipt.state !== "completing") {
              const parts = new Map<number, Part>();
              const revision = receipt.revision;
              let page = receipt;
              for (;;) {
                current();
                if (page.revision !== revision || page.state !== receipt.state)
                  throw new Error("送信状態が変わりました。もう一度確認してください。");
                for (const part of page.parts ?? []) parts.set(part.partNumber, part);
                if (page.nextAfter == null) break;
                page = await api.request<UploadReceipt>(
                  `${base}?after=${page.nextAfter}&limit=200`,
                  { headers },
                );
              }
              const count = receipt.partCount,
                partBytes = receipt.partBytes;
              if (!count || !partBytes || count > 10000)
                throw new Error("アップロードの分割情報を取得できません。");
              let next = 1,
                confirmed = [...parts.values()]
                  .filter((part) => part.state === "completed")
                  .reduce((sum, part) => sum + part.expectedBytes, 0);
              this.#update(task, { bytes: confirmed });
              const send = async () => {
                while (next <= count && !controller.signal.aborted) {
                  const number = next++;
                  const part = parts.get(number);
                  if (part?.state === "completed") continue;
                  if (part?.state === "unknown")
                    throw new Error(
                      "送信結果が不明のため停止しました。中止してから再度お試しください。",
                    );
                  const attempt =
                    part?.state === "in_flight" && part.attemptId
                      ? part.attemptId
                      : (record.attempts[number] ?? crypto.randomUUID());
                  record.attempts[number] = attempt;
                  await saveUpload(record);
                  current();
                  let result: { disposition: string } | undefined;
                  try {
                    result = await api.request(
                      `${base}/parts/${number}`,
                      {
                        method: "PUT",
                        headers: { ...contentHeaders, "Upload-Attempt-Id": attempt },
                        body: file.slice(
                          (number - 1) * partBytes,
                          Math.min(file.size, number * partBytes),
                        ),
                        signal: controller.signal,
                      },
                      900_000,
                    );
                  } catch (error) {
                    if (controller.signal.aborted) throw error;
                    if (
                      record.target &&
                      error instanceof ApiError &&
                      [409, 412, 423, 428].includes(error.status)
                    )
                      throw error;
                  }
                  current();
                  if (result?.disposition === "not_started") {
                    delete record.attempts[number];
                    await saveUpload(record);
                    throw new Error("送信は開始されませんでした。同じファイルで再試行できます。");
                  }
                  if (result?.disposition !== "completed") {
                    let done = false;
                    for (let i = 0; i < 5 && !controller.signal.aborted; i++) {
                      await tick();
                      current();
                      const status = await api.request<UploadReceipt>(
                        `${base}?after=${number - 1}&limit=1`,
                        { headers },
                      );
                      if (
                        status.parts?.[0]?.partNumber === number &&
                        status.parts[0].state === "completed"
                      ) {
                        done = true;
                        break;
                      }
                    }
                    if (!done)
                      throw new Error(
                        "送信結果を確認中です。時間をおいて同じファイルで再確認してください。",
                      );
                  }
                  confirmed += Math.min(partBytes, file.size - (number - 1) * partBytes);
                  this.#update(task, { bytes: confirmed });
                }
              };
              const results = await Promise.allSettled(
                Array.from({ length: Math.min(4, count) }, send),
              );
              const failed = results.find((result) => result.status === "rejected");
              if (failed?.status === "rejected") throw failed.reason;
            }
            if (controller.signal.aborted) return;
            this.#update(task, { phase: "completing", message: "ファイルを確定しています" });
            const operation = await api.json<Operation>(
              `${base}/complete`,
              "POST",
              {},
              record.completeKey,
              headers,
            );
            if (operation.state !== "committed")
              throw new ApiError(503, "commit_unknown", operation.id);
            current();
            await this.#complete(task);
          },
        ),
      );
    } catch (error) {
      if (!controller.signal.aborted)
        this.#update(task, {
          phase: "paused",
          message:
            error instanceof ApiError
              ? errorMessage(error)
              : error instanceof Error &&
                  !["TypeError", "AbortError", "TimeoutError"].includes(error.name)
                ? error.message
                : errorMessage(error),
        });
    } finally {
      this.#controllers.delete(record.localId);
      this.#notify();
    }
  }

  async #complete(task: UploadTask) {
    await removeUpload(task.record.localId);
    this.#update(task, {
      phase: "completed",
      bytes: task.record.size,
      message: "アップロード完了",
    });
    this.onCompleted();
  }
  async cancel(task: UploadTask) {
    this.#controllers.get(task.record.localId)?.abort();
    const record = task.record;
    try {
      if (record.uploadId && record.capability)
        await api.json(
          `/api/v1/uploads/${encodeURIComponent(record.uploadId)}`,
          "DELETE",
          {},
          undefined,
          { "Upload-Capability": record.capability },
        );
      else if (task.phase !== "queued")
        throw new Error("作成結果を確認するため、同じファイルを選び直してください。");
      await removeUpload(record.localId);
      this.#update(task, {
        phase: "cancelled",
        message: "中止を受け付けました。使用容量は回収後に反映されます",
      });
      this.onCompleted();
    } catch (error) {
      this.#update(task, { phase: "paused", message: errorMessage(error) });
    }
  }
  dismiss() {
    this.#tasks = this.#tasks.filter((task) => !["completed", "cancelled"].includes(task.phase));
    this.#notify();
  }
  async clear() {
    this.#generation++;
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
    this.#tasks = [];
    this.#loaded = undefined;
    this.#notify();
    await clearUploads();
  }
}
export const uploads = new UploadManager();
