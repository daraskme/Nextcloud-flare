import type { Env } from "../env.js";

type DurableState = "created" | "receiving" | "completing" | "completed" | "aborting" | "aborted";

interface UploadMetadata {
  uploadId: string;
  mode: "single" | "multipart";
  declaredSize: number;
  partSize: number;
  multipartUploadId?: string;
  state: DurableState;
  acceptParts: boolean;
  singleAttempted: boolean;
  inFlight: number;
  calls: number;
  attemptedBytes: number;
}

interface PartResult {
  partNumber: number;
  attempt: number;
  size: number;
  etag: string;
}

interface InitializeRequest {
  uploadId: string;
  mode: "single" | "multipart";
  declaredSize: number;
  partSize: number;
  multipartUploadId?: string;
}

interface ClaimRequest {
  size: number;
}

function isInitializeRequest(value: unknown): value is InitializeRequest {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Partial<InitializeRequest>;
  return (
    typeof input.uploadId === "string" &&
    (input.mode === "single" || input.mode === "multipart") &&
    Number.isSafeInteger(input.declaredSize) &&
    input.declaredSize !== undefined &&
    input.declaredSize >= 0 &&
    Number.isSafeInteger(input.partSize) &&
    input.partSize !== undefined &&
    input.partSize >= 5 * 1024 * 1024 &&
    (input.multipartUploadId === undefined || typeof input.multipartUploadId === "string")
  );
}

function isClaimRequest(value: unknown): value is ClaimRequest {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Partial<ClaimRequest>;
  return Number.isSafeInteger(input.size) && input.size !== undefined && input.size > 0;
}

