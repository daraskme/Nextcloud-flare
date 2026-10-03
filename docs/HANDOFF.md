# セッション引き継ぎ

更新: 2026-10-03。次のセッションはこの資料から開始する。実際の `git status` / `git log` とコードを正とし、過去の会話だけで作業状態を推測しない。

## 目標とユーザーの追加条件

Cloudflare 上のファイル管理アプリを設計の完了条件まで実装する。Foundation のみを完成扱いにしない。
継続目標は「完成まで続けて」。完成した範囲は検証後にコミット・プッシュし、引き継ぎ資料も更新する。この checkpoint は全体完成ではない。

- 切りのよい単位で検証後に commit / push する。`origin/main` への通常 push はユーザー承認済み。force push はしない。
- ユーザーが事前に **画像 AVIF・動画 AV1・音声 Opus** にエンコードする。保存・配信・Gallery/player を必須対応にする。具体的なコンテナと試験条件は [MEDIA_FORMATS](MEDIA_FORMATS.md)。
- 承認済みの Cloudflare staging は `darask.date` に配備済み。通常 push と staging の継続実装・検証を進める。production 配備は別の境界。最新の実環境状態は [staging runbook](../ops/staging/README.md) を正とする。
- 許可済みの可逆な実装・検証は継続し、必要な情報が足りる作業で確認を挟まない。

## 2026-10-03 の追加依頼

管理者1人と一般利用者2人の実Accessログイン、アップロード・ダウンロード、一般利用者間の一覧分離をユーザーが確認済み。管理者には専用画面で全利用者の一覧・閲覧・ダウンロードを許可し、読み取り専用・閲覧履歴付きにすることを選択した。[ADMIN_FILES](ADMIN_FILES.md) に操作と権限を記載する。一般APIやDAVのowner/share境界を一律に緩めない。

音声・動画の実再生も依頼された。AV1動画と音声のみのOpus（Ogg/WebM/MP4）を必須対象とし、拡張子やクライアント申告だけでMIMEを確定しない。実アップロードから解析・一覧・content session・デコード・シークまで確認し、ローカルfixtureと実Cloudflare、試したbrowserと未試験browserを区別する。以前の「media UI接続済み」だけで実再生確認済みと扱わない。

この追加分はstaging version `02bf2b69-a687-42a4-a1ad-9855a8fd2ea6` に反映済み。0052/0053を適用し、52 migrations・83通常table・168 route契約。次のmigration番号は0054以降とする。単体806件、関連統合145件、全browser45件、ビルド・静的検査、83-table backup drill、配備後の匿名smoke 9件が成功した。MP3、Opus 3 container、AV1+Opus 2 containerはローカルChromeで一般利用者・管理者双方の再生・seekを検証した。残る直近確認は、本人のログイン済みブラウザーによるstaging管理画面・メディア再生と、この変更のGitHub CI結果。別ブラウザー・長時間/高解像度の実ファイルは未試験。

## 資料の読み方

1. [CURRENT_STATE](CURRENT_STATE.md) で実装済み・未実装・検証済み・未検証と、セッション間の固定事項を確認する。
2. この資料で直近の状態と再開点を確認する。
3. [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) をテスト件数・実行記録の正本とする。
4. [FOUNDATION](FOUNDATION.md) で変更対象の内部契約だけを読む。
5. [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) §2 が全 phase の順序、§8 が R6 の確定条件。
6. [DESIGN](DESIGN.md) v0.6 の該当章を参照。R6 は BRIEF §8、メディア追加要件は MEDIA_FORMATS を併読する。

`reviews/` と REVIEW_LOG は判断経緯。通常の再開時に全レビューを読み直す必要はない。

## 2026-10-02 時点の再開点（履歴）

