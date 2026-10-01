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
  `read`/`download` action、有効期限を指定して作成する。
- `PATCH /api/v1/shares/:shareId`: `read` または `read,download` の canonical action set
  へ更新する。
- `DELETE /api/v1/shares/:shareId`: 既存 disable 処理で共有を取り消す。
- `GET /api/v1/groups`: 所有者の既存 group を bounded list として選択する。browser
  は group や membership の別状態を作らない。

mutation は既存 `ApiClient` の same-origin credential、private CSRF、no-store、
redirect rejection、timeout、session lifetime cancellation を通る。recipient email は作成時の
明示入力だけを送信し、directory search や unbounded recipient lookup は追加しない。

## recipient mount

`GET /api/v1/shared-with-me` は現在有効な mount だけを返す。各応答には D1 の grant から得た
次の provenance を含める。

- direct grant: `kind=direct` と `recipientVersion`
- group grant: `kind=group`、group ID/name、現在の `membershipVersion`

UI は provenance、有効な `read`/`download` action、owner、mount name を表示する。
direct/group の判定や effective action の計算は browser で行わない。mount が後続の成功応答
から消えた場合は、取り消し、期限切れ、membership 変更のいずれかとして再取得を案内するが、
過去の認可状態を保持して理由を断定しない。

mount は `/shared/:shareId` と `/shared/:shareId/:folderId` で開く。この private SPA shell
allowlist は share ID と高々1つの folder ID に限定し、未知の深い path は 404 のままにする。
node list/path/content ticket は既存 private API を使い、各 request で backend の share、
action、version、membership、ancestry、epoch fence を再評価する。

shared route では upload、folder 作成、rename、move、copy、trash と node action menu を表示
しない。`download` が現在の action にない file は browser から content ticket を要求しない。
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

migration は追加しない。owner の `rootName` は既存 `nodes` row、recipient provenance は既存
`share_grants`、`share_group_grants`、`share_groups`、`share_group_members` の version/name
から返す。browser-side share table、local storage、public session、追加の Durable Object
state は作らない。
