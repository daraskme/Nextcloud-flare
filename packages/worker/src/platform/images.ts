import { LIMITS } from "@next-cloud-flare/shared/limits";

/** Admission guard only; real binding codec/dimension checks remain a staging gate. */
export function assertImageInput(bytes: number, width: number, height: number): void {
  if (![bytes, width, height].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError("invalid_image");
  }
  if (
    bytes > LIMITS.imageBytes ||
    width > LIMITS.imageDimension ||
    height > LIMITS.imageDimension ||
    width * height > LIMITS.imagePixels
  ) {
    throw new RangeError("image_too_large");
  }
}