export class UploadDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async initialize(input: InitializeRequest): Promise<Response> {
    const created = await this.state.storage.transaction(async (transaction) => {
      if ((await transaction.get<UploadMetadata>("metadata")) !== undefined) return false;
      const metadata: UploadMetadata = {
        uploadId: input.uploadId,
        mode: input.mode,
        declaredSize: input.declaredSize,
        partSize: input.partSize,
        ...(input.multipartUploadId === undefined
          ? {}
          : { multipartUploadId: input.multipartUploadId }),
        state: "created",
        acceptParts: true,
        singleAttempted: false,
        inFlight: 0,
        calls: 0,
        attemptedBytes: 0,
      };
      await transaction.put("metadata", metadata);
      return true;
    });
    return created
      ? new Response(null, { status: 201 })
      : Response.json({ error: "already_initialized" }, { status: 409 });
  }

  private async startSingle(): Promise<Response> {
    const started = await this.state.storage.transaction(async (transaction) => {
      const metadata = await transaction.get<UploadMetadata>("metadata");
      if (
        metadata === undefined ||
        metadata.mode !== "single" ||
        metadata.state !== "created" ||
        metadata.singleAttempted
      ) {
        return false;
      }
      await transaction.put("metadata", {
        ...metadata,
        state: "receiving",
        singleAttempted: true,
        calls: metadata.calls + 1,
        attemptedBytes: metadata.declaredSize,
      });
      return true;
    });
    return started
      ? new Response(null, { status: 204 })
      : Response.json({ error: "single_attempt_forbidden" }, { status: 409 });
  }

  private async claimPart(partNumber: number, input: ClaimRequest): Promise<Response> {
    let attempt = 0;
    const accepted = await this.state.storage.transaction(async (transaction) => {
      const metadata = await transaction.get<UploadMetadata>("metadata");
      if (
        metadata === undefined ||
        metadata.mode !== "multipart" ||
        !metadata.acceptParts ||
        !["created", "receiving"].includes(metadata.state) ||
        metadata.inFlight > 0
      ) {
        return false;
      }
      const previous = await transaction.get<number>(`attempt:${partNumber}`);
      attempt = (previous ?? 0) + 1;
      const expectedParts = Math.ceil(metadata.declaredSize / metadata.partSize);
      if (
        attempt > 3 ||
        metadata.calls + 1 > expectedParts * 3 ||
        metadata.attemptedBytes + input.size > metadata.declaredSize * 3
      ) {
        return false;
      }
      await transaction.put(`attempt:${partNumber}`, attempt);
      await transaction.put("metadata", {
        ...metadata,
        state: "receiving",
        inFlight: metadata.inFlight + 1,
        calls: metadata.calls + 1,
        attemptedBytes: metadata.attemptedBytes + input.size,
      });
      return true;
    });
    return accepted
      ? Response.json({ attempt })
      : Response.json({ error: "part_attempt_rejected" }, { status: 409 });
  }

  private async finishPart(
    partNumber: number,
    input: PartResult,
    outcome: "stored" | "unknown",
  ): Promise<Response> {
    const finished = await this.state.storage.transaction(async (transaction) => {
      const metadata = await transaction.get<UploadMetadata>("metadata");
      const attempt = await transaction.get<number>(`attempt:${partNumber}`);
      if (metadata === undefined || metadata.inFlight < 1 || attempt !== input.attempt)
        return false;
      if (outcome === "stored") {
        await transaction.put(`part:${partNumber}`, input);
        await transaction.put("metadata", { ...metadata, inFlight: metadata.inFlight - 1 });
      } else {
        await transaction.put("metadata", {
          ...metadata,
          state: "aborting",
          acceptParts: false,
          inFlight: metadata.inFlight - 1,
        });
      }
      return true;
    });
    return finished
      ? new Response(null, { status: 204 })
      : Response.json({ error: "part_fence_rejected" }, { status: 409 });
  }

  private async seal(): Promise<Response> {
    const result = await this.state.storage.transaction(async (transaction) => {
      const metadata = await transaction.get<UploadMetadata>("metadata");
      if (
        metadata === undefined ||
        metadata.mode !== "multipart" ||
        metadata.inFlight !== 0 ||
        !["created", "receiving"].includes(metadata.state)
      ) {
        return null;
      }
      const stored = await transaction.list<PartResult>({ prefix: "part:" });
      const parts = [...stored.values()].sort((left, right) => left.partNumber - right.partNumber);
      const total = parts.reduce((sum, part) => sum + part.size, 0);
      const expectedParts = Math.ceil(metadata.declaredSize / metadata.partSize);
      if (
        parts.length !== expectedParts ||
        total !== metadata.declaredSize ||
        parts.some((part, index) => part.partNumber !== index + 1)
      ) {
        return null;
      }
      await transaction.put("metadata", {
        ...metadata,
        state: "completing",
        acceptParts: false,
      });
      return { metadata, parts };
    });
    return result === null
      ? Response.json({ error: "parts_incomplete" }, { status: 409 })
      : Response.json(result);
  }

  private async transition(state: "completed" | "aborted"): Promise<Response> {
    await this.state.storage.transaction(async (transaction) => {
      const metadata = await transaction.get<UploadMetadata>("metadata");
      if (metadata !== undefined) {
        await transaction.put("metadata", { ...metadata, state, acceptParts: false, inFlight: 0 });
      }
    });
    return new Response(null, { status: 204 });
  }

  private async status(): Promise<Response> {
    const metadata = await this.state.storage.get<UploadMetadata>("metadata");
    const stored = await this.state.storage.list<PartResult>({ prefix: "part:" });
    return Response.json({
      metadata: metadata ?? null,
      parts: [...stored.values()].sort((left, right) => left.partNumber - right.partNumber),
    });
  }

  async fetch(request: Request): Promise<Response> {
    void this.env;
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/initialize") {
      const body: unknown = await request.json();
      return isInitializeRequest(body)
        ? this.initialize(body)
        : Response.json({ error: "invalid_upload" }, { status: 400 });
    }
    if (request.method === "POST" && url.pathname === "/single/start") return this.startSingle();
    if (request.method === "GET" && url.pathname === "/status") return this.status();
    if (request.method === "POST" && url.pathname === "/seal") return this.seal();
    if (request.method === "POST" && url.pathname === "/completed")
      return this.transition("completed");
    if (request.method === "POST" && url.pathname === "/aborted") return this.transition("aborted");
    const claim = /^\/parts\/(\d+)\/claim$/u.exec(url.pathname);
    if (request.method === "POST" && claim?.[1] !== undefined) {
      const body: unknown = await request.json();
      return isClaimRequest(body)
        ? this.claimPart(Number(claim[1]), body)
        : Response.json({ error: "invalid_part" }, { status: 400 });
    }
    const finish = /^\/parts\/(\d+)\/(stored|unknown)$/u.exec(url.pathname);
    if (request.method === "POST" && finish?.[1] !== undefined && finish[2] !== undefined) {
      const body: PartResult = await request.json();
      return this.finishPart(
        Number(finish[1]),
        body,
        finish[2] === "stored" ? "stored" : "unknown",
      );
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
