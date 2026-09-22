import { expect, it } from "vitest";
import { parsePropfindRequest, validateDavXmlFragment } from "../../src/dav/xml";

function request(body?: string, contentType = "application/xml") {
  return new Request(
    "https://app.invalid/dav",
    body === undefined
      ? { method: "PROPFIND" }
      : { method: "PROPFIND", headers: { "Content-Type": contentType }, body },
  );
}

it("parses empty, allprop, propname and namespace-qualified propfind bodies", async () => {
  await expect(parsePropfindRequest(request())).resolves.toEqual({
    mode: "allprop",
    properties: [],
  });
  await expect(
    parsePropfindRequest(request('<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>')),
  ).resolves.toEqual({ mode: "allprop", properties: [] });
  await expect(
    parsePropfindRequest(request('<p:propfind xmlns:p="DAV:"><p:propname/></p:propfind>')),
  ).resolves.toEqual({ mode: "propname", properties: [] });
  await expect(
    parsePropfindRequest(
      request(
        '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><X:color xmlns:X="urn:ncf:props"/></D:prop></D:propfind>',
      ),
    ),
  ).resolves.toEqual({
    mode: "prop",
    properties: [
      { namespace: "DAV:", name: "displayname" },
      { namespace: "urn:ncf:props", name: "color" },
    ],
  });
});

it("rejects unsafe, malformed and over-budget propfind XML", async () => {
  for (const body of [
    '<!DOCTYPE x><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    '<!ENTITY x "y"><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname>value</D:displayname></D:prop></D:propfind>',
    '<D:propfind xmlns:D="DAV:"><D:allprop/><D:propname/></D:propfind>',
    '<D:propfind xmlns:D="DAV:"><D:prop><X:p/></D:prop></D:propfind>',
    '<D:propfind xmlns:D="DAV:" xmlns:X="http://www.w3.org/2001/XInclude"><D:allprop/></D:propfind>',
    '<D:propfind xmlns:D="DAV;&#xD800;"><D:allprop/></D:propfind>',
  ]) {
    await expect(parsePropfindRequest(request(body))).rejects.toThrow("invalid_dav_xml");
  }
  await expect(parsePropfindRequest(request("<x/>", "application/json"))).rejects.toThrow(
    "invalid_dav_xml",
  );
  const properties = Array.from({ length: 101 }, (_, index) => `<X:p${index}/>`).join("");
  await expect(
    parsePropfindRequest(
      request(
        `<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:prop>${properties}</D:prop></D:propfind>`,
      ),
    ),
  ).rejects.toThrow("invalid_dav_xml");
});

it("validates stored mixed-content XML fragments before response embedding", () => {
  expect(() =>
    validateDavXmlFragment('blue <X:shade xmlns:X="urn:test">dark</X:shade>'),
  ).not.toThrow();
  for (const value of ["</R><evil/>", "<!DOCTYPE x>", "&unknown;", "<?xml version='1.0'?>"])
    expect(() => validateDavXmlFragment(value)).toThrow("invalid_dav_xml");
});
