// Explicit maintenance command. Review the emitted versions before installation.
import { writeFile } from "node:fs/promises";

const cutoff = "2026-09-14T00:00:00.000Z";
const packages = {
  node: /^24\./,
  pnpm: /^12\./,
  wrangler: /^4\./,
  typescript: /^5\./,
  vitest: /^4\./,
  "@cloudflare/vitest-pool-workers": /^0\./,
  "@cloudflare/workers-types": /^5\./,
  "@types/node": /^24\./,
  "@biomejs/biome": /^2\./,
  fflate: /^0\./,
  jose: /^6\./,
  vite: /^7\./,
};
const versions = {};
for (const [name, major] of Object.entries(packages)) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`);
  const metadata = await response.json();
  const candidates = Object.keys(metadata.versions)
    .filter(
      (version) =>
        major.test(version) &&
        /^\d+\.\d+\.\d+$/.test(version) &&
        metadata.time[version] <= cutoff &&
        !metadata.versions[version].deprecated,
    )
    .sort((a, b) => {
      const av = a.split(".").map(Number);
      const bv = b.split(".").map(Number);
      return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
    });
  const version = candidates[0];
  if (!version) throw new Error(`No eligible release: ${name}`);
  versions[name] = {
    version,
    publishedAt: metadata.time[version],
    engines: metadata.versions[version].engines ?? {},
    peers: metadata.versions[version].peerDependencies ?? {},
  };
}
const evidence = {
  selectedAt: "2026-09-21",
  cutoff,
  registry: "https://registry.npmjs.org",
  versions,
};
await writeFile(
  new URL("../docs/toolchain.json", import.meta.url),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence, null, 2));
