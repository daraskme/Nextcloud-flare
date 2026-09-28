// These are explicit request/input rejections. Connection, timeout and internal errors are unknown.
// See Cloudflare Images troubleshooting and workerd's throwErrorIfErrorResponse implementation.
export const IMAGE_REJECTION_CODES = [9401, 9412, 9413, 9422, 9432, 9520] as const;
export type ImageTransformFailureReceipt =
  | { kind: "binding_rejected"; code: number }
  | { kind: "output_rejected"; code: null };
export type ImageFailureObserver = (receipt: ImageTransformFailureReceipt) => Promise<void>;

export function imageFailureJson(receipt: ImageTransformFailureReceipt | null): string | null {
  if (receipt === null) return null;
  if (
    !receipt ||
    !(
      (receipt.kind === "binding_rejected" &&
        IMAGE_REJECTION_CODES.some((code) => code === receipt.code)) ||
      (receipt.kind === "output_rejected" && receipt.code === null)
    )
  )
    throw new Error("invalid_image_transform_failure");
  return JSON.stringify({ kind: receipt.kind, code: receipt.code });
}

/** Only call on a rejection of the native .output() promise, never on caller/input errors. */
export function imageBindingRejection(error: unknown): ImageTransformFailureReceipt | null {
  if (
    error instanceof Error &&
    error.message.startsWith("IMAGES_TRANSFORM_") &&
    "code" in error &&
    IMAGE_REJECTION_CODES.some((code) => code === error.code)
  )
    return { kind: "binding_rejected", code: error.code as number };
  return null;
}

export class ImageTransformFailed extends Error {
  constructor(
    readonly receipt: ImageTransformFailureReceipt,
    message: string,
  ) {
    super(message);
    imageFailureJson(receipt);
    Object.freeze(receipt);
  }
}
