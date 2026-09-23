# 現在の実装・検証状態

更新日: 2026-09-24

この文書は、実装済み・未実装・検証済み・未検証をセッション間で共有するための入口である。実際の作業ツリー、最新commit、CI結果は必ずコマンドで再確認する。詳細な実行履歴は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、次回作業の注意事項は [HANDOFF](HANDOFF.md)、製品全体の完了条件は [DESIGN](DESIGN.md) と [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) を正とする。

## 状態の意味

| 状態 | 意味 |
|---|---|
| 実装済み | repository内に本体と接続経路がある。ただしリモート公開済みとは限らない |
| 検証済み（local） | Node/SQLiteまたはworkerdのD1/R2/DO/Imagesで自動試験済み |
| 検証済み（CI） | GitHub ActionsのUbuntu/Windowsでrepository全checkが成功済み |
| 未検証（staging） | 実Cloudflare resource、Access、Queue、ネットワーク、browser等の試験が残る |
| 未実装 | 必要なサービス、UI、運用処理、または接続経路がまだない |

ローカル成功はstagingやproductionの成功を意味しない。現在productionへのmigration・deployは行っていない。

## 実装済みでローカル検証済み

| 分野 | 実装済みの範囲 | 検証済みの範囲 | 残る境界 |
|---|---|---|---|
| schema・契約 | migration `0001`〜`0026`、61通常table、FTS、147 route契約、FK graph、会計・状態遷移trigger | SQLiteとD1 migration、FK/CHECK/trigger、生成契約一致 | 全147 routeの機能実装は未完了 |
| 認証 | Access JWT/JWKS、user/service分離、bootstrap、session、logout、CSRF、app password | JWT失敗境界、鍵cache、bootstrap競合、session失効、PBKDF2 | 実Access/MFA policy、remote issuer/AUD/secret |
| KDF実行制限 | app password作成・検証・pepper更新をisolate内1件、待機256件・5秒へ制限、取消しと503再試行 | Node/workerdで境界・実PBKDF2・失効競合。詳細は[KDF_ADMISSION](KDF_ADMISSION.md) | ControlDOの全体rate/同時数、共有password、実環境 |
| 認可 | private/app-password/internal-share/anonymous-shareのnode authority、祖先検査 | 4 principal、失効対commit、別owner・削除祖先拒否 | 全operation・全routeのoperand tuple |
| atomic mutation | operation claim/lookup、permit、LockDO、rollback、commit unknown収束 | 同時再送、競合、失効、応答喪失、全step rollback | 実ControlDO admission下のstaging試験 |
| Files UI | React/TanStackの一覧・操作・trash・確認付き上書き/再開upload・logout、認証付きprivate assets | ローカル実APIの16 browser scenario、NodeのCSRF競合4件 | 共有・検索・media・実環境。詳細は[FILES_UI](FILES_UI.md) |
| Files REST | node詳細、breadcrumb、children、folder作成、rename、trash、MOVE、COPY、operation照会 | 実D1/DO、cursor改変・期限・tree変更、Outbox provenance | 全route profile・実環境 |
| Trash | 一覧、restore、purge、別trash子退避、名前衝突解決、GC稼働中の永続pauseと既存削除drain | 最大64層・1,000 node、冪等再送、期限/識別子/停止競合、応答喪失・再起動、実browser復元 | 単一hold、実環境、大規模非同期trash/purge。詳細は[RESTORE_GC](RESTORE_GC.md) |
| 停止中GC drain | 旧deletingのみのblob/orphan回収、claim epoch・dispatch counter、ControlDO内部RPC、前後の監査初期化 | 応答喪失、停止/epoch/lease変更、遅延削除、二重精算防止、回収後の全復旧監査 | 外部置換objectの猶予、実R2・完全restore drill |
| GC | 7日猶予candidate、claim lease、pin/ref/pause fence、R2 delete/head、physical精算 | 実workerd R2、複数pin、pause、応答喪失、lease再取得 | unknown multipart ID、既知keyの不正置換、実Cron運用 |
| 未追跡object | D1のページcursor/lease、HEAD照合、隔離台帳、35日猶予、実physical会計、再利用拒否、Cronと停止中inventory | 応答喪失、同時走査/回収、置換・再出現、owner後日復元、pause/epoch、復旧監査 | incomplete multipart、他prefix、実R2運用 |
| multipart S3診断 | 署名付きListMultipartUploads/ListParts/GetBucketLifecycleConfiguration、1 GET/最大100件/1 MiB/10秒、停止中ControlDO診断 | XML/設定/署名/timeout/ページ失敗、実D1 fenceとControlDO監査再初期化、予約保持 | 対応検証との接続、全体不在証明・予約精算、実S3/lifecycle試験 |
| R2/S3対応検証 | migration `0023`、固定64-byte system probeのfresh nonce/CAS更新、scope付きD1 fence、ControlDO検証と復旧監査 | 実R2条件付きPUT、遅延create/更新、誤bucketの古い値、応答喪失、epoch/pause/lease、system容量保持 | multipart全体閉鎖・予約精算への接続、実S3試験 |
| multipart ID修復 | migration `0022`のscan/handle台帳、既存uploadの全ID走査・実BLOBS abort・不変receipt・physical観測、停止中ControlDO repair | 複数ID/ページ、claim・page・receipt応答喪失、遅延ID、epoch/token/pin/lease、S3障害時の会計 | 対応検証との接続と全体不在証明・予約精算、upload行ごと失われたhandle、実S3、Cron |
| private単一upload | HMAC capability、D1予約、1回だけのR2 PUT、SHA-256、GETによる応答喪失回収、原子的新規作成/上書き、status/abort HTTP、24時間後のCron回収・GC接続 | 実D1/R2/LockDO、0 byte、同時送信、10 step rollback、失効、DB/R2応答喪失、CSRF/Origin、回収lease競合、旧epoch、実ControlDO停止中repair | 公開共有、未知object修復、stagingは未完了 |
| private multipart upload | D1予約・immutable geometry、R2一度限りcreate、UploadDO認可RPC・状態/part mirror、streaming part/SHA-256、4並列・3試行、R2一度限りcomplete/HEAD、原子的新規/上書き公開、terminal照合、既知R2 IDのabort/期限切れ回収・GC接続、HTTP create/part/status/page/complete/abort | D1/R2/DO/LockDO、64 MiB+末尾の公開、同時確定、応答喪失、storage全喪失、失効、10 step rollback、complete/abort排他 | 未知ID回収後の予約精算は未接続 |
| WebDAV | OPTIONS、GET/HEAD/Range、PROPFIND Depth 0/1、MKCOL、PROPPATCH、PUT、DELETE、COPY、MOVE、LOCK/UNLOCK | path、If/Lock-Token、ETag、dead props、95MB stream、各mutation、実HTTPの空本文操作。詳細は[EMPTY_HTTP_BODY](EMPTY_HTTP_BODY.md) | 実OS client gate、共有DAV、残るmethod/profile |
| content ticket | target manifest、ticket発行/取消、Cookie交換、current blob配信、BudgetDOの対象重複排除/共有使用量 | D1/R2、署名、失効、Range、budget reserve/settle、実HTTPの発行・交換・空本文取消し、上書き/別target配信、1MiB/対象数上限。詳細は[BUDGET_ALLOWANCE](BUDGET_ALLOWANCE.md) | ZIP/page/entry/track、全route会計 |
| quota・会計 | logical ref、pin、used/reserved/physical bytes、reservation | counter drift、上限、rollback、物理削除精算 | 実運用repairとalert |
| Outbox | durable producer、lease再送、ID-only Queue message、consumer、bounded repair | send/D1応答喪失、重複delivery、主要node event provenance | 実Queue/DLQ、残るevent kind |
| 復旧基盤 | epoch履歴、quiesce、paged recovery audit、FTS rebuild、限定cleanup、受付/GCの段階再開、永続repair hold | DO eviction/全喪失、実LockDO mutation、HTTP bootstrap、応答喪失・停止競合、最終batch fence | 完全restore drill、実環境、account/KDF admission |
| media形式基盤 | AVIF/AV1/Opus判定、bounded sniff、ZIP STORE serializer | format vector、境界、CRC、Unicode、cancel | parser、変換、配信、player/gallery/reader |

