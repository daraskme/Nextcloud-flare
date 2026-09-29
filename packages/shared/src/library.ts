export interface ArchiveBook {
  readonly nodeId: string;
  readonly spaceId: string;
  readonly blobId: string;
  readonly title: string;
  readonly pageCount: number;
  readonly generator: "archive-index-v1";
  readonly indexHash: string;
  readonly reading: PageReadingState | null;
}

export interface PageReadingState {
  readonly page: number;
  readonly updatedAt: number;
}

export interface PageReadingUpdate {
  readonly blobId: string;
  readonly generator: "archive-index-v1";
  readonly indexHash: string;
  readonly page: number;
  readonly previousUpdatedAt: number | null;
}

export interface LibraryItem {
  readonly id: string;
  readonly name: string;
  readonly kind: "file" | "folder";
  readonly revision: number;
  readonly currentBlobId: string | null;
  readonly updatedAt: number;
  readonly size: number | null;
  readonly mime: string | null;
  readonly format: "folder" | "zip" | "cbz" | "epub" | "pdf" | "cbr" | "rar" | "7z";
  readonly title: string;
  readonly author: string | null;
  readonly series: string | null;
  readonly state: "folder" | "ready" | "pending" | "failed" | "unsupported" | "original";
  readonly pageCount: number | null;
  readonly reading: PageReadingState | null;
}

export interface LibraryPage {
  readonly rootId: string;
  readonly spaceId: string;
  readonly treeGeneration: number;
  readonly items: readonly LibraryItem[];
  readonly nextCursor: string | null;
  readonly scanned: number;
}

export interface LibraryRoot {
  readonly nodeId: string;
  readonly name: string | null;
}
export interface LibraryRoots {
  readonly items: readonly LibraryRoot[];
  readonly limit: number;
}
