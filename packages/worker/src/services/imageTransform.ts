import {
  confirmImageTransform,
  type ImageTransformGrant,
  type ImageTransformReceipt,
  type ImageTransformRequest,
  imageOutputJson,
  imageTransformValues,
  validateImageTransformGrant,
} from "../db/imageTransform";
import { CONTROL_NAME } from "../do/controlName";
import type { Env } from "../env";
import { type ImageFailureObserver, imageFailureJson } from "../media/images/failure";
import type { ImageTransformOutput } from "../media/images/transform";

/** Cost admission only; every R2 publication still needs its separate current proof and write grant. */
export async function trackedImageTransform(
  env: Pick<Env, "DB" | "CONTROL">,
  input: Omit<ImageTransformRequest, "id" | "deadline">,
  action: (signal: AbortSignal, onFailure: ImageFailureObserver) => Promise<ImageTransformOutput>,
  beforeDispatch: (signal: AbortSignal) => Promise<void>,
): Promise<ImageTransformOutput> {
  if (
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= Date.now() ||
    input.expiresAt > Date.now() + 25000
  )
    throw new Error("image_transform_unavailable");
  const request: ImageTransformRequest = {
    ...input,
    id: crypto.randomUUID(),
    deadline: Math.min(input.expiresAt, Date.now() + 5000),
  };
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStop!: (reason: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  const expire = () => {
    const reason = new Error("image_transform_deadline");
    controller.abort(reason);
    rejectStop(reason);
  };
  const run = async () => {
    const grant = await control.beginImageTransform(request);
    validateImageTransformGrant(grant);
    const expected = { ...request, token: grant.token, startedAt: grant.startedAt };
    if (
      JSON.stringify(imageTransformValues(grant)) !== JSON.stringify(imageTransformValues(expected))
    )
      throw new Error("image_transform_grant_mismatch");
    try {
      await beforeDispatch(controller.signal);
      controller.signal.throwIfAborted();
      if (Date.now() < grant.startedAt || Date.now() >= grant.deadline)
        throw new Error("image_transform_deadline");
    } catch (error) {
      try {
        await control.finishImageTransform(grant, "not_started", null);
      } catch {
        /* Retain proof/hold. */
      }
      throw error;
    }
    const output = await action(controller.signal, async (failure) => {
      const encoded = imageFailureJson(failure);
      try {
        await control.finishImageTransform(grant, "failed", null, failure);
      } catch (error) {
        if (!(await confirmImageTransform(env.DB, grant, "failed", null, encoded))) throw error;
      }
    });
    const receipt: ImageTransformReceipt = {
      bytes: output.bytes.length,
      width: output.width,
      height: output.height,
      sha256: output.sha256,
    };
    const encoded = imageOutputJson(grant, receipt);
    try {
      await control.finishImageTransform(grant, "succeeded", receipt);
    } catch (error) {
      if (!(await confirmImageTransform(env.DB, grant, "succeeded", encoded))) throw error;
    }
    controller.signal.throwIfAborted();
    return output;
  };
  timer = setTimeout(expire, Math.max(1, input.expiresAt - Date.now()));
  try {
    return await Promise.race([run(), stopped]);
  } finally {
    clearTimeout(timer);
  }
}
