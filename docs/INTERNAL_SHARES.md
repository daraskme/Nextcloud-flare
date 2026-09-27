# 内部共有の管理

更新: 2026-09-28。Phase 6の内部共有管理と一覧APIを接続した段階。

## 利用者の操作

Filesの各項目の「共有を管理」から、登録済みメールアドレスを1〜20件指定して内部共有を作成する。閲覧はread/download、編集はread/download/create/edit/uploadを許可する。権限・共有相手・有効期限の変更と共有停止も同じ画面で行う。自分への共有、無効ユーザー、同じメールを持つ複数の有効アカウントは拒否する。メールはASCII・最大254文字、大小文字を区別せず照合する。

所有者の一覧には期限切れの共有も表示し、期限の延長や停止を可能にする。削除済みの祖先配下、停止済み、所有者無効化後の共有を公開しない。受信者には他の受信者のメールアドレスを返さない。

## APIと更新の条件

| 経路 | 動作 |
|---|---|
| `GET /api/v1/shares?rootNodeId=...` | 所有する共有。rootNodeId省略時は所有分全体 |
| `POST /api/v1/shares` | internal共有を作成。201とid/version/ETagを返す |
| `GET /api/v1/shares/:id` | 所有する共有の設定とETag |
| `PATCH /api/v1/shares/:id` | 相手・role・expiresAtを全体置換。rootの変更は不可 |
| `DELETE /api/v1/shares/:id` | versionを進めて停止。200のJSONで結果を返す |
| `GET /api/v1/shared-with-me` | 現在のgrantで利用できる共有と固定mountName |

書込みはAccessセッションと既存CSRFを要求する。PATCH/DELETEは`If-Match: "share-N"`が必須で、欠落/不正は428、事前照合でのversion競合は412。POST/PATCH本文は最大8 KiB、最大256chunk、5秒まで。rootNodeId・recipients・role・expiresAtと`kind: "internal"`以外の属性を拒否する。

共有の所有者だけが管理できる。app_adminでも他人の共有を操作できず、受信したedit権限を再共有することもできない。共通32 active/256 waitingのmutation受付を使い、現在のcredential/epoch/maintenance、rootと祖先の認可、相手の有効性・メールの一意性、期限と共有versionを更新batchで再検査する。更新と受付の確定記録・枠返却を同時に保存する。待機後のversion競合などでbatchが失敗した場合は汎用503として一覧確認を促す。

設定変更/停止はversionを進め、旧grantを無効化し、share_sessions/content_sessionsと紐づくticketを同じbatchで失効させる。更新後の相手だけに新versionを付与する。配信budgetを削除・初期化しない。DB確定応答の喪失はexact receiptで照合する。HTTP作成の再送を冪等化するoperation journalはまだ提供しないため、UIはPOSTを自動再送せず、入力を残して一覧の確認を要求する。

一覧は最大100候補と次ページ判定用の1件について、深さ64の祖先を同一D1 snapshotで検証する。署名cursorは用途・root/user・credential・epochに束縛し、各ページで現行権限を確認する。一覧全体のsnapshotを固定するものではない。非表示候補があるページはitemsが空でもnextCursorを持つ場合がある。trash用cursorとの相互流用を拒否する。

## マイグレーション

`0048_internal_share_mounts.sql`で共有作成時のmount_name/mount_name_ciと索引を追加する。新規mountは乱数prefixとその時点のroot名から作り、portableNameの文字/byte上限を満たす。rootを改名してもmountは不変。旧共有はNULLを保ち、過去の名前を推測して補わない。通常table数は69のまま。schemaのexport/FK順序に変更はない。

## 検証と残り

Nodeで入力境界とmigrationの不変条件、workerdの実D1でCRUD・read/edit認可・再共有拒否・相手差替え・旧session/ticket失効・budget保持・待機中の失効/祖先trash/停止/epoch/同時version更新・SQL rollback・確定応答喪失・cursorの用途分離を確認する。ブラウザーは実Access/CSRF/ControlDO/D1のAPIでmobile CRUD、作成応答喪失後の非再送、古い編集画面の競合拒否を確認する。最新件数は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

受信者のShared画面と共有選択を保つcontent/upload操作、`/dav/Shared/<mount>`の解決、既存NULL mountの移行方針、公開link/password/unlock/public bundle、upload-only、ZIPと共有メディアのE2Eは後続。現時点の管理画面と一覧APIだけでPhase 6完了とはしない。復旧の全体閉鎖と容量精算の未完了事項は[MULTIPART_ABORT_RECONCILIATION](MULTIPART_ABORT_RECONCILIATION.md)に残る。
