import { afterEach, expect, it, vi } from "vitest";

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = "activated";
  postMessage = vi.fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function fixture(state: ServiceWorkerState) {
  const previous = new FakeWorker();
  const target = new FakeWorker();
  target.state = state;
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: previous,
    register: vi.fn(),
  });
  const registration = {
    active: previous,
    waiting: state === "installed" ? target : null,
    installing: state === "installing" ? target : null,
    update: vi.fn().mockResolvedValue(undefined),
  };
  serviceWorker.register.mockResolvedValue(registration);
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("location", { origin: "https://app.example.test" });
  const { ensureClientMediaWorker } = await import("../../src/lib/clientMediaRegistration");
  return { previous, target, serviceWorker, registration, ensureClientMediaWorker };
}

it("activates a waiting update and waits for it to control the page instead of using the old worker", async () => {
  const { target, serviceWorker, ensureClientMediaWorker } = await fixture("installed");
  let ready = false;
  const pending = ensureClientMediaWorker().then(() => {
    ready = true;
  });
  await vi.waitFor(() =>
    expect(target.postMessage).toHaveBeenCalledWith({ kind: "ncf-client-media-activate" }),
  );
  expect(ready).toBe(false);
  target.state = "activated";
  target.dispatchEvent(new Event("statechange"));
  await Promise.resolve();
  expect(ready).toBe(false);
  serviceWorker.controller = target;
  serviceWorker.dispatchEvent(new Event("controllerchange"));
  await pending;
  expect(ready).toBe(true);
  await ensureClientMediaWorker();
  expect(serviceWorker.register).toHaveBeenCalledTimes(1);
});

it("waits for installation before requesting activation", async () => {
  const { target, serviceWorker, ensureClientMediaWorker } = await fixture("installing");
  const pending = ensureClientMediaWorker();
  await vi.waitFor(() => expect(serviceWorker.register).toHaveBeenCalled());
  expect(target.postMessage).not.toHaveBeenCalled();
  target.state = "installed";
  target.dispatchEvent(new Event("statechange"));
  await vi.waitFor(() =>
    expect(target.postMessage).toHaveBeenCalledWith({ kind: "ncf-client-media-activate" }),
  );
  target.state = "activated";
  serviceWorker.controller = target;
  serviceWorker.dispatchEvent(new Event("controllerchange"));
  await pending;
});

it("does not replace an already current controller", async () => {
  const { previous, registration, ensureClientMediaWorker } = await fixture("activated");
  await ensureClientMediaWorker();
  expect(registration.update).toHaveBeenCalledTimes(1);
  expect(previous.postMessage).not.toHaveBeenCalled();
});
