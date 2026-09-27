import {
  type RestoreAdoptionChallenge,
  restoreAdoptionChallenge,
} from "../../../shared/src/restoreAdoption";
import { type RestoreFreezeTargets, restoreFreezeTargets } from "../../../shared/src/restoreFreeze";
import { atomicBatch, primary } from "../db/primary";
import { restoreAdoptionBatch } from "../db/restoreAdoption";
import { RESTORE_SNAPSHOT_CONTROL_QUERY, restoredAdoptionDigest } from "../db/restoreSnapshot";
import type { ControlDatabaseRestore } from "./controlDatabaseRestore";
import type { ControlRestoreEpoch } from "./controlRestoreEpoch";
import type { ControlRestoreSnapshot } from "./controlRestoreSnapshot";

/** One D1 batch, a persistent marker, then independent target attestation. Admission stays closed. */
export class ControlRestoreAdoption {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly restore: ControlDatabaseRestore,
    private readonly snapshot: ControlRestoreSnapshot,
    private readonly reservation: ControlRestoreEpoch,
    private readonly localReady: (epoch: number) => void,
    private readonly publish: (epoch: number, next: number, token: string) => void,
  ) {}

  #row(id: string) {
    return this.storage.sql
      .exec("SELECT * FROM control_database_restore_adoption WHERE id=?", id)
      .toArray()[0];
  }
  #current(c: RestoreAdoptionChallenge) {
    const row = this.#row(c.id),
      selected = this.restore.inspect(c.epoch, c.id);
    if (!row || row.challenge_json !== JSON.stringify(c) || selected.newEpoch !== c.newEpoch)
      throw new Error("database_restore_adoption_conflict");
    this.localReady(row.state === "adopted" ? c.newEpoch : c.epoch);
    return row;
  }
  async #bounded<T>(run: (active: () => void) => Promise<T>): Promise<T> {
    const started = Date.now();
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => {
      if (!active || Date.now() < started || Date.now() >= started + 25000)
        throw new Error("database_restore_adoption_timeout");
    };
    try {
      return await Promise.race([
        run(current),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            active = false;
            reject(new Error("database_restore_adoption_timeout"));
          }, 25000);
        }),
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
    }
  }
  async #verify(c: RestoreAdoptionChallenge, active: () => void) {
    const current = () => {
      active();
      this.#current(c);
    };
    current();
    await this.reservation.verifyHistory(c.epoch, c.id, c.targets, current);
    const rows = await primary(this.db)
      .prepare(RESTORE_SNAPSHOT_CONTROL_QUERY)
      .all<Record<string, unknown>>();
    current();
    const digest = await restoredAdoptionDigest(rows.results, c.kdfNotBefore);
    current();
    if (digest !== c.controlSha256) throw new Error("database_restore_adoption_mirror_conflict");
    // The unique marker is in the same atomic transaction as every D1 mutation.
    // Its presence proves that batch committed, including after a lost native response.
    this.storage.sql.exec(
      "UPDATE control_database_restore_adoption SET state='written' WHERE id=? AND state='pending'",
      c.id,
    );
  }
  async begin(epoch: number, id: string, input: RestoreFreezeTargets, writeEnabled: boolean) {
    const targets = restoreFreezeTargets(input);
    return this.#bounded(async (active) => {
      const previous = this.#row(id);
      if (previous) {
        const c = restoreAdoptionChallenge(JSON.parse(previous.challenge_json as string));
        if (c.epoch !== epoch || JSON.stringify(c.targets) !== JSON.stringify(targets))
          throw new Error("database_restore_adoption_conflict");
        this.#current(c);
        if (previous.state !== "adopted") await this.#verify(c, active);
        return c;
      }
      if (!writeEnabled) throw new Error("database_restore_write_disabled");
      const source = await this.snapshot.adoptionSnapshot(epoch, id, targets, active),
        token = crypto.randomUUID(),
        batch = restoreAdoptionBatch(source.control, source.challenge.newEpoch, token, Date.now()),
        c = restoreAdoptionChallenge({
          validator: "restore-epoch-adoption-v1",
          id,
          epoch,
          newEpoch: source.challenge.newEpoch,
          targets,
          token,
          kdfNotBefore: batch.expected.kdf_not_before,
          controlSha256: await restoredAdoptionDigest(
            [batch.expected],
            batch.expected.kdf_not_before as number,
          ),
        });
      source.current();
      // Durable intent precedes native dispatch. An unknown result never dispatches again.
      this.storage.sql.exec(
        "INSERT INTO control_database_restore_adoption VALUES(?,?,'pending')",
        id,
        JSON.stringify(c),
      );
      await atomicBatch(this.db, batch.statements);
      // A late actual success records only its receipt, never publishes the DO epoch.
      this.storage.sql.exec(
        "UPDATE control_database_restore_adoption SET state='written' WHERE id=? AND challenge_json=? AND state='pending'",
        id,
        JSON.stringify(c),
      );
      active();
      await this.#verify(c, active);
      return c;
    });
  }
  async attest(epoch: number, id: string, input: RestoreAdoptionChallenge) {
    const c = restoreAdoptionChallenge(input);
    if (c.epoch !== epoch || c.id !== id) throw new Error("database_restore_adoption_conflict");
    return this.#bounded(async (active) => {
      if (this.#current(c).state !== "adopted") {
        await this.#verify(c, active);
        active();
        this.storage.transactionSync(() => {
          if (this.#current(c).state === "adopted") return;
          this.publish(epoch, c.newEpoch, c.token);
          this.storage.sql.exec(
            "UPDATE control_database_restore_adoption SET state='adopted' WHERE id=? AND state='written'",
            id,
          );
        });
      }
      return this.restore.inspect(epoch, id);
    });
  }
}
