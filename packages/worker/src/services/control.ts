import type { Env } from "../env.js";

export interface RuntimeControlState {
  epoch: number;
  maintenance: boolean;
  gcPaused: boolean;
}

function stub(env: Env): DurableObjectStub {
  return env.CONTROL.get(env.CONTROL.idFromName("singleton"));
}

export async function getRuntimeControl(env: Env): Promise<RuntimeControlState> {
  const response = await stub(env).fetch("https://control.internal/state");
  if (!response.ok) throw new Error("control_unavailable");
  return response.json();
}

async function setFlag(
  env: Env,
  path: "/maintenance" | "/gc-pause",
  enabled: boolean,
): Promise<RuntimeControlState> {
  const response = await stub(env).fetch(`https://control.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error("control_unavailable");
  return response.json();
}

export function setMaintenance(env: Env, enabled: boolean): Promise<RuntimeControlState> {
  return setFlag(env, "/maintenance", enabled);
}

export function setGcPaused(env: Env, enabled: boolean): Promise<RuntimeControlState> {
  return setFlag(env, "/gc-pause", enabled);
}

export async function bumpRecoveryEpoch(env: Env, reason: string): Promise<number> {
  const response = await stub(env).fetch("https://control.internal/epoch/bump", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) throw new Error("epoch_unavailable");
  const result: { epoch: number } = await response.json();
  return result.epoch;
}
