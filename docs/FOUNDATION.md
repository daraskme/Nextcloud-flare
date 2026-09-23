# Foundation 実装契約（Phase 1 進行中）

2026-09-22。設計 v0.6 と IMPLEMENTATION_BRIEF §8 の確定条件を具体化する。
Phase 1 全体の完了判定ではなく、以下の DB・epoch・認証・node 認可基盤の実装記録。

## 契約・schema

- `packages/shared/src/contracts.ts`: scope、operation、state と single upload 遷移。
- `packages/worker/src/routes/manifest.ts`: 設計表を元にした147経路。R6 の CSRF issue / operation lookup credential を適用。すべて未有効化。
- `0001`〜`0007`: 53通常テーブル、FTS5 external-content index、構造・失効・terminal state、容量/参照会計、permit/operation identity の guards。
- timestamps はミリ秒。permit/session expiry は DB 側時計で評価する。
- `control.maintenance/gc_paused` は ControlDO 正本の D1 mirror。初期値は両方1。`control.epoch=1` は初期 schema の値であり、新規 permit 発行許可ではない。
- `spaces.root_node_id` / `trash_ops.root_node_id` / audit affected ID は設計どおり論理参照。root は insert guard で owner/space 一致を検査し、通常更新・削除不可。
- 全 FK に索引、全 TEXT PK に NOT NULL、台帳 counter/state/revision に CHECK。tree guard は cycle / owner / space / depth64 を検査する。
- `_assert` / application assertions は引き続き必須。DB guard は認可や quota/ref 会計の代わりではない。

