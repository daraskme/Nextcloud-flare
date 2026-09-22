export type PlatformErrorCode =
  | "bad_request"
  | "forbidden"
  | "unauthorized"
  | "budget_exceeded"
  | "not_found"
  | "not_ready"
  | "binding_unavailable"
  | "commit_unknown"
  | "invalid_length"
  | "payload_too_large"
  | "precondition_failed"
  | "range_not_satisfiable";

export function problem(status: number, code: PlatformErrorCode): Response {
  return new Response(JSON.stringify({ type: `urn:ncf:error:${code}`, status, title: code }), {
    status,
    headers: {
      "Content-Type": "application/problem+json",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
