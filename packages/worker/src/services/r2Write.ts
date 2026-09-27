import { type R2WriteGrant, type R2WriteRequest, validateR2WriteGrant } from "../db/r2Write";
import { CONTROL_NAME } from "../do/controlName";
import { type AccountMutationEnv, MutationUnavailableError } from "./accountMutation";

/** Each invocation gets one grant; a rejected native call remains unknown, never replayed here. */
async function runWrite<T>(
  env: AccountMutationEnv,
  input: Pick<R2WriteRequest, "epoch" | "ownerId" | "kind" | "key">,
  action: () => Promise<T>,
  current: () => boolean,
): Promise<T> {
  const request: R2WriteRequest = {
    ...input,
    id: crypto.randomUUID(),
    deadline: Date.now() + 5000,
  };
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  let grant: R2WriteGrant;
  try {
    grant = await control.beginR2Write(request);
    validateR2WriteGrant(grant);
    if (
      Object.keys(request).some(
        (key) => request[key as keyof R2WriteRequest] !== grant[key as keyof R2WriteRequest],
      )
    )
      throw new Error("invalid_r2_write_grant");
  } catch {
    throw new MutationUnavailableError();
  }
  if (!current() || Date.now() < grant.startedAt || Date.now() >= grant.deadline) {
    try {
      await control.finishR2Write(grant, "not_started");
    } catch {
      /* keep durable hold */
    }
    throw new MutationUnavailableError();
  }
  let value: T;
  try {
    value = await action();
  } catch {
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
  env: AccountMutationEnv,
  input: Pick<R2WriteRequest, "epoch" | "ownerId" | "kind" | "key">,
  action: () => Promise<T>,
): Promise<T> {
  let active = true,
    timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runWrite(env, input, action, () => active),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          active = false;
          reject(new MutationUnavailableError());
        }, 25000);
      }),
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