2026-10-01のmainにはgroup lifecycle・recipient reshare、app password/WebDAV設定、Recent/Starred、private ZIP、media resume stateのUIも統合済み。2026-10-02の前回checkpointではFiles gridの仮想化、private Gallery ticket取消し、移動Outboxの移動元親権限検査、DAV同時接続のKDF即時503、実AVIF静止画とAV1+Opus WebMの単体fixtureを統合した。`pnpm check`はNode774件・workerd2,214件、全browser39件が成功した。

同日の継続作業では、現行audio投影限定のmetadata検索をAPI・Files UIへ接続し、移動operationのterminal lookupで移動元親権限と対応node stepを再確認する。実AVIF静止画は隔離HTTPSのChromiumでthumbnail/原本とも16×12として表示できた。`pnpm check`はNode774件・workerd2,218件、全browser40件が成功した。次はvideo/image metadata検索、AV1+Opusの実再生・複数browser、残るoperation/Outbox/repairと復旧・運用を進める。実環境へのmigration・deployは未実施。

Cloudflare stagingの候補hostは`staging-app.darask.date`と`staging-content.darask.date`。設定テンプレートと台帳は[ops/staging](../ops/staging/README.md)、複数テスト利用者のAccess設定は[STAGING_ACCESS](STAGING_ACCESS.md)。ユーザーの予算はstagingの追加費用で月1万円。CloudflareのBudget alertsはアカウント全体の通知で、staging単独の強制停止ではない。Cloudflare scoped API tokenをGitHub Environment `staging`から使う手動ワークフローを追加した。初回Worker/resource作成・remote migrationは別手順で、account ID・resource実ID・token/secretは未設定。remote作成・migration・deployは未実施。

アプリ側は初回管理者だけをbootstrapし、管理者の7日間の明示招待をAccessの正確なissuer・メール表記と照合して、本人の初回ログインで`iss+sub`と専用space/rootへ一度だけ結び付ける。管理者設定画面には招待の追加・保留一覧・取消を接続した。アプリはメールを送らず、AccessのAllowとアプリ招待の両方が必要。一般利用者の初期quotaは1 GiB。実Cloudflare Accessでの複数利用者試験は未実施。

読み取り専用/upload-only公開link、Queue dead-letter repair、audio/video metadata、画像metadata/thumbnail、bounded private/public ZIP/EPUB、private/public media UI、direct-user/group internal share、bounded reshare、編集可能なshared DAV、multipart closure settlement、大規模treeの非同期trash/restore/purgeをmainへ統合した。internal shareはowner lifecycle、rename-stable mount、recipient/action/share/policy/delegation/ancestry/epoch fenceを持ち、group shareはmembership versionも検査する。owner/recipient管理UIは現在有効な操作とprovenanceを表示し、share actionと再共有ポリシーを管理する。

最新変更はmigration `0051`（全50件）・81通常tableで、bounded reshare authority、編集可能なshared DAV authorization context、Access招待台帳を持つ。1,000 node以下のtrash/restore/purgeは既存同期経路、1,001〜10,000 nodeはoperationに結合した`bulk_jobs`、manifest、250 node cursor、dispatch/worker leaseで処理する。RESTは202とoperation location/job progressを返し、DAV DELETEの1,001 node拒否は維持する。

workerは各chunkと最終確定でepoch、maintenance、current credential/authority、owner、root/parent ancestry、revision/tree generation、operation operand、job claimを再検査する。restoreは最終確定時にGC pauseを取得しrootからdepth順に復元、purgeはD1のnamespace/ref/quota/GC candidateを先に確定してR2 bytesを直接削除しない。Queue/DLQ/Cronの実Cloudflare検証とremote migration/deployは未実施である。

multipart closureはquiet period、bounded bucket verification、immutable closure run、handle/upload settlement receipt、ControlDO inspect/advance/settle、owner ledger・recovery fenceを持つ。全bucket scanやabortだけで予約・保留容量を返さず、closure proofとexact receiptの成立後だけ精算する。

backup sweep、maintain、pruneとoffline restoreは引き続き実装済みで、最新schema 81 tableを生成・検証対象とする。定時起動の実設置、外部通知、Time Travel/live restore、remote運用は未実施である。

