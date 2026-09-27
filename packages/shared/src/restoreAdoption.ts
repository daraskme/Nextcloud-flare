import { type RestoreFreezeTargets, restoreFreezeTargets } from "./restoreFreeze.ts";

/** Persistent, single-use D1 marker. Its independent observation precedes DO publication. */
export interface RestoreAdoptionChallenge {
  validator: "restore-epoch-adoption-v1";
  id: string;
  epoch: number;
  newEpoch: number;
  targets: RestoreFreezeTargets;
  token: string;
  controlSha256: string;
  kdfNotBefore: number;
}

export function restoreAdoptionChallenge(input: unknown): RestoreAdoptionChallenge {
  const v = input as RestoreAdoptionChallenge,
    uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (
    !v ||
    v.validator !== "restore-epoch-adoption-v1" ||
    typeof v.id !== "string" ||
    !uuid.test(v.id) ||
    typeof v.token !== "string" ||
    !uuid.test(v.token) ||
    !Number.isSafeInteger(v.epoch) ||
    v.epoch < 1 ||
    !Number.isSafeInteger(v.newEpoch) ||
    v.newEpoch <= v.epoch ||
    typeof v.controlSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.controlSha256) ||
    !Number.isSafeInteger(v.kdfNotBefore) ||
    v.kdfNotBefore < 0
  )
    throw new Error("database_restore_invalid_adoption");
  return {
    validator: v.validator,
    id: v.id,
    epoch: v.epoch,
    newEpoch: v.newEpoch,
    targets: restoreFreezeTargets(v.targets),
    token: v.token,
    controlSha256: v.controlSha256,
    kdfNotBefore: v.kdfNotBefore,
  };
}
