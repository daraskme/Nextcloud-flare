import { type EditOperation, type PublicClient, PublicError } from "./client";
import { fileSample, type PublicUploadRecord, publicUploadStore } from "./uploadStore";

interface Part {
  partNumber: number;
  state: "pending" | "in_flight" | "completed" | "unknown";
  expectedBytes: number;
  attempts: number;
  attemptId: string | null;
}
interface Receipt {
  id: string;
  mode: "single" | "multipart";
  state: string;
  declaredSize: number;
  expiresAt: number;
  operationId: string | null;
  partCount?: number;
  partBytes?: number;
  revision?: number;
  parts?: Part[];
  nextAfter?: number | null;
}
export interface UploadProgress {
  phase: "checking" | "uploading" | "completing" | "paused" | "completed" | "stopped";
  bytes: number;
  message: string;
}
const stopped = new Set(["aborting", "aborted", "expired", "failed"]);
const states = new Set([
  "created",
  "receiving",
  "uploading",
  "completing",
  "completed",
  ...stopped,
]);
const waiting = () =>
  new Error("送信結果を確認できません。再送せず、少し待って「結果を確認」を押してください。");
export function uploadMessage(error: unknown) {
  if (error instanceof PublicError) {
    if ([401, 403, 404, 412].includes(error.status))
      return "共有の状態や上書き先が変わりました。送信を止めて一覧を更新し、現在の内容を確認してください。";
    if (error.status === 423) return "保存先がロックされています。解除後に再確認してください。";
    if (error.status === 507)
      return "保存先の空き容量が不足しています。共有した方に確認してください。";
    if (error.status === 429) return "しばらく待ってから結果を確認してください。";
    if (error.status === 400 || error.status === 413)
      return "名前やファイルサイズを確認してください。";
    return waiting().message;
  }
  if (error instanceof Error && error.name === "Error") return error.message;
  return waiting().message;
}

