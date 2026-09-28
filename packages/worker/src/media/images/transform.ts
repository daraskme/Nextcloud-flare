import { assertImageInput } from "../../platform/images";
import { hex } from "../../platform/stream";
import {
  type ImageFailureObserver,
  ImageTransformFailed,
  type ImageTransformFailureReceipt,
  imageBindingRejection,
} from "./failure";
import { type ImageMetadata, inspectImage } from "./inspect";
import { ascii, type ImageSource, view } from "./reader";

export const IMAGE_TRANSFORM_GENERATOR = "image-webp-v1";
export const IMAGE_VARIANTS = Object.freeze({ sm: 256, md: 768, lg: 1600 });
export type ImageVariant = keyof typeof IMAGE_VARIANTS;
export const IMAGE_OUTPUT_BYTES = 12 * 1024 * 1024;

export class ImageTransformUnsupported extends Error {
  constructor(readonly reason: "format" | "animation" | "size") {
    super("image_transform_unsupported_" + reason);
  }
}
export interface ImageTransformPlan {
  readonly variant: ImageVariant;
  readonly generator: typeof IMAGE_TRANSFORM_GENERATOR;
  readonly source: Readonly<ImageMetadata>;
  readonly sourceBytes: number;
  readonly width: number;
  readonly height: number;
}

/** Inspect the immutable source before obtaining a paid transformation claim. */
export async function planImageTransform(
  source: ImageSource,
  variant: ImageVariant,
): Promise<ImageTransformPlan> {
  if (!Object.hasOwn(IMAGE_VARIANTS, variant)) throw new Error("invalid_image_variant");
  // A huge source does not warrant even a metadata GET for a thumbnail request.
  try {
    assertImageInput(source.size, 1, 1);
  } catch {
    throw new ImageTransformUnsupported("size");
  }
  const metadata = await inspectImage(source);
  if (!metadata) throw new ImageTransformUnsupported("format");
  if (metadata.animated) throw new ImageTransformUnsupported("animation");
  try {
    assertImageInput(source.size, metadata.width, metadata.height);
  } catch {
    throw new ImageTransformUnsupported("size");
  }
  const swap = (metadata.orientation ?? 1) >= 5;
  const width = swap ? metadata.height : metadata.width;
  const height = swap ? metadata.width : metadata.height;
  const scale = Math.min(1, IMAGE_VARIANTS[variant] / Math.max(width, height));
  return Object.freeze({
    variant,
    generator: IMAGE_TRANSFORM_GENERATOR,
    source: metadata,
    sourceBytes: source.size,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  });
}

/** Reject leaked EXIF/XMP/profile/animation/unknown chunks, even from a binding response. */
export async function validateImageOutput(bytes: Uint8Array, plan: ImageTransformPlan) {
  if (bytes.length > IMAGE_OUTPUT_BYTES || bytes.length < 20)
    throw new Error("image_transform_output_size");
  let pixels = 0,
    extended = false,
    alpha = false;
  if (
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    view(bytes).getUint32(4, true) + 8 !== bytes.length
  )
    throw new Error("image_transform_output_format");
  for (let at = 12; at < bytes.length; ) {
    if (at + 8 > bytes.length) throw new Error("image_transform_output_format");
    const kind = ascii(bytes, at, 4),
      length = view(bytes).getUint32(at + 4, true),
      next = at + 8 + length + (length % 2);
    if (next > bytes.length || length === 0) throw new Error("image_transform_output_format");
    if (kind === "VP8X") {
      if (at !== 12 || extended || length !== 10 || (bytes[at + 8]! & ~0x10) !== 0)
        throw new Error("image_transform_output_metadata");
      extended = true;
    } else if (kind === "ALPH") {
      if (!extended || alpha || pixels !== 0 || (bytes[20]! & 0x10) === 0)
        throw new Error("image_transform_output_format");
      alpha = true;
    } else if (kind === "VP8 " || kind === "VP8L") {
      if (++pixels !== 1 || (kind === "VP8L" && alpha))
        throw new Error("image_transform_output_format");
    } else throw new Error("image_transform_output_metadata");
    at = next;
  }
  if (pixels !== 1) throw new Error("image_transform_output_format");
  const image = await inspectImage({
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  });
  if (
    !image ||
    image.mime !== "image/webp" ||
    image.animated ||
    image.width !== plan.width ||
    image.height !== plan.height
  )
    throw new Error("image_transform_output_dimensions");
  return image;
}

export interface ImageTransformOutput {
  bytes: Uint8Array;
  sha256: string;
  mime: "image/webp";
  width: number;
  height: number;
}

/**
 * One native invocation, with no retry or R2 publication. The caller owns the durable cost
 * claim and provides the exact, authorized input stream. An abort does not prove native end.
 */