最新の全検証記録は Node 356件 + workerd 771件 = 1,127件。別途browser16件成功、合計1,143件。全checkは、lint、typecheck、contracts、config、schema整合性テスト、Web build、Wrangler dry-runを含む。migration `0026`をローカルD1/SQLiteへ適用済み。件数は追加実装で変わるため、次回は再実行結果で更新する。

## 実装済みだがstaging未検証・未公開

- Workerのprivate/content/DAV handler。ControlDOは監査後に再開可能だが、実環境の設定・公開は未実施。
- Queue consumer、Cron outbox dispatch、Cron GC。ローカルworkerdでは検証済みだが実Queue/DLQ/Cron deliveryは未検証。
- Cloudflare Images bindingの入力境界。実codec、制限、費用は未検証。
- Access JWT、app password、content ticket、cursor鍵。remote secretと実鍵rotationは未設定・未検証。
- 実D1/R2/KV/DO/Queue/Rate Limit/Assets間のネットワーク断、retry、region挙動。
- WebDAVのWindows/macOS/Linux実client相互運用。
- custom domain、host分離、CORS/Cookie、workers.dev/preview無効化の実環境確認。

## 未実装

### サービスとデータ処理

- multipartのunknown creation IDの全体閉鎖・予約精算と実7日incomplete lifecycle検証。既存uploadの未知ID中止とfresh nonceによるBLOBS/S3対応検証は実装済み。S3設定読取りと一覧/partのbounded診断は接続済み（[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)）。
- upload行自体が失われたincomplete multipartの全体inventory・repair。未知の完成済み`u/` objectの隔離・35日回収は接続済み。
- 大規模tree向けの非同期trash/restore/purge job。
- 残るoperationの認可tuple、terminal lookup、Outbox consumer/repair。
- 検索API、権限filter付きpagination、media metadata全文検索。
- 共有作成・編集・解除、内部共有、公開link、password/unlock、upload-only共有の完全なHTTP surface。
- ZIP download、archive entry、EPUB page、audio/video track、thumbnail/derivativeの完全なHTTP配信。
- 日次logical export、backup manifest、Time Travel手順、restore automation。
- `u/`以外の未追跡生成物、catalogueに残るkeyの不正置換。既存deletingの停止中blob/orphan drainは接続済み（[GC_RECOVERY](GC_RECOVERY.md)）。

