import { describe, expect, it } from "vitest";

import { parseDavXml } from "../../src/dav/davXml.js";

function xmlRequest(value: string): Request {
  return new Request("https://app.test.invalid/dav", {
    method: "PROPFIND",
    headers: { "Content-Length": String(new TextEncoder().encode(value).byteLength) },
    body: value,
  });
}

describe("DAV XML adapter", () => {
  it("resolves namespaces and bounded numeric character references", async () => {
    const root = await parseDavXml(
      xmlRequest(
        '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:prop><X:title>&#65;<X:bold>x</X:bold>&#x42;&amp;</X:title></D:prop></D:propfind>',
      ),
      true,
    );
    expect(root).toMatchObject({ namespace: "DAV:", localName: "propfind" });
    expect(root?.children[0]?.children[0]).toMatchObject({
      namespace: "urn:test",
      localName: "title",
      text: "AB&",
      content: ["A", expect.objectContaining({ localName: "bold" }), "B&"],
    });
  });

  it("accepts an XML declaration before the root element", async () => {
    const root = await parseDavXml(
      xmlRequest(
        '<?xml version="1.0" encoding="utf-8"?>\n<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>',
      ),
      true,
    );
    expect(root).toMatchObject({ namespace: "DAV:", localName: "lockinfo" });
  });

  it("rejects DTD, entities, XInclude and invalid scalar references", async () => {
    await expect(
      parseDavXml(xmlRequest('<!DOCTYPE x><D:propfind xmlns:D="DAV:"/>'), true),
    ).rejects.toThrow("forbidden");
    await expect(
      parseDavXml(xmlRequest('<D:propfind xmlns:D="DAV:">&custom;</D:propfind>'), true),
    ).rejects.toThrow("entity");
    await expect(
      parseDavXml(
        xmlRequest('<D:propfind xmlns:D="DAV:" xmlns:xi="urn:x"><xi:include/></D:propfind>'),
        true,
      ),
    ).rejects.toThrow("forbidden");
    await expect(
      parseDavXml(xmlRequest('<D:propfind xmlns:D="DAV:">&#xD800;</D:propfind>'), true),
    ).rejects.toThrow("reference");
  });
});
