# セッション引き継ぎ

更新: 2026-09-24。次のセッションはこの資料から開始する。実際の `git status` / `git log` とコードを正とし、過去の会話だけで作業状態を推測しない。

## 目標とユーザーの追加条件

Cloudflare 上のファイル管理アプリを設計の完了条件まで実装する。Foundation のみを完成扱いにしない。
継続目標は「完成まで続けて」。完成した範囲は検証後にコミット・プッシュし、引き継ぎ資料も更新する。この checkpoint は全体完成ではない。

- 切りのよい単位で検証後に commit / push する。`origin/main` への通常 push はユーザー承認済み。force push はしない。
- ユーザーが事前に **画像 AVIF・動画 AV1・音声 Opus** にエンコードする。保存・配信・Gallery/player を必須対応にする。具体的なコンテナと試験条件は [MEDIA_FORMATS](MEDIA_FORMATS.md)。
- リモート Cloudflare の resource 作成・migration・配備は実行していない。GitHub push の許可を production 配備の許可とみなさない。
- 許可済みの可逆な実装・検証は継続し、必要な情報が足りる作業で確認を挟まない。

## 資料の読み方

1. [CURRENT_STATE](CURRENT_STATE.md) で実装済み・未実装・検証済み・未検証と、セッション間の固定事項を確認する。
2. この資料で直近の状態と再開点を確認する。
3. [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) をテスト件数・実行記録の正本とする。
4. [FOUNDATION](FOUNDATION.md) で変更対象の内部契約だけを読む。
5. [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) §2 が全 phase の順序、§8 が R6 の確定条件。
6. [DESIGN](DESIGN.md) v0.6 の該当章を参照。R6 は BRIEF §8、メディア追加要件は MEDIA_FORMATS を併読する。

`reviews/` と REVIEW_LOG は判断経緯。通常の再開時に全レビューを読み直す必要はない。

## 現在動いている範囲

Phase 0 のローカル基盤、Phase 1 の大半と Phase 2 / WebDAV / Phase 3 の一部。61通常テーブル、migration `0001`〜`0026`、147 route の契約がある。
JWT/JWKS、bootstrap、sessions、read/create/rename/content write/automation 認可、CSRF、quota/ref/pin/physical 会計、epoch 復旧、D1 permit、create/rename 用 LockDO、operation claim/lookup を実装済み。

直近の追加: WebDAV の MKCOL / PROPPATCH / PUT / DELETE / COPY / MOVE / LOCK と、private Files REST の folder create / rename / trash / MOVE / COPY を原子的 namespace mutationへ接続した。REST/DAVそれぞれのoperation provenanceをOutbox consumerと復旧監査まで検証する。content ticket、Cookie、R2 target manifest、current blob配信もHTTPへ接続済み。直近の検証件数と CI は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を正とする。ControlDO admissionは全監査後の段階再開をローカル実装済み。実環境では再開・配備していない。

主要な内部成果物（最新状態は進捗表を参照）:

