import { z } from "zod";

import { idSchema, timestampSchema } from "./contracts.js";
import type { nodeSummarySchema } from "./files.js";

export const shareModeSchema = z.enum(["view", "download", "upload"]);
export type ShareMode = z.infer<typeof shareModeSchema>;

export const shareKindSchema = z.enum(["link", "user"]);
export type ShareKind = z.infer<typeof shareKindSchema>;

export const createShareBodySchema = z
  .object({
    rootNodeId: idSchema,
    kind: shareKindSchema,
    mode: shareModeSchema,
    expiresAt: timestampSchema.nullable().optional(),
    password: z.string().max(1024).optional(),
    granteeEmail: z.string().email().max(320).optional(),
  })
  .superRefine((value, context) => {
    if (value.kind === "user" && value.granteeEmail === undefined) {
      context.addIssue({
        code: "custom",
        path: ["granteeEmail"],
        message: "Recipient is required",
      });
    }
    if (value.kind === "user" && value.mode === "upload") {
      context.addIssue({ code: "custom", path: ["mode"], message: "Upload-only is link-only" });
    }
    if (value.kind === "user" && value.password !== undefined) {
      context.addIssue({ code: "custom", path: ["password"], message: "Password is link-only" });
    }
  });

export const updateShareBodySchema = z
  .object({
    mode: shareModeSchema.optional(),
    expiresAt: timestampSchema.nullable().optional(),
    password: z.string().max(1024).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const unlockShareBodySchema = z.object({
  secret: z.string().min(32).max(2048),
  password: z.string().max(1024).optional(),
});

export const contentPurposeSchema = z.enum(["content", "thumb", "page", "zip", "track"]);
export type ContentPurpose = z.infer<typeof contentPurposeSchema>;

export const createContentSessionBodySchema = z.object({
  purpose: contentPurposeSchema,
  nodeIds: z.array(idSchema).min(1).max(100),
});

export interface ShareSummary {
  id: string;
  kind: ShareKind;
  mode: ShareMode;
  root: z.infer<typeof nodeSummarySchema>;
  mountName: string;
  expiresAt: number | null;
  disabledAt: number | null;
  passwordProtected: boolean;
  granteeEmail: string | null;
  publicUrl?: string;
}

export interface SharedMount {
  shareId: string;
  mountName: string;
  ownerEmail: string;
  mode: ShareMode;
  root: z.infer<typeof nodeSummarySchema>;
}
