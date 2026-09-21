export const LIMITS = {
  maxRequestBytes: 95_000_000,
  maxImageInputBytes: 20_000_000,
  maxTreeDepth: 64,
  maxD1Bindings: 100,
  pbkdf2Iterations: 100_000,
  maxPasswordBytes: 1_024,
  zip32MaxBytes: 4_294_967_295,
} as const;
