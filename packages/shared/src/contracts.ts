import { z } from "zod";

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const epochSchema = z.number().int().positive();
export const timestampSchema = z.number().int().nonnegative();

export const scopes = [
  "account:read",
  "node:read",
  "node:create",
  "node:write",
  "node:delete",
  "node:star",
  "state:write",
  "tag:write",
  "share:manage",
  "upload:create",
  "upload:write",
  "library:read",
  "library:write",
  "credential:manage",
  "job:read",
  "job:cancel",
  "admin:user",
  "admin:lock",
  "admin:dlq",
  "admin:repair",
] as const;

export const scopeSchema = z.enum(scopes);
export type Scope = z.infer<typeof scopeSchema>;

export const operations = [
  "spa.read",
  "public.asset.read",
  "share.landing",
  "reader.shell",
  "account.read",
  "account.logout",
  "csrf.issue",
  "node.read",
  "node.create",
  "node.content.write",
  "node.rename",
  "node.move",
  "node.copy",
  "node.trash",
  "node.restore",
  "node.purge",
  "node.star",
  "search.read",
  "recent.read",
  "starred.read",
  "shared.read",
  "trash.read",
  "zip.create",
  "zip.read",
  "gallery.read",
  "audio.read",
  "audio.metadata.write",
  "library.read",
  "library.write",
  "reading_state.write",
  "playback_state.write",
  "tag.read",
  "tag.create",
  "tag.update",
  "tag.delete",
  "upload.create",
  "upload.read",
  "upload.write",
  "upload.abort",
  "upload.complete",
  "share.read",
  "share.manage",
  "share.disable",
  "share.unlock",
  "share.logout",
  "content.session.create",
  "content.session.accept",
  "ticket.cancel",
  "content.read",
  "credential.read",
  "credential.create",
  "credential.revoke",
  "job.read",
  "job.cancel",
  "job.retry",
  "operation.read",
  "admin.user.disable",
  "admin.transfer",
  "admin.lock.force_unlock",
  "admin.dlq",
  "admin.repair",
  "automation.list",
  "automation.metadata.read",
  "dav.options",
  "dav.read",
  "dav.propfind",
  "dav.put",
  "dav.mkcol",
  "dav.proppatch",
  "dav.copy",
  "dav.move",
  "dav.delete",
  "dav.lock",
  "dav.unlock",
] as const;

export const operationSchema = z.enum(operations);
export type Operation = z.infer<typeof operationSchema>;

const basePrincipalSchema = z.object({
  principalId: idSchema,
  credentialId: z.string().min(1).max(160),
  scopes: z.array(scopeSchema).max(scopes.length),
});

export const principalSchema = z.discriminatedUnion("kind", [
  basePrincipalSchema.extend({
    kind: z.literal("user"),
    userId: idSchema,
    sessionId: idSchema,
  }),
  basePrincipalSchema.extend({
    kind: z.literal("app_password"),
    userId: idSchema,
    appPasswordId: idSchema,
    rootNodeId: idSchema.nullable(),
  }),
  basePrincipalSchema.extend({
    kind: z.literal("share"),
    shareId: idSchema,
    shareVersion: z.number().int().positive(),
    rootNodeId: idSchema,
  }),
  basePrincipalSchema.extend({
    kind: z.literal("service"),
    serviceId: idSchema,
    mappedUserId: idSchema,
    spaceId: idSchema,
  }),
  basePrincipalSchema.extend({
    kind: z.literal("job"),
    actorId: idSchema,
    operationId: idSchema,
    claimFence: idSchema,
  }),
  basePrincipalSchema.extend({
    kind: z.literal("system"),
    systemKind: z.enum(["gc", "repair", "backup", "restore"]),
    claimFence: idSchema,
  }),
]);

export type Principal = z.infer<typeof principalSchema>;

export const createNodeRequestSchema = z.object({
  parentId: idSchema,
  spaceId: idSchema,
  kind: z.literal("folder"),
  name: z.string().min(1).max(255),
  expectedParentRevision: z.number().int().positive(),
  expectedTreeGeneration: z.number().int().positive(),
});

export const uploadStates = [
  "created",
  "receiving",
  "completing",
  "completed",
  "failed",
  "aborted",
  "expired",
] as const;

export const uploadStateSchema = z.enum(uploadStates);
export type UploadState = z.infer<typeof uploadStateSchema>;

export const routeMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
] as const;

export const routeMethodSchema = z.enum(routeMethods);
export type RouteMethod = z.infer<typeof routeMethodSchema>;
