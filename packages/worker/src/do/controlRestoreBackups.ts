import {
  RESTORE_BACKUPS_PROBE_BYTES,
  RESTORE_BACKUPS_PROBE_KEY,
  RESTORE_BACKUPS_PROBE_KIND,
  RESTORE_BACKUPS_WINDOW_MS,
  type RestoreBackupsTarget,
  restoreBackupsTarget,
} from "../../../shared/src/restoreBackups";
import type { RestoreD1Challenge } from "../../../shared/src/restoreTarget";
import { atomicBatch } from "../db/primary";
import {
  acquireGlobalMutation,
  type GlobalMutationSource,
  globalMutationStatements,
} from "../services/globalMutation";
import type { ControlRestoreTarget } from "./controlRestoreTarget";

interface BackupsRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  target_json: string;
  source_json: string;
  attempt_id: string;
  challenge_id: string;
  revision: number;
  token: string;
  issued_at: number;
  expires_at: number;
  nonce: string;
  phase: "writing" | "issued" | "verified";
  etag: string | null;
  version: string | null;
  verified_at: number | null;
}

function validObject(object: R2Object) {
  if (
    object.key !== RESTORE_BACKUPS_PROBE_KEY ||
    object.size !== RESTORE_BACKUPS_PROBE_BYTES ||
    object.customMetadata?.ncf_kind !== RESTORE_BACKUPS_PROBE_KIND ||
    !object.etag ||
    object.etag.length > 256 ||
    !object.version ||
    object.version.length > 256
  )
    throw new Error("database_restore_backups_invalid_probe");
}

