export interface TrashItem {
  opId: string;
  nodeId: string;
  name: string;
  kind: "folder" | "file";
  size: number | null;
  deletedAt: number;
  purgeAfter: number | null;
  memberCount: number;
}

export interface TrashPage {
  items: TrashItem[];
  nextCursor: string | null;
}
