import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { inspectOperationsHealth } from "./health";

interface OperatorProps {
  readonly purpose?: string;
  readonly environment?: string;
}

const PURPOSE = "operations-health-v1";

export class OperationsOperator extends WorkerEntrypoint<Env, OperatorProps> {
  #authorize(expectedEpoch: number): void {
    if (
      !["development", "staging", "production"].includes(this.env.ENVIRONMENT) ||
      this.ctx.props?.purpose !== PURPOSE ||
      this.ctx.props.environment !== this.env.ENVIRONMENT ||
      !Number.isSafeInteger(expectedEpoch) ||
      expectedEpoch < 1
    )
      throw new Error("ops_operator_forbidden");
  }

  async inspect(expectedEpoch: number) {
    this.#authorize(expectedEpoch);
    return inspectOperationsHealth(this.env, { expectedEpoch });
  }

  fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