| ファイル | 実装内容 |
|---|---|
| `do/controlAdmission.ts` / `ControlDO.resumeAdmission`・`resumeGarbageCollection` | migration `0025`、永続intentとD1 revision/token、最終batch fence、repair hold、停止と応答喪失の競合、初回bootstrapと実LockDO mutation |
| `jobs/gc.ts` / `jobs/orphanInventory.ts` / `ControlDO.drainBlobGarbageCollection`・`drainOrphanGarbageCollection` | migration `0024`、旧deletingのみの停止中回収、dispatch/final fence・counter・physical精算、全復旧監査fixture |
| `jobs/r2BindingVerification.ts` / `ControlDO.verifyInventoryBinding` | migration `0023`、固定64-byte system objectのfresh nonce/CASによるBLOBS/S3検証。scope内のみ有効なD1 fence、復旧監査・容量保持。全体閉鎖への接続は次段階 |
| `jobs/multipartInventoryRepair.ts` / `ControlDO.repairUnidentifiedMultipartUploads` | migration `0022`でscan/handleを永続化。全ページ後の実BLOBS abort、immutable receipt、physical観測。予約・復旧再開は保持 |
| `r2/s3Inventory.ts` / `jobs/multipartInventory.ts` / `ControlDO.inspectIncompleteMultipart` | S3署名付き未完了multipart/part/lifecycleのbounded診断。停止中のepoch fenceと監査再初期化へ接続。既存uploadの未知ID走査・中止は別serviceへ接続。予約解放は未接続 |
| `jobs/orphanInventory.ts` / `ControlDO.inventoryOrphanObjects` | 永続cursor/lease付き完成済みR2走査、未知keyの隔離・実physical会計・35日回収・同key再利用拒否、停止中の走査と復旧監査 |
| `services/uploads/` / `api/uploads.ts` / `auth/uploadCapability.ts` | private単一/分割uploadの予約、HMAC capability、R2送信/照合、LockDO/D1原子的complete、abort intent、期限切れ後のreceiptと最大200 partのHTTP照会 |
| `jobs/uploadCleanup.ts` / `ControlDO.repairExpiredUploads` | 24時間後のHEAD照合、lease付き回収、予約/physical会計、GC handoff、停止中の旧epoch修復。汎用予約回収は全uploadを除外 |
| `packages/worker/src/do/UploadDO.ts` / `uploadLedger.ts` / `uploadPlan.ts` | 固定multipart分割、SQLite attempt台帳、4並列/3試行/15分lease、認可RPC、D1 marker/mirror、停止alarm、complete/abort排他。`services/uploads/multipart.ts`でR2 create/part、`multipartComplete.ts`でcomplete/HEAD・原子的公開・terminal照合を接続。既知ID cleanupはCron/停止中repairに接続済み。private HTTPも接続済み |
| `packages/shared/src/names.ts` | NFC/portable name、Unicode 17 full casefold、folder-name search text/bigram |
| `packages/worker/src/services/fsMutation.ts` | SQL assertion、全 step と terminal の atomic commit、確実な rollback と commit_unknown の分離 |
| `packages/worker/src/services/createFolder.ts` | LockDO/認可/claim/7 step/terminal/release を接続した最初の folder create |
| `packages/worker/src/services/renameNode.ts` | 対象と親の lock、FTS 更新、operation/terminal/outbox を一括確定する改名 |
| `packages/worker/src/services/blobRead.ts` | Cookie→current credential/session/ticket/target manifest/blob plan と BudgetDO reserve/settle 付き R2 immutable blob HEAD/Range 配信基盤 |
| `packages/worker/src/do/BudgetDO.ts` | `budget_id` ごとの SQLite lease/byte/request/parallel counter。公開 fetch は未有効化 |
| `packages/worker/src/services/contentBudget.ts` | principal/share/unlock 単位の安定 budget ID を current D1 認可で確保・再利用。ticket 内部発行サービスに接続済み |
| `packages/worker/src/services/contentTicket.ts` | R2 target manifest の staging と読戻し、現行認可の一括証明、D1 ticket/target set 確定、応答喪失時の照合・object cleanup |
| `packages/worker/src/services/contentTicketCancel.ts` | current credential を照合し、ticket と派生 content session を同一 D1 batch で失効。共有 budget は維持 |
| `packages/worker/src/api/contentTickets.ts` | Access 認証済み private request の CSRF・bounded JSON 検査から ticket 発行/取消へ接続 |
| `packages/worker/src/api/privateApp.ts` / `privateAppConfig.ts` | app host の Access JWT→D1 session→`/me`・CSRF 発行・logout・app password・private ticket handler。必要な issuer/AUD/署名鍵/bootstrap 設定が無ければ 503 |
| `packages/worker/src/api/account.ts` | current credential を再確認する `/me`、CSRF 後の D1 session 失効と Access logout 303 |
| `packages/worker/src/services/nodeRead.ts` / `api/nodes.ts` | current ancestry と maintenance を D1 batch で確認する node 詳細・root-first breadcrumb・最大200件の keyset children 一覧 |
| `packages/worker/src/services/trashRead.ts` / `api/trash.ts` | owner space rootのcurrent認可とmaintenanceをD1 batchで再確認する、最大200件の署名keyset trash一覧 |
| `packages/worker/src/services/restoreTrash.ts` | 固定trash membershipをGC/permit/current destination fenceの下で深さ順に原子的復元するprivate RESTサービス |
| `packages/worker/src/services/purgeTrash.ts` | operation束縛node/blob manifestからFK順・depth降順にnamespaceを削除しGC candidateへ接続する原子的purge |
| `packages/worker/src/jobs/gc.ts` | ref/pin/pauseを再検査するclaim lease、R2 delete/head収束、physical bytes最終精算を行うbounded GC |
| `packages/worker/src/api/nodeMutations.ts` | CSRF と bounded JSON / Idempotency-Key の検査から folder 作成・rename・trash・MOVE・COPY、確定・競合・結果不明の HTTP 応答、同 credential の operation 照会 |
| `packages/worker/src/auth/nodeCursor.ts` | credential/parent/owner/epoch/tree generation と最終 sort key を10分の専用 HMAC kid ring に束縛 |
| `packages/worker/src/auth/appPassword.ts` / `api/dav.ts` | DAV Basic 用の厳密な入力境界、kid 別 pepper + PBKDF2 digest、認証前後の current D1 照合。OPTIONS、file GET/HEAD/Range、PROPFIND Depth 0/1、MKCOL、PROPPATCH、streaming PUT、subtree DELETE、same-owner COPY/MOVE、LOCK/UNLOCKを接続 |
| `packages/worker/src/dav/conditions.ts` / `conditionState.ts` / `etag.ts` | bounded `If` / `Lock-Token` 文法、tagged/untagged条件評価、独立token submission、same-origin D1 path/ancestor lock/ETag state。GET/HEAD・PROPFIND・条件評価のDAV validatorを共有し、MKCOL/PROPPATCHへtokenを接続 |
| `packages/worker/src/services/appPasswords.ts` / `api/appPasswords.ts` | Access/CSRF 付き app password 発行・一覧・失効、scope/root/件数/期限、秘密の一度きりの応答。発行した資格情報をDAV Basic認証へ接続 |
| `packages/worker/src/api/content.ts` | content host の ticket 交換/CORS と Cookie 配信 HTTP handler。ControlDO と署名鍵 gate は Worker entry |
| `packages/worker/src/auth/contentTokens.ts` / `contentAccept.ts` | kid ring の HS256 ticket/Cookie と D1 redemption。`content_sessions.ticket_id` は migration `0009` |
| `packages/worker/src/jobs/outbox.ts` | token/lease 付き producer、ID-only send、期限切れ再送、bounded repair scan |
| `packages/worker/src/jobs/consumeOutbox.ts` | create/rename event の current authority、元 operation step、保存済み operand/result を照合する consumer |
| `packages/worker/test/integration/fs-mutation.test.ts` | 全必須 step の rollback、並行再送、応答喪失、失効対 commit |
| `packages/worker/test/integration/outbox.test.ts` | producer 競合、送信/D1 応答喪失、completed の巻戻し拒否 |
| `packages/worker/test/unit/names.test.ts` | Unicode同名・portable禁止・長さ境界・検索正規化 |