/** Durable intent before dispatch. The caller's file stays in memory and is never stored. */
export async function transferPublicUpload(
  client: PublicClient,
  original: PublicUploadRecord,
  action: "continue" | "check" | "cancel",
  file: File | undefined,
  signal: AbortSignal,
  progress: (value: UploadProgress) => void,
  store: Pick<typeof publicUploadStore, "read" | "save" | "remove"> = publicUploadStore,
) {
  const current = () => {
    client.lifetime.signal.throwIfAborted();
    signal.throwIfAborted();
  };
  if (!navigator.locks)
    throw new Error("このブラウザーは安全なアップロードの再開に対応していません。");
  await navigator.locks.request(
    `ncf-public-upload:${original.id}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error("別のタブでこの送信を確認しています。少し待ってから再確認してください。");
      current();
      const r = await store.read(original.id);
      if (
        !r ||
        r.sessionId !== original.sessionId ||
        r.shareId !== client.id ||
        r.uploadOnly !== original.uploadOnly
      )
        throw new Error("転送記録が更新されました。一覧を更新してください。");
      current();
      if (r.expiresAt <= Date.now())
        throw new Error("送信の有効期限が切れました。一覧を確認してから新しく送信してください。");
      if (
        file &&
        (file.name !== r.sourceName ||
          file.size !== r.size ||
          file.lastModified !== r.modified ||
          (await fileSample(file)) !== r.sample)
      )
        throw new Error("名前・サイズ・更新日時・内容が一致する元のファイルを選択してください。");
      const save = async () => {
        current();
        await store.save(r);
        current();
      };
      let bytes = 0;
      const update = (phase: UploadProgress["phase"], message: string) => {
        current();
        progress({ phase, bytes, message });
      };
      const terminal = async (complete: boolean, message: string) => {
        current();
        await store.remove(r.id);
        current();
        if (complete) bytes = r.size;
        update(complete ? "completed" : "stopped", message);
      };
      update("checking", "保存済みの状態を確認しています");
      if (!r.uploadId) {
        const receipt = await client.uploadJson<Receipt & { capability: string }>(
          r.sessionId,
          "/uploads",
          "POST",
          {
            mode: r.mode,
            ...(r.parentId ? { parentId: r.parentId } : {}),
            name: r.name,
            declared_size: r.size,
            ...(r.target ? { targetId: r.target.id, targetRevision: r.target.revision } : {}),
          },
          { "Idempotency-Key": r.createKey },
          signal,
          r.uploadOnly,
        );
        current();
        if (
          !/^up_[a-f0-9]{64}$/.test(receipt.id) ||
          !/^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$/.test(receipt.capability) ||
          (!r.uploadOnly &&
            (receipt.mode !== r.mode ||
              receipt.declaredSize !== r.size ||
              !Number.isSafeInteger(receipt.expiresAt)))
        )
          throw waiting();
        r.uploadId = receipt.id;
        r.capability = receipt.capability;
        if (!r.uploadOnly) r.expiresAt = Math.min(r.expiresAt, receipt.expiresAt);
        await save();
      }
      const base = `/uploads/${r.uploadId}`;
      const headers = { "Upload-Capability": r.capability!, "Share-Session": r.sessionId };
      const read = async (query = "") => {
        const receipt = await client.request<Receipt>(
          base + query,
          "GET",
          undefined,
          undefined,
          headers,
          undefined,
          signal,
        );
        current();
        if (
          receipt.id !== r.uploadId ||
          receipt.mode !== r.mode ||
          receipt.declaredSize !== r.size ||
          (r.uploadOnly && receipt.operationId !== null) ||
          !states.has(receipt.state)
        )
          throw waiting();
        return receipt;
      };
      let receipt = await read();
      const completedMessage = r.uploadOnly
        ? `送信が完了しました。受付番号: ${r.uploadId}`
        : "アップロードが完了しました。";
      if (receipt.state === "completed") return terminal(true, completedMessage);
      if (stopped.has(receipt.state))
        return terminal(false, "送信は停止済みです。使用容量は回収後に反映されます。");
      if (action === "cancel") {
        const stoppedReceipt = await client.uploadJson<Receipt>(
          r.sessionId,
          base,
          "DELETE",
          {},
          headers,
          signal,
        );
        if (stoppedReceipt.id !== r.uploadId || !stopped.has(stoppedReceipt.state)) throw waiting();
        return terminal(false, "中止を受け付けました。使用容量は回収後に反映されます。");
      }
      const operation = async (op: EditOperation) => {
        if (
          !/^op_[a-f0-9]{64}$/.test(op.id) ||
          !["claimed", "committed", "failed"].includes(op.state)
        )
          throw waiting();
        if (r.operationId && r.operationId !== op.id) throw waiting();
        r.operationId = op.id;
        await save();
        if (op.state === "committed") await terminal(true, "アップロードが完了しました。");
        else if (op.state === "failed")
          await terminal(
            false,
            "保存は完了しませんでした。一覧を確認してから、改めて送信してください。",
          );
        else update("paused", "保存処理を確認中です。少し待ってから結果を確認してください。");
      };
      if (!r.uploadOnly && receipt.operationId && !r.operationId) {
        if (!/^op_[a-f0-9]{64}$/.test(receipt.operationId)) throw waiting();
        r.operationId = receipt.operationId;
        await save();
      }
      if (!r.uploadOnly && r.operationId)
        return operation(await client.operation(r.operationId, r.sessionId, signal));
      const readParts = async () => {
        const count = receipt.partCount!,
          partBytes = receipt.partBytes!,
          revision = receipt.revision;
        if (
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 10000 ||
          !Number.isSafeInteger(partBytes) ||
          partBytes < 8388608 ||
          partBytes > 94371840 ||
          Math.ceil(r.size / partBytes) !== count ||
          !Number.isSafeInteger(revision)
        )
          throw waiting();
        const parts = new Map<number, Part>();
        let after = 0;
        for (;;) {
          if (
            receipt.revision !== revision ||
            receipt.partCount !== count ||
            receipt.partBytes !== partBytes ||
            !["created", "uploading"].includes(receipt.state) ||
            !Array.isArray(receipt.parts) ||
            receipt.parts.length > 200
          )
            throw waiting();
          for (const p of receipt.parts) {
            if (
              !Number.isSafeInteger(p.partNumber) ||
              p.partNumber <= after ||
              p.partNumber > count ||
              p.expectedBytes !== Math.min(partBytes, r.size - (p.partNumber - 1) * partBytes) ||
              !["pending", "in_flight", "completed", "unknown"].includes(p.state) ||
              !Number.isInteger(p.attempts) ||
              p.attempts < 0 ||
              p.attempts > 3
            )
              throw waiting();
            after = p.partNumber;
            parts.set(after, p);
          }
          if (receipt.nextAfter === null) break;
          if (receipt.nextAfter !== after || after === 0 || after >= count) throw waiting();
          receipt = await read(`?after=${after}&limit=200`);
        }
        bytes = [...parts.values()]
          .filter((p) => p.state === "completed")
          .reduce((n, p) => n + p.expectedBytes, 0);
        return { parts, count, partBytes };
      };
      if (receipt.state === "completing") bytes = r.size;
      if (action === "check" && !r.completeRequested) {
        if (r.mode === "multipart" && receipt.state !== "completing") await readParts();
        update(
          "paused",
          receipt.state === "completing"
            ? "送信済みです。「再開する」で保存を確定できます。"
            : "状態を確認しました。元のファイルを選択し「再開する」を押してください。",
        );
        return;
      }
      if (!r.completeRequested && receipt.state !== "completing") {
        if (!file) throw new Error("元のファイルを選択してから「再開する」を押してください。");
        const contentHeaders = {
          ...headers,
          ...(r.target ? { "If-Match": `"b-${r.target.blobId}"` } : {}),
        };
        update("uploading", "アップロード中です。この画面を開いたままお待ちください。");
        if (r.mode === "single") {
          if (receipt.state !== "created" || r.singleDispatched) throw waiting();
          r.singleDispatched = true;
          await save();
          await client.uploadBytes(base + "/content", file, contentHeaders, signal, r.uploadOnly);
          receipt = await read();
          if (receipt.state !== "completing") throw waiting();
          bytes = r.size;
        } else {
          const { parts, count, partBytes } = await readParts();
          if ([...parts.values()].some((p) => p.state === "in_flight" || p.state === "unknown"))
            throw waiting();
          update("uploading", "完了済みの部分を除いて送信しています。");
          let next = 1,
            halted = false;
          const send = async () => {
            try {
              while (next <= count && !halted) {
                current();
                const number = next++,
                  p = parts.get(number) ?? {
                    state: "pending",
                    attempts: 0,
                    attemptId: null,
                    expectedBytes: Math.min(partBytes, r.size - (number - 1) * partBytes),
                  };
                if (p.state === "completed") continue;
                // D1 pending with a recorded attempt proves the preceding call did not start.
                if (p.attempts >= 3)
                  throw new Error(
                    "送信回数の上限に達しました。中止してから新しく送信してください。",
                  );
                if (p.attemptId && p.attemptId === r.attempts[number]) delete r.attempts[number];
                const attempt = r.attempts[number] ?? crypto.randomUUID();
                r.attempts[number] = attempt;
                await save();
                const result = await client.uploadBytes<{ disposition: string }>(
                  `${base}/parts/${number}`,
                  file.slice((number - 1) * partBytes, Math.min(r.size, number * partBytes)),
                  { ...contentHeaders, "Upload-Attempt-Id": attempt },
                  signal,
                  r.uploadOnly,
                );
                current();
                if (result.disposition !== "completed") throw waiting();
                bytes += p.expectedBytes;
                update("uploading", "完了済みの部分を除いて送信しています。");
              }
            } catch (error) {
              halted = true;
              throw error;
            }
          };
          const results = await Promise.allSettled(
            Array.from({ length: Math.min(4, count) }, send),
          );
          const failed = results.find((v) => v.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
      }
      r.completeRequested = true;
      await save();
      update("completing", "ファイルを確定しています。");
      try {
        if (r.uploadOnly) {
          await client.uploadJson(
            r.sessionId,
            base + "/complete",
            "POST",
            {},
            { ...headers, "Idempotency-Key": r.completeKey },
            signal,
            true,
          );
          const result = await read();
          if (result.state === "completed") await terminal(true, completedMessage);
          else if (stopped.has(result.state))
            await terminal(false, "保存は完了しませんでした。共有した方に確認してください。");
          else update("paused", "保存処理を確認中です。少し待ってから結果を確認してください。");
          return;
        }
        await operation(
          await client.uploadJson<EditOperation>(
            r.sessionId,
            base + "/complete",
            "POST",
            {},
            { ...headers, "Idempotency-Key": r.completeKey },
            signal,
          ),
        );
      } catch (error) {
        if (!r.uploadOnly && error instanceof PublicError && error.operationId) {
          r.operationId = error.operationId;
          await save();
        }
        throw error;
      }
    },
  );
}
