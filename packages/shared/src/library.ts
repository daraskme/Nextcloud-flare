export type LibraryKind = "cbz" | "epub" | "pdf" | "folder";
export type ReadingMode = "single" | "spread";

export interface ReadingPosition {
  page: number;
  entryId?: string;
  cfi?: string;
  mode: ReadingMode;
  rtl: boolean;
}

export interface LibraryItemSummary {
  id: string;
  nodeId: string;
  blobId: string;
  kind: LibraryKind;
  title: string;
  author: string | null;
  series: string | null;
  tags: string[];
  pageCount: number | null;
  coverUrl: string | null;
  status: "pending" | "indexed" | "failed";
  errorCode: string | null;
  readingState: ReadingPosition | null;
  updatedAt: number;
}

export interface LibraryRootSummary {
  nodeId: string;
  name: string;
  createdAt: number;
}

export interface EpubEntrySummary {
  id: string;
  path: string;
  title: string;
}
