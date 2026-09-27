import { type R2WriteGrant, type R2WriteRequest, validateR2WriteGrant } from "../db/r2Write";
import type { ControlDO } from "../do/ControlDO";
import { CONTROL_NAME } from "../do/controlName";
import { type AccountMutationEnv, MutationUnavailableError } from "./accountMutation";

export type R2WriteSource =
  | AccountMutationEnv
  | {
      DB: D1Database;
      systemControl: Pick<ControlDO, "beginR2Write" | "finishR2Write">;
    };
type WriteInput = Pick<
  R2WriteRequest,
  "epoch" | "ownerId" | "kind" | "key" | "gc" | "upload" | "abort" | "probe"
>;

/** Each invocation gets one grant; a rejected native call remains unknown, never replayed here. */
async function runWrite<T>(
  env: R2WriteSource,
  input: WriteInput,
  action: () => Promise<T>,
  current: () => boolean,
  dispatch: () => void,
  deadline?: number,
  beforeDispatch?: () => void,
): Promise<T> {
  const request: R2WriteRequest = {
    ...input,
    id: crypto.randomUUID(),
    deadline: Math.min(
      deadline ?? Infinity,
      input.upload?.expiresAt ?? Infinity,
      input.probe?.stop?.expiresAt ?? Infinity,
      input.gc && typeof input.gc.mode === "object" ? input.gc.mode.expiresAt : Infinity,
      Date.now() + 5000,
    ),
  };
  const control =
    "systemControl" in env
      ? env.systemControl
      : env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  let grant: R2WriteGrant;
  try {
    grant = await control.beginR2Write(request);
    validateR2WriteGrant(grant);
    if (
      Object.keys(request).some(
        (key) =>
          JSON.stringify(request[key as keyof R2WriteRequest]) !==
          JSON.stringify(grant[key as keyof R2WriteRequest]),
      )
    )
      throw new Error("invalid_r2_write_grant");
  } catch {
    throw new MutationUnavailableError();
  }
  let dispatchError: unknown;
  let dispatchReady = false;
  try {
    if (!current() || Date.now() < grant.startedAt || Date.now() >= grant.deadline)
      throw new MutationUnavailableError();
    beforeDispatch?.();
    const dispatchAt = Date.now();
    if (!current() || dispatchAt < grant.startedAt || dispatchAt >= grant.deadline)
      throw new MutationUnavailableError();
    dispatchReady = true;
  } catch (error) {
    dispatchError = error;
  }
  if (!dispatchReady) {
    try {
      await control.finishR2Write(grant, "not_started");
    } catch {
      /* keep durable hold */
    }
    throw dispatchError;
  }
  let value: T;
  try {
    dispatch();
    value = await action();
  } catch (error) {
    // Upload callers retain their existing transport/stream error contract; the hold remains.
    if (input.upload) throw error;
    throw new MutationUnavailableError();
  }
  try {
    await control.finishR2Write(grant, "succeeded");
  } catch {
    throw new MutationUnavailableError();
  }
  return value;
}

export async function trackedR2Write<T>(
  env: R2WriteSource,
  input: WriteInput,
  action: () => Promise<T>,
  deadline?: number,
  beforeDispatch?: () => void,
): Promise<T> {
  if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline <= Date.now()))
    throw new MutationUnavailableError();
  let active = true,
    timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout!: (reason: Error) => void;
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const arm = (milliseconds: number) => {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        active = false;
        rejectTimeout(new MutationUnavailableError());
      },
      Math.max(1, milliseconds),
    );
  };
  // Waiting for a grant stays short; a dispatched upload retains its original transfer lease.
  arm(
    Math.min(
      25000,
      (deadline ?? Infinity) - Date.now(),
      (input.upload?.expiresAt ?? Infinity) - Date.now(),
    ),
  );
  try {
    return await Promise.race([
      runWrite(
        env,
        input,
        action,
        () => active,
        () => {
          if (input.upload)
            arm(
              Math.min(
                900000,
                input.upload.expiresAt - Date.now(),
                (deadline ?? Infinity) - Date.now(),
              ),
            );
        },
        deadline,
        beforeDispatch,
      ),
      timeout,
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