直近の test 件数と CI は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を正とする。checkpoint の commit SHA と最新 CI は下記の Git コマンドで確認する。資料内に self-reference の commit SHA を固定しない。

## 公開・接続していないもの

- content/private/DAV HTTP handler は追加済みだが、ControlDO maintenance と署名鍵・remote secret未設定で実公開は停止中。Files SPAは[FILES_UI](FILES_UI.md)の範囲を接続済み。147 route の存在は handler の完成を意味しない。
- **ControlDOは起動/epoch回復時に閉じる。** 全監査後の`resumeAdmission`と最後の`resumeGarbageCollection`を内部RPCで実装済み。実環境の再開・operator UIは未実施。flagsを直接変更しない。[CONTROL_ADMISSION](CONTROL_ADMISSION.md)参照。
- LockDO namespace mutation の成功テストは test-only admission と実 DO SQLite/D1 を組み合わせる。実 ControlDO による稼働許可を実証したものではない。
- Queue handler と Cron は ControlDO/D1 admission gate を通過した場合に outbox を処理する。ControlDO が閉じている間は Queue を retry し、Cron は送信しない。実 Queue ack/DLQ の配信試験は未完了。
- private単一uploadのHTTP・D1予約・R2送信・原子的complete・abort・期限切れ回収・GC handoffは接続済み。multipartのD1予約/認可RPC/状態mirrorとR2 create/part送信は内部接続済み。multipartのR2 complete/HEAD・原子的新規/上書き公開は内部接続済み。既知IDのR2 abort・期限切れ回収は接続済み。private HTTPは接続済み。Files UIの一覧・操作・確認付き上書き/再開uploadは接続済み。未知object/multipart修復、全 operation の認可 tuple、検索/共有/contentの残り、DAV実client gate、Gallery/Bookshelf/Audio、運用・release は未完了。trash一覧・同期restore・同期purge・purge blob GCは接続済み。実環境のControlDO admission/Access/署名鍵設定、全route会計は未完了。ローカルbrowser fixtureは実ControlDOで受付を再開する。
- AVIF/AV1/Opus は形式基盤まで。実 track parser・配信経路・player/lightbox・ブラウザー実ファイル試験は未接続。
- Cloudflare staging inventory/Access/MFA・実 Images codec/費用・実 D1/Queue・backup復旧等の gate は未完了。ローカル成功で代替しない。
- private app route のリモート設定は `ACCESS_ISSUER`、`ACCESS_USER_AUDIENCE`、`ACCESS_SERVICE_AUDIENCE`、`BOOTSTRAP_OWNER_EMAILS`/`BOOTSTRAP_OWNER_IDENTITIES`、`BOOTSTRAP_QUOTA_BYTES`、`CSRF_PRIVATE_KEYS`/`CSRF_PUBLIC_KEYS` と各 active kid、content ticket/Cookie の kid ring。local `wrangler.jsonc` に秘密を置かず、未設定時は 503。
- app password 作成と DAV 認証には `APP_PASSWORD_PEPPERS` と `APP_PASSWORD_ACTIVE_KID` の pepper ring が必要。未設定なら 503。remote secret 登録は未完了。
- children とtrash一覧の続きには `NODE_CURSOR_KEYS` と `NODE_CURSOR_ACTIVE_KID` の専用 ring が必要。未設定時も node 詳細は使えるが両一覧 route は 503。
- 単一uploadは専用 `UPLOAD_CAPABILITY_KEYS` / `UPLOAD_CAPABILITY_ACTIVE_KID` が必要。32-byte base64url鍵をkidで選ぶ。旧kidは有効uploadの期限まで保持する。remote secret未設定ならupload routeは503。

