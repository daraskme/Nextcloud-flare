export const ERROR_CODES = {
  invalidInput: "invalid_input",
  payloadTooLarge: "payload_too_large",
  commitUnknown: "commit_unknown",
  maintenance: "maintenance",
  internal: "internal",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