export async function transformImage(
  binding: Pick<ImagesBinding, "input">,
  plan: ImageTransformPlan,
  input: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFailure?: ImageFailureObserver,
): Promise<ImageTransformOutput> {
  let output: ReadableStream<Uint8Array> | undefined,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    inputController: ReadableStreamDefaultController<Uint8Array> | undefined,
    consumed = 0,
    inputChunks = 0,
    inputComplete = false,
    inputFault = false;
  const failed = async (receipt: ImageTransformFailureReceipt, message: string): Promise<never> => {
    try {
      // This also runs when a genuine native rejection arrives after the caller's timeout.
      await onFailure?.(receipt);
    } catch {
      /* Failure to mirror a known end leaves the durable hold/proof for repair. */
    }
    throw new ImageTransformFailed(receipt, message);
  };
  let rejectStop!: (error: unknown) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  const cancel = (reason?: unknown) => {
    if (inputReader) void inputReader.cancel(reason).catch(() => undefined);
    else if (!input.locked) void input.cancel(reason).catch(() => undefined);
    if (reader) void reader.cancel(reason).catch(() => undefined);
    else if (output && !output.locked) void output.cancel(reason).catch(() => undefined);
  };
  const abort = () => {
    inputController?.error(signal.reason);
    cancel(signal.reason);
    rejectStop(signal.reason);
  };
  const run = async () => {
    signal.throwIfAborted();
    if (
      plan.generator !== IMAGE_TRANSFORM_GENERATOR ||
      !Object.hasOwn(IMAGE_VARIANTS, plan.variant) ||
      !Number.isSafeInteger(plan.width) ||
      !Number.isSafeInteger(plan.height) ||
      plan.width < 1 ||
      plan.height < 1 ||
      Math.max(plan.width, plan.height) > IMAGE_VARIANTS[plan.variant] ||
      plan.source.animated
    )
      throw new Error("invalid_image_transform_plan");
    assertImageInput(plan.sourceBytes, plan.source.width, plan.source.height);
    inputReader = input.getReader();
    const bounded = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          inputController = controller;
        },
        async pull(controller) {
          try {
            const next = await inputReader!.read();
            signal.throwIfAborted();
            if (next.done) {
              if (consumed !== plan.sourceBytes) throw new Error("image_source_length_mismatch");
              inputComplete = true;
              controller.close();
              return;
            }
            if (++inputChunks > 4096) throw new Error("image_source_chunk_limit");
            consumed += next.value.byteLength;
            if (consumed > plan.sourceBytes) throw new Error("image_source_length_mismatch");
            controller.enqueue(next.value);
          } catch (error) {
            inputFault = true;
            controller.error(error);
            cancel(error);
          }
        },
        cancel(reason) {
          cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const pending = binding
      .input(bounded)
      .transform({ width: plan.width, height: plan.height, fit: "contain" })
      .output({ format: "image/webp", quality: 85, anim: false });
    let result: ImageTransformationResult;
    try {
      result = await pending;
    } catch (error) {
      const receipt = !inputFault && imageBindingRejection(error);
      if (receipt) return failed(receipt, "image_transform_binding_rejected");
      throw error;
    }
    output = result.image();
    signal.throwIfAborted();
    const contentType = result.contentType();
    reader = output.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0,
      reads = 0;
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (++reads > 4096) throw new Error("image_transform_output_chunk_limit");
      const start = size;
      size += next.value.byteLength;
      if (size > IMAGE_OUTPUT_BYTES) throw new Error("image_transform_output_size");
      // Coalesce tiny native chunks: the array overhead is bounded as well as the bytes.
      for (let copied = 0; copied < next.value.length; ) {
        const index = Math.floor((start + copied) / 65536),
          within = (start + copied) % 65536;
        const block = (chunks[index] ??= new Uint8Array(65536));
        const count = Math.min(65536 - within, next.value.length - copied);
        block.set(next.value.subarray(copied, copied + count), within);
        copied += count;
      }
    }
    if (!inputComplete) throw new Error("image_source_not_consumed");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      const count = Math.min(chunk.length, size - offset);
      bytes.set(chunk.subarray(0, count), offset);
      offset += count;
    }
    try {
      if (contentType !== "image/webp") throw new Error("image_transform_output_format");
      await validateImageOutput(bytes, plan);
    } catch (error) {
      // Both streams reached EOF; rejecting these bytes does not leave native work running.
      return failed(
        { kind: "output_rejected", code: null },
        error instanceof Error ? error.message : "image_transform_output_invalid",
      );
    }
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    signal.throwIfAborted();
    return { bytes, sha256, mime: "image/webp" as const, width: plan.width, height: plan.height };
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([
      run().finally(() => {
        cancel();
        reader?.releaseLock();
        inputReader?.releaseLock();
      }),
      stopped,
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
