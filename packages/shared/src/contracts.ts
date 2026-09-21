export const SCOPES = [
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
export type Scope = (typeof SCOPES)[number];

export const STATES = {
  operation: ["claimed", "committed", "failed"],
  permit: ["open", "released", "revoked"],
  blob: ["staging", "committed", "orphan", "gc_candidate", "deleting", "deleted"],
  trash: ["pending", "trashed", "restoring", "restored", "purging", "purged"],
  outbox: ["pending", "dispatching", "sent", "completed", "failed"],
  singleUpload: ["created", "receiving", "completing", "completed", "aborted", "expired", "failed"],
  multipartUpload: [
    "created",
    "uploading",
    "completing",
    "completed",
    "aborting",
    "aborted",
    "expired",
    "failed",
  ],
  job: ["pending", "running", "completed", "failed", "cancelled"],
  gc: ["candidate", "deleting", "deleted"],
} as const;

export const SINGLE_UPLOAD_TRANSITIONS = {
  created: ["receiving", "aborted", "expired"],
  receiving: ["completing", "aborted", "expired"],
  completing: ["completed", "failed"],
  completed: [],
  aborted: [],
  expired: [],
  failed: [],
} as const satisfies Record<(typeof STATES.singleUpload)[number], readonly string[]>;

export const SYSTEM_OPERATIONS = ["system.gc", "system.repair", "system.backup"] as const;

export const OPERATIONS = {
  "spa.read": [],
  "public.asset.read": [],
  "share.landing": [],
  "reader.shell": [],
  "account.read": ["account:read"],
  "account.logout": [],
  "csrf.issue": [],
  "node.read": ["node:read"],
  "search.read": ["node:read"],
  "recent.read": ["node:read"],
  "starred.read": ["node:read"],
  "shared.read": ["node:read"],
  "trash.read": ["node:read"],
  "node.create": ["node:create"],
  "node.content.write": ["node:write"],
  "node.rename": ["node:write"],
  "node.move": ["node:write"],
  "node.copy": ["node:read", "node:create"],
  "node.trash": ["node:delete"],
  "node.restore": ["node:create"],
  "node.purge": ["node:delete"],
  "node.star": ["node:star"],
  "zip.create": ["node:read"],
  "zip.read": ["node:read"],
  "gallery.read": ["library:read"],
  "audio.read": ["library:read"],
  "library.read": ["library:read"],
  "library.write": ["library:write"],
  "audio.metadata.write": ["library:write"],
  "reading_state.write": ["state:write"],
  "playback_state.write": ["state:write"],
  "tag.read": ["node:read"],
  "tag.create": ["tag:write"],
  "tag.update": ["tag:write"],
  "tag.delete": ["tag:write"],
  "upload.create": ["upload:create"],
  "upload.read": ["upload:write"],
  "upload.write": ["upload:write"],
  "upload.abort": ["upload:write"],
  "upload.complete": ["upload:write"],
  "share.read": ["node:read"],
  "share.manage": ["share:manage"],
  "share.disable": ["share:manage"],
  "share.unlock": [],
  "share.logout": [],
  "content.session.create": [],
  "content.session.accept": [],
  "ticket.cancel": [],
  "content.read": [],
  "credential.read": ["credential:manage"],
  "credential.create": ["credential:manage"],
  "credential.revoke": ["credential:manage"],
  "job.read": ["job:read"],
  "job.cancel": ["job:cancel"],
  "job.retry": ["job:cancel"],
  "operation.read": [],
  "admin.user.disable": ["admin:user"],
  "admin.transfer": ["admin:user"],
  "admin.lock.force_unlock": ["admin:lock"],
  "admin.dlq": ["admin:dlq"],
  "admin.repair": ["admin:repair"],
  "automation.list": ["node:read"],
  "automation.metadata.read": ["node:read"],
  "dav.options": [],
  "dav.read": ["node:read"],
  "dav.propfind": ["node:read"],
  "dav.put": ["node:write"],
  "dav.mkcol": ["node:create"],
  "dav.proppatch": ["node:write"],
  "dav.copy": ["node:read", "node:create"],
  "dav.move": ["node:write"],
  "dav.delete": ["node:delete"],
  "dav.lock": ["node:write"],
  "dav.unlock": ["node:write"],
} as const satisfies Record<string, readonly Scope[]>;
export type Operation = keyof typeof OPERATIONS;

// Scope lists are necessary constraints, never complete authorization decisions.
// Empty lists still require the operation-specific surface/credential/target policy.
export type PrincipalKind = "user" | "app_password" | "link_share" | "service" | "job" | "system";
export type AuthMode =
  | "access"
  | "app_password"
  | "share"
  | "service"
  | "public"
  | "content_cookie";
export type CsrfProfile =
  | "same-origin-json"
  | "cross-origin-content"
  | "dav"
  | "public-form"
  | "csrf-issue"
  | "public-csrf-issue";

export interface RouteContract {
  readonly host: "app" | "content";
  readonly method: string;
  readonly template: string;
  readonly auth: readonly AuthMode[];
  readonly operation: Operation;
  readonly operands: readonly string[];
  readonly adminOnly: boolean;
  readonly csrf: CsrfProfile;
}
