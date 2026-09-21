import type { Env } from "../env.js";

export class PlaceholderDurableObject {
  protected readonly state: DurableObjectState;
  protected readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  fetch(): Response {
    return Response.json(
      { error: { code: "unavailable", message: "Durable Object is not implemented" } },
      { status: 503 },
    );
  }
}
