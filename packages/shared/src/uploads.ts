import { z } from "zod";

import { idSchema } from "./contracts.js";

export const uploadModeSchema = z.enum(["single", "multipart"]);
export type UploadMode = z.infer<typeof uploadModeSchema>;

export const createUploadBodySchema = z.object({
  parentId: idSchema,
  targetNodeId: idSchema.optional(),
  name: z.string().min(1).max(255),
  declaredSize: z.number().int().nonnegative(),
  mode: uploadModeSchema,
});

export interface UploadPartStatus {
  partNumber: number;
  size: number;
  etag: string;
}

export interface UploadInfo {
  id: string;
  mode: UploadMode;
  state: "created" | "receiving" | "completing" | "completed" | "failed" | "aborted" | "expired";
  name: string;
  declaredSize: number;
  uploadedSize: number;
  partSize: number;
  expiresAt: number;
  capability?: string;
  parts: UploadPartStatus[];
  nodeId?: string;
}
