import { expect, it } from "vitest";
import {
  parsePropfindRequest,
  parseProppatchRequest,
  validateDavXmlFragment,
} from "../../src/dav/xml";

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

it("parses ordered PROPPATCH set/remove instructions and normalizes mixed content", async () => {
  const parsed = await parseProppatchRequest(
    request(`<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test">
      <D:set><D:prop><X:color>blue &amp; <X:shade X:level="2">dark</X:shade></X:color></D:prop></D:set>
      <D:remove><D:prop><X:old/></D:prop></D:remove>
    </D:propertyupdate>`),
  );
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toMatchObject({ namespace: "urn:test", name: "color", action: "set" });
  expect(parsed[0]?.valueXml).toContain("blue &amp;");
  expect(parsed[0]?.valueXml).toContain("dark");
  expect(parsed[0]?.valueXml).toContain('level="2"');
  expect(parsed[1]).toEqual({
    namespace: "urn:test",
    name: "old",
    action: "remove",
    valueXml: "",
  });
});

it("rejects malformed, duplicate and over-budget PROPPATCH XML", async () => {
  for (const body of [
    '<!DOCTYPE x><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:x/></D:prop></D:set></D:propertyupdate>',
    '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:remove><D:prop><X:x>value</X:x></D:prop></D:remove></D:propertyupdate>',
    '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:x/></D:prop></D:set><D:remove><D:prop><X:x/></D:prop></D:remove></D:propertyupdate>',
  ])
    await expect(parseProppatchRequest(request(body))).rejects.toThrow("invalid_dav_xml");
  const properties = Array.from({ length: 101 }, (_, index) => `<X:p${index}/>`).join("");
  await expect(
    parseProppatchRequest(
      request(
        `<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop>${properties}</D:prop></D:set></D:propertyupdate>`,
      ),
    ),
  ).rejects.toThrow("invalid_dav_xml");
});
