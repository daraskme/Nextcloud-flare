import { LIMITS } from "@ncf/shared";

export function assertImageInputSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("Image input size is invalid");
  }
  if (size > LIMITS.maxImageInputBytes) {
    throw new RangeError("Image input exceeds the service limit");
  }
}
