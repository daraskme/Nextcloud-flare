# 内部共有 UI

更新: 2026-10-01。

## 境界

内部共有は Cloudflare Access で認証済みの private app surface だけで扱う。public link
の capability、public share session、public asset entry、upload-only action は利用しない。
browser は共有状態や認可結果を保存・合成せず、D1 を authority とする既存 API の現在値だけを
表示する。

所有者 UI は次の private API を使う。

- `GET /api/v1/shares`: 所有者が作成した共有を取得する。UI は `kind=internal` だけを表示し、
  link と upload-only share を内部共有画面へ混在させない。
- `POST /api/v1/shares`: folder root、direct recipient email または既存 group ID、
  `read`/`download`/`create`/`edit` action、有効期限、任意の `resharePolicy` を指定して作成する。
- `PATCH /api/v1/shares/:shareId`: canonical action set と、元の所有者だけが設定できる
  `resharePolicy` を更新する。
- `DELETE /api/v1/shares/:shareId`: 既存 disable 処理で共有を取り消す。
- `GET /api/v1/groups`: 所有者の既存 group を bounded list として選択する。browser
  は group や membership の別状態を作らない。

mutation は既存 `ApiClient` の same-origin credential、private CSRF、no-store、
redirect rejection、timeout、session lifetime cancellation を通る。recipient email は作成時の
明示入力だけを送信し、directory search や unbounded recipient lookup は追加しない。

## 再共有ポリシーと委任表示

元の内部共有には任意の再共有ポリシーを設定できる。UI は backend と同じ境界で、enabled、
許可 action、最大委任深度 1–4、最大 fan-out 1–20、任意の TTL を作成時または編集 dialog
から送信する。`read` は他の action に常に必要で、policy の `download`、`create`、`edit` は
元の共有が同じ action を持つ場合だけ選択できる。policy TTL を更新する場合は保存時点からの
日数として明示し、元共有の残存期間を超える値を client validation でも許可しない。最終的な
authority 判定は常に D1 で再検証される。

`GET /api/v1/shares` と mutation の share output に含まれる `sourceShareId`、
`delegatedByUserId`、`delegationDepth`、`resharePolicy` を型付きで保持する。元共有 card は
policy の enabled/action/depth/fan-out/expiry を表示して編集できる。委任された descendant
card は共有元、委任者、depth と pinned policy を read-only で表示し、descendant から policy
を変更する control は出さない。

## recipient mount

`GET /api/v1/shared-with-me` は現在有効な mount だけを返す。各応答には D1 の grant から得た
次の provenance を含める。

- direct grant: `kind=direct` と `recipientVersion`
- group grant: `kind=group`、group ID/name/version、現在の `membershipVersion`

UI は provenance、有効な `read`/`download`/`create`/`edit` action、owner、mount name を
表示する。
direct/group の判定や effective action の計算は browser で行わない。mount が後続の成功応答
から消えた場合は、取り消し、期限切れ、membership 変更のいずれかとして再取得を案内するが、
過去の認可状態を保持して理由を断定しない。

同じ share ID が残っていても、share version、recipient/group/membership version、effective
actions、root/mount identity が変化した場合は access-change notice を表示する。action を
狭める owner mutation は既存 policy action も同じ PATCH と backend transaction で交差させ、
policy summary が source action を超える操作を表示しない。

mount は `/shared/:shareId` と `/shared/:shareId/:folderId` で開く。この private SPA shell
allowlist は share ID と高々1つの folder ID に限定し、未知の深い path は 404 のままにする。
node list/path/content ticket は既存 private API を使い、各 request で backend の share、
action、version、membership、ancestry、epoch fence を再評価する。

shared route では upload、folder 作成、rename、move、copy、trash と node action menu を表示
しない。`create` と `edit` は migration `0049_editable_shared_dav.sql` が追加した WebDAV
authority であり、この browser route が mutation authority を合成することはない。`download`
が現在の action にない file は browser から content ticket を要求しない。
query key は share version と direct recipient version または group membership version を含み、
変更後の mount data を古い file-list cache と共有しない。

breadcrumb は backend path から共有 root より下だけを表示する。共有 root を含まない path
応答は範囲外として fail closed にし、owner の祖先名を表示しない。

## 状態と accessibility

owner list、recipient list、group list、folder picker、shared mount の各 read は loading、
empty、error、retry を持つ。作成、action 更新、取り消しは pending 中の重複操作を抑止し、
server error を対象 card または dialog の alert として表示する。取り消しは確認 dialog を
必須とする。

navigation、dialog、fieldset、form label、section heading、status/alert、icon button の
accessible name を維持する。card grid、toolbar、details、dialog form は狭い viewport で
1 column に変わり、horizontal overflow を作らない。

## stale request と失効

TanStack Query の `signal` を全 share/group/mount/folder read に渡す。再取得や session clear
で supersede された request は `AbortSignal.any()` を通じて中止され、遅い旧応答で新しい
permission または mount list を上書きしない。

recipient が開いている間にも backend が authority であり、disabled/expired share、
membership removal/re-add、action version 更新は次の API request で拒否または再評価される。
UI の一覧から消えた mount、shared route の 404/403、root ancestry 不一致はいずれも access
不能状態として扱い、personal file controls へ fallback しない。

## migration と永続状態

この UI 変更は migration を追加しない。再共有の永続状態と authority は main の
`0048_internal_share_reshare.sql`、editable shared DAV は
`0049_editable_shared_dav.sql`、および backend service が所有し、browser は list/detail
output を表示して mutation input を送るだけである。owner の `rootName` は既存 `nodes` row、
recipient provenance は `share_grants`、`share_group_grants`、`share_groups`、
`share_group_members` の version/name から返す。browser-side share table、local storage、
public session、追加の Durable Object state は作らない。

recipientのstar/recent状態は migration `0050_user_node_state.sql` の
`user_node_state(user_id,node_id,starred,last_opened_at)` に保存する。共有node metadataや
ownerの状態には書き込まず、owner/recipientの一覧JOINは必ずcurrent user IDで限定する。
Starred/Recent readとmutationは共有version、recipient/group membership version、live ancestry、
epoch、maintenanceを再検証するため、revoke、membership removal、trash後の項目は即時に消える。