読み取り専用public shareのGallery/Audio/Bookshelf/Video UI、thumbnail/audio/video ticket、EPUB metadata/page/entryとbounded ZIP create/redirect、idempotent manifest/ticket再発行、content-origin Range/HEAD、大規模treeの非同期trash/restore/purge、bounded reshare、編集可能なshared DAV、内部共有管理UIを接続した。private mediaの実ファイル・複数browser検証、timer設置・外部通知、破損世代、Time Travel/live復旧、未知KDF、実OS client・実環境gateを残す。remote migration・deployは未実施。

次のschema変更は`0050`以後を使い、既存migrationを編集しません。`0045`が欠番でも、適用済みの`0046_multipart_closure.sql`を改名しません。日次の再実行は同じUUID/epochを継続し、不明な開始/保存結果を自動取消ししません。

## 2026-10-02 時点で動いていた範囲（履歴）

Phase 0 のローカル基盤、Phase 1 の大半と Files/WebDAV/共有、Phase 3 media配信基盤の一部。80通常テーブル、48 migrations（最新`0049`）、156 route の契約がある。
JWT/JWKS、bootstrap、sessions、read/create/rename/content write/automation 認可、CSRF、quota/ref/pin/physical 会計、epoch 復旧、D1 permit、create/rename 用 LockDO、operation claim/lookup を実装済み。

直近の追加: public EPUB metadata/page/entryと大規模非同期tree処理。既存Files REST/WebDAV mutation、content ticket、Cookie、R2 target manifest、current blob配信と同じD1/R2/DO authorityを維持する。直近の検証件数と CI は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を正とする。ControlDO admissionは全監査後の段階再開をローカル実装済み。実環境では再開・配備していない。

主要な内部成果物（最新状態は進捗表を参照）:

| ファイル | 実装内容 |
|---|---|
| `jobs/multipartBucketInventory.ts` / `jobs/multipartBucketAbort.ts` / `jobs/multipartClosure.ts` / ControlDO内部RPC | migration `0027`/`0028`/`0046`、upload行不要の全bucket走査・part容量保留・発見handleの中止・quiet period後のclosure proof・handle/upload settlement |
| `do/controlAdmission.ts` / `ControlDO.resumeAdmission`・`resumeGarbageCollection` | migration `0025`、永続intentとD1 revision/token、最終batch fence、repair hold、停止と応答喪失の競合、初回bootstrapと実LockDO mutation |
| `jobs/gc.ts` / `jobs/orphanInventory.ts` / `ControlDO.drainBlobGarbageCollection`・`drainOrphanGarbageCollection` | migration `0024`、旧deletingのみの停止中回収、dispatch/final fence・counter・physical精算、全復旧監査fixture |
| `jobs/r2BindingVerification.ts` / `ControlDO.verifyInventoryBinding` | migration `0023`、固定64-byte system objectのfresh nonce/CASによるBLOBS/S3検証。scope内のみ有効なD1 fence、復旧監査・容量保持。multipart closureへ接続済み |
| `jobs/multipartInventoryRepair.ts` / `ControlDO.repairUnidentifiedMultipartUploads` | migration `0022`でscan/handleを永続化。全ページ後の実BLOBS abort、immutable receipt、physical観測。closure settlementまで予約・復旧fenceを保持 |
| `r2/s3Inventory.ts` / `jobs/multipartInventory.ts` / `ControlDO.inspectIncompleteMultipart` | S3署名付き未完了multipart/part/lifecycleのbounded診断。停止中のepoch fence、監査再初期化、closure inspect/advance/settleへ接続 |
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

## 2026-10-02 時点の未公開・未接続事項（履歴）

