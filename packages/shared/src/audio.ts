export interface AudioTrackSummary {
  nodeId: string;
  blobId: string;
  name: string;
  title: string;
  artist: string | null;
  album: string | null;
  trackNo: number | null;
  discNo: number | null;
  durationMs: number | null;
  codec: string;
  bitrate: number | null;
  coverUrl: string | null;
  contentUrl: string;
  positionMs: number;
}

export interface AudioAlbum {
  nodeId: string;
  name: string;
  tracks: AudioTrackSummary[];
}
