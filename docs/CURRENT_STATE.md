# 現在の実装・検証状態

更新日: 2026-09-23

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
| schema・契約 | migration `0001`〜`0021`、58通常table、FTS、147 route契約、FK graph、会計・状態遷移trigger | SQLiteとD1 migration、FK/CHECK/trigger、生成契約一致 | 全147 routeの機能実装は未完了 |
| 認証 | Access JWT/JWKS、user/service分離、bootstrap、session、logout、CSRF、app password | JWT失敗境界、鍵cache、bootstrap競合、session失効、PBKDF2 | 実Access/MFA policy、remote issuer/AUD/secret |
| 認可 | private/app-password/internal-share/anonymous-shareのnode authority、祖先検査 | 4 principal、失効対commit、別owner・削除祖先拒否 | 全operation・全routeのoperand tuple |
| atomic mutation | operation claim/lookup、permit、LockDO、rollback、commit unknown収束 | 同時再送、競合、失効、応答喪失、全step rollback | 実ControlDO admission下のstaging試験 |
| Files REST | node詳細、breadcrumb、children、folder作成、rename、trash、MOVE、COPY、operation照会 | 実D1/DO、cursor改変・期限・tree変更、Outbox provenance | Files UI、全route profile |
| Trash | 一覧、restore、purge、別trash子退避、名前衝突解決 | 最大64層・1,000 node、冪等再送、GC競合、深さ順処理 | 大規模非同期trash/purgeは未実装 |
| GC | 7日猶予candidate、claim lease、pin/ref/pause fence、R2 delete/head、physical精算 | 実workerd R2、複数pin、pause、応答喪失、lease再取得 | unknown multipart ID、既知keyの不正置換、実Cron運用 |
| 未追跡object | D1のページcursor/lease、HEAD照合、隔離台帳、35日猶予、実physical会計、再利用拒否、Cronと停止中inventory | 応答喪失、同時走査/回収、置換・再出現、owner後日復元、pause/epoch、復旧監査 | incomplete multipart、他prefix、停止中GC drain、実R2運用 |
| multipart S3診断 | 署名付きListMultipartUploads/ListParts/GetBucketLifecycleConfiguration、1 GET/最大100件/1 MiB/10秒、停止中ControlDO診断 | XML/設定/署名/timeout/ページ失敗、実D1 fenceとControlDO監査再初期化、予約保持 | 実BLOBS対応証明、永続scan・未知ID回収、実S3/lifecycle試験 |
| private単一upload | HMAC capability、D1予約、1回だけのR2 PUT、SHA-256、GETによる応答喪失回収、原子的新規作成/上書き、status/abort HTTP、24時間後のCron回収・GC接続 | 実D1/R2/LockDO、0 byte、同時送信、10 step rollback、失効、DB/R2応答喪失、CSRF/Origin、回収lease競合、旧epoch、実ControlDO停止中repair | 公開共有、Files UI、未知object修復、stagingは未完了 |
| private multipart upload | D1予約・immutable geometry、R2一度限りcreate、UploadDO認可RPC・状態/part mirror、streaming part/SHA-256、4並列・3試行、R2一度限りcomplete/HEAD、原子的新規/上書き公開、terminal照合、既知R2 IDのabort/期限切れ回収・GC接続、HTTP create/part/status/page/complete/abort | D1/R2/DO/LockDO、64 MiB+末尾の公開、同時確定、応答喪失、storage全喪失、失効、10 step rollback、complete/abort排他 | UI・未知IDの外部inventory回収は未接続 |
| WebDAV | OPTIONS、GET/HEAD/Range、PROPFIND Depth 0/1、MKCOL、PROPPATCH、PUT、DELETE、COPY、MOVE、LOCK/UNLOCK | path、If/Lock-Token、ETag、dead props、95MB stream、各mutation | 実OS client gate、共有DAV、残るmethod/profile |
| content ticket | target manifest、ticket発行/取消、Cookie交換、current blob配信、BudgetDO | D1/R2、署名、失効、Range、budget reserve/settle | ZIP/page/entry/track、全route会計 |
| quota・会計 | logical ref、pin、used/reserved/physical bytes、reservation | counter drift、上限、rollback、物理削除精算 | 実運用repairとalert |
| Outbox | durable producer、lease再送、ID-only Queue message、consumer、bounded repair | send/D1応答喪失、重複delivery、主要node event provenance | 実Queue/DLQ、残るevent kind |
| 復旧基盤 | epoch履歴、quiesce、paged recovery audit、FTS rebuild、限定cleanup | DO eviction、R2 inventory、会計・credential/share/outbox監査 | admission再開、未完了GC drain、完全restore drill |
| media形式基盤 | AVIF/AV1/Opus判定、bounded sniff、ZIP STORE serializer | format vector、境界、CRC、Unicode、cancel | parser、変換、配信、player/gallery/reader |