## 次に進める順序

最新の追加は[確認付き上書き](UPLOAD_OVERWRITE.md)と[異なる配信対象のbudget台帳](BUDGET_ALLOWANCE.md)。上書きは対象node/revision/blobと元file名を保持し、全partのIf-Match、競合停止、完了応答喪失からのreceipt照合へ接続。配信budgetは認可manifestのpurpose/blobを重複排除し、対象追加でも使用量・回数・期限をリセットしない。同期transaction、1,024対象/lease・1 MiB上限、旧DO保存領域の期限までの制限を文書化した。実環境・共有/検索/media・全体admission等は引き続き未完了。全検証結果はIMPLEMENTATION_STATUSを参照。

前回の追加は[KDF isolate内制限](KDF_ADMISSION.md)。app passwordの作成・検証・pepper更新を同時1件、待機256件・5秒へ制限した。取消し中の実計算が終わるまで枠を保持し、混雑は503 + Retry-Afterで返す。作成前のAccess/root検査と計算後の現行D1 assertionを維持する。Node/workerd/独立HTTPの試験を追加。ControlDOによる全体600回/分・20並列とmutation32並列・待ちqueueは未実装なので、local executorで完了扱いにしない。

前回の追加は[本文なしHTTP操作](EMPTY_HTTP_BODY.md)。実HTTPで本文なしMKCOLが415になる不具合を修正し、DAVのCOPY/MOVE/DELETE/UNLOCK、private ticket/app-password取消し、logoutも共通検査へ接続した。実データ・既読/locked・失敗・取消しを拒否し、5秒・16回のreadで待機を制限する。Node境界13件、workerdの待機中失効/停止2件を追加し、既存D1/LockDO試験をclosed streamで拡張。独立HTTPでDAV作成から移動/コピー/削除/lock解除とticket取消しを検証した。`pnpm check`とbrowser試験は同一checkoutでは順番に実行する。並行buildによる開発サーバーreloadは進行中のfixtureを壊す。