authority read は D1 binding を直接使い、Sessions API を使用しない。`first-primary` は最初の query だけを primary に固定するため、後続の認可 read の保証には使わない。[D1 公式 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

`credentials` は Access/app-password/share-session/service の ID registry。
`as:<session_id>`、`ap:<app_password_id>`、`ss:<share_session_id>`、`sv:<service_principal_id>` を型別 CHECK で束縛する。
これにより `content_sessions.issued_by_credential_id`、operations、jobs の credential は実 FK になり、文字列だけの参照にしない。
system operation だけは credential NULL を許可し、GC/repair/backup の列挙に制限する。

## FK graph と purge/export

`scripts/generate-schema-contracts.mjs` は全 migration を適用した SQLite PRAGMA の FK graph から `purgeOrder` を生成し、FK index と operation catalogue を検査する。適用済み migration を書き換えず、追加 index/catalogue は新しい migration で更新する。
`schema.test.ts` は migration から独立に再計算して一致を検査する。
`purgeOrder` は全テーブルの依存順であり、全行削除を許可するスクリプトではない。
nodes の self-edge は別扱いとし、Phase 4 の row purge は deepest-first / trash membership で制限する。

別 trash operation の既削除子だけは `parent_id=NULL` を許容。live node は NULL にできず、restore は新しい parent を同時指定する。
root 不在や同名時の `(restored N)` 選定は Phase 4 サービスの仕事。

credential を参照する operation terminal を90日保持できるよう、root を purge する前に失効済み credential/share/service mapping の scope root を外せる形とした。
app password は revoke と同時にのみ root を解除でき、再有効化を禁止する。
share/service root が NULL の行は disabled 必須。active credential の scope を全体へ拡大する NULL 化は禁止。
この detach は同期 purge の同一 transaction に含める。

`exportTables` はアプリの通常テーブルだけ。FTS virtual/shadow table を含めず、restore 後に `search_index` から rebuild する。
Phase 4 の exporter では runtime table inventory と照合し、migration metadata (`d1_migrations`) も保存する。
実 export は maintenance window の全期間で書込みを止める。削除中 blob は不可逆であり、schema は参照再追加・state 復帰を拒否する。

## ControlDO の epoch

ControlDO は `CONTROL.idFromName('singleton')` だけを受け付ける。外向け HTTP は503のまま。
内部 helper は ECMAScript private method とし RPC に公開しない。

1. SQLite に pending epoch / reason / time / token を保存する。
2. BACKUPS の `sys/epoch/<epoch>.json` を conditional put で作る。既存 record は完全一致時だけ同一 intent とみなす。
3. D1 mirror を更新し、open permit を revoke、旧 claimed operation だけを failed にする。terminal は維持する。
4. 成功後だけ SQLite pending を ready にし、epoch を返す。

R2/D1 応答喪失では pending を残し、`recover()` で同じ intent を照合する。
DO storage 全喪失では R2 list の全ページの数値最大値+1、D1 epoch+1、operator の EPOCH_FLOOR の最大値を使う。
履歴が空・取得失敗なら EPOCH_FLOOR の明示なしで起動しない。時刻から epoch を生成しない。
履歴走査は100ページまでで、上限を越えた場合も明示的 floor なしでは拒否する。
`bumpEpoch(expectedEpoch,reason)` の期待値は再送・並行 bump の重複発行を防ぐ。

現在の `status()` は maintenance / GC pause を常に true と返す。`quiesce(expectedEpoch)` は停止側の DO status を確認してから D1 mirror の両 flag を立て、open permit を revoke、claimed operation を failed へ同一 batch で収束させる。応答喪失時は全 postcondition を primary で照合する。active job lease の有無を返し、残存していれば drain 完了と扱わない。SQL failure の rollback を確認済み。admission と復旧検証後の再開は未実装で、`quiesce()` の成功を再開許可に使わない。
`do/recoveryAudit.ts` は停止中の D1 と R2 を段階的に走査する診断 helper。1回最大20 user/blob/R2 object/outbox/share/credential/credential source を確認し、bootstrap identity、有効 admin、root/owner、used/reserved/physical/ref 会計、記録された R2 object の HEAD サイズと etag、R2 list の全件を blob/ready derivative/archive の D1 行と照合し、未知オブジェクトを検出する。outbox の元操作と送信・claim lease、share の予約量・root から space root までの有効な祖先・version、credential の参照先種別・有効 scope root と、4種の参照元に対する registry 行の存在も検査する。FTS5 `integrity-check` は `rank=1` で `search_index` の全件と照合するため、ページ上限の対象外。open permit、claimed operation、active job/outbox claim、削除中 GC、不完全 upload があれば開始しない。ControlDO の `beginRecoveryAudit` / `nextRecoveryAuditPage` は SQLite の `recovery_audit_v7` に epoch・token・stage・R2 の opaque cursor を永続化し、eviction と失敗ページの再試行に対応する。完了済み監査の再照会でも最終 D1 fence を再確認し、失敗時は監査を先頭へ戻す。`rebuildRecoveryFts` は停止中に external-content index を `search_index` から再構築・検証し、監査カーソルを初期化する。旧 epoch の監査を再利用しない。最終 D1 fence は予約・未完了 upload・旧 outbox・job lease を拒否する。`releaseStaleReservations` は旧 epoch でuploadに一切紐づかない予約を最大20件ずつ解放し、監査を初期化する。監査完了はまだ再開の証明ではない。credential/share/outbox の全意味検証、未知 R2 object の repair、incomplete multipart、実 Queue/GC drain と admission 再開は未実装。

`failStaleOutbox` は停止中に旧 epoch の `node.created` と `node.renamed` を最大20件ずつ `failed` に収束させ、監査を先頭へ戻す。active claim が残る間は処理しない。旧 epoch の他の event kind は専用 cleanup が必要なため残す。
outbox の復旧監査は両 kind の元 operation 種別、保存済み operand/result、step 1 の node ID が通知 payload に一致することも確認する。不整合な通知は監査を失敗させる。
credential の復旧監査では、有効な app password と service の scope root も同じ space root までの生存・所有者・深さを確認する。祖先が trash の場合は資格情報が残っていても監査を失敗させる。

## Private単一upload

`services/uploads/` と `api/uploads.ts` は Access user の `POST /api/v1/uploads`、`PUT /:id/content`、`POST /:id/complete`、`GET/DELETE /:id` を接続する。作成はcredentialとIdempotency-Keyから安定IDを作り、current node authority、quota予約、staging blob、immutable upload identityを同じD1 batchで保存する。migration `0016` は名前・上書きrevision・request digest・capability kid・単一write attempt/lease・completion operationを追加する。公開共有とmultipartのHTTPは未接続。

専用 `UPLOAD_CAPABILITY_KEYS` / `UPLOAD_CAPABILITY_ACTIVE_KID` のHMAC ringを使い、upload ID、credential、epoch、期限を署名する。DBにはcapabilityのhashだけを保存し、作成応答喪失時は保存済みkidで同じtokenを再発行する。旧kidは有効uploadがなくなるまで保持する（現在のsingleは24時間）。JSON mutationはCSRF、binaryはcurrent Access・capability・exact Origin、上書きはstrong If-Matchを要求する。

単一PUTは95,000,000 byte以下の既知長。D1が`created→receiving`と1回限りのattempt/15分leaseを確定し、その応答を受けた呼出しだけがimmutable keyへR2 PUTを開始する。claimの応答喪失では送信せず、R2 PUTの応答喪失では同じobjectのGET・metadata・size・SHA-256照合で回収する。再送のPUTは行わない。sourceを最大64 KiBずつdigestとFixedLengthStreamへ直列供給し、lease signalでreaderと両sinkを中止する。観測した物理bytesは確定失敗でも計上し、R2の不存在を確認するまで戻さない。

completeはLockDO permit、current authorization、epoch、予約、R2 HEAD/physical/hashを検証し、新規10 step/上書き8 stepでnode/version・検索・quota・upload terminal・activity/outboxを一括確定する。DB応答喪失はoperation lookupへ収束し、unknown時は補償しない。既知failedの予約解放は再実行可能。abortは公開を止めorphan/cleanup intentを保存する。未送信の予約だけを解放し、write attemptがある場合は24時間の期限後にR2を照合するまで予約を保持する。abortとclaimの競合は同じD1 batch内のattempt有無で判断する。ControlDO admissionは閉じたまま。

`jobs/uploadCleanup.ts` は期限切れsingleを既定20件/最大100件、既定20秒の処理時間予算で回収する。migration `0017`の60秒lease・token・次回時刻・errorと専用indexで重複Cron、再試行、失敗候補による後続処理の停滞を防ぐ。D1 batchでcurrent epoch/maintenance、未公開blob/ref/pin、completion operandを検査し、`created/receiving→expired`、`completing→failed`と未確定completion claimを同時に終端化してからHEADする。completion_op_id保存前のclaimもuploadId/credential/space/parent/target tupleで照合する。committed operationや部分stepが残る矛盾した行は回収しない。

HEAD presentなら実サイズをphysicalへ一度だけ計上し、予約解放とGC candidate挿入を同じbatchで行う。正しいupload/attempt/epoch/blob metadataが必須で、サイズ不一致の自分のobjectも実byteを計上してからGCへ渡す。metadata不一致は容量を計上して隔離し、予約を保持する。HEAD absentなら同じbatchでblobをdeleted、既存physical観測をremoved、予約をreleasedへ確定する。期限前のabsent、HEAD失敗、期限切れ/交代したcleanup leaseからの書込みでは精算しない。GCがdelete/HEAD不在を確認するまでcleanup_pendingは保持する。GC pause中もHEADと会計・candidate化は可能だがR2削除はしない。

CronはControlDO/D1 admission後に回収し、その後pause解除時のみ既存GCを呼ぶ。復旧時は `ControlDO.repairExpiredUploads` がquiesceし、停止中の同じ回収処理を実行して前後のauditを無効化する。旧epoch・失効credentialでも未公開データは回収できるが、24時間の期限は短縮しない。汎用 `releaseStaleReservations` はterminalを含む全upload予約を除外する。最終復旧fenceは未解決cleanup claimと、physical計上済みGC candidateへ引き渡していないcleanupを拒否する。未知object全般のrepair、multipartと実Cron運用の検証は残る。

## UploadDO multipart台帳

`do/uploadPlan.ts`は1 byte〜500 GiB、既定64 MiB・非最終8〜90 MiB・最大10,000 partの固定計画を作る。0 byteはsingle upload用でありmultipartでは拒否する。

`do/uploadLedger.ts`はUploadDO専用SQLiteの内部部品。immutable upload/R2 ID/epoch/分割/期限を初期化し、attemptを一行ずつ保存する。claimとcounter更新は`transactionSync`で原子的に行い、同part排他、全体4並列、part毎3試行、calls≤parts×3、bytes≤declared×3を守る。成功metadataはサイズ・SHA-256形式・etag境界を検査する。再送では保存済み結果を返し、`dispatch`以外ではR2 I/Oを開始してはいけない。`not_started`はR2を一度も呼んでいないと確定した失敗に限り、消費済みbudgetは戻さない。

15分lease切れとunknown応答はupload全体を`aborting`にし、全in-flightをunknownへ固定する。遅れた成功を採用せず、同upload/R2 IDでは再送しない。無進捗24時間/作成から最大6日の期限と旧epoch失敗も永続化する。全part成功後のみ`completing`へ進み、abortと追加partを拒否する。complete応答喪失はR2 head/D1照合が必要なので期限切れからabortへ変えない。cleanup counterはdata/controlと独立で、data budget枯渇後も記録できる。完了partは数値keysetで最大200行ずつ取得する。

`do/UploadDO.ts`は内部RPCのたびにcanonical DO ID、ControlDO epoch/admission、capabilityのD1 digest、current credential/node authorityを検査する。D1の予約・epoch・maintenanceを同じmirror batchで再検査し、確認済み応答だけが新規dispatchを返す。外部D1 I/Oを挟むmetadata操作を`blockConcurrencyWhile`で直列化するが、streamとR2 I/OはWorkerに置く。通常の拒否はcallback内で捕捉し、30秒timeoutによるDO resetでは永続leaseから閉鎖側へ復旧する。

migration `0018`はimmutable part geometry、R2 initialization identity、`multipart_ledger_id`、単調増加revisionを追加する。D1 markerをSQLite初期化より先に確定し、markerの応答喪失と全storage喪失を`upload_ledger_recovery_required`として停止する。evictionは正常に再開できる。SQLiteのtriggerがrevisionとdirty partを記録し、最大200行の差分をD1 `uploads`/`upload_parts`へ同時反映する。D1応答喪失時はdirtyを残し、再照合してもdispatchを再発行しない。初回・part lease・idle alarmを設定し、停止mirrorが失敗した場合は60秒後の再試行を残す。alarmは失効credential/停止中/旧epochでも停止状態を反映するが、予約を解放しない。

`services/uploads/multipart.ts`は内部private userサービス。予約とstaging blobを作り、一度限りのD1 initialization claimを確認してからR2 multipart IDを取得する。create応答喪失では同uploadを再作成しない。既知R2 IDのD1保存は失効後も可能だが送信権限を与えない。partは現在のD1認可/予約を再確認し、固定長streamとSHA-256を同時に処理して結果をDOへ精算する。R2呼出し後の結果不明はupload全体を停止し、呼出し前の確実な失敗だけをnot_startedとする。個別part hashをwhole-objectの`sha256_verified`へ転用しない。

**R2 complete/HEAD照合・原子的namespace公開・R2 abort/期限切れcleanup・HTTP/UIは未接続。** R2へのpart送信成功は製品のupload完了を意味しない。unknown creation IDと台帳消失では予約を保持する。7日incomplete lifecycleの実bucket検証とrepairが必要で、ローカル試験で代替しない。

metadata直列化の30秒timeoutと例外時resetは[Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/)に従う。SQLiteの同期transactionは[Cloudflare Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)に従う。R2 multipartの再開handleを実在の証明として使わない（[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)）。

## Access session

`services/blobRead.ts` は `node.read` の現在認可 assertion と node/blob/物理観測行を同じ D1 batch で照合し、R2 配信用 plan を作る。R2 HEAD と GET のサイズ/ETag を plan と照合し、D1 content ETag による 304/If-Range、HEAD、単一 Range の 206/416、MIME/Disposition、no-store/nosniff を返す。purpose・content session・予算の検証は呼出し側の必須条件であり、公開 route にはまだ接続していない。

`auth/contentSession.ts` は content session・ticket・target set・budget の同一 credential/epoch/対象と、有効期限・失効・share version/grant を D1 assertion で検査する内部部品。使用時は node 認可 assertion と同じ batch に入れる。
`services/targetManifest.ts` と `prepareContentBlobRead` は R2 manifest を 1MiB 以下で読み、SHA-256・target の node/blob/purpose/size と D1 total bytes を検証する。current node 認可、content session assertion、manifest hash/ref/owner、blob 物理行を同じ D1 batch で再確認する。復旧監査は target manifest も hash/構造を照合する。
`auth/contentTokens.ts` は専用 kid ring で audience/purpose/credential/epoch/target hash/budget を束縛した HS256 ticket と、署名済み host-only Cookie を発行・検証する。`auth/contentAccept.ts` は D1 ticket/credential/share/target/budget の現行状態を batch で照合し、発行元 `ticket_id` を持つ content session を作る。`prepareCookieBlobRead` は Cookie から現行 principal と ticket を復元し、上記の読み取り証明に接続する。
`do/BudgetDO.ts` は `budget_id` ごとの SQLite counter と最大10分の lease を保持する。初回 target bytes×3 を固定上限として、1,024 requests/10分、並列8、unknown transfer 全額消費を守る。credential/share/session/ticket の D1 現行状態を lease 前に再確認し、旧有効期間が終わった場合だけ新しい D1 budget で counter を再初期化する。alarm は期限切れ lease の並列枠だけを解放する。`streamBudgetedContentBlob` は GET/HEAD/Range/304 の各 request を reserve し、body 完了時に実 byte、キャンセルや結果不明時に全額を精算する。内部共有の read は選択した share root が node の祖先であることを同じ D1 batch で確認する。migration `0010` は D1 trigger で owner あたり active budget を64件に制限する。予算発行 API は未接続。
`api/content.ts` は content host の `/session` POST/OPTIONS と `/c/:nodeId/:blobId` GET/HEAD を接続する。ticket body は4KiB、Origin は APP_ORIGIN と完全一致、GET は node/blob ID の一致から space を引き、内部の現行認可と BudgetDO に進む。Worker entry は署名鍵4値と ControlDO/D1 admission を要求する。現状 ControlDO は maintenance=true 固定で公開停止。鍵はリモート secret として別途設定が必要で、local config には置かない。page/entry/track/ZIP 等の経路と全 route 会計は未接続。
`services/contentBudget.ts` は `node.read` の証明を使い、private user、内部共有 user、匿名 unlock session ごとの安定した budget ID を D1 batch で確保する。credential と選択 share root/owner/expiry、ControlDO mirror の maintenance を再照合し、既存の active budget は再利用する。revoked budget の再開は拒否し、owner 64件上限は migration `0010` が確定時に守る。`services/contentTicket.ts` は最大1,000件の現行 node/blob と選択 share を検証し、R2 target manifest を staging・読戻し後、全認可証明と budget/ticket/target set を D1 batch で確定する。commit 応答喪失は primary の行で照合し、未確定時は R2 object を削除する。HTTP 発行 route は未接続。
`services/contentTicketCancel.ts` は同じ current credential だけに ticket 取り消しを許し、派生 content session の失効と同一 D1 batch で確定する。他の ticket が共有する budget は維持する。HTTP 取り消し route は未接続。
`api/contentTickets.ts` は認証済み private request の CSRF、同一 origin、bounded JSON を確認し、発行と取消を内部サービスへ渡す。`api/privateApp.ts` は app host で Access JWT を検証し、D1 session を登録して CSRF 発行と ticket handler に接続する。ticket 期限は Access session 期限以内に丸める。Worker entry は ControlDO/D1 admission と issuer/AUD、bootstrap policy、private/public CSRF kid ring、content 署名鍵の設定を要求する。現状 ControlDO は maintenance=true 固定で公開停止し、remote 設定も未完了。
`api/account.ts` は `/api/v1/me` で current credential/user/space と control epoch を照合し、quota と識別情報だけを返す。`POST /api/v1/auth/logout` は CSRF 検証後に D1 session と派生 content session を失効し、[Access の logout URL](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) である app origin の `/cdn-cgi/access/logout` へ 303 を返す。ブラウザー側の state 削除と top-level navigation は Files UI 実装時に接続する。
`services/nodeRead.ts` は node 詳細、root-first breadcrumb、children 一覧で current `node.read` の祖先証明・control maintenance を同一 D1 batch で再照合する。breadcrumb は同一space/ownerのlive親だけを最大64 edge辿り、rootに到達しない循環・切断・深さ超過を拒否する。一覧は `nodes_children_keyset` で最大200件を返し、201件目で次 cursor を発行する。`auth/nodeCursor.ts` は専用 HMAC ring で parent/space/owner/user/credential/epoch/tree generation/最終 name_ci+id/10分期限を束縛し、改変・期限切れ・tree 変更を拒否する。Worker entry は app の GET node詳細、path、children routeを接続した。remote cursor ring が未設定なら children は 503。
`api/nodeMutations.ts` は app の `POST /api/v1/nodes` と `PATCH /api/v1/nodes/:nodeId` を bounded JSON、CSRF、Idempotency-Key で folder 作成・rename の既存サービスに接続する。terminal commit は作成201・rename200、failed/conflict は409、未確定は Operation-Id/Retry-After 付き503。同 credential の `GET /api/v1/operations/:id` は既存の current operand/result 照合を使う。実 LockDO/D1 の HTTP テストは test-only admission を使用し、ControlDO の実再開を意味しない。

`auth/sessions.ts` は JWT 検証済み claims を受ける内部サービス。`auth/login.ts` が JWT 検証→bootstrap（未初期化時だけ）→session 登録を接続する。HTTP route は未有効化。
既存 user の iss+sub を照合し、email だけでは identity を結合しない。
fingerprint は R6 の SHA-256(iss|sub|iat|exp)。区切り文字衝突を避けるため iss/sub 内の `|` を拒否する。
同じ fingerprint の同時登録は同じ session / credential へ収束し、logout tombstone を再作成しない。

logout は対象 Access session と同 user の全派生 content session を同一 batch で失効させる。
session identity の更新と revoked→active の復帰は DB trigger でも禁止する。
job chunk は `assertLiveAccessCredential` を commit batch に入れ、ユーザー停止・session失効・期限・epoch を再検査できる。
node read/create の current grant/scope は以下の authorize サービスで検査する。その他の operation は未対応。

## Access JWT / JWKS

- `auth/access.ts` は user と service の固定・別 AUD を要求する。単一 `Cf-Access-Jwt-Assertion` 以外の Cookie/Authorization/raw Service Token/query/body へ fallback しない。
- `jose@6.2.12` を exact 固定（2026-09-05 公開、2026-09-22 選定）。依存なしの ESM/WebCrypto 実装を Node と workerd で実署名検証した。公開日と採用判断は `toolchain.json`。
- JOSE header は `RS256` / `JWT` / bounded `kid` のみ。payload は固定 issuer・単一 AUD・type=app・整数時刻・有効期間24h以下・skew60秒を検査する。user/service claims を相互昇格しない。
- JWKS URL は設定済み issuer の `/cdn-cgi/access/certs` のみ。redirect 禁止、fetch/body timeout5秒、256KiB、RSA16鍵、duplicate kid/private key 拒否。
- `AccessJwks` は issuer ごとに長寿命の1 instance を使う。KV と memory は1時間 fresh、取得障害時の既知 key のみ取得から24時間まで使用する。正常な refresh で消えた key は失効し、未知 kid へ stale fallback しない。
- refresh single-flight・10回/分・negative cache 最大64件/TTL60秒は **isolate/instance 内**の上限。KV は isolate 間の共有 hint であり、グローバル厳密 rate limit ではない。HTTP 接続時の Edge rate limit と実 Access の鍵ローテーション検証は残る。
- JWT verifier の60秒 grace があっても、session 登録と各認可の有効期限は D1 時計で厳密に検査する。

仕様/API 参照: [Access JWT 検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Access claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、[jose upstream](https://github.com/panva/jose)。

## 初回管理者登録

`auth/bootstrap.ts` は検証済み user identity と明示 allowlist（email は exact match、または iss+sub）だけを受ける。
quota は policy の明示値を使い、未設定の実環境値は推定しない。
bootstrap latch の条件付き UPDATE→user(app_admin)→personal space→root を同じ batch で作成する。
current epoch・maintenance解除・DB側の有効期限・user未登録・signup既定falseを要求する。
競合/応答喪失時は primary で bootstrap identity と完成した root を照合し、同じ identity だけ同一結果へ収束する。
bootstrap 後の新規 identity は自動作成せず、同 email でも既存 user へ結合しない。
Google IdP/MFA は Access policy の staging gate であり、このローカルサービスはその設定済み証拠ではない。

## Node 認可と commit assertion

`auth/authorize.ts` は `node.read` / `node.create` / `node.rename` / `node.content.write` / `automation.list` / `automation.metadata.read` を扱う。
単一 primary query の同じ snapshot で、root 到達・深さ64・cycle・全祖先の live/space/owner、user/credential の現在有効性を検査する。

- user: 自分の space、または現在有効な internal share grant/action/version。app_admin に他 owner の file 読取り例外を与えない。
- app password: user の権限に加え、現在 scope・optional root・失効/期限を必須にする。owner/admin で scope を拡張しない。
- link share: 現在 share/action/version、session/epoch/期限と root を必須にする。upload-only share に node read/create を開かない。
- service: 現在 identity mapping・mapped user・space・root・scope・JWT期限を検査し、automation 2 operation だけ許可する。
- job/system はこの入口では拒否する。専用の claim/fence/explicit operand 認可は後続実装。

戻り値は read=node / create=parent+space / rename・content write=node+parentId の discriminated tuple。rename は root・share/credential scope root を拒否し、edit action と node:write scope を要求する。content write は file に限定し、同じ edit action と node:write scope を要求する。request-local の変更不可 proof に認可 SQL を保持し、`authorizationAssertion()` で同一 mutation batch へ入れる。
再検査では credential/grant/epoch に加えて対象 revision、tree generation、parentId を束縛する。
これは permit、operation、quota/ref/pin の assertion の代わりではなく、create は後述の fsMutation で各 assertion と結合する。

`auth/appPassword.ts` は DAV Basic の `ap_<ULID>` ID と32B secret を HTTPS app origin のみで受け、Origin/JWT 混在を拒否する。kid 別の HMAC pepper と16B salt、PBKDF2-SHA256 100,000回/32B digest を照合し、D1 の current credential/user/epoch/maintenance を秘密計算の前後で確認する。`services/appPasswords.ts` と `api/appPasswords.ts` は Access/CSRF 付き `GET/POST/DELETE /api/v1/app-passwords` を接続し、秘密は作成時だけ no-store で返す。scope は DAV に必要な node:read/create/write/delete に限定し、所有者 root、最大20件、90日既定/365日上限を D1 batch で確定する。失効は派生 content session も同じ batch で無効化する。旧 kid の認証成功時は D1 batch の条件付き更新で新 kid と新 salt に再ハッシュし、応答喪失時も現行レコードを再照合する。`api/dav.ts` は DAV 入口で Edge rate limit を Basic 認証より先に適用する。`dav/path.ts` は一度だけ decode した bounded path を app password root から casefold 解決し、認可と同じ D1 batch で再照合する。Class 1 OPTIONS、file GET/HEAD/single Range、PROPFIND Depth 0/1、MKCOL、PROPPATCH、PUT、DELETE、COPY、MOVE は接続済み。MKCOL は親 path を `node:create` で再照合し、`dav.mkcol` operation と LockDO permit を既存の `fsMutation` に渡す。`services/putFile.ts` は最大95 MBのrequest streamをR2とSHA-256へ同時配送し、R2書込み前にquota reservationを確保し、新規fileを10-step、条件付き上書きを旧blobのimmutable version化を含む8-step `dav.put` mutationで確定する。R2 size/ETag、D1 physical観測、logical/physical quota trigger、LockDOとcommit時lock assertionを通し、失敗が確定した固有objectは削除する。`services/trashNode.ts` は最大1,000 nodeのlive subtree membershipを確定し、node不可視化、親/tree revision、subtree locks、share/share session、ownerの短期ticket/content session、activity/outboxを13-step `dav.delete` batchで同時確定する。1,000 node超は同期DAV DELETEを403で拒否する。`dav/transferProtocol.ts` は8 KiBの同一origin `Destination`、`Overwrite`、method別`Depth`をURL正規化前に検査する。`services/moveNode.ts` は同一ownerの最大1,000 node・10 GiBのsource/overwrite manifestを固定し、循環防止、両親/tree revision、source/target lock終了、上書きtargetのtrash/share/session失効、検索、activity/outboxを19-step `dav.move` batchで確定する。 `services/copyNode.ts` はmigration `0012`の固定source→copied manifestを使い、同じ上限内のfile/folderをsame-owner COWで複製する。dead property、検索、blob ref会計、親/tree revision、上書きtargetのtrash/share/session失効、activity/outboxを18-step `dav.copy` batchで全成功または全rollbackする。PROPPATCH は `node:write` の path 証明と対象 lock を検査し、最大100件の dead property、node revision、activity、terminal result を同じ D1 batch で確定する。保護 live property を403、同じ request の他 property を424として全て rollbackする。`dav/xml.ts` は固定した `fast-xml-parser` 設定と XML budget で property request と mixed content を解析し、`dav/propfind.ts` は current authority と最大1,000 child を集合取得して live/dead property を207で返す。`dav/conditions.ts` は8 KiB以内の tagged/untagged `If`、`Not`、state token、ETag、単一 `Lock-Token` を上限付きで解析し、resource/list/condition の論理評価と全branchからのtoken submission収集を分離する。`dav/conditionState.ts` はsame-origin credential path、対象とancestor infinity lock、DAV ETagをcurrent D1から取得し、不一致を412にする。提出tokenはMKCOL/PROPPATCH/COPY/MOVEのLockDOとcommit時lock assertionへ渡す。`dav/etag.ts` のfile `"b-<blob_id>"`、collection `"c-<node_id>-<revision>"` をGET/HEAD、PROPFIND、条件評価で共有する。主要なDAV namespace handlerは接続済み。remote `APP_PASSWORD_PEPPERS`/`APP_PASSWORD_ACTIVE_KID` 設定は未接続。作成応答喪失時は秘密を再表示できないため、一覧で credential を確認して失効・再作成する。

`services/trashRead.ts` と `api/trash.ts` は所有者space rootのcurrent `node.read`証明、epoch、maintenanceを同じD1 batchで再検査し、`trashed` operationを`created_at DESC, op_id DESC`のkeysetで最大200件返す。migration `0013`のpartial indexを固定使用する。10分のpurpose-bound HMAC cursorはspace、user、credential、epoch、tree generation、最終sort keyを束縛し、改変やnamespace変更後の継続を拒否する。`services/restoreTrash.ts` は所有者の固定membershipをrootから深さ順に最大64層・1,000 nodeまで同じD1 transactionで復元する。復元先のcurrent `node:create`、LockDO permit、GC pause、`gc_candidates.deleting=0`、参照blob非deleting、credential/epoch/tree/nameをcommit直前に再検査し、root名衝突はbounded `(restored N)` 名へ解決する。別trash operationの削除済み子と旧shareは復活させない。`services/purgeTrash.ts` はmigration `0014`のoperation束縛logical node/blob manifestを作り、`trashed→purging`を不可逆点としてnode参照FKを正本順に削除する。別trashの削除済み子は`parent_id=NULL`へ退避し、nodeをdepth降順で削除する。node/version triggerでlogical refとquotaを減算し、対象blobを7日猶予の`gc_candidate`と`gc_candidates`へ接続する。restore/purgeともoperation/activity/outbox/terminalまで同じtransactionで確定する。`jobs/gc.ts` はmigration `0015`の一方向claim leaseを使い、epoch・pause・ref・複数pinを同じD1 batchで再検査してblob/candidateを`deleting`へ移す。R2 deleteの応答喪失は`head()`で収束し、不在確認後だけ両台帳を`deleted`へ進めて`blob_storage.removed_at`によるphysical bytes減算を確定する。

残る境界: 全147 route の認可、source/destination/overwrite/job/upload 等の tuple、HTTP host/surface dispatch、残る DAV operation handler・share secret 検証、実 listing/content handler、ControlDO admission/再開。
認可 query が返す node metadata は content ticket/purpose/blob/pin の検査を代替しない。

## CSRF

`auth/csrf.ts` は R6 の session 束縛 HMAC token（TTL1h、再利用・再発行可）を実装する。
256-bit key、用途別 key ring、kid rotation、canonical JSON、aud/epoch/credential/purpose を検査し、毎回 D1 の現在 session/share version/owner を照合する。
private issue は POST + Sec-Fetch-Site:same-origin を要求し、既存 CSRF token は不要。Origin があれば exact match。
public issue は exact Origin と同じ unlock credential を必須とする。
mutation verifier は HTTPS の exact request origin / Origin / same-origin / application/json / X-CSRF-Token を検査する。
GET/HEAD、DAV、content-origin や upload binary の扱いは各 HTTP profile への接続時に分離する。HTTP route はまだ無効。

## 容量・参照会計

`0005_accounting.sql` と `services/{quota,refs,physical}.ts` を追加した。

- reservation の作成時に owner の used+reserved≤quota、physical+reserved≤floor(quota×6/5) と share 上限を同一 transaction で取得する。終端化で一度だけ解放し、reserved row の直接削除・identity変更・終端復帰を禁止する。
- node current / node_versions / blob_pins の追加・除去が trigger で ref_count を同時更新する。合計1,000を超える追加は元の変更も rollback。expired pin も行がある限り参照として残す。
- logical used は current/version/trash から参照される owner 内の unique blob。COW/複数 version で二重課金せず、pin-only blob は logical に含めない。current blob の置換は一つの trigger 内で旧参照減算→新参照加算し、trigger 実行順に依存しない。
- `blob_storage` は R2 HEAD で実測した size/etag の会計行。staging/orphan を含めて一度だけ physical を計上する。宣言 size と違う物も実測 bytes を記録してから公開を拒否し、cleanup 完了まで課金を残す。既に存在する bytes は quota が下げられていても記録し、次の reservation を拒否する。
- removed_at は blob deleted 後の一方向 tombstone。GC claim lease、quiesce、実R2 delete/head、不在確認後の最終batchへ接続し、応答喪失と再claimを含めて物理減算を実証する。
- caller は reservation/pin SQL を認可・permit/operation guard と同じ batch に入れる。consume は新 logical reference 公開より先。trigger が counter を更新するため、handler から counter を重ねて加減算しない。
- `auditOwnerLedger` は D1 集合から used/reserved/physical observation/ref count の差を診断する。R2 の完成済み object は監査ページで全件照合する。単一uploadに紐づく旧epoch予約は期限後のHEAD照合で回収する。未知objectの復旧repair・incomplete multipartの回収は後続実装。

migration 0005 は既存 node/version/pin と予約行から logical/ref/reserved を再計算する。以前の実装は physical 会計を公開していないため、既存 physical_bytes が非0なら migration を拒否し、先に個別 inventory 移行を要求する。物理実在を推定して埋めない。

## 検証の境界

### D1 permit 基盤

`db/permits.ts` は LockDO から利用する内部 primitive。
`0006` は space あたり open permit 一つを unique index で強制し、permit の ID/space/epoch/expiry 変更を禁止する。
追加前に open permit が無いことを migration で要求する。

- grant は current epoch/maintenance解除を検査し、期限切れ open→revoked と関連 claimed→failed を同じ batch で終えてから次の open 行を作る。
- lease は D1 時刻から最大30秒。LockDO が事前に永続化する request ID を使い、再送や commit 応答喪失は同じ行へ収束する。lease 延長や terminal permit 再利用はしない。
- commit assertion は ID/space/epoch/expiry の一致に加えて open・D1時計の期限・current epoch・maintenance解除を要求する。
- 正常 release は未完了 claim があれば拒否。maintenance revoke は open と claimed を一緒に収束させ、committed/failed を変えない。
- permit は現在の credential/全 operand の認可を代替しない。grant 前の ControlDO admission と lock graph 確認、commit batch 内の operation/current authorization は呼出し側で必須。

### LockDO と operation claim

`do/LockDO.ts` は space 名の正規 instance だけを使い、create 用 permit の取得・release・maintenance recovery を提供する。
ControlDO の現在 epoch/admission を確認し、SQLite に request intent を保存してから D1 へ進む。
grant の同じ batch で現在の create 認可、parent の depth 0 lock、祖先の infinity lock を再検査する。
token は SHA-256 のみ保存し、同じ利用者の別 credential でも現在 scope と提示 token を要求する。他利用者の token 利用は拒否する。
再送で parent/actor/credential/share version/token 集合を変えず、D1 permit の終端行を再利用しない。
SQLite 全喪失後に同 epoch の D1 履歴がある場合は発行を拒否し、新 epoch + maintenance recovery を要求する。
現在の ControlDO は閉じたままなので、成功側テストは test-only admission fixture と実 DO SQLite/D1/eviction を使う。公開サービスの admission gate 合格を意味しない。

`jobs/operations.ts` は create の claim と内部 lookup を実装する。body と operand は上限付き canonical JSON とし、idempotency key は initiating principal/credential の枠へ固定する。
異なる payload/space/kind/operand/step 数は同じ operation に再利用できない。同じ claimed の再開は同一 permit/epoch/expiry のみ。
claim 前と応答喪失後の照合で request-local authorization proof と現在の D1 認可を要求する。
`0007` は operation identity と app password creator identity の変更を禁止する。
lookup は同じ initiating credential と現在の元 parent の create 権限を要求し、成功結果は status と現在参照可能な node ID/revision に絞る。purge 済み node の name/path や内部診断は返さない。
namespace の fsMutation/最初の folder create は以下へ接続済み。HTTP 経路は未接続。

### 名前・fsMutation・最初の folder create

`shared/names.ts` は NFC、portable 禁止文字/予約名、UTF-8≤255B、scalar<255、full casefold≤1,024B を検査する。
URL decode は呼出し adapter の責務であり、JSON の `%2F` 等を再 decode しない。`.DS_Store`/`._*` は hidden として保存可能。
`unicode-case-folding@1.1.1` を exact 固定し、公式 Unicode 17.0.0 の C/F mapping と照合した。name_ci の変更は同名制約に影響するため依存更新だけで切り替えない。
folder name の検索索引は NFKC + full casefold + かな統一と scalar bigram を分離保存し、normalization_version を付ける。media metadata 合成と検索 API は後続。

`services/createFolder.ts` は canonical intent → terminal replay または LockDO permit → current create 認可 → claim → fsMutation → terminal 照合 → release を接続する。
`services/renameNode.ts` は rename 認可、対象と親の lock、permit、operation claim を確認する。node/parent revision、tree generation、旧 FTS term の削除、search_index 更新、新 FTS term の追加、activity、`node.renamed` outbox、terminal を一つの D1 batch に入れる。同名衝突や必須 step 失敗は全体 rollback する。公開 HTTP と実 ControlDO admission は未接続。
`services/fsMutation.ts` は先頭で permit/operation/current auth/current lock を SQL assertion にし、以下7 step と terminal を一つの D1 batch に入れる。

1. folder node（operation 由来の固定 ID）、2. parent revision、3. space tree_generation、4. search_index、5. search_fts、6. activity、7. outbox。

各 write の直後に `changes()=1`、各 operation_steps insert の直後にも同じ assertion を置く。terminal は step 数も照合する。
folder は blob を持たず容量 counter を変えない。FTS と outbox が失敗しても node/parent/tree まで rollback する。
確実な constraint rollback のみ、同じ current permit/claim を条件に別 batch で failed を記録する。network/timeout は failed と決めず、現在認可を再確認して最大3回/5秒で primary 照合する。
未確定は operation ID 付きの commit_unknown として返す。terminal replay は現在見える ID/revision/status と安定 error code だけ。
テストは各 step/terminal の0行、同じ claim の並行実行、応答喪失、失効・revision/tree/epoch/maintenance/lock/permit 変更を注入する。

### outbox producer / consumer

`jobs/outbox.ts` は D1 の current epoch/maintenance解除/committed operation を条件に30秒 dispatch lease を取得し、Queue へ `{outboxId}` だけ送る。
送信後の sent 更新は同じ token/lease で CAS し、先に completed となった行や新しい sender の token を上書きしない。
送信応答が不明なら lease を残し、期限後に同じ ID を再送する。`dispatchPendingOutbox` は最大100件、既定50件の pending/期限切れ dispatching/sent を走査し、有効な consumer claim がある行を再送しない。
`jobs/consumeOutbox.ts` は `node.created` と `node.renamed` を処理する内部 helper。D1 に保存された principal/credential と元の親フォルダー operand を現在の認可で再検査し、30秒の claim token/lease を取得する。rename では対象 node と元の parent の一致も確認する。元 operation の node step、保存済み operand/result、operation terminal、epoch/maintenance と同じ認可を完了 batch でも再確認する。後続の node mutation で `last_op_id` が変わっても元 event の検証は維持される。D1 応答喪失時は completed 行だけを完了と判定する。migration `0008` は outbox の identity を不変にし、consumer claim 列を追加する。
`jobs/queue.ts` は ID-only メッセージを逐次処理し、completed/failed の終端行だけを ack、それ以外を retry する。ack 喪失後の再配信は同じ terminal を確認して収束する。`index.ts` の Queue handler は ControlDO status と D1 epoch/maintenance mirror が揃う場合だけ consumer を呼び、閉鎖中や状態不明では batch 全件を retry する。scheduled handler も同じ admission 条件で `dispatchPendingOutbox` を最大50件呼び、ローカル設定は毎分 Cron を指定する。現在 ControlDO は常に maintenance を返すため、実 Queue delivery と Cron 送信は停止中。ローカル Queue 設定は最大10回の再試行後 DLQ へ送るが、実 Queue/Cron/DLQ の end-to-end 試験、他の event kind、ControlDO admission、復旧時の検証は未完了。

### 実サービス gate

native SQLite とローカル D1 で migration/FK/tree/state を検証。workerd の SQLite DO/R2/D1 で eviction・storage loss・write failure を検証。
固定 pool 0.22 の RPC 拒否例外は後続 invocation の cleanup を停止させるため、意図的な拒否試験は `runInDurableObject` 内で捕捉し、成功時は実 stub RPC を使用する。
実 Cloudflare の RPC/ネットワーク断/復旧運用の staging gate は未完了。

次は Queue ack/DLQ と repair、ControlDO 再開、残る operation tuple の認可と HTTP profile 接続。
後半が終わるまで Files core を公開しない。
