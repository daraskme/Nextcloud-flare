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