直近は[通常稼働中の復元](RESTORE_GC.md)を実装。migration `0026`、61通常table。管理者GC設定と復元用の単一・5分期限holdを分け、既存deletingだけをdrainする。LockDO grantと原子的restoreの両方でoperation/token/epoch/期限を検査し、finally/alarmで解放する。alarmの失敗回数はepoch/revision/tokenごとに永続化し、連続6回でclosing intentを作って自動再試行を停止する。DB全面障害時もDOの受付は閉じ、復旧後にquiesce再送・repair・全監査が必要。古い失敗は新hold/管理者設定を閉じず、cleanup alarmも失わない。遅延処理、応答喪失、停止・epoch変更、eviction/全喪失を検証する。Files browser fixtureもGCを再開し、復元前後と応答喪失の再照会を試験する。次はaccount/KDF admissionと残るQueue、共有・検索・media UIを進める。Nodeとブラウザー型は分離。`pnpm test:browser`はlocal専用entryと`.wrangler/browser-tests`を使い、通常開発DBやremoteを変更しない。全checkにbrowser試験は含まれず、CIは別job。

直近はControlDOの受付とGCの段階再開を追加した。migration `0025`、61通常table。全監査とD1最終assert、永続revision/token、repair holdを使い、応答喪失・停止/epoch競合・eviction/全喪失を検証。手順と限界は[CONTROL_ADMISSION](CONTROL_ADMISSION.md)。Files UIの残り、account/KDF admission、残るQueue/共有/検索/媒体サービス、backup/exportと実環境gateを続ける。

直近は停止中GC drainを追加した。[GC_RECOVERY](GC_RECOVERY.md)に対象・上限・再試行と残作業を記録した。通常blob GCも各R2 dispatchと最終精算でepoch/mode/leaseを再確認する。schemaは61通常table/migration `0024`。未知multipartの全体閉鎖は進行中partとの競合を含むR2保証の確認が必要で、予約holdは解除していない。

その前の変更はmigration `0023`と`withVerifiedR2Inventory`によるBLOBS/S3対応検証。固定system keyの64-byte nonceを条件付きPUTで更新し、S3 GETとの一致を同じ60秒lease内で確かめる。成功booleanは後日再利用せず、callbackのcurrent D1 fenceと同じbatchでのみ後続変更を確定する。全体閉鎖・予約精算への接続は次段階。system probeを通常処理で削除しない。

その前の変更は既存uploadに対する未知multipart IDの永続走査とabort。`multipart_inventory_scans`登録と永久停止/claimを同じbatchにし、以後は普通のknown-ID cleanupによる早期精算を拒否する。別source/epochでcursorを再開せずroundを作り直す。1回1page/20件、既定10handleのabort。marker破壊を避けて全ページ後に中止する。R2 abort成功を各handleに保存し、S3の空一覧・NoSuchUpload・応答喪失は全体閉鎖としない。S3障害時にも完成物を計上するためHEADを一覧取得前と処理後に行う。後から判明した元IDも追加handleとして扱う。schemaは61通常table/migration `0023`。次は対応検証との接続・完全な不在証明と予約精算。scan/handleのdelete guardや予約holdを外すだけで完成扱いにしない。

未完了multipartのS3取得境界と停止中ControlDOの診断RPCを追加した。詳細は[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)。1回1 GET、20件既定/100件上限、1 MiB/10秒、manual redirect・retryなし、XML/echo/markerを検査する。`aws4fetch@1.0.20`をexactで追加し選定証拠を記録した。実S3設定・接続試験は未実施。返却の`bindingVerified:false`/`closureProven:false`を変更して修復扱いにしない。migration `0022`で複数IDの永続走査とpermanent stop/drain後のabortを追加済み。fresh nonceによるBLOBS/S3対応検証は別serviceへ追加済み。次は全体不在証明、予約精算へ接続する。D1 snapshotでpart行がないだけでは未完了bytesなしと推測できず、最初のIDだけuploadsへ保存して予約を解放してはいけない。

