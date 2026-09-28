export interface DeadLetter {
  messageId: string;
  outboxId: string | null;
  sentAt: number;
  receivedAt: number;
  recordedEpoch: number;
  eventKind: string | null;
  eventState: "pending" | "dispatching" | "sent" | "completed" | "failed" | null;
  eventEpoch: number | null;
  jobId: string | null;
  jobState: "pending" | "running" | "completed" | "failed" | "cancelled" | null;
}

export interface DeadLetterPage {
  items: DeadLetter[];
  nextCursor: string | null;
}
