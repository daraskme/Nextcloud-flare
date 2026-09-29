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
}

export interface AudioPage {
  rootId: string;
  treeGeneration: number;
  generator: string;
  items: AudioTrack[];
  nextCursor: string | null;
  limitReached: boolean;
  trackLimit: number;
}

export interface PlaybackUpdate {
  blobId: string;
  generator: string;
  positionMs: number;
  previousUpdatedAt: number | null;
}
