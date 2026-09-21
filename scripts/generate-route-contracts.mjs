import { readFile, writeFile } from "node:fs/promises";
import { routeContracts } from "./route-contract-source.mjs";

// Explicitly regenerate after a reviewed DESIGN/brief change. CI only checks drift.
const design = await readFile(new URL("../docs/DESIGN.md", import.meta.url), "utf8");
const routes = routeContracts(design);
await writeFile(
  new URL("../packages/worker/src/routes/manifest.ts", import.meta.url),
  `// Generated from DESIGN §5.1 with IMPLEMENTATION_BRIEF §8 overrides.\nimport type { RouteContract } from "@next-cloud-flare/shared/contracts";\n\nexport const ROUTES = ${JSON.stringify(routes, null, 2)} as const satisfies readonly RouteContract[];\n`,
);
console.log(`Generated ${routes.length} route contracts (none enabled).`);
