import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { defineConfig } from "@playwright/test";

const chrome = "/run/current-system/sw/bin/google-chrome";
// Trust exactly the public key of the checked-in isolated test certificate, including SW install.
const testCertificatePath = resolve(
  import.meta.dirname,
  "scripts/test/fixtures/browser-test-only.cert.pem",
);
const testCertificatePem = readFileSync(testCertificatePath, "utf8");
const testCertificate = new X509Certificate(testCertificatePem);
const testSpkiSha256 = createHash("sha256")
  .update(testCertificate.publicKey.export({ type: "spki", format: "der" }))
  .digest("base64");
if (testSpkiSha256 !== "6UPl6R3ZxB8TCcKTT3uEZhA9DH/beJG+CpiwgEiTXh4=")
  throw new Error("browser_test_certificate_changed");
// Playwright's route.fetch uses Node TLS, whereas Chromium uses the SPKI flag below.
// Child test workers read NODE_EXTRA_CA_CERTS at startup; this process needs the explicit CA call.
process.env.NODE_EXTRA_CA_CERTS = testCertificatePath;
setDefaultCACertificates([...getCACertificates("default"), testCertificatePem]);
export default defineConfig({
  testDir: "./packages/web/test/browser",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: false,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      ...(existsSync(chrome) ? { executablePath: chrome } : {}),
      args: [
        "--host-resolver-rules=MAP app.ncf.test 127.0.0.1, MAP content.ncf.test 127.0.0.1",
        "--no-proxy-server",
        `--ignore-certificate-errors-spki-list=${testSpkiSha256}`,
      ],
    },
  },
  webServer: {
    command: "node scripts/browser-server.mjs",
    url: "https://127.0.0.1:8879/__test__/ready",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
