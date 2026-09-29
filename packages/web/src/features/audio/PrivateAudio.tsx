import { useMemo, useState } from "react";
import type { SelectedShare } from "../../../../shared/src/shares";
import { type Account, api } from "../../lib/api";
import { AudioLibrary, useAudioPlayer } from "../../public-share/audio";
import { AudioMetadataEditor } from "./AudioMetadataEditor";

export function PrivateAudio({
  account,
  rootId,
  share,
}: {
  account: Account;
  rootId: string;
  share?: SelectedShare & { spaceId: string };
}) {
  const [editing, setEditing] = useState<{ scope: string; id: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const player = useAudioPlayer();
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
  return (
    <>
      <AudioLibrary
        key={client.scope}
        client={client}
        refresh={refresh}
        onEdit={(item) => setEditing({ scope: client.scope, id: item.id })}
      />
      {editing?.scope === client.scope && (
        <AudioMetadataEditor
          key={editing.id}
          client={client}
          id={editing.id}
          close={() => setEditing(null)}
          saved={(page) => {
            player.refreshMetadata(client, page);
            setEditing(null);
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
