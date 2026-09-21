export type GalleryMediaKind = "image" | "video";

export interface GalleryItem {
  id: string;
  name: string;
  blobId: string;
  mediaKind: GalleryMediaKind;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  takenAt: number | null;
  capturedAt: number;
  updatedAt: number;
  thumbUrl: string;
  contentUrl: string;
}

export interface GalleryPage {
  items: GalleryItem[];
  nextCursor: string | null;
  recursive: boolean;
  candidateLimit: number;
}
