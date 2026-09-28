import { useInfiniteQuery } from "@tanstack/react-query";
import type { InternalShare, SelectedShare } from "../../../../shared/src/shares";
import { Button } from "../../components/ui/button";
import { type Account, api, errorMessage } from "../../lib/api";

export interface CopyDestination {
  spaceId: string;
  rootNodeId: string;
  share: SelectedShare | null;
}
export const ownDestination = (account: Account): CopyDestination => ({
  spaceId: account.spaceId,
  rootNodeId: account.rootNodeId,
  share: null,
});
export const sharedDestination = (share: InternalShare): CopyDestination => ({
  spaceId: share.spaceId,
  rootNodeId: share.rootNodeId,
  share: { id: share.id, version: share.version },
});
const key = (scope: CopyDestination) =>
  scope.share ? `${scope.share.id}:${scope.share.version}` : "mine";

export function CopyDestinationSelect({
  account,
  source,
  value,
  onChange,
}: {
  account: Account;
  source?: InternalShare;
  value: CopyDestination;
  onChange: (scope: CopyDestination) => void;
}) {
  const list = useInfiniteQuery({
    queryKey: ["copy-destinations", account.id, account.epoch],
    queryFn: ({ pageParam, signal }) => api.sharedWithMe(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    gcTime: 0,
  });
  const shares = (
    !list.error && !list.isRefetching ? (list.data?.pages.flatMap((p) => p.items) ?? []) : []
  ).filter((share) => share.role === "edit" && share.nodeKind !== "file");
  // Retain the exact current source selection even while later share pages load.
  // A newer version in the list is a separate choice, never an implicit upgrade.
  if (
    source?.role === "edit" &&
    source.nodeKind !== "file" &&
    !shares.some((s) => s.id === source.id && s.version === source.version)
  )
    shares.unshift(source);
  const options = [
    { label: "マイドライブ", scope: ownDestination(account) },
    ...shares.map((share) => ({
      label: `共有: ${share.name || "ドライブ"}`,
      scope: sharedDestination(share),
    })),
  ];
  return (
    <div className="copy-destination">
      <label className="field-label">
        保存するドライブ
        <select
          aria-busy={list.isFetching}
          value={key(value)}
          onChange={(event) => {
            const option = options.find((option) => key(option.scope) === event.target.value);
            if (option) onChange(option.scope);
          }}
        >
          {options.map((option) => (
            <option key={key(option.scope)} value={key(option.scope)}>
              {option.label}
            </option>
          ))}
          {!options.some((option) => key(option.scope) === key(value)) && (
            <option value={key(value)} disabled>
              選択した共有を確認できません
            </option>
          )}
        </select>
      </label>
      {list.error && (
        <p role="alert" className="form-error">
          {errorMessage(list.error)}
        </p>
      )}
      {list.hasNextPage && (
        <Button
          type="button"
          size="small"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          さらに保存先を読み込む
        </Button>
      )}
    </div>
  );
}