直近はprivate multipart HTTPのcreate/part/status/page/complete/abortを既存route契約へ接続した。契約は[UPLOAD_HTTP](UPLOAD_HTTP.md)。完成済み`u/` objectのinventory/35日回収も追加済み（[ORPHAN_INVENTORY](ORPHAN_INVENTORY.md)）。次はunknown multipart IDのS3 inventory修復と、Queue drain・復旧監査・再開gateを進める。readUploadは現在認可をsnapshot batchで再確認するD1照会専用で、DO台帳を再初期化しない。期限/idle/回収後も現在権限でreceiptを読むが、transfer fenceは維持する。multipart DELETEはD1のcreated/uploadingだけをabortingへCASし、completing/completedは409。遅延partの予約はR2回収まで保持する。`claim`の`dispatch`だけが新しいR2 callを許し、同attempt再送の`in_flight`では送信しない。`not_started`はR2未呼出しが確定している場合だけ使用する。D1のimmutable `multipart_ledger_id`をSQLite初期化より先に確定する。markerの応答喪失やDO storage全喪失では`upload_ledger_recovery_required`として停止し、空の新規台帳でbudgetをリセットしない。dirty part mirrorはSQLiteのrevisionで保持し、D1応答喪失時も同attemptへdispatchを再発行しない。D1 mirror失敗後の停止intentには再試行alarmを残す。R2 createの結果不明IDは再作成せず予約を保持するため、unknown IDは外部inventory/lifecycle実確認に基づくrepairが必要。7日経過だけでは予約を解放しない。

migration `0019`はmultipart_complete_attempt/lease、multipart_object_etag、成功partの不変性とcompleted終端guardを追加。R2 complete claimの応答喪失では再送せずHEADへ進み、不在だけでは再completeや予約解放を許さない。全partのD1 geometry/etag/hash証明、R2 objectのsize/metadata/etag、physical observationを最終fsMutationでも検査する。multipartのwhole sha256_verifiedはNULLを維持する。確定中の権限失効ではphysicalだけ計上し予約を維持、既知namespace失敗ではobject proofがある時だけ予約を解放する。D1 committed operation/digest/operand/result/stepをDO terminal照合の正本とし、ack喪失や旧epochで公開済みblobをcleanupへ戻さない。HEAD用control_calls上限64はcleanup counterと独立。

migration `0020`のmultipart_cleanup_started_atは回収開始後の再送/再初期化/completeを永続拒否し、multipart_cleanup_closedはR2 abort成功または既知complete attemptに対応する完成物のHEAD照合だけで固定する。activeなinit/part/complete leaseは待ち、期限/idle/旧epoch/停止intentをbounded scanで回収する。中止応答不明やNoSuchUploadとHEAD不在だけでは予約を戻さない。実bytesの観測を先に保存し、予約解放とGC handoffは同じbatch、physical減算はR2不在後のみ。CronとControlDO.repairStoppedMultipartUploadsに接続し、DO alarmは恒久停止markerを検出するとmirrorせず終了する。未知ID・不正metadataは隔離を維持する。

単一uploadの回収は24時間まで待ち、60秒claimのcurrent tokenでのみHEAD結果を精算する。HEAD失敗・metadata不一致では予約を保持する。physical観測、予約解放、GC handoffは原子的に確定し、R2不在確認前にphysicalを戻さない。単一uploadの未知object隔離は汎用inventory/repairの代替ではない。upload用のControlDO repairは完成objectを削除せず、multipartの既知handleのみabortする。別RPCの停止中GC drainだけが既存deleting objectの削除を完了する。admissionを再開しない。

以下の全体gateも引き続き必要:

