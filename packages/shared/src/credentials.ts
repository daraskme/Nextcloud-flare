import { z } from "zod";

import { idSchema, scopeSchema } from "./contracts.js";

export const createAppPasswordBodySchema = z.object({
  label: z.string().trim().min(1).max(64),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  rootNodeId: idSchema.nullable().optional(),
  scopes: z.array(scopeSchema).min(1).max(20).optional(),
});

export interface AppPasswordSummary {
  id: string;
  label: string;
  scopes: string[];
  rootNodeId: string | null;
  expiresAt: number;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface CreatedAppPassword extends AppPasswordSummary {
  secret: string;
}
