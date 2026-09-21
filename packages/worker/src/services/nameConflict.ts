export class NameConflictError extends Error {
  readonly existingNodeId: string;
  readonly revision: number;

  constructor(existingNodeId: string, revision: number) {
    super("name_conflict");
    this.name = "NameConflictError";
    this.existingNodeId = existingNodeId;
    this.revision = revision;
  }
}
