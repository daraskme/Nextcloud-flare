export interface AudioTrack {
  id: string;
  name: string;
  currentBlobId: string;
  mime: string;
  durationMs: number | null;
  codec: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  trackNumber: number | null;
  discNumber: number | null;
}

export interface AudioPage {
  rootId: string;
  treeGeneration: number;
  recursive: boolean;
  items: AudioTrack[];
  nextCursor: string | null;
  limitReached: boolean;
  trackLimit: number;
}
