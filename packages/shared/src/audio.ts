export interface PlaybackState {
  positionMs: number;
  updatedAt: number;
}

export interface AudioTrack {
  id: string;
  name: string;
  currentBlobId: string;
  mime: string;
  durationMs: number | null;
  title: string;
  artist: string | null;
  album: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  playback: PlaybackState | null;
  cover?: "ready" | "pending" | "failed" | "none";
  metadata?: AudioMetadata;
}

export interface AudioTags {
  title: string | null;
  artist: string | null;
  album: string | null;
}
export interface AudioMetadata {
  revision: number;
  extracted: AudioTags;
  overrides: AudioTags;
}
export interface AudioMetadataUpdate extends AudioTags {
  blobId: string;
  generator: string;
  revision: number;
}

export interface AudioPage {
  rootId: string;
  treeGeneration: number;
  generator: string;
  items: AudioTrack[];
  nextCursor: string | null;
  limitReached: boolean;
  trackLimit: number;
  canEdit?: boolean;
}

export interface PlaybackUpdate {
  blobId: string;
  generator: string;
  positionMs: number;
  previousUpdatedAt: number | null;
}
