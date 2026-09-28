import { portableName, searchName } from "@next-cloud-flare/shared/names";

/** Private candidates, selected in the publication batch. No namespace probe reaches the sender. */
export function receiptNames(input: string, uploadId: string) {
  if (!/^up_[a-f0-9]{64}$/.test(uploadId)) throw new Error("invalid_upload_id");
  const original = portableName(input);
  const encoder = new TextEncoder();
  const dot = original.name.lastIndexOf(".");
  const extension =
    dot > 0 && encoder.encode(original.name.slice(dot)).length <= 32
      ? original.name.slice(dot)
      : "";
  const stem = extension ? original.name.slice(0, dot) : original.name;
  const names = [original];
  for (let n = 1; n <= 16; n++) {
    const suffix = ` (${uploadId.slice(3, 27)}-${n})${extension}`;
    const limit = 255 - encoder.encode(suffix).length;
    let prefix = "";
    for (const char of stem) {
      if (
        encoder.encode(prefix + char).length > limit ||
        [...(prefix + char + suffix)].length >= 255
      )
        break;
      prefix += char;
    }
    names.push(portableName(prefix + suffix));
  }
  return names.map((name) => ({ ...name, ...searchName(name.name) }));
}
