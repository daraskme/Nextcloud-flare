import { type DavPath, parseDavPath } from "./path";

const MAX_DESTINATION_BYTES = 8_192;

export interface DavDestination {
  readonly href: string;
  readonly path: DavPath;
}

/** Parse Destination before URL normalization can erase dot segments. */
export function parseDavDestination(value: string | null, appOrigin: string): DavDestination {
  if (
    value === null ||
    value !== value.trim() ||
    value.includes(",") ||
    value.includes("\\") ||
    /[\0-\x1f\x7f]/.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_DESTINATION_BYTES ||
    !value.startsWith("https://")
  )
    throw new Error("invalid_dav_destination");
  const authorityEnd = value.indexOf("/", "https://".length);
  const rawPath = authorityEnd < 0 ? "/" : value.slice(authorityEnd);
  if (rawPath.includes("?") || rawPath.includes("#")) throw new Error("invalid_dav_destination");
  let destination: URL;
  let expected: URL;
  try {
    destination = new URL(value);
    expected = new URL(appOrigin);
  } catch {
    throw new Error("invalid_dav_destination");
  }
  if (
    destination.protocol !== "https:" ||
    destination.origin !== expected.origin ||
    expected.pathname !== "/" ||
    expected.search ||
    expected.hash ||
    destination.username ||
    destination.password ||
    destination.search ||
    destination.hash
  )
    throw new Error("invalid_dav_destination");
  try {
    const path = parseDavPath(rawPath);
    return Object.freeze({ href: `${destination.origin}${destination.pathname}`, path });
  } catch {
    throw new Error("invalid_dav_destination");
  }
}

export function parseDavOverwrite(value: string | null): boolean {
  if (value === null || value === "T") return true;
  if (value === "F") return false;
  throw new Error("invalid_dav_overwrite");
}

export function parseDavTransferDepth(
  method: "COPY" | "MOVE",
  value: string | null,
): "0" | "infinity" {
  if (value === null || value.toLowerCase() === "infinity") return "infinity";
  if (method === "COPY" && value === "0") return "0";
  throw new Error("invalid_dav_depth");
}
