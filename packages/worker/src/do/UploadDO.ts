import type { Env } from "../env.js";

export class UploadDO {
  private readonly env: Env;

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  fetch(): Response {
    void this.env;
    return Response.json({ error: "upload_unavailable" }, { status: 503 });
  }
}
