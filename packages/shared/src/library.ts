export interface ArchiveBook {
  readonly nodeId: string;
  readonly spaceId: string;
  readonly blobId: string;
  readonly title: string;
  readonly pageCount: number;
  readonly generator: "archive-index-v1";
}