1. **outbox Queue 実サービス / repair**: `node.created` と `node.renamed` のローカル handler を基に実 Queue/DLQ/requeue を検証し、残る kind の saved operand/result CAS と chunk fencing を実装する。ControlDO admission が閉じている間は `retryAll` を維持する。
2. **ControlDOの残る制御**: account単位のmutation同時数と待ちqueue、ControlDOのKDF全体rate/同時数、backup専用barrier、実restore drill。全監査後の受付再開は空DB/実データ両方で実装・検証済み。未知multipartの予約hold・最終fenceは維持する。
3. **Phase 1 の残り**: 各 operation の operand tuple、HTTP host/profile/CSRF、app-password/share secret 検証、operation lookup/commit_unknown response を接続。R6 §8 の全 fixture と完了条件を現在のテストへ対応付ける。
4. Phase 1 gate を閉じてから BRIEF の後続 phase を順に実装する。メディア形式の追加条件を維持し、最後に実環境 gate とリリース確認を行う。

フォルダー作成は current parent/revision/tree を読み、7 step を一括確定する内部サービス。SQL plan は server code のみで生成し、外部から任意 step/SQL を受け付けない。
現在の検索 helper は folder-name 用。media metadata の全文索引や検索 API が実装済みと扱わない。

## 再開コマンド

作業場所は実環境で確認する。現在の NixOS workspace は `/home/hiroshi/ドキュメント/Nextcloud-flare`（2026-09-23にユーザー指定で移動）。`/tmp/Nextcloud-flare`は移動前の保管用コピーで、開発先として使わない。Windows workspace は `C:\Users\micro\Documents\Nextcloud-flare`。remote: `https://github.com/daraskme/Nextcloud-flare.git`、branch: `main`。

```powershell
git status --short
git log -5 --oneline
gh run list --limit 3 --json databaseId,headSha,status,conclusion,url
node --version
pnpm --version
```

Node 24.21.0 / pnpm 12.4.1。依存は exact、公開後7日以上。`docs/toolchain.json` に選定証拠、`pnpm-lock.yaml` に固定版。
環境の準備が必要なら `pnpm install --frozen-lockfile`、変更後の checkpoint は `pnpm check`。
このPCにはGit対象外の`.local-toolchain/`に両固定版を用意した。NixOS用loaderで起動でき、repository rootから`.local-toolchain/run pnpm check`、`.local-toolchain/run pnpm dev`で使える。Node配布物は公式SHASUMS256との一致を確認後にloader/RPATHのみ調整した。OS全体の設定は変更していない。
範囲を絞った検証例:

```powershell
pnpm exec vitest run --config vitest.config.ts packages/worker/test/integration/fs-mutation.test.ts packages/worker/test/integration/outbox.test.ts
pnpm exec vitest run --config vitest.unit.config.ts packages/worker/test/unit/names.test.ts
```

schema 変更時は新 migration を追加し `node scripts/generate-schema-contracts.mjs` を実行する。既存適用済み migration を書き換えず、schema test のテーブル数/適用数も整合させる。
`pnpm build` は Vite + Wrangler **dry-run**。`pnpm dev` もローカル binding のみ。全0の resource ID を実環境の ID として利用しない。

## 環境で分かった注意点

- Windows の sandbox 内で esbuild の親 directory 読取りが拒否される場合がある。既存セッションでは承認された制限外プロセスで pnpm test/check/build を実行した。
- Git の index 書込みと network push に sandbox escalation が必要だった。拒否を lock 残骸と誤認して `.git/index.lock` を削除しない。
- Git author は global 未設定。必要時は `gh api user` と既存 commit の author を確認し、per-command config を使う。既存は `darask` / `102633287+daraskme@users.noreply.github.com`。global 設定は変更していない。
- `.gitattributes` は LF 固定。Windows CI の過去の改行失敗は修正済み。
- Vitest Workers pool 0.22 の intentional RPC rejection は cleanup を停止させることがある。拒否は `runInDurableObject` の内側で捕捉する。成功側を含め、admission fixture と実 RPC の検証範囲を区別する。
- 同梱 workerd の都合で compatibility date は2026-08-15。日付や依存更新は別途 gate を通す。
- ローカル試験の R2/DB fixture と実 inventory は別物。会計 fixture の一部は metadata のみで実 R2 object を作らないため、resume verifier 試験には整合する専用 fixture が必要。
- commit_unknown で namespace を補償しない。単純な `meta.changes` の JS 判定で rollback と判断しない。DO epoch を時刻から生成しない。秘密値・全 JWT・lock token をログしない。
