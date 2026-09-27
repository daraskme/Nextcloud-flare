import {
  restoreBookmarkObservation,
  restoreBookmarkTimestamp,
} from "../../packages/shared/src/restoreBookmark.ts";
import { restoreFreezeTargets } from "../../packages/shared/src/restoreFreeze.ts";
import {
  restoreTimeTravelGrant,
  restoreTimeTravelResult,
} from "../../packages/shared/src/restoreTimeTravel.ts";
import { restoreStatus } from "./verify.mjs";

async function providerResult(response, timeoutMs) {
  let reader, timer;
  try {
    if (response.status !== 200 || !response.body)
      throw new Error("database_restore_provider_unknown");
    reader = response.body.getReader();
    return await Promise.race([
      (async () => {
        const bytes = new Uint8Array(16384);
        let count = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (count + part.value.byteLength > bytes.length)
            throw new Error("database_restore_provider_unknown");
          bytes.set(part.value, count);
          count += part.value.byteLength;
        }
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)),
        );
        if (value?.success !== true) throw new Error("database_restore_provider_unknown");
        return restoreTimeTravelResult({
          bookmark: value.result?.bookmark,
          previousBookmark: value.result?.previous_bookmark,
        });
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("database_restore_provider_unknown")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
    else void response.body?.cancel().catch(() => {});
  }
}

/** One fixed-origin POST. Transport errors/timeouts/readback never manufacture completion. */
export function timeTravelProvider(
  apiToken,
  { fetch: transport = fetch, timeoutMs = 60000, bodyTimeoutMs = 10000 } = {},
) {
  if (
    typeof apiToken !== "string" ||
    !/^[\x21-\x7e]{1,4096}$/.test(apiToken) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000 ||
    !Number.isSafeInteger(bodyTimeoutMs) ||
    bodyTimeoutMs < 1 ||
    bodyTimeoutMs > 10000
  )
    throw new Error("database_restore_provider_unconfigured");
  const dispatched = new Set();
  return async (input, onSuccess) => {
    const grant = restoreTimeTravelGrant(input),
      now = Date.now();
    if (
      typeof onSuccess !== "function" ||
      dispatched.has(grant.token) ||
      now < grant.issuedAt ||
      now >= grant.expiresAt
    )
      throw new Error("database_restore_dispatch_unavailable");
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${grant.targets.target.accountId}/d1/database/${grant.targets.target.databaseId}/time_travel/restore`,
    );
    url.searchParams.set("bookmark", grant.bookmark);
    const abort = new AbortController();
    let timer;
    dispatched.add(grant.token);
    try {
      return await Promise.race([
        (async () => {
          const response = await transport(url, {
            method: "POST",
            redirect: "manual",
            signal: abort.signal,
            headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
          });
          const result = await providerResult(response, bodyTimeoutMs);
          // A late native success can record its result, but it cannot authorize more work.
          await onSuccess(result);
          return result;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error("database_restore_provider_unknown"));
          }, timeoutMs);
        }),
      ]);
    } catch {
      // Never include provider bodies, URLs with credentials, transport errors or auth headers.
      throw new Error("database_restore_provider_unknown");
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function applyRestoreTimeTravel({ epoch, id, control, reader, timestamp, provider }) {
  restoreBookmarkTimestamp(timestamp, Date.now());
  const targets = restoreFreezeTargets({
    target: reader.target,
    blobs: reader.blobsTarget,
    backups: reader.backupsTarget,
  });
  await reader.assertUnchanged();
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.source.kind !== "time_travel")
    throw new Error("database_restore_dispatch_unavailable");
  // A durable successful receipt is safe to report. Pending must never acquire another grant.
  if (
    [
      "restore_written",
      "snapshot_checking",
      "snapshot_verified",
      "adoption_pending",
      "adoption_written",
      "epoch_adopted",
    ].includes(selected.state)
  )
    return selected;
  if (selected.state !== "epoch_reserved") throw new Error("database_restore_dispatch_unavailable");
  const observed = restoreBookmarkObservation(
    await reader.readBookmark(timestamp),
    selected.source.bookmark,
    Date.now(),
  );
  if (observed.timestamp !== timestamp) throw new Error("database_restore_bookmark_mismatch");
  const observedAt = Date.now();
  await reader.assertUnchanged();
  const grant = restoreTimeTravelGrant(
    await control.beginTimeTravel(epoch, id, targets, { ...observed, observedAt }),
  );
  if (
    grant.id !== id ||
    grant.epoch !== epoch ||
    grant.newEpoch !== selected.newEpoch ||
    JSON.stringify(grant.targets) !== JSON.stringify(targets) ||
    grant.bookmark !== selected.source.bookmark ||
    grant.timestamp !== timestamp ||
    grant.issuedAt < observedAt
  )
    throw new Error("database_restore_invalid_grant");
  await reader.assertUnchanged();
  let finished;
  await provider(grant, async (result) => {
    const saved = restoreStatus(
      await control.finishTimeTravel(epoch, id, grant, result),
      epoch,
      id,
    );
    if (
      saved.state !== "restore_written" ||
      saved.newEpoch !== selected.newEpoch ||
      saved.createdAt !== selected.createdAt ||
      JSON.stringify(saved.source) !== JSON.stringify(selected.source) ||
      JSON.stringify(saved.restoreResult) !== JSON.stringify(restoreTimeTravelResult(result))
    )
      throw new Error("database_restore_invalid_result");
    finished = saved;
  });
  if (!finished) throw new Error("database_restore_provider_unknown");
  return finished;
}
