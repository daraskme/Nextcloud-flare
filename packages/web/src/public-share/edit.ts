import { type EditOperation, type PublicClient, PublicError } from "./client";
import {
  editLock,
  type PublicEditRecord,
  publicEditStore,
  samePublicEdit,
  validPublicEdit,
} from "./editStore";

export function editMessage(error: unknown, remove = false) {
  if (error instanceof PublicError) {
    if (error.status === 423) return "この項目はロックされています。解除後にお試しください。";
    if (error.status === 413 && remove)
      return "項目が多すぎます。一度に移動できるのは、フォルダー自身を含め1,000件までです。小分けにしてお試しください。";
    if (error.status === 409)
      return remove
        ? "別の操作と競合しています。一覧を更新し、現在の内容を確認してください。"
        : "同じ名前の項目があるか、別の操作と競合しています。名前を確認してください。";
    if (error.status === 429) return "しばらく待ってから、もう一度お試しください。";
    if (error.status === 400)
      return "名前を確認してください。使用できない文字や長すぎる名前は保存できません。";
  }
  if (!(error instanceof PublicError) && error instanceof Error && error.name === "Error")
    return error.message;
  return "結果を確認できませんでした。少し待ってから「結果を確認」を押してください。";
}
function operation(value: EditOperation, record: PublicEditRecord) {
  const invalid = () =>
    new Error("操作の結果を確認できませんでした。保存済みの記録から再確認してください。");
  if (
    !value ||
    !/^op_[a-f0-9]{64}$/.test(value.id) ||
    (record.operationId !== undefined && record.operationId !== value.id) ||
    !["claimed", "committed", "failed"].includes(value.state)
  )
    throw invalid();
  if (value.state === "committed") {
    const result = value.result;
    if (
      !result ||
      result.status !==
        (record.intent.method === "POST" ? 201 : record.intent.method === "DELETE" ? 204 : 200)
    )
      throw invalid();
    // The server withholds node data after deletion or when the result is no longer readable.
    if (
      result.nodeId !== undefined &&
      (!/^[A-Za-z0-9_-]{1,128}$/.test(result.nodeId) ||
        (record.intent.method !== "POST" && record.intent.suffix !== `/nodes/${result.nodeId}`))
    )
      throw invalid();
  }
  return value;
}

/** The journal is durable before any request; recovered intents never acquire a new key/session. */
export async function runPublicEdit(
  client: PublicClient,
  original: PublicEditRecord,
  mode: "new" | "check",
  signal: AbortSignal,
  changed: (record: PublicEditRecord | null) => void,
  store: Pick<typeof publicEditStore, "read" | "save" | "remove"> = publicEditStore,
): Promise<EditOperation> {
  const current = () => {
    client.lifetime.signal.throwIfAborted();
    signal.throwIfAborted();
  };
  if (!validPublicEdit(original) || original.shareId !== client.id)
    throw new Error("操作の記録が共有と一致しません。");
  if (!navigator.locks) throw new Error("このブラウザーは操作の安全な再開に対応していません。");
  return navigator.locks.request(editLock(original.id), { ifAvailable: true }, async (lock) => {
    if (!lock)
      throw new Error("別のタブで操作を確認しています。少し待ってから再確認してください。");
    current();
    const existing = await store.read(original.id);
    if (mode === "new" ? existing !== undefined : !existing || !samePublicEdit(existing, original))
      throw new Error("確認記録が更新されました。保存済みの操作を確認してください。");
    let record = structuredClone(existing ?? original);
    if (record.expiresAt <= Date.now()) throw new PublicError(401);
    current();
    if (mode === "new") await store.save(record, true);
    current();
    changed(record);
    let result: EditOperation;
    try {
      result = operation(
        record.operationId
          ? await client.operation(record.operationId, record.intent.sessionId, signal)
          : await client.edit(record.intent, signal),
        record,
      );
    } catch (error) {
      current();
      if (error instanceof PublicError && error.operationId && record.operationId === undefined) {
        record = { ...record, operationId: error.operationId };
        await store.save(record);
        current();
        changed(record);
      } else if (
        mode === "new" &&
        error instanceof PublicError &&
        [400, 409, 413, 423, 429].includes(error.status) &&
        !error.operationId
      ) {
        await store.remove(record);
        current();
        changed(null);
      }
      throw error;
    }
    current();
    record = { ...record, operationId: result.id };
    await store.save(record);
    current();
    changed(record);
    if (result.state !== "claimed") {
      await store.remove(record);
      current();
      changed(null);
    }
    return result;
  });
}
