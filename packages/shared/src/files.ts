import { z } from "zod";

import { idSchema } from "./contracts.js";

export const nodeKindSchema = z.enum(["root", "folder", "file"]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const nodeSummarySchema = z.object({
  id: idSchema,
  parentId: idSchema.nullable(),
  name: z.string(),
  kind: nodeKindSchema,
  revision: z.number().int().positive(),
  blobId: idSchema.nullable(),
  size: z.number().int().nonnegative().nullable(),
  mime: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type NodeSummary = z.infer<typeof nodeSummarySchema>;

export const createFolderBodySchema = z.object({
  parentId: idSchema,
  name: z.string().min(1).max(255),
});

export const renameNodeBodySchema = z.object({ name: z.string().min(1).max(255) });
export const moveNodeBodySchema = z.object({
  destinationParentId: idSchema,
  name: z.string().min(1).max(255).optional(),
});
export const copyNodeBodySchema = moveNodeBodySchema;

export interface BreadcrumbItem {
  id: string;
  name: string;
}

export interface ChildrenPage {
  items: NodeSummary[];
  nextCursor: string | null;
  treeGeneration: number;
}

export interface NodeVersionSummary {
  id: string | null;
  blobId: string;
  size: number;
  createdAt: number;
  current: boolean;
}
