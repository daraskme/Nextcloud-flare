export const purgeOrder = [
  "trash_members",
  "node_props",
  "node_tags",
  "node_media",
  "node_audio",
  "archive_index",
  "user_reading_state",
  "user_playback_state",
  "share_grants",
  "shares",
  "node_versions",
  "locks",
  "upload_parts",
  "uploads",
  "search_index",
  "library_items",
  "nodes",
] as const;

export type PurgeTable = (typeof purgeOrder)[number];
