export interface GalleryItem {
  id: string;
  name: string;
  currentBlobId: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  takenAt: number | null;
  updatedAt: number;
  thumbnail: "ready" | "pending" | "failed";
}

export interface GalleryPage {
  rootId: string;
  treeGeneration: number;
  recursive: boolean;
  items: GalleryItem[];
  nextCursor: string | null;
  truncated: boolean;
  candidateLimit: number;
}
