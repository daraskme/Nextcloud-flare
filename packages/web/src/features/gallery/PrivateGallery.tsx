import { useMemo } from "react";
import type { SelectedShare } from "../../../../shared/src/shares";
import { type Account, api } from "../../lib/api";
import { Gallery } from "../../public-share/gallery";

export function PrivateGallery({
  account,
  rootId,
  share,
}: {
  account: Account;
  rootId: string;
  share?: SelectedShare & { spaceId: string };
}) {
  const client = useMemo(
    () => api.galleryClient(account, rootId, share),
    [
      account.id,
      account.epoch,
      account.contentOrigin,
      rootId,
      share?.id,
      share?.version,
      share?.spaceId,
    ],
  );
  return (
    <Gallery
      key={`${account.id}:${account.epoch}:${rootId}:${share?.id}:${share?.version}`}
      client={client}
    />
  );
}