### UI

- File System Access handle、詳細preview。
- share管理、検索APIとの接続、大量gridの仮想化。
- Gallery/lightbox、Bookshelf/EPUB reader、Audio player。
- AVIF/AV1/Opusの実browser再生試験とfallback。

### 制御・運用

- account単位のmutation同時数・待ちqueue、ControlDOのKDF全体rate/同時実行制限、共有password制限、backup専用barrier。isolate内のKDF制限は実装済み。
- operator HTTP/管理UIと実環境の停止・全復旧監査・段階再開drill。内部RPCの最終再開gateは[CONTROL_ADMISSION](CONTROL_ADMISSION.md)に実装済み。
- staging/production resource inventory、remote migration、deploy。
- monitoring、alert、Logpush、capacity/費用確認。
- backup/restore drill、release、rollback、障害対応runbookの実行。

## 未検証

未実装項目は当然未検証である。それ以外に、実装済みでも次は未検証である。

- 実Cloudflare Access + MFA + service token。
- 実Queueのack loss、最大retry、DLQ、requeue。
- 実Cronの重複・遅延・同時実行。
- 実R2のdelete/head障害、429、長時間ネットワーク断、lifecycle。
- 実D1 Time Travelとlogical exportからの復元。
- 実CloudflareでのControlDO storage lossを含む完全な停止→監査→再開。ローカルfixtureは検証済み。
- 実Images codecとAVIF生成。
- 複数ブラウザー、モバイル、支援技術、実WebDAV client。
- セキュリティheader、CORS、Cookie、domain aliasのdeploy後検査。
- 負荷、長時間運転、大量データ、費用上限。

