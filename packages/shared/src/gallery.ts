export interface GalleryItem {
  id: string;
  name: string;
  currentBlobId: string;
  revision: number;
  size: number;
  mime: string;
  width: number;
  height: number;
  takenAt: number | null;
  updatedAt: number;
  orientation: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  thumbnail: "ready" | "pending" | "unsupported" | "failed";
}
export interface GalleryPage {
  rootId: string;
  treeGeneration: number;
  recursive: boolean;
  items: GalleryItem[];
  nextCursor: string | null;
  truncated: boolean;
  scannedNodes: number;
  candidateLimit: number;
}
