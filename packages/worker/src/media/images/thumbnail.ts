export const IMAGE_THUMBNAIL_GENERATOR = "image-sm256-v1";
export const IMAGE_THUMBNAIL_VARIANT = "sm256";
export const IMAGE_THUMBNAIL_MAX_BYTES = 2_000_000;

export async function generateThumbnail(
  images: ImagesBinding,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const result = await images
    .input(new Blob([bytes]).stream())
    .transform({ width: 256, height: 256, fit: "scale-down" })
    .output({ format: "image/webp", quality: 80, anim: false });
  if (result.contentType() !== "image/webp") throw new Error("thumbnail_output_type");
  const reader = result.image().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > IMAGE_THUMBNAIL_MAX_BYTES) throw new RangeError("thumbnail_output_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error("thumbnail_output_empty");
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
