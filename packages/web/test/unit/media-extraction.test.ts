import { expect, it } from "vitest";
import {
  MEDIA_EXTRACTION_GENERATOR,
  mediaExtractionReceipt,
} from "../../../shared/src/mediaExtraction";

const valid = {
  nodeId: "node",
  blobId: "blob",
  generator: MEDIA_EXTRACTION_GENERATOR,
  state: "ready",
  kind: "audio",
};
it.each([
  ["pending", null],
  ["failed", null],
  ["unsupported", "unsupported"],
  ["ready", "audio"],
  ["ready", "image"],
  ["ready", "video"],
])("accepts a bound %s extraction result %s", (state, kind) => {
  expect(mediaExtractionReceipt({ ...valid, state, kind }, "node", "blob")).toMatchObject({
    state,
    kind,
  });
});
it.each([
  { nodeId: "other" },
  { blobId: "other" },
  { generator: "other" },
  { state: "completed" },
  { state: "pending" },
  { kind: null },
  { kind: "unsupported" },
  { kind: "other" },
])("rejects mismatched or inconsistent completion %s", (change) => {
  expect(() => mediaExtractionReceipt({ ...valid, ...change }, "node", "blob")).toThrow(
    "invalid_media_receipt",
  );
});