- content/private/DAV HTTP handler は追加済みだが、ControlDO maintenance と署名鍵・remote secret未設定で実公開は停止中。Files SPAは[FILES_UI](FILES_UI.md)の範囲を接続済み。156 route の存在は handler の完成を意味しない。
- **ControlDOは起動/epoch回復時に閉じる。** 全監査後の`resumeAdmission`と最後の`resumeGarbageCollection`を内部RPCで実装済み。実環境の再開・operator UIは未実施。flagsを直接変更しない。[CONTROL_ADMISSION](CONTROL_ADMISSION.md)参照。
- LockDO namespace mutation の成功テストは test-only admission と実 DO SQLite/D1 を組み合わせる。実 ControlDO による稼働許可を実証したものではない。
- Queue handler と Cron は ControlDO/D1 admission gate を通過した場合に outbox を処理する。ControlDO が閉じている間は Queue を retry し、Cron は送信しない。実 Queue ack/DLQ の配信試験は未完了。
- private/public upload、multipart closure、Files UI、private/public Gallery/Audio/Bookshelf/Video、private/public ZIP/EPUB、audio/video track、direct-user/group share、bounded reshare、編集可能なshared DAV、内部共有管理UIは接続済み。全operation/route会計、DAV実client gate、運用・releaseは未完了。実環境のControlDO admission/Access/署名鍵設定も未完了。ローカルbrowser fixtureは実ControlDOで受付を再開する。
- AVIF/AV1/Opus は形式判定、対応projection/原本配信、private native playerまで。実codec変換と複数browserでの実ファイル再生試験は未接続。
- Cloudflare staging inventory/Access/MFA・実 Images codec/費用・実 D1/Queue・backup復旧等の gate は未完了。ローカル成功で代替しない。
- private app route のリモート設定は `ACCESS_ISSUER`、`ACCESS_USER_AUDIENCE`、`ACCESS_SERVICE_AUDIENCE`、`BOOTSTRAP_OWNER_EMAILS`/`BOOTSTRAP_OWNER_IDENTITIES`、`BOOTSTRAP_QUOTA_BYTES`、`CSRF_PRIVATE_KEYS`/`CSRF_PUBLIC_KEYS` と各 active kid、content ticket/Cookie の kid ring。local `wrangler.jsonc` に秘密を置かず、未設定時は 503。
- app password 作成と DAV 認証には `APP_PASSWORD_PEPPERS` と `APP_PASSWORD_ACTIVE_KID` の pepper ring が必要。未設定なら 503。remote secret 登録は未完了。
- 公開share passwordの作成とunlockにはpurposeを分けた `SHARE_PASSWORD_PEPPERS` と `SHARE_PASSWORD_ACTIVE_KID` が必要。未設定でもpasswordなしshareは利用できるが、保護shareの作成・unlockは503。remote secret登録は未完了。
- children とtrash一覧の続きには `NODE_CURSOR_KEYS` と `NODE_CURSOR_ACTIVE_KID` の専用 ring が必要。未設定時も node 詳細は使えるが両一覧 route は 503。
- 単一uploadは専用 `UPLOAD_CAPABILITY_KEYS` / `UPLOAD_CAPABILITY_ACTIVE_KID` が必要。32-byte base64url鍵をkidで選ぶ。旧kidは有効uploadの期限まで保持する。remote secret未設定ならupload routeは503。

## 2026-10-02 時点の後続計画（履歴）

共通更新受付、DAV PUTの失敗精算と不明結果の保留、multipart closure settlement、backup barrier、logical export/隔離restore drill、日次取得・補充・期限切れ回収、private/public media/EPUB/ZIP、大規模非同期tree処理、bounded reshare、編集可能なshared DAV、内部共有管理UI、group lifecycle・recipient reshare、app password/WebDAV設定、Recent/Starred、private ZIP、media resume stateまで実装済み。次はmedia metadata検索と残るQueue/repairを優先する。並行して運用通知、Time Travel/live復旧と全storage喪失後の世代選択を整備する。実環境の設置・通知・配備には具体的な環境情報が必要。

以下は以前のcheckpoint記録（当時の「最新」「未実装」「CI確認予定」を含む）。