/** One permanent BACKUPS object. Never use a copied archive or epoch record as bucket identity. */
export class ControlRestoreBackups {
  #busy = false;
  private readonly sql: SqlStorage;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: GlobalMutationSource,
    private readonly bucket: R2Bucket,
    private readonly target: ControlRestoreTarget,
  ) {
    const sql = (this.sql = storage.sql);
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_backups(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),epoch INTEGER NOT NULL,
      target_json TEXT NOT NULL,source_json TEXT NOT NULL,attempt_id TEXT NOT NULL,
      challenge_id TEXT NOT NULL,revision INTEGER NOT NULL,token TEXT NOT NULL,
      issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,nonce TEXT NOT NULL,
      phase TEXT NOT NULL,etag TEXT,version TEXT,verified_at INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS control_restore_backups_probe(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),attempt_id TEXT NOT NULL,
      lease_expires_at INTEGER NOT NULL,allocated_bytes INTEGER NOT NULL CHECK(allocated_bytes=64),
      calls INTEGER NOT NULL DEFAULT 0
    )`);
  }

  #row(id: string) {
    const row = this.sql
      .exec<BackupsRow>("SELECT * FROM control_database_restore_backups WHERE id=?", id)
      .toArray()[0];
    if (!row) throw new Error("database_restore_backups_missing");
    return row;
  }

  observation(epoch: number, id: string, input: RestoreD1Challenge, attemptId: string) {
    const scope = this.target.verifiedScope(epoch, id, input),
      c = scope.challenge,
      now = scope.current(),
      row = this.#row(id);
    if (
      row.epoch !== epoch ||
      row.attempt_id !== attemptId ||
      row.challenge_id !== c.challengeId ||
      row.target_json !== JSON.stringify(c.target) ||
      row.revision !== c.revision ||
      row.token !== c.token ||
      row.phase !== "verified" ||
      row.verified_at === null ||
      now < row.verified_at ||
      now >= row.expires_at ||
      row.expires_at > c.expiresAt
    )
      throw new Error("database_restore_backups_conflict");
    return {
      source: restoreBackupsTarget(JSON.parse(row.source_json)),
      attemptId,
      verifiedAt: row.verified_at,
      expiresAt: row.expires_at,
    };
  }

  async #run<T>(
    epoch: number,
    id: string,
    input: RestoreD1Challenge,
    action: (
      scope: ReturnType<ControlRestoreTarget["verifiedScope"]>,
      current: () => number,
      budget: () => Promise<void>,
    ) => Promise<T>,
  ) {
    if (this.#busy) throw new Error("database_restore_backups_busy");
    this.#busy = true;
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const scope = this.target.verifiedScope(epoch, id, input),
        started = scope.current(),
        deadline = Math.min(scope.challenge.expiresAt, started + 25000);
      let attempt: string | undefined, pinned: BackupsRow | undefined;
      const current = () => {
        if (!active) throw new Error("database_restore_backups_scope_closed");
        const now = scope.current(),
          row = this.#row(id),
          c = scope.challenge;
        if (now < started || now >= deadline || now < row.issued_at || now >= row.expires_at)
          throw new Error("database_restore_backups_expired");
        attempt ??= row.attempt_id;
        pinned ??= row;
        if (
          row.epoch !== epoch ||
          row.attempt_id !== attempt ||
          row.challenge_id !== c.challengeId ||
          row.target_json !== JSON.stringify(c.target) ||
          row.revision !== c.revision ||
          row.token !== c.token ||
          row.source_json !== pinned.source_json ||
          row.nonce !== pinned.nonce ||
          row.issued_at !== pinned.issued_at ||
          row.expires_at !== pinned.expires_at
        )
          throw new Error("database_restore_backups_conflict");
        const lease = this.sql
          .exec(
            "SELECT 1 FROM control_restore_backups_probe WHERE singleton=1 AND attempt_id=? AND lease_expires_at=? AND lease_expires_at>?",
            attempt,
            row.expires_at,
            now,
          )
          .toArray();
        if (lease.length !== 1) throw new Error("database_restore_backups_conflict");
        return now;
      };
      const budget = async () => {
        current();
        const admission = await acquireGlobalMutation(this.env, "restore.backups-probe", deadline);
        current();
        // Persist the dispatch budget before requesting D1's direct ACK. Unknown means no I/O.
        const saved = this.sql.exec(
          "UPDATE control_restore_backups_probe SET calls=calls+1 WHERE singleton=1 AND attempt_id=? RETURNING singleton",
          attempt,
        );
        if (saved.toArray().length !== 1) throw new Error("database_restore_backups_conflict");
        await atomicBatch(this.env.DB, globalMutationStatements(admission, [scope.fence()]));
        current();
      };
      return await Promise.race([
        action(scope, current, budget),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              active = false;
              reject(new Error("database_restore_backups_timeout"));
            },
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
      this.#busy = false;
    }
  }

  async #read(current: () => void) {
    const object = await this.bucket.get(RESTORE_BACKUPS_PROBE_KEY);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      current();
      if (!object) return null;
      validObject(object);
      reader = object.body.getReader();
      const bytes = new Uint8Array(RESTORE_BACKUPS_PROBE_BYTES);
      let size = 0;
      for (;;) {
        const next = await reader.read();
        current();
        if (next.done) break;
        if (size + next.value.length > bytes.length)
          throw new Error("database_restore_backups_invalid_probe");
        bytes.set(next.value, size);
        size += next.value.length;
      }
      const nonce = new TextDecoder().decode(bytes);
      if (size !== bytes.length || !/^[a-f0-9]{64}$/.test(nonce))
        throw new Error("database_restore_backups_invalid_probe");
      return { object, nonce };
    } finally {
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else if (object) void object.body.cancel().catch(() => {});
    }
  }

  challenge(
    epoch: number,
    id: string,
    input: RestoreD1Challenge,
    sourceInput: RestoreBackupsTarget,
  ) {
    const source = restoreBackupsTarget(sourceInput);
    return this.#run(epoch, id, input, async (scope, current, budget) => {
      const c = scope.challenge;
      if (c.target.mode !== "remote" || c.target.accountId !== source.accountId)
        throw new Error("database_restore_backups_target_mismatch");
      const issuedAt = scope.current(),
        expiresAt = Math.min(c.expiresAt, issuedAt + RESTORE_BACKUPS_WINDOW_MS),
        attemptId = crypto.randomUUID(),
        nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      const saved = this.sql.exec(
        `INSERT INTO control_database_restore_backups VALUES(?,?,?,?,?,?,?,?,?,?,?,'writing',NULL,NULL,NULL)
        ON CONFLICT(id) DO UPDATE SET attempt_id=excluded.attempt_id,challenge_id=excluded.challenge_id,
          revision=excluded.revision,token=excluded.token,issued_at=excluded.issued_at,expires_at=excluded.expires_at,
          nonce=excluded.nonce,phase='writing',etag=NULL,version=NULL,verified_at=NULL
        WHERE epoch=excluded.epoch AND target_json=excluded.target_json AND source_json=excluded.source_json
          AND issued_at<=excluded.issued_at AND (verified_at IS NULL OR verified_at<=excluded.issued_at)
        RETURNING id`,
        id,
        epoch,
        JSON.stringify(c.target),
        JSON.stringify(source),
        attemptId,
        c.challengeId,
        c.revision,
        c.token,
        issuedAt,
        expiresAt,
        nonce,
      );
      if (saved.toArray().length !== 1) throw new Error("database_restore_backups_conflict");
      const lease = this.sql.exec(
        `INSERT INTO control_restore_backups_probe VALUES(1,?,?,64,0)
        ON CONFLICT(singleton) DO UPDATE SET attempt_id=excluded.attempt_id,lease_expires_at=excluded.lease_expires_at
        WHERE lease_expires_at<=? RETURNING singleton`,
        attemptId,
        expiresAt,
        issuedAt,
      );
      if (lease.toArray().length !== 1) throw new Error("database_restore_backups_busy");
      current();
      await scope.readMirror();
      await budget();
      const previous = await this.#read(current);
      await budget();
      const object = await this.bucket.put(RESTORE_BACKUPS_PROBE_KEY, nonce, {
        onlyIf: previous
          ? { etagMatches: previous.object.etag }
          : new Headers({ "If-None-Match": "*" }),
        customMetadata: { ncf_kind: RESTORE_BACKUPS_PROBE_KIND },
        httpMetadata: { contentType: "text/plain", cacheControl: "no-store" },
      });
      current();
      if (!object) throw new Error("database_restore_backups_conflict");
      validObject(object);
      const updated = this.sql.exec(
        "UPDATE control_database_restore_backups SET phase='issued',etag=?,version=? WHERE id=? AND attempt_id=? AND phase='writing' RETURNING id",
        object.etag,
        object.version,
        id,
        attemptId,
      );
      if (updated.toArray().length !== 1) throw new Error("database_restore_backups_conflict");
      return {
        id,
        epoch,
        target: c.target,
        source,
        state: "backups_challenge" as const,
        challengeId: c.challengeId,
        revision: c.revision,
        attemptId,
        issuedAt,
        expiresAt,
      };
    });
  }

  attest(epoch: number, id: string, input: RestoreD1Challenge, attemptId: string, nonce: string) {
    return this.#run(epoch, id, input, async (scope, current, budget) => {
      current();
      const row = this.#row(id);
      if (
        row.attempt_id !== attemptId ||
        row.phase !== "issued" ||
        typeof nonce !== "string" ||
        !/^[a-f0-9]{64}$/.test(nonce) ||
        row.nonce !== nonce
      )
        throw new Error("database_restore_backups_mismatch");
      await budget();
      const found = await this.#read(current);
      if (
        !found ||
        found.nonce !== nonce ||
        found.object.etag !== row.etag ||
        found.object.version !== row.version
      )
        throw new Error("database_restore_backups_mismatch");
      await scope.readMirror();
      const verifiedAt = current();
      this.storage.transactionSync(() => {
        const saved = this.sql.exec(
          "UPDATE control_database_restore_backups SET phase='verified',verified_at=? WHERE id=? AND attempt_id=? AND phase='issued' RETURNING id",
          verifiedAt,
          id,
          attemptId,
        );
        if (saved.toArray().length !== 1) throw new Error("database_restore_backups_conflict");
        const released = this.sql.exec(
          "UPDATE control_restore_backups_probe SET lease_expires_at=0 WHERE singleton=1 AND attempt_id=? RETURNING singleton",
          attemptId,
        );
        if (released.toArray().length !== 1) throw new Error("database_restore_backups_conflict");
      });
      return {
        id,
        epoch,
        target: scope.challenge.target,
        source: JSON.parse(row.source_json) as RestoreBackupsTarget,
        state: "backups_verified" as const,
        validator: "backups-binding-v1" as const,
        challengeId: row.challenge_id,
        revision: row.revision,
        attemptId,
        verifiedAt,
        expiresAt: row.expires_at,
      };
    });
  }
}