## セッションをまたいで保持する事項

### 目標

Foundationだけで完了扱いにせず、[DESIGN](DESIGN.md) と [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) の製品完了条件まで進める。ユーザー確認が不要なローカル実装、試験、通常commit、`origin/main`への通常pushは継続する。

### 許可と禁止

- 検証済みのまとまりはcommitし、`origin/main`へ通常pushしてよい。
- force pushはしない。
- GitHubへのpushをCloudflare production deployの許可と解釈しない。
- remote resource作成、remote D1 migration、secret設定、staging/production deployは、具体的な環境情報と実行段階の確認が必要。
- secretをrepository、`wrangler.jsonc`、logへ書かない。

### 壊してはいけない条件

- ControlDO再開は全監査と同一D1 batchの最終fenceを通す。flagsを直接解除しない。実環境再開は未実施。
- D1がnamespace・authorization・ledgerの正本、R2がimmutable contentの正本。
- mutationはcurrent auth、epoch、permit、revision/tree fence、operation terminalを同じatomic boundaryで確認する。
- `blobs.state='deleting'` とGC `deleting`は不可逆。
- blob参照追加は`deleting/deleted`を拒否する。
- GCはref=0、全pinなし、current control mode・epoch・claim所有を各dispatch/精算時に再検査する。通常GCはpause解除時のみ、停止中drainは既存deletingのみ。不在確認後だけphysical精算する。
- 適用済みmigrationを書き換えず、新しい番号のmigrationを追加する。
- AVIF・AV1・Opusを保存・配信・Gallery/player要件から外さない。詳細は [MEDIA_FORMATS](MEDIA_FORMATS.md)。

### 次の優先順

1. unknown multipart IDのS3/BLOBS対応証明・全体不在証明・予約精算を実装。S3診断と完成済み`u/` objectの隔離・35日回収は接続済み。
2. Upload/GC/Queueの未完了状態を復旧監査と修復に統合。
3. Queueの残るevent kindとrepair。
4. account mutation / KDF全体admission、backup barrier、実環境のrestore/再開drill。内部RPCの段階再開は実装済み。
5. Files UIの残り（共有・検索・media）。
6. share、search、ZIP/reader/media配信。
7. backup/export/restore drill。
8. staging inventoryと実環境gate。

### 次回開始時の確認

```sh
cd /home/hiroshi/ドキュメント/Nextcloud-flare
git status --short
git diff
git log -5 --oneline
gh run list --limit 3 --json databaseId,headSha,status,conclusion,url
```

変更前に既存差分を保護する。変更後は最低限 `git diff --check`、該当テスト、typecheckを行い、checkpoint前に全check、Web build、Wrangler dry-runを実行する。schema変更時は新migrationを追加し、`node scripts/generate-schema-contracts.mjs`とschema testを更新する。

## 文書更新ルール

checkpointごとに次を更新する。

1. この文書の該当行を「実装済み」「staging未検証」「未実装」の間で移動する。
2. [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ実行コマンド、件数、結果を記録する。
3. [HANDOFF](HANDOFF.md)の次作業と注意事項を更新する。
4. READMEの短い概要が古くなっていないか確認する。
