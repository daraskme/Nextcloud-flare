import { expect, it } from "vitest";
import { boundedMediaRequest, MEDIA_RANGE_BYTES } from "../../src/platform/mediaRange";

const media = {
  mime: 'video/mp4; codecs="av01.0.08M.10,Opus"',
  size: 60_161_053,
  contentEtag: '"v1"',
};
const request = (range?: string, extra: HeadersInit = {}, method = "GET") =>
  new Request("https://content.invalid/c/node/blob/track", {
    method,
    headers: { ...(range ? { Range: range } : {}), ...extra },
  });

it.each(["video/mp4", "audio/ogg", media.mime])(
  "bounds an open-ended %s seek and preserves authority headers",
  (mime) => {
    const abort = new AbortController();
    const original = new Request(
      request("bytes=3309568-", { Cookie: "fixture-only", Origin: "https://app.invalid" }),
      { signal: abort.signal },
    );
    const bounded = boundedMediaRequest(original, { ...media, mime });
    expect(bounded.headers.get("Range")).toBe(`bytes=3309568-${3309568 + MEDIA_RANGE_BYTES - 1}`);
    expect(original.headers.get("Range")).toBe("bytes=3309568-");
    expect(bounded.headers.get("Cookie")).toBe("fixture-only");
    expect(bounded.headers.get("Origin")).toBe("https://app.invalid");
    abort.abort();
    expect(bounded.signal.aborted).toBe(true);
  },
);

it("retains validators, explicit ranges, full downloads and unsatisfiable requests", () => {
  for (const r of [
    request(),
    request("bytes=0-1023"),
    request("bytes=-1000"),
    request("bytes=1-2,3-4"),
    request("bytes=999999999-"),
    request("bytes=0-", {}, "HEAD"),
    request("bytes=0-", { "If-Range": '"old"' }),
    request("bytes=0-", { "If-Range": 'W/"v1"' }),
    request(`bytes=${media.size - 10}-`),
  ])
    expect(boundedMediaRequest(r, media)).toBe(r);
  const original = request("bytes=0-");
  expect(boundedMediaRequest(original, { ...media, mime: "application/octet-stream" })).toBe(
    original,
  );
  expect(boundedMediaRequest(original, { ...media, size: MEDIA_RANGE_BYTES })).toBe(original);
  const current = boundedMediaRequest(
    request("bytes=0-", { "If-Range": media.contentEtag }),
    media,
  );
  expect(current.headers.get("Range")).toBe(`bytes=0-${MEDIA_RANGE_BYTES - 1}`);
  expect(current.headers.get("If-Range")).toBe(media.contentEtag);
});
