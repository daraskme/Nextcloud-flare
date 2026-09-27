import { randomUUID } from "node:crypto";

/** Synthetic private control for offline SQL fixtures; real DO authority is tested in workerd. */
export function publicationControlFixture() {
  const attempts = new Map();
  const clear = () => {
    if ([...attempts.values()].some((attempt) => attempt.state === "pending"))
      throw new Error("backup_publication_write_unsettled");
  };
  return {
    async checkPublicationWrites(epoch, id) {
      clear();
      return { epoch, id, state: "settled" };
    },
    async grantPublicationWrite(epoch, id, request) {
      clear();
      if (attempts.has(request.attemptId)) throw new Error("backup_publication_write_replayed");
      const grant = { epoch, id, attemptId: request.attemptId, token: randomUUID() };
      attempts.set(request.attemptId, { grant, state: "pending" });
      return grant;
    },
    async finishPublicationWrite(epoch, id, grant) {
      const attempt = attempts.get(grant.attemptId);
      if (
        !attempt ||
        attempt.grant.token !== grant.token ||
        attempt.grant.epoch !== epoch ||
        attempt.grant.id !== id
      )
        throw new Error("backup_publication_write_conflict");
      attempt.state = "ended";
      return { state: "ended" };
    },
  };
}
