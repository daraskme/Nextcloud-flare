# Public test fixtures

`browser-test-only.cert.pem` and `browser-test-only.key.pem` are an intentionally
public, self-signed certificate/key pair for the isolated HTTPS browser harness.
They identify only `app.ncf.test`, `content.ncf.test`, and loopback. They are not
Cloudflare credentials, file-encryption keys, or production TLS material.

The browser runner pins this certificate's SPKI and trusts its certificate only
inside the test process. This lets Chromium install the test Service Worker
without globally disabling certificate validation. Never deploy this key or use
it to protect a real service. Changing the fixture requires updating the explicit
SPKI pin in `playwright.config.ts`.
