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
この detach を含む purge サービス自体は未実装。

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
`do/recoveryAudit.ts` は停止中の D1 と R2 を段階的に走査する診断 helper。1回最大20 user/blob/R2 object/outbox/share/credential/credential source を確認し、bootstrap identity、有効 admin、root/owner、used/reserved/physical/ref 会計、記録された R2 object の HEAD サイズと etag、R2 list の全件を blob/ready derivative/archive の D1 行と照合し、未知オブジェクトを検出する。outbox の元操作と送信・claim lease、share の予約量・root から space root までの有効な祖先・version、credential の参照先種別・有効 scope root と、4種の参照元に対する registry 行の存在も検査する。FTS5 `integrity-check` は `rank=1` で `search_index` の全件と照合するため、ページ上限の対象外。open permit、claimed operation、active job/outbox claim、削除中 GC、不完全 upload があれば開始しない。ControlDO の `beginRecoveryAudit` / `nextRecoveryAuditPage` は SQLite の `recovery_audit_v7` に epoch・token・stage・R2 の opaque cursor を永続化し、eviction と失敗ページの再試行に対応する。完了済み監査の再照会でも最終 D1 fence を再確認し、失敗時は監査を先頭へ戻す。`rebuildRecoveryFts` は停止中に external-content index を `search_index` から再構築・検証し、監査カーソルを初期化する。旧 epoch の監査を再利用しない。最終 D1 fence は予約・未完了 upload・旧 outbox・job lease を拒否する。`releaseStaleReservations` は旧 epoch で進行中 upload に紐づかない予約を最大20件ずつ解放し、監査を初期化する。監査完了はまだ再開の証明ではない。credential/share/outbox の全意味検証、未知 R2 object の repair、incomplete multipart、実 Queue/GC drain と admission 再開は未実装。

`failStaleOutbox` は停止中に旧 epoch の `node.created` と `node.renamed` を最大20件ずつ `failed` に収束させ、監査を先頭へ戻す。active claim が残る間は処理しない。旧 epoch の他の event kind は専用 cleanup が必要なため残す。
outbox の復旧監査は両 kind の元 operation 種別と step 1 の node ID が通知 payload に一致することも確認する。不整合な通知は監査を失敗させる。
credential の復旧監査では、有効な app password と service の scope root も同じ space root までの生存・所有者・深さを確認する。祖先が trash の場合は資格情報が残っていても監査を失敗させる。

## Access session

`services/blobRead.ts` は `node.read` の現在認可 assertion と node/blob/物理観測行を同じ D1 batch で照合し、R2 配信用 plan を作る。R2 HEAD と GET のサイズ/ETag を plan と照合し、D1 content ETag による 304/If-Range、HEAD、単一 Range の 206/416、MIME/Disposition、no-store/nosniff を返す。purpose・content session・予算の検証は呼出し側の必須条件であり、公開 route にはまだ接続していない。

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

`auth/authorize.ts` は `node.read` / `node.create` / `node.rename` / `automation.list` / `automation.metadata.read` を扱う。
単一 primary query の同じ snapshot で、root 到達・深さ64・cycle・全祖先の live/space/owner、user/credential の現在有効性を検査する。

- user: 自分の space、または現在有効な internal share grant/action/version。app_admin に他 owner の file 読取り例外を与えない。
- app password: user の権限に加え、現在 scope・optional root・失効/期限を必須にする。owner/admin で scope を拡張しない。
- link share: 現在 share/action/version、session/epoch/期限と root を必須にする。upload-only share に node read/create を開かない。
- service: 現在 identity mapping・mapped user・space・root・scope・JWT期限を検査し、automation 2 operation だけ許可する。
- job/system はこの入口では拒否する。専用の claim/fence/explicit operand 認可は後続実装。

戻り値は read=node / create=parent+space / rename=node+parentId の discriminated tuple。rename は root・share/credential scope root を拒否し、edit action と node:write scope を要求する。request-local の変更不可 proof に認可 SQL を保持し、`authorizationAssertion()` で同一 mutation batch へ入れる。
再検査では credential/grant/epoch に加えて対象 revision、tree generation、parentId を束縛する。
これは permit、operation、quota/ref/pin の assertion の代わりではなく、create は後述の fsMutation で各 assertion と結合する。

残る境界: 全147 route の認可、source/destination/overwrite/job/upload 等の tuple、HTTP host/surface dispatch、app password/share secret 検証、実 listing/content handler、trash 時の share 失効、ControlDO admission/再開。
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
- removed_at は blob deleted 後の一方向 tombstone。物理減算の DB 制約は実装したが、実 GC の lease/quiesce/R2削除/不在確認との接続は Phase 4。試験では実 R2 delete/head 後に GC 最終 batch の fixture で減算を実証した。
- caller は reservation/pin SQL を認可・permit/operation guard と同じ batch に入れる。consume は新 logical reference 公開より先。trigger が counter を更新するため、handler から counter を重ねて加減算しない。
- `auditOwnerLedger` は D1 集合から used/reserved/physical observation/ref count の差を診断する。R2 の完成済み object は監査ページで全件照合する。未知 object の復旧 repair・incomplete multipart・進行中 upload に紐づく旧 epoch reservation の回収は後続実装。

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
`jobs/consumeOutbox.ts` は `node.created` と `node.renamed` を処理する内部 helper。D1 に保存された principal/credential と元の親フォルダー operand を現在の認可で再検査し、30秒の claim token/lease を取得する。rename では対象 node と元の parent の一致も確認する。元 operation の node step、operation terminal、epoch/maintenance と同じ認可を完了 batch でも再確認する。後続の node mutation で `last_op_id` が変わっても元 event の検証は維持される。D1 応答喪失時は completed 行だけを完了と判定する。migration `0008` は outbox の identity を不変にし、consumer claim 列を追加する。
`jobs/queue.ts` は ID-only メッセージを逐次処理し、completed/failed の終端行だけを ack、それ以外を retry する。ack 喪失後の再配信は同じ terminal を確認して収束する。`index.ts` の Queue handler は ControlDO status と D1 epoch/maintenance mirror が揃う場合だけ consumer を呼び、閉鎖中や状態不明では batch 全件を retry する。scheduled handler も同じ admission 条件で `dispatchPendingOutbox` を最大50件呼び、ローカル設定は毎分 Cron を指定する。現在 ControlDO は常に maintenance を返すため、実 Queue delivery と Cron 送信は停止中。ローカル Queue 設定は最大10回の再試行後 DLQ へ送るが、実 Queue/Cron/DLQ の end-to-end 試験、他の event kind、ControlDO admission、復旧時の検証は未完了。

### 実サービス gate

native SQLite とローカル D1 で migration/FK/tree/state を検証。workerd の SQLite DO/R2/D1 で eviction・storage loss・write failure を検証。
固定 pool 0.22 の RPC 拒否例外は後続 invocation の cleanup を停止させるため、意図的な拒否試験は `runInDurableObject` 内で捕捉し、成功時は実 stub RPC を使用する。
実 Cloudflare の RPC/ネットワーク断/復旧運用の staging gate は未完了。

次は Queue ack/DLQ と repair、ControlDO 再開、残る operation tuple の認可と HTTP profile 接続。
後半が終わるまで Files core を公開しない。
