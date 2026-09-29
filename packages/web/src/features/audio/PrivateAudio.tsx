import { useMemo } from "react";
import type { SelectedShare } from "../../../../shared/src/shares";
import { type Account, api } from "../../lib/api";
import { AudioLibrary } from "../../public-share/audio";

export function PrivateAudio({
  account,
  rootId,
  share,
}: {
  account: Account;
  rootId: string;
  share?: SelectedShare & { spaceId: string };
}) {
  const client = useMemo(
    () => api.audioClient(account, rootId, share),
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
  return <AudioLibrary key={client.scope} client={client} />;
}
