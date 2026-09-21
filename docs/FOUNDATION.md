# Foundation 実装契約（Phase 1 進行中）

2026-09-22。設計 v0.6 と IMPLEMENTATION_BRIEF §8 の確定条件を具体化する。
Phase 1 全体の完了判定ではなく、以下の DB・epoch・認証・node 認可基盤の実装記録。

## 契約・schema

- `packages/shared/src/contracts.ts`: scope、operation、state と single upload 遷移。
- `packages/worker/src/routes/manifest.ts`: 設計表を元にした147経路。R6 の CSRF issue / operation lookup credential を適用。すべて未有効化。
- `0001`〜`0005`: 53通常テーブル、FTS5 external-content index、構造・失効・terminal state と容量/参照会計の guards。
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

現在の `status()` は maintenance / GC pause を常に true と返す。admission、quiesce、復旧検証後の再開は後半実装まで有効にしない。

## Access session

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

`auth/authorize.ts` は `node.read` / `node.create` / `automation.list` / `automation.metadata.read` だけを扱う。
単一 primary query の同じ snapshot で、root 到達・深さ64・cycle・全祖先の live/space/owner、user/credential の現在有効性を検査する。

- user: 自分の space、または現在有効な internal share grant/action/version。app_admin に他 owner の file 読取り例外を与えない。
- app password: user の権限に加え、現在 scope・optional root・失効/期限を必須にする。owner/admin で scope を拡張しない。
- link share: 現在 share/action/version、session/epoch/期限と root を必須にする。upload-only share に node read/create を開かない。
- service: 現在 identity mapping・mapped user・space・root・scope・JWT期限を検査し、automation 2 operation だけ許可する。
- job/system はこの入口では拒否する。専用の claim/fence/explicit operand 認可は後続実装。

戻り値は read=node / create=parent+space の discriminated tuple。request-local の変更不可 proof に認可 SQL を保持し、`authorizationAssertion()` で同一 mutation batch へ入れる。
再検査では credential/grant/epoch に加えて対象 revision と tree generation を束縛する。
これは permit、operation、quota/ref/pin の assertion の代わりではなく、create サービス自体は未実装。

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
- `auditOwnerLedger` は D1 集合から used/reserved/physical observation/ref count の差を診断する。R2 inventory 全走査・復旧 repair・旧 epoch reservation の回収は後続実装。

migration 0005 は既存 node/version/pin と予約行から logical/ref/reserved を再計算する。以前の実装は physical 会計を公開していないため、既存 physical_bytes が非0なら migration を拒否し、先に個別 inventory 移行を要求する。物理実在を推定して埋めない。

## 検証の境界

native SQLite とローカル D1 で migration/FK/tree/state を検証。workerd の SQLite DO/R2/D1 で eviction・storage loss・write failure を検証。
固定 pool 0.22 の RPC 拒否例外は後続 invocation の cleanup を停止させるため、意図的な拒否試験は `runInDurableObject` 内で捕捉し、成功時は実 stub RPC を使用する。
実 Cloudflare の RPC/ネットワーク断/復旧運用の staging gate は未完了。

次は残る operation tuple の認可 → LockDO permit → fsMutation/create/outbox/repair と HTTP profile 接続。
後半が終わるまで Files core を公開しない。