最新の全検証記録は Node 326件 + workerd 612件 = 938件で、lint、typecheck、contracts、config、schema整合性テスト、Web build、Wrangler dry-runを含む。migration `0021`をローカルD1/SQLiteへ適用済み。件数は追加実装で変わるため、次回は再実行結果で更新する。

## 実装済みだがstaging未検証・未公開

- Workerのprivate/content/DAV handler。ControlDOが閉じているため公開停止中。
- Queue consumer、Cron outbox dispatch、Cron GC。ローカルworkerdでは検証済みだが実Queue/DLQ/Cron deliveryは未検証。
- Cloudflare Images bindingの入力境界。実codec、制限、費用は未検証。
- Access JWT、app password、content ticket、cursor鍵。remote secretと実鍵rotationは未設定・未検証。
- 実D1/R2/KV/DO/Queue/Rate Limit/Assets間のネットワーク断、retry、region挙動。
- WebDAVのWindows/macOS/Linux実client相互運用。
- custom domain、host分離、CORS/Cookie、workers.dev/preview無効化の実環境確認。

## 未実装

### サービスとデータ処理

- multipartのFiles UI。private HTTP create/part/status/page/complete/abortは接続済み。契約は[UPLOAD_HTTP](UPLOAD_HTTP.md)。
- multipartのunknown creation IDの外部inventoryからの回収、実BLOBS対応証明、実7日incomplete lifecycle検証。S3設定読取りと一覧/partのbounded診断は接続済み（[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)）。
- incomplete multipartの永続inventory・repair。未知の完成済み`u/` objectの隔離・35日回収は接続済み。
- 大規模tree向けの非同期trash/restore/purge job。
- 残るoperationの認可tuple、terminal lookup、Outbox consumer/repair。
- 検索API、権限filter付きpagination、media metadata全文検索。
- 共有作成・編集・解除、内部共有、公開link、password/unlock、upload-only共有の完全なHTTP surface。
- ZIP download、archive entry、EPUB page、audio/video track、thumbnail/derivativeの完全なHTTP配信。
- 日次logical export、backup manifest、Time Travel手順、restore automation。
- `u/`以外の未追跡生成物、catalogueに残るkeyの不正置換、停止中の未完了orphan GC drain。

### UI

- Files SPA全体。現在は準備用HTMLのみ。
- file一覧、upload、作成、rename、move、copy、trash、restore、purgeの画面。
- share管理、検索、進捗、競合、失敗復旧、logout後navigation。
- Gallery/lightbox、Bookshelf/EPUB reader、Audio player。
- AVIF/AV1/Opusの実browser再生試験とfallback。

### 制御・運用

- ControlDOの安全なadmission/resume。`maintenance=true` / `gcPaused=true`を単純に解除してはいけない。
- Upload/GC/Queue/permit drainと復旧監査を束ねた最終再開gate。
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
- ControlDO storage lossを含む完全な停止→監査→再開。
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

- ControlDOは安全なresumeが完成するまでfail closedを維持する。
- D1がnamespace・authorization・ledgerの正本、R2がimmutable contentの正本。
- mutationはcurrent auth、epoch、permit、revision/tree fence、operation terminalを同じatomic boundaryで確認する。
- `blobs.state='deleting'` とGC `deleting`は不可逆。
- blob参照追加は`deleting/deleted`を拒否する。
- GCはref=0、全pinなし、pause解除、claim所有を再検査し、R2不在確認後だけphysical精算する。
- 適用済みmigrationを書き換えず、新しい番号のmigrationを追加する。
- AVIF・AV1・Opusを保存・配信・Gallery/player要件から外さない。詳細は [MEDIA_FORMATS](MEDIA_FORMATS.md)。

### 次の優先順

1. unknown multipart IDのS3/BLOBS対応証明・永続inventory・修復を実装。S3診断と完成済み`u/` objectの隔離・35日回収は接続済み。
2. Upload/GC/Queueの未完了状態を復旧監査と修復に統合。
3. Queueの残るevent kindとrepair。
4. recovery auditの不足を埋め、ControlDO admission/resumeを実装。
5. Files UI。
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