最新はKDF終了記録の修復。ControlDO SQLiteに送信前reserved/実終了finished/未送信確定not_startedを最大20件保存し、D1精算を確認してから削除する。次回受付前と内部`repairKdfSettlements`で再照合する。後者はmaintenanceと監査初期化を伴う。未知reservedは時間で削除せず、復旧監査と再開にもローカル記録のfenceを追加。D1に行がない終端proofはwrite barrierとDB側期限の照合後だけ掃除し、計算成功とはしない。新規14件と全check Node396+workerd891=1,287件成功。今回のCI/browserはpush後に確認する。詳細はKDF_ADMISSION、検証結果はIMPLEMENTATION_STATUS。D1 migrationは追加せず0029/66tableを維持。次はaccount mutation admission、残るQueue/backupと製品の後続phaseを進める。未知KDF・未知multipartの保留を勝手に解除しない。

直前commit `4dbafdd`の[CI run35997960544](https://github.com/daraskme/Nextcloud-flare/actions/runs/35997960544)は全成功、Node396+workerd877+browser19=1,292件。以下は以前のcheckpoint記録。

最新はアプリパスワードKDFのControlDO/D1全体制限。migration `0029`、通常66table。WorkerのHMAC中間値から固定100k PBKDF2を実行し、D1で600受付/65秒・未精算20枠を保留。通常は単一ControlDO内1件ずつで、20並列の処理能力を主張しない。同じattemptを再送せず、claim応答喪失では未送信を自身のtokenでのみ精算する。nativeの実終了後だけ枠を返し、DB精算不明は保持して復旧再開を止める。epoch変更後65秒cooldown。発行/認証/鍵更新とHTTP503を接続済み。新規Node7件とworkerd20件、既存認証34件成功。全checkはNode396 + workerd877、browser19も成功して合計1,292件。詳細はIMPLEMENTATION_STATUS。今回のCIはpush後に確認する。契約と残るrepair/実環境gateは[KDF_ADMISSION](KDF_ADMISSION.md)。次はKDF未精算repair、account mutation admission、Queue・backupと製品の後続phaseを進める。

直前commit `026f534`の[CI run35993638387](https://github.com/daraskme/Nextcloud-flare/actions/runs/35993638387)は全成功。Ubuntu2分42秒・Windows13分57秒・browser1分32秒、Node389 + workerd857 + browser19 = 1,265件。Windowsの新規中止19件も成功。以下は以前のcheckpoint時点の記録。

最新の追加は発見済み未追跡handleの中止と不変attempt台帳（migration `0028`）。毎回fresh proofを取り、bucket/part走査完了・稼働upload/lease不在を検査する。claim応答確認後のみ正確なkey/IDへ1回dispatch、同一attemptは再送しない。64件の生涯上限・10秒待機、遅い応答でもhold/隔離は維持する。新規19件とschema検証は成功。全check結果はIMPLEMENTATION_STATUSへ記録する。中止receiptを全体閉鎖と解釈して精算しない。次はprovider保証・実S3の閉鎖条件を詰め、独立に進められるaccount/KDF admission、Queue、共有・mediaも続ける。

直前commit `284a202`の[CI run35966922855](https://github.com/daraskme/Nextcloud-flare/actions/runs/35966922855)は全成功。Ubuntu2分39秒・Windows8分55秒・browser2分11秒、Node389 + workerd838 + browser19 = 1,246件。以下の2件のWindows fixture失敗は解消済み。

以下は以前のcheckpoint時点の記録（当時の未完了項目を含む）。現在の状態は上記とCURRENT_STATEを優先する。

CI補足: commit `5544432`の[CI run35965874860](https://github.com/daraskme/Nextcloud-flare/actions/runs/35965874860)はUbuntu（3分7秒）・browser（2分17秒）成功。Windowsの検索9件は成功したが、既存content-leaseのlate GETテストだけ90秒timeout（837/838件成功）。fixtureの初期期限5秒を準備中に超えると、BudgetDOが仕様どおり更新済みticketの2分期限へrenewするため、短い期限の試験にならない。準備を含むfixture期限を15秒にし、2回目のgrantが元の期限を保持することを直ちに検査する。本番コード・期限は変更しない。 最終結果は最新SHAと照合する。

CI補足: commit `dfd2468`の[CI run35964611990](https://github.com/daraskme/Nextcloud-flare/actions/runs/35964611990)はUbuntu（6分23秒）・browser（19件、2分7秒）成功。Windowsは新機能27件を含む837/838件が成功し、既存の1万件検索fixtureだけ個別60秒でtimeout。個別指定を既存Windows runner予算と同じ90秒へ揃える。検索の1万件上限・アサーション・本番期限は変更しない。 修正後の結果は最新SHAと照合する。

最新はupload行喪失時の未完了multipart走査とpart容量保留。migration `0027`、64通常table。[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md)が契約。各RPCでfresh proofを取得し、100件以下のページをD1へ原子的保存する。keyとR2 IDの完全一致だけtracked、その他は隔離する。partの最大観測bytesをowner physicalへ差分加算し、縮小・空一覧・404・遅延IDで解除しない。隔離handleは0 bytesでも復旧を止める。次は中止・遅延create/part/complete・完成物の照合・全体閉鎖と精算。元台帳のdelete guardやholdを外すだけで完成扱いにしない。直前commit `9811560`のUbuntu/Windows/browser CIは全成功（run35954162544）。今回の結果はIMPLEMENTATION_STATUSを参照。

未知multipart IDの修復に毎回freshなBLOBS/S3対応検証を接続した。maintenance/GC pauseを必須とし、claim・round reset・dispatch counter・page/receipt・physical観測・lease解放をcurrent proof fenceと同一batchで確定する。過去の成功や保存済みpageだけでは次のdispatchを許可しない。複数修復はprobe leaseで直列化する。詳細は[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)、試験結果はIMPLEMENTATION_STATUS。全体閉鎖・容量精算・upload行喪失時の中止・実S3は引き続き未完了。scanの完了を閉鎖証明として使わず、reservation holdを外さない。

進捗は[PROGRESS](PROGRESS.md)へ記録する。commit `26c4d07`はpush済み。直前のCI run35919687576はWindowsのmigration hook10秒、run35919870356はWindowsのcontrol-admission3件30秒でtimeout。Windowsのworkerdテストに限りtest90秒/hook60秒へ調整し、他OSとアプリ内部期限は維持した。同commitの[CI run35926517271](https://github.com/daraskme/Nextcloud-flare/actions/runs/35926517271)はUbuntu・Windows・browser全job成功を確認済み。

所有folderの要求時集計APIとFiles情報dialogを追加。現在のファイル数・サブフォルダー数・logical bytesを、Access認可/epoch/maintenance/世代と同一batchで取得する。検索と共通の索引付きsuccessor walkでscope込み1万ノード・深さ64、部分結果とcontent不足を明示。再集計中/拒否後は古い数値を隠す。migration・依存変更なし。詳細は[FOLDER_STATS](FOLDER_STATS.md)。共有/media別集計、実D1予算、以下の製品要件は未完了。

Accessのフォルダー配下検索APIとFiles検索画面を接続。共通正規化、literal query、scope10,000/page200、現在のcredential/祖先/共有read grant、検索専用cursor、同一batchの世代assertを使う。走査は索引付きsuccessor walkで全siblingの先行展開を避ける。検索結果のparentIdを上書きに渡し、保存場所への移動、世代競合/拒否時の古い結果の非表示を実browserで検証。子一覧だけが更新されたfolderのrename/move失敗も再現・修正。詳しくは[SEARCH](SEARCH.md)。media metadata/索引再構築運用/実D1予算、共有・media・全体admission・復旧/公開の全体要件は残る。

配信leaseの期限をDOのbyte期間内へ制限し、旧実装の有効なleaseは精算まで保持する処理を追加。`/c`も返された期限をR2 HEAD/GETとbody終了まで引き継ぎ、停止した読み込み・未読応答・取消しを扱う。精算は1回、結果不明は全額保持。実D1の期限更新で有効なleaseが消える問題と、修正前の配信関数が期限後の3 byteを返す問題を再現した。詳細は[CONTENT_LEASES](CONTENT_LEASES.md)。実HTTP切断伝播、長時間downloadのRange/ticket更新UI、全media/public配信経路と実環境gateは残る。

作成応答喪失と対象更新が重なる場合のreceipt回収を修正した。同じcreate key/bodyへの再送は現在のnode権限・credential・epoch・owner・parentを原子的に検査し、元のID/capabilityを返す。新規予約・R2初期化・本文・確定の旧revision検査は維持し、multipart初期化が対象変更で止まれば202で中止可能なreceiptを返す。実HTTPの競合/予約不変/失効境界5件、browserの単一・分割の応答喪失/reload/中止2件を追加。対象の移動・削除・失効・期限切れは引き続き制限される。詳細は[UPLOAD_OVERWRITE](UPLOAD_OVERWRITE.md)、全結果はIMPLEMENTATION_STATUS。

前回の追加は[確認付き上書き](UPLOAD_OVERWRITE.md)と[異なる配信対象のbudget台帳](BUDGET_ALLOWANCE.md)。上書きは対象node/revision/blobと元file名を保持し、全partのIf-Match、競合停止、完了応答喪失からのreceipt照合へ接続。配信budgetは認可manifestのpurpose/blobを重複排除し、対象追加でも使用量・回数・期限をリセットしない。同期transaction、1,024対象/lease・1 MiB上限、旧DO保存領域の期限までの制限を文書化した。実環境・共有/検索/media・全体admission等は引き続き未完了。全検証結果はIMPLEMENTATION_STATUSを参照。

当時の[KDF isolate内制限](KDF_ADMISSION.md)はapp passwordの作成・検証・pepper更新を同時1件、待機256件・5秒へ制限した。現在は実browserの同時DAV接続でfetch eventをまたぐ待機が中断される問題を再現したため、Worker/ControlDOとも並行要求を即503へ返す。取消し中の実計算が終わるまで枠を保持し、作成前のAccess/root検査と計算後の現行D1 assertionを維持する。ControlDO/D1の全体600回/分・未精算20枠も接続済み。実Cloudflareの処理量・切断挙動は未検証。

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

1. **outbox Queue 実サービス / repair**: dead-letter台帳とbounded requeueは実装済み。実 Queue/DLQ/retry exhaustionを検証し、残る kind の saved operand/result CAS と chunk fencingを実装する。ControlDO admission が閉じている間は `retryAll` を維持する。
2. **ControlDOの残る制御**: namespace以外のaccount mutation受付、終了証明を失ったKDFの運用収束・共有password/IP制限、実restore drill。全監査後の受付再開、backup barrier、multipart closure settlementはローカル実装・検証済み。
3. **Phase 1 の残り**: 各 operation の operand tuple、HTTP host/profile/CSRF、app-password/share secret 検証、operation lookup/commit_unknown response を接続。R6 §8 の全 fixture と完了条件を現在のテストへ対応付ける。
4. Audio/video metadata/track、画像thumbnail、private/public ZIP/EPUB、private/public Gallery/Audio/Bookshelf/Video、direct-user/group共有、bounded reshare、編集可能なshared DAV、内部共有管理UIは接続済み。残るself-service UIと実ファイル・複数browser検証を進め、最後に実環境 gate とリリース確認を行う。

フォルダー作成は current parent/revision/tree を読み、7 step を一括確定する内部サービス。SQL plan は server code のみで生成し、外部から任意 step/SQL を受け付けない。
名前検索は private API と Files UI へ接続済み（[SEARCH](SEARCH.md)）。media metadata の全文索引・索引更新の運用・実 D1 の処理量/応答時間 gate は未完了。

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
