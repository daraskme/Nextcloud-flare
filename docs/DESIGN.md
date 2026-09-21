# Next-cloud-flare — 設計・実装方針 (v0.4)

Cloudflare のサービスだけで完結する、Google Drive / Nextcloud ライクなセルフホスト型ストレージ管理アプリ。

> ステータス: **Astra ラウンド1〜3 反映済み / ギャラリー・本棚・オーディオ追加**。本書を v1 の実装契約とし、未決事項は安全側の制限を置いて §18 へ送る。
>
> 制限定義と公式仕様の確認基準日: 2026-09-21。数値の正本は §13 とし、契約・環境依存値はリリース時に分離 staging で再確認する。

---

## 0. ゴール、非ゴール、提供範囲

### 0.1 ゴール

- **Cloudflare 完結**: Workers、Workers Static Assets、R2、D1、KV、Durable Objects、Queues、Cron Triggers、Cloudflare Access のみを実行基盤とする。Google IdP は Access の認証元としてのみ利用する。
- **正本の分離**: R2 は不変のファイル内容と派生物、D1 は論理名前空間・参照・権限・操作状態の正本とする。D1 外の復旧制御は `ControlDO` を正本とする。
- **線形化された書き込み**: REST、WebDAV、upload complete、Queue consumer の名前空間変更を `fsMutation` に集約し、全 operand 認可、lock reservation、operation claim、期待 revision、tree generation、quota、recovery epoch を一つの確定契約で扱う。
- **必須機能**: Web UI、WebDAV Class 1/2、期限・パスワード付きリンク共有、内部共有、upload-only 共有、回収箱、名前検索、再開可能 multipart、プレビュー、サムネイル、クォータ、監査に加え、ギャラリー、本棚、オーディオライブラリを提供する。
- **障害復旧**: 日次 D1 export、D1 Time Travel、GC 停止、recovery epoch 更新を含む復旧手順と演習をリリース条件にする。
- **安全な既定値**: 仕様や実測が未確定な機能は v1 で狭く制限し、上限値は §13 に一元化する。

### 0.2 非ゴール

- Office/Collabora 相当の同時編集、E2E 暗号化、デスクトップ同期クライアント、サーバ側マルウェア検査、取得済みデータや転送済み共有 capability の DRM 的な回収。
- OCR、本文全文検索、DRM 付き EPUB、サーバ側 EPUB→画像変換、外部メタデータ DB 照合、RAR/CBR/7z 展開、波形表示、歌詞同期表示。RAR/7z と波形等の候補は §18 に限定して記載する。
- Nextcloud 固有 discovery、capability、chunking、全 API との互換。WebDAV 対応と Nextcloud client 互換は別であり、後者は保証しない。
- R2 bucket の直接操作。R2 key は論理 path ではなく、直接書き込みと `r2.dev` 公開を禁止する。
- 無料 plan での動作保証。Workers Paid は前提だが、zone の HTTP body 上限を引き上げるものではない。
- Cloudflare account 全権管理者に対する機密性・完全性。最小権限、MFA、配備承認、外部保全で運用上のリスクを下げる。

### 0.3 client / transfer support

| 経路 | v1 の扱い | 競合・上限 |
|---|---|---|
| Web UI | 専用 multipart | §13 の upload 上限。file content 競合は 412。 |
| REST 単発 | 一つの HTTP request | `MAX_REQUEST_BYTES`。body 付き route は `Content-Length` 必須。 |
| WebDAV | Class 1/2、一 request PUT | `MAX_REQUEST_BYTES`。独自 multipart は使わない。 |
| CLI 大容量 | 後段 | v1 は通常 WebDAV 上限まで。 |
| Nextcloud client | 非目標 | 基本 WebDAV が動く範囲のみ。固有 chunking は保証しない。 |

`If-Match` を必須にするのは既存ファイル content の PUT だけとする。server は conflicted copy を自動生成せず、再取得・別名保存は client 責務とする。collection、PROPPATCH、metadata mutation は内部 revision CAS を使い、競合は 409 とし、weak comparison を 412 の根拠にしない。

---

## 1. Cloudflare サービス選定と役割

| 役割 | サービス | 設計上の扱い |
|---|---|---|
| API / WebDAV / share page | Workers + Hono + TypeScript | 宣言的 route manifest と共通 service へ全 surface を集約する。 |
| SPA | Workers Static Assets | `run_worker_first` で shell を含む全 request を Worker に通す。 |
| 内容・派生物・backup | R2 | 本体は不変 blob。public access は無効。 |
| 名前空間・状態 | D1 | node、参照、quota、operation、outbox、audit、epoch 複製値の正本。 |
| WebDAV lock | `LockDO(spaceId)` | `node_id` 単位 lock、lock generation、commit reservation の正本。 |
| multipart | `UploadDO(uploadId)` | session、part、in-flight barrier、terminal result の正本。 |
| 復旧制御 | singleton `ControlDO` | D1 外の `epoch`、`gc_paused`、maintenance mode の正本。 |
| download budget | `TicketDO(ticketId)` | 署名検証後だけ生成し、byte、request、並列 budget を厳密に消費する。 |
| 派生物・索引・タグ | Queues + Images binding / 制限付き parser | outbox、世代、result claim で at-least-once と費用を制限する。 |
| 短命 cache | KV | JWKS、read-only path hint、feature flag。認可・失効・mutation・mutex には使わない。 |
| 定期処理 | Cron Triggers | lease と checkpoint で再開可能 job を起動する。 |
| 認証 | Cloudflare Access | private user / service route の入口。share と WebDAV は Worker が認証する。 |
| rate limit | Workers Rate Limiting binding + DO | binding は一次防御、KDF・ticket 等の全体上限は DO で厳密化する。 |

Images binding 有り・無しの Wrangler environment を分け、binding 不足を runtime fallback で隠さない。

---

## 2. 全体アーキテクチャとルート境界

```text
Browser ─ Access ─┐                         ┌─ D1: namespace/auth/state/outbox/control
                  ├─ Worker / routes.ts ────┼─ R2: immutable blobs/derivatives/backups
WebDAV ─ Basic ───┤ authenticate/authorize ├─ LockDO / UploadDO / TicketDO
Share capability ─┘       + fsMutation      └─ Queue / Cron / KV(JWKS/read hint)
                                      ControlDO(epoch, maintenance, gc_paused)
```

### 2.1 monorepo

```text
Next-cloud-flare/
  pnpm-workspace.yaml
  package.json
  wrangler.jsonc
  packages/
    worker/
      src/index.ts
      src/routes.ts
      src/auth/
      src/api/
      src/dav/
      src/services/
      src/do/
      src/jobs/
      migrations/
      test/
    web/
      dist/
    shared/
  docs/
```

### 2.2 宣言的 route manifest と型境界

`routes.ts` は次の宣言を唯一の route 定義とし、Hono 登録、Static Assets 境界、CSRF、CORS、Access IaC、監査イベント、negative test を manifest から生成する。

```ts
type Route = {
  method: HttpMethod;
  path: RouteTemplate;
  auth: 'access' | 'app_password' | 'share' | 'public' | 'service';
  operation: Operation;
  operands: readonly OperandBinding[]; // param/body/claim -> node, parent, upload, job, share...
  adminOnly: boolean;
};
```

- handler は manifest から解決した全 operand を渡す `authorize` の戻り値 `Authorized<Operation, Operands>` を必須引数にする。認証済み context だけでは object 認可済みとしない。
- CI は「登録された全 route が manifest に一意に存在」「各 operation の handler が `authorize` を呼ぶ」「auth と principal 型が一致」「全 param が operand へ束縛」を静的検査と生成 E2E で証明する。未分類 route は compile error にする。
- URL、Request URI、DAV `Destination`、tagged URI は同じ decoder で percent decode を一度だけ行い、不正 percent / UTF-8、NUL、encoded slash、backslash、dot segment、二重 decode を拒否する。JSON の名前は percent decode しない。

| surface | 絶対 path | Access | Worker 側認証 |
|---|---|---|---|
| private SPA/API | `/`、assets、private `/api/v1/*` allowlist | private app 必須 | Access user JWT。 |
| service automation | `/api/v1/automation/*` の method+template allowlist | Service Auth policy | Access service JWT と登録 mapping。 |
| public API | `/api/v1/public/*` の完全一致 allowlist | Bypass | share session / capability / CSRF。 |
| share page | `/s` と `/s/:shareId` | Bypass | secret を含まない landing。 |
| WebDAV | `/dav` と `/dav/*` | Bypass | app password Basic のみ。 |
| content host | content 用 allowlist のみ | private API を置かない | short-lived content ticket のみ。 |
| well-known | 個別 allowlist path のみ | 必要時だけ Bypass | wildcard は置かない。 |

- public / service prefix 配下は method+template の完全一致だけを dispatch し、未知経路は 404。private router、SPA、asset へ fallthrough しない。
- `run_worker_first=true` とし、private SPA shell も Worker の JWT 検証後だけ返す。public shell は share landing に限定する。
- Bypass request に Access JWT が付いても user / service principal へ昇格・合成しない。Bypass の認証監査と rate limit はアプリ自身で行い、Access log を防御根拠にしない。
- `workers.dev`、preview URL、想定外 host、古い alias、R2 public access を全環境で無効化する。app / content の全 custom domain で HTTPS を強制し、DAV の HTTP request は credential を読む前に拒否して redirect しない。
- Access application path は `/dav` と `/dav/*`、`/s` と `/s/*` の双方を明示する。具体 path 優先規則に依存せず、Worker allowlist を最終境界とする。

---

## 3. データモデルと不変条件 (D1 / R2)

### 3.1 中核 model

以下は論理 schema である。CHECK、外部キー、部分 index、operation barrier 用 trigger / composite FK は migration test で固定する。

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  access_iss TEXT NOT NULL,
  access_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('member','app_admin')),
  quota_bytes INTEGER,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  physical_bytes INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(access_iss, access_sub)
);

CREATE TABLE control (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  epoch INTEGER NOT NULL,
  bootstrap_done_at INTEGER,
  bootstrap_iss TEXT,
  bootstrap_sub TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  root_node_id TEXT NOT NULL,
  tree_generation INTEGER NOT NULL DEFAULT 1,
  UNIQUE(owner_id)
);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES nodes(id),
  name TEXT NOT NULL,
  name_ci TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('root','folder','file')),
  current_blob_id TEXT REFERENCES blobs(id),
  revision INTEGER NOT NULL DEFAULT 1,
  client_mtime INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_op_id TEXT REFERENCES trash_ops(id),
  orig_parent_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  last_op_id TEXT
);
CREATE UNIQUE INDEX nodes_parent_name
  ON nodes(parent_id, name_ci) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX nodes_one_root
  ON nodes(space_id) WHERE kind = 'root' AND deleted_at IS NULL;

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  sha256_verified TEXT,
  content_etag TEXT NOT NULL,
  mime_sniffed TEXT,
  ref_count INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('staging','committed','gc_candidate','deleting','deleted')),
  created_at INTEGER NOT NULL,
  last_op_id TEXT
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  principal_fingerprint TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  claim_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('claimed','committed','failed')),
  expected_steps INTEGER NOT NULL,
  lock_generation INTEGER,
  tree_generation INTEGER,
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(id, state, claim_token)
);
```

`node_versions(node_id,blob_id,revision,created_at,created_by,operation_id)` は `(node_id,revision)` を主鍵とする。`trash_ops(id,actor_id,root_node_id,state,reason,created_at,purge_after,checkpoint)` の state は `deleting|trashed|restoring|purging|purged|failed` に限定する。`trash_ops.root_node_id`、terminal upload の snapshot ID、activity / job / operation result の node ID は監査用論理 ID とし、purge を妨げる循環 FK を作らない。

認証・状態 table:

- `uploads(id,owner_id,creator_fingerprint,credential_id,share_id,share_version,epoch,parent_id,parent_snapshot_id,target_node_id,name,blob_id,declared_size,reserved_bytes,physical_charge_state,state,reason,operation_id,result_node_id,result_revision,...)`。
- `shares`、`share_sessions(session_id,share_id,share_version,expires_at,revoked_at)`、`app_passwords`、`service_principals`、`node_props`、`user_node_state`。
- `derivative_results(blob_id,variant,generator_version,state,attempts,claim_expires_at,r2_key,...)`、`client_thumbs`、`gc_candidates`、`blob_pins`。
- `outbox`、`job_leases`、`backup_runs`、`mutation_journal`、`bulk_jobs`、`folder_stats`、`node_search`、`activity`。

メディア table:

```sql
CREATE TABLE node_media (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  width INTEGER, height INTEGER, taken_at INTEGER, duration_ms INTEGER,
  orientation INTEGER, dominant_color TEXT, camera_make TEXT, camera_model TEXT,
  generator_version INTEGER NOT NULL
);

CREATE TABLE library_items (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
  blob_id TEXT REFERENCES blobs(id),
  format TEXT NOT NULL,
  title TEXT, authors TEXT, series TEXT, volume TEXT, publisher TEXT, language TEXT,
  page_count INTEGER, cover_thumb_key TEXT,
  index_state TEXT NOT NULL CHECK(index_state IN ('pending','ready','failed','unsupported')),
  index_key TEXT, revision INTEGER NOT NULL DEFAULT 1,
  user_override TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE user_reading_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  position TEXT, page INTEGER, percent REAL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,node_id)
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(owner_id,name)
);
CREATE TABLE node_tags (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(node_id,tag_id)
);
CREATE TABLE library_roots (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,node_id)
);

CREATE TABLE node_audio (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  title TEXT, artist TEXT, album TEXT, album_artist TEXT,
  track_no INTEGER, disc_no INTEGER, duration_ms INTEGER,
  codec TEXT, bitrate INTEGER, sample_rate INTEGER,
  has_cover INTEGER NOT NULL DEFAULT 0, cover_thumb_key TEXT,
  lyrics_present INTEGER NOT NULL DEFAULT 0,
  tag_state TEXT NOT NULL CHECK(tag_state IN ('pending','ready','failed','unsupported')),
  generator_version INTEGER NOT NULL, user_override TEXT
);

CREATE TABLE user_playback_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,node_id)
);
```

GPS、任意 EXIF、埋め込み原画像、未検証 XML/HTML は D1 に保存しない。`authors` 等の複数値の実 schema は正規化 table または size-bounded JSON とし、検索 index は表示上書き後の値を使う。

### 3.2 tree invariants と EffectiveLive

- space 作成時に実体 root node を一つ作る。root だけ `parent_id IS NULL`。root の rename、MOVE、trash、purge は禁止する。
- 親は同一 space の未削除 `folder|root`。削除中、別 space、file は親にできない。
- namespace 構造変更は `spaces.tree_generation` を期待値付きで `+1` する statement と同じ D1 batch で確定する。MOVE、COPY、create、rename、DELETE、restore、purge は同一 space 内で直列化される。
- `EffectiveLive(node)` は、node 自身から space root までを再帰 CTE 一クエリで辿り、深さ ≤ 64、全 node の `deleted_at IS NULL`、各辺の同一 space、循環なし、root 到達を満たすこととする。孤児、上限超過、別 space、root 未到達は拒否する。
- `authorize` は content、HEAD/Range、thumb、children、search/count、ZIP、gallery、tracks、library、ticket 発行を含む**全 read**で `EffectiveLive` を確認する。共有 root への到達性と space root までの有効性は別々に証明し、応答 path だけ共有 root で打ち切る。
- 共有 root より上の祖先が trash に入った時点で共有は同期的に無効となる。`shares.disabled_reason='trashed'` の非同期設定は表示最適化にすぎない。
- trash / restore 専用 operation だけが、明示された state と op ID の下で削除済み operand を扱える。
- MOVE の確定 statement は再帰 CTE で destination が source の子孫でないこと、深さ、全祖先、space、epoch を同じ batch 内で再確認する。
- owner / space をまたぐ MOVE は v1 では拒否する。cross-owner は copy job 完了後の明示 delete とする。

### 3.3 path、名前、出力前提

検証順は「decode 一回（URL のみ）→ UTF-8 / separator / control 拒否 → NFC → portable check → byte / 文字数 → locale 非依存 Unicode casefold」。casefold / Unicode version は migration と config に固定し、version変更は衝突scanを伴う。空、`.`、`..`、末尾 dot/space、`CON` 等 Windows 予約名、drive / ADS の colon、slash、backslash、NUL、不正 Unicode を拒否する。`/dav/Shared/` 予約名は casefold 後に検査する。検索用 NFKC は名前解決に使わない。上限は §13。

`.DS_Store` と `._*` は `hidden=1` で保存できる。mount 名は share ID 由来の stable ID を含み、表示名変更で解決先を変えない。名前正規化は出力エンコードの代用ではなく、§10.5 を必ず適用する。

### 3.4 immutable blob、generation、COW

- 本体 key は `u/<ownerId>/b/<blobId>`。同じ key を上書きしない。`committed` blob だけ content API から配信する。
- metadata ETag は revision、content ETag は `content_etag`。DAV collection validator は §7 の node identity 付き strong ETag を使う。
- 内容更新は新 key へ書き、R2 object の実在と実 size を容量台帳へ反映してから、期待 revision 付き D1 参照切替を確定する。D1 参照切替が利用者から見た確定点である。
- `ref_count` は current node、保持中 version、明示 pin の参照を同じ batch で整合させる。無条件加減算は禁止する。
- same-owner COPY は COW。cross-owner COPY は source pin と destination quota reservation を作り、Range GET と multipart upload を checkpoint 付き job で実行する。folder COPY は source `tree_generation` と cursor を固定し、share、lock、client thumb、reading / playback state は copy しない。

### 3.5 D1 boundary と epoch

- D1 `batch()` は bind、SQL、query、実行時間の §13 budget で分割し、大規模操作は checkpoint 付き job にする。
- 条件付き statement の影響行ゼロは SQL error ではない。step proof と commit barrier で rollback を強制する。
- 認可、user / credential / share / job 失効、quota、operation claim、tree / lock 確定は primary を読む。KV と read replica は権威にしない。DB adapter は `withSession("first-primary")` を session 全 query の primary 保証と解釈せず、権威 query ごとに primary 契約を満たす。
- path cache key は `space_id + tree_generation`。mutation 前は primary の再帰 CTE で現在 path / ancestor を再検証する。
- `control` 一行へ ControlDO の current epoch を複製する。全 mutation / job の D1 batch は `WHERE (SELECT epoch FROM control WHERE singleton=1)=:request_epoch` を step proof と final barrier の双方に含め、旧 epoch の commit を D1 側で拒否する。

---

## 4. 認証、principal、認可、初期化

### 4.1 JWT 受入プロファイルと principal

private / service route の JWT 入力は、重複のない単一 `Cf-Access-Jwt-Assertion` header **だけ**とする。`CF_Authorization` Cookie、raw `CF-Access-Client-Id`、query、body へ fallback しない。CONTENT_HOST 等、Access が header を付けない経路に private API を置かない。

検証契約:

- JOSE `alg=RS256` と `typ=JWT`、payload `type=app` のみ。`none`、HMAC、`jku`、`x5u`、埋め込み key を拒否する。
- `iss` は設定済み `https://<team>.cloudflareaccess.com` と厳密一致し、JWKS URL はこの設定値からのみ構成する。
- `aud` は一要素の文字列配列として型検証し、manifest の route / environment ごとに固定した private app AUD または service app AUD と厳密一致させる。単なる全 AUD 集合や別 Access app の AUD を受けない。
- `exp` と `iat` は全 tokenで、`nbf` はuser tokenで必須の有限整数とする。service tokenは`nbf`省略を許すが存在時は必ず評価する。clock skewは60秒で、未来`iat`、未来`nbf`、期限切れ、`iat`から24hを超える寿命を拒否する。
- user token は非空文字列 `sub` と `email` を必須とし、`principal=user(iss,sub,user_id)` にする。
- service token は非空 `common_name` で識別し、空 `sub` を user として保存しない。検証済み `iss + aud + common_name` を既存 `service_principals` へ mapping して `principal=service(...)` にする。未登録 / 停止 mapping、停止 mapped user は拒否する。
- service principal は `/api/v1/automation/*` の allowlist だけで受理し、owner bootstrap、通常 session、DAV credential へ変換しない。権限は service scope、mapped user の現在権限、対象 space の積集合とする。

JWKS は固定 issuer 単位で KV に 1 時間 cache し、取得 timeout 5 秒、応答 256 KiB、RSA key 数 16 の上限を置く。既知 `kid` は cache を使う。未知 `kid` は issuer ごとの single-flight で一回だけ再取得し、更新は 1 分 10 回まで、1 分 cooldown と容量 64 の negative cache を適用する。超過は 503。取得失敗時は既存 cache が取得から 24 時間以内なら既知 key に限り使用し、それ以外または cache 無しは fail closed。重複 `kid`、RSA 以外、不整合 key は拒否する。

principal 型:

```text
user(iss, sub, user_id, credential_id=access-session)
app_password(user_id, credential_id, scope, optional_root)
link_share(share_id, share_version, session_id, actions, root)
service(service_principal_id, credential_id, mapped_user, space, scope)
job(saved_principal, credential_id, epoch, operation)
```

### 4.2 `authorize` と endpoint 被覆

```ts
authorize(
  principal: Principal,
  operation: Operation,
  operands: Operand[],
): Authorized<Operation, typeof operands>
```

`Operand` は source node / parent、destination parent、overwrite target、ancestor chain、blob generation、upload、job、share、ticket、operation key を型付きで表す。`AuthorizationProof` は principal / credential、grant version、operation、全 operand ID、space / tree generation、revision、epoch を束縛し、別 operation で再利用できない。

Allow は「route が principal 型を許可」「principal / credential / grant / user が primary で現在有効」「epoch と用途一致」「全 operand の権限」「EffectiveLive または trash 専用規則」「node / parent / space / blob 世代」「lock / revision 条件」の論理積とする。

upload / job / idempotency / operation の ID 所有関係は権限を拡張しない。terminal result の再生は**作成時と同じ principal fingerprint かつ同じ `credential_id`**に限り、再生前に user / credential / share / scope と結果開示権限を再検査する。停止・scope 縮小後は node 名、path、result を返さず 403 とする。space owner や同一 user であることを制限付き credential の例外にしない。

### 4.3 権限表

`space owner` は対象 space だけ、`app admin` は監査された全体管理 operation だけに効く。一般 member が自分の space を所有しても他 space の admin にはならない。

| operation | space owner | app admin | member / internal grant | app password | link share | upload-only | service |
|---|---|---|---|---|---|---|---|
| `read`, gallery/tracks | 対象 space | support policy が許す時だけ | own space / read grant | scope∩current grant | capability subtree | 禁止 | scope∩mapped user |
| `library.read` | 対象 space | 原則禁止 | node read と同じ | read scope | capability subtree | 禁止 | read scope |
| create / write / MOVE / delete | 対象 space | 原則禁止 | own / edit grant、全 operand | rw scope∩current grant | edit capability | 新規受取のみ | write scope |
| COPY | src read + dst write | 原則禁止 | grant ごとに両側 | scope ごとに両側 | edit subtree 内 | 禁止 | scope ごとに両側 |
| trash list / restore / purge | 対象 space | repair operation のみ | own space または明示 grant | rw scope 内 | 禁止 | 禁止 | 明示 scope |
| share 管理 / quota | 対象 space | global policy | 禁止 | 禁止 | 禁止 | 禁止 | admin scope のみ |
| 自分の app password | 自分 | disable / audit のみ | 自分 | 禁止 | 禁止 | 禁止 | 禁止 |
| job status/cancel/retry | 同 credential で現在権限あり | admin job のみ | 同 principal+credential | 同 credential | 同 share session | 自分の receipt のみ | 同 service credential |
| DLQ / requeue / user admin | 禁止 | `adminOnly=true` | 禁止 | 禁止 | 禁止 | 禁止 | 専用 admin scope |
| LOCK | 対象 space write | repair のみ | edit grant | rw scope | 禁止 | 禁止 | 禁止 |
| reading/playback state | 自分 | 禁止 | 自分 | 禁止 | 禁止 | 禁止 | 禁止 |
| library metadata / audio override | 対象 node write | 禁止 | node write | rw scope | edit capability | 禁止 | write scope |

HEAD、Range、conditional response、thumb / preview / count / cursor も元の read operation と同じ認可を通す。Queue / Cron は保存 principal と `credential_id` を復元し、各 chunk と公開確定時に current user、grant、scope、epoch、全 operand を再認可する。

### 4.4 bootstrap と失効連携

- `OWNER_EMAILS` は初回 bootstrap 候補の設定であり secret ではない。Google IdP と MFA を要求する Access policy からの user token に限り、email を trim + Unicode NFC + ASCII case-insensitive 比較し、dot / plus 除去等の provider 固有変換をしない。
- 初回一致 identity を `iss+sub` へ固定し、`control.bootstrap_done_at IS NULL` の条件付き UPDATE、`app_admin` 付与、personal space owner 作成を同じ batch で一度だけ成功させる。以後 `OWNER_EMAILS` を無視し、space owner / app admin 追加は fresh `iat` 5 分以内を要求する監査付きアプリ内操作だけにする。
- bootstrap 完了済み状態は backup / recovery 後にも current ControlDO / 運用記録と照合し、巻き戻りなら maintenance を解除しない。email 再利用、別 sub、削除・再追加で再 bootstrap しない。
- Access session は 24h 以下を推奨し、アプリは `iat` から 24h 超の JWT を拒否する。Access / IdP 側失効の private request への上限は既発行 JWT の残存時間であり、即時失効とは主張しない。Access / IdP停止だけではBypassのDAV/shareを止めないため、運用runbookは同時にアプリ管理APIでuser停止を確定する。
- `users.disabled_at` は全 private / service request で D1 primary から一クエリで確認し、KV cache しない。user停止時は mapped service、app password、job、uploadと、そのuserが所有するlink/internal shareを同期的に拒否する。share version更新と進行中jobのterminal化はoutboxで追従してもよいが、各requestのowner停止joinを失効判定の正本とする。
- app password、share / share session、job、upload は各 request / part / status / terminal replay で D1 primary の状態を cache 無しで確認する。app password は Access logout と独立し、revoke / expiry / user disable で即時拒否する。
- `POST /api/v1/auth/logout` は自分の share unlock Cookie と upload capability、IndexedDB / memory / Cache Storage の認証関連状態を消し、`BroadcastChannel` で他 tab に通知してから同一 app domain の `/cdn-cgi/access/logout` へ 303 redirect する。開始済み stream の受信済み bytes は回収できず、新規 request から拒否する。

### 4.5 token / secret 仕様

全署名 payload は canonical JSON / 長さ区切り encoding を HMAC-SHA256 で署名し、曖昧な文字列連結をしない。HMAC JSON は共通 claim `typ,kid,aud,iat,exp,epoch` と用途固有 claim を必須にし、未知field、許可外typ/aud/kidを拒否する。全 bearer secret / nonce は CSPRNG ≥128 bit、既定 256 bit。random ID は bearer secret と分け、ID の秘匿性を認可に使わない。

| 種別 | `typ` / 構造 | entropy・保存 | 期限 | 失効 | Cookie 属性 |
|---|---|---|---|---|---|
| Access user / service | JOSE `typ=JWT` の Cloudflare RS256 JWT、payload `type=app` | 外部発行、保存なし | `iat` から最大24h | Access expiry + D1 user/mapping停止 | Access 管理。本アプリは Cookie を読まない |
| link secret | `typ=share-link` の DB参照不透明256-bit secret | D1は HMAC/hash のみ | share expiry 以下 | share version / revoke / epoch | なし。fragment または POST body |
| unlock session | `typ=share-unlock` HMAC JSON。`kid,aud,epoch,share_id,share_version,session_id,iat,exp` | 128-bit session ID、D1は session state | min(share expiry, 7日) | session revoke、share version、epoch | `__Host-ncf_share_<shareIdShort>`; Secure; HttpOnly; SameSite=Lax; Path=/; host-only |
| app password | `typ=app-password` の 128-bit base64url credential ID + 256-bit secret | IDと `HMAC-SHA256(key, canonical(epoch,typ,secret))` のみ | 既定90日、最大365日、20件/user | revoke、user停止、expiry、epoch、key削除 | なし。Basic over HTTPS |
| download / ZIP / content ticket | `typ=download|zip-download|content-host` HMAC JSON + random `jti` | 128-bit `jti`、TicketDOは検証後に作成 | ≤6h。share時はshare expiry以下 | ticket cancel / budget、principal/credentialまたはshare version、epoch、鍵 | なし |
| upload capability | `typ=upload` HMAC JSON。upload / creator / credential / share version / aud を束縛 | 256-bit nonce、D1/DOは digest | upload deadline 以下 | abort / terminal、credential / share失効、epoch | private browser は memory/IndexedDB、Cookieなし |
| DAV lock token | `typ=dav-lock` の不透明 `opaquelocktoken` | 256-bit secret、LockDOはhashのみ | `Second-N`≤604800 | expiry、UNLOCK、MOVE source終了、epoch / admin強制解除 | なし |
| one-time CSRF | `typ=csrf` HMAC JSON。session / share / method / operation / nonce | 128-bit nonce、消費 ledger | 10分 | atomic one-time consume / session失効 | form時だけ Lax sessionと併用 |
| operation / job / lease ID | `typ=operation-id|job-id|lease-id` のDB参照不透明ID、bearerではない | ≥128 bit、D1 row | row retention | current principal+同 credential 認可 | なし |

secret は operations result、audit、journal、URL、error に平文保存しない。app password HMAC は固定32 byteを runtime の timing-safe API で比較する。scope 変更は in-place 拡張せず、新 credential 発行 + 旧 credential revoke とする。

共有 password は random salt 16 byte、derived key 32 byte、password UTF-8 ≤ 1 KiB、KDF version / parameter を保存する。既定は PBKDF2-HMAC-SHA256 600,000 回とし、staging 実測で §18 の scrypt 条件を満たす場合だけ全環境 config を一括変更する。KDF 前に有効 ID の安価な照合を行うが、存在 oracle は返さない。上限は per-share 10回/分、Cloudflare が提供する client IP per-IP 30回/分、global DO 600回/分、同時 KDF 20。任意転送 header を IP 根拠にせず、無効 ID ごとに DO を生成しない。

---

## 5. REST API、共通 mutation、状態機械

### 5.1 API surface

private base は `/api/v1`、public base は `/api/v1/public`。下表の全行を §2.2 manifest へ登録する。`operands` は代表値であり、MOVE / COPY 等は source / parents / target / ancestors を全て列挙する。

| Method | Path | auth | operation / operands | adminOnly |
|---|---|---|---|---|
| GET | `/api/v1/me` | access | `account.read` / current user | false |
| POST | `/api/v1/auth/logout` | access | `account.logout` / current session | false |
| GET | `/api/v1/search`, `/api/v1/recent`, `/api/v1/starred`, `/api/v1/stats` | access | `read` / scope root, result nodes, cursor | false |
| GET/HEAD | `/api/v1/nodes/:id[/children|/path|/content|/thumb|/preview]` | access | `read` / node, ancestors, blob | false |
| POST/PATCH/DELETE | `/api/v1/nodes...` | access | `write|move|copy|trash` / all operands | false |
| POST | `/api/v1/nodes/:id/zip` | access | `read` / subtree, blobs, ticket | false |
| GET | `/api/v1/nodes/:id/gallery` | access | `read` / folder, candidates | false |
| GET | `/api/v1/nodes/:id/tracks` | access | `read` / folder, audio nodes | false |
| PATCH | `/api/v1/nodes/:id/audio` | access | `write` / audio node, current blob | false |
| GET/PATCH | `/api/v1/library/items...`, `/api/v1/library/:nodeId...` | access | `library.read|library.write` / node, blob, index | false |
| GET | `/api/v1/library/:nodeId/pages/:n[/thumb]`, `/api/v1/library/:nodeId/entries/*path` | access | `library.read` / node, blob, index entry | false |
| GET/POST/DELETE | `/api/v1/library/roots...` | access | `library.read|library.write` / root node | false |
| PUT | `/api/v1/library/:nodeId/reading-state`, `/api/v1/nodes/:id/playback-state` | access | `state.write` / current user, node | false |
| POST/PUT/GET/DELETE | `/api/v1/uploads...` | access | `upload.*` / upload, parent, target, blob | false |
| GET/POST | `/api/v1/trash`, `.../restore`, `.../purge` | access | `trash.*` / op, node, destination | false |
| GET/POST/PATCH/DELETE | `/api/v1/shares...` | access | `share.manage` / share, root | false |
| POST | `/api/v1/nodes/:id/thumbs` | access | `write` / node, blob | false |
| GET/POST/DELETE | `/api/v1/app-passwords` | access | `credential.manage` / current user | false |
| GET/POST/DELETE | `/api/v1/jobs...` | access | `job.read|cancel|retry` / job and source operands | false |
| GET/POST | `/api/v1/admin/dlq[/requeue]` | access | `admin.dlq` / job | true |
| POST | `/api/v1/automation/...` | service | manifest 固有 / all operands | routeごと |
| GET | `/api/v1/public/shares/:shareId` と children/content/thumb | share | `read` / share, node, ancestors | false |
| POST | `/api/v1/public/shares/:shareId/unlock|tickets|logout` | public/share | `share.unlock|read|logout` / share, session | false |
| GET | `/api/v1/public/shares/:shareId/gallery`, `/tracks`, `/library/...` | share | `read|library.read` / capability subtree | false |
| POST/PATCH/DELETE | `/api/v1/public/shares/:shareId/nodes...` | share | `write` / capability subtree all operands | false |
| POST | `/api/v1/public/shares/:shareId/uploads` | share | `upload.create` / share, parent | false |
| GET/PUT/POST/DELETE | `/api/v1/public/shares/:shareId/uploads/:uploadId...` | share | `upload.*` / share, upload, credential | false |

`unlock`、ticket 発行、upload-only の create / complete / abort、public edit は POST/PATCH/DELETE だけで、GET mutation は禁止する。公開 JSON mutation は正確な app Origin のみ許可し、`Origin: null` と欠落、CONTENT_HOST origin を拒否する。`Sec-Fetch-Site` は `same-origin` のみ、`Content-Type: application/json` を必須とし、share/session/method/operation に束縛した one-time CSRF を原子的に消費する。通常 content GET の ticket budget 消費はこの mutation 分類とは別である。

public multipart は private upload path を Bypass せず public allowlist 内で完結する。REST error は RFC 9457、DAV error は §7 の XML。

### 5.2 `fsMutation` 確定 protocol

R2 transfer は先に終え、lock reservation は短い namespace commit だけを囲む。terminal result の早期 return より先に current principal / credential と結果開示を再認可する。

```ts
async function fsMutation(req: MutationRequest): Promise<MutationResult> {
  const control = await ControlDO.read();
  assertWritable(control);
  assertEqual(req.epoch, control.epoch);

  const existing = await readOperationPrimary(req.opId);
  if (existing?.terminal) {
    await authorizeTerminalReplay(req.principal, req.credentialId, existing);
    return existing.result;
  }

  const claim = await claimOperation(req, control.epoch);
  const snapshot = await readOperandsAndAncestorsPrimary(req.operands);
  const auth = authorize(req.principal, req.operation, snapshot.allOperands);
  assertIdBindings(req.ids, req.principal, req.credentialId);

  const preparedBlob = await finishOrVerifyImmutableR2Object(req);
  await chargePhysicalBeforeReservationRelease(preparedBlob, req.uploadId);
  const inspected = await LockDO.inspectCanonicalNodes(req, control.epoch);
  const permit = await LockDO.beginCommit(req.opId, inspected.generation, control.epoch);

  try {
    const statements = [
      requireControlEpoch(control.epoch),
      insertClaim(req, claim.claimToken, permit.generation),
      ...conditionalOperandUpdates(req, auth, claim.claimToken),
      verifyAndIncrementTreeGeneration(req, snapshot.treeGeneration, claim.claimToken),
      ...dependentReferenceQuotaAndActivityUpdates(req, claim.claimToken),
      ...stepProofs(req, claim.claimToken, control.epoch),
      insertOutboxAndStepProof(req, claim.claimToken),
      commitOperationOnlyIfEveryStepExists(req, claim.claimToken, control.epoch),
      finalBarrierRequiringClaimCredentialAndControlEpoch(req, claim.claimToken, control.epoch)
    ];
    const result = await D1.batch(statements);
    assertEveryReturningCount(result, req.expectedCounts);
    return await readCommittedResultPrimary(req.opId);
  } catch (error) {
    const concurrent = await resolveConcurrentClaim(req, claim.claimToken, error);
    if (concurrent) {
      await authorizeTerminalReplay(req.principal, req.credentialId, concurrent);
      return concurrent;
    }
    await recordFailedClaimCompensation(req, claim.claimToken, error);
    throw mapMutationError(error);
  } finally {
    await LockDO.endCommit(permit);
  }
}
```

確定規則:

1. claim は operation ID、principal fingerprint、`credential_id`、space、kind、digest、epoch を束縛する。不一致再利用は 409。
2. node / parent / ancestors / share version / credential / user / service mapping / upload / job / revision / tree generation / epoch を commit batch 内で再検査する。
3. 各更新と outbox は operation 固有 step proof を作り、全 step がある時だけ `committed` にする。final barrier は composite FK / tested trigger と `control.epoch` guard で一件でも欠ければ batch 全体を rollback する。
4. rollback 後の補償 transaction は同じ claim token のみを `failed` にし、未公開 blob を GC candidate 化する。
5. `LockDO.beginCommit` は generation / epoch 不一致で再検査を要求する。permit は R2 I/O を囲まない。
6. ControlDO が epoch を上げる時は先に D1 `control.epoch` を maintenance transaction で更新する。順序途中は maintenance で fail closed とし、旧 HTTP request は D1 barrier を通れない。

### 5.3 conditional request、bulk、ZIP

- file content PUT の `If-Match` / create の `If-None-Match:*` 失敗は 412。その他の revision 競合は 409、lock は 423、quota は 507。
- bulk は principal / credential / space / digest に束縛した idempotency key、job ID、cursor、項目別結果、cancel state を返す。
- v1 ZIP は STORE / non-ZIP64 に固定し、全 header 込み出力 size を開始前に計算する。一つの typed ticket に manifest hash、各 `node_id+blob_id`、share version、epoch を束縛する。
- ZIP entry path は安全な認可済み node tree から再生成する。absolute、drive、UNC、`.`、`..`、backslash、control、symlink、変換後重複、portable policy 違反が一件でもあれば ZIP 全体を開始前に拒否し、危険部分だけ除去して継続しない。

### 5.4 UploadDO と epoch

`initiating → active → completing → committed|failed`、`active → aborting → aborted`、`initiating|active → expired` を状態機械とし、terminal state は巻き戻さない。全 terminal failure に `reason` を必須とし、D1 の node revision / operation result を正本とする。

- UploadDO は起動 / wake ごとに ControlDO epoch と保存 epoch を照合し、不一致なら `stale` を永続化して status を含む全操作を 409 で拒否する。
- part / status / abort / complete の全てで current principal、同一 credential、user / share / app password 状態を再検査する。
- `completing` は `acceptParts=false` と barrier generation を永続化し、in-flight zero 後にだけ R2 complete と D1 commit を行う。
- D1 committed と DO 非 terminal の不一致は D1 を正として修復し、二重課金・再確定しない。

### 5.5 trash、GC、lease、outbox、backup

次の状態機械を v0.4 の確定契約とする。

- `trash_ops`: `deleting → trashed → restoring|purging → removed|purged`、fatal は `failed`。root を先に不可視化し、全 chunk を state + op ID + epoch で guard する。
- `gc_candidates`: `candidate ↔ pinned → deleting → deleted`。`deleting` が不可逆点で、新参照を禁止する。
- `job_leases`: `idle|expired → leased → quiescing|idle`。epoch / fence / checkpoint を D1 副作用と同じ batch で検査する。
- `outbox`: `pending → dispatching → sent → completed|failed`。outbox ID を論理 job ID とし、consumer result と同じ batch で完了する。
- backup journal: base scan の start/end watermark 間の upsert / tombstone を commit 順に適用し、checksum / restore probe 後だけ generation を公開する。

---

## 6. upload、quota、再開

### 6.1 size / route

全 size、part、deadline、retry 値は §13。body 付き REST / WebDAV は `Content-Length` 必須で、非負整数・route 上限・expected part size を stream 前後で照合する。長さ不明は 411、宣言超過は開始前 413、実 bytes の超過 / 短縮も失敗とする。全 body をメモリ化しない。

public upload-only multipart も同じ UploadDO を使う。part number から expected size を upload 前に検査し、complete まで遅延しない。

### 6.2 logical / physical quota ledger

- `used_bytes`: current / version / trash として論理保持する owner 内 unique blob bytes。
- `reserved_bytes`: 未確定 upload / cross-owner copy の宣言 bytes。
- `physical_bytes`: R2 に実在する owner の全本体 blob。失敗 upload、orphan、GC 待ちを含み、server derivative は別 budget とする。

予約は `used+reserved` と `physical+reserved ≤ quota×PHYSICAL_HEADROOM_FACTOR` の両方を一つの条件付き UPDATE で満たす時だけ成功する。R2 完成後は reservation 解放前に physical charge を D1 へ確定し、公開成功時だけ logical charge を増やす。R2 delete 成功時だけ physical charge を減らす。

### 6.3 part cost / browser resume

同一 part 送信、session call、累積受信 bytes、in-flight、wall deadline は §13。upload-only share では file / count / cumulative bytes / concurrent session を atomic に予約し、匿名利用者へ残量を出さない。

IndexedDB には upload ID、暗号化しない bearer capability を必要最小期間だけ、epoch、file fingerprint、part state と共に保存する。logout / abort / terminal で削除する。name、size、mtime、sample hash を再照合し、未検証 checksum を dedupe 根拠にしない。

---

## 7. WebDAV (`/dav`, `/dav/*`) と lock

### 7.1 auth / path

v1 WebDAV は app password の Basic over HTTPS のみ。Cookie、Access JWT、Service Tokenへ fallback しない。CORS は公開せず、browser の `Origin` 付き request は拒否する。`Authorization` は一個の Basic だけを受け、decode後512 byte以下の `128-bit base64url credential_id:256-bit base64url secret` に固定し、不正Base64、colon不足/追加、重複headerを拒否する。user、credential、scope、optional root、epoch を各 request で D1 primary から確認する。

path は再帰 CTE で解決し、read でも `EffectiveLive`、mutation では全 operand / revision / tree generation / epoch を再検証する。`X-OC-Mtime` は `client_mtime` とする。

### 7.2 bounded parser と Class 1/2 semantics

OPTIONS、PROPFIND、PROPPATCH、MKCOL、GET、HEAD、PUT、DELETE、COPY、MOVE、LOCK、UNLOCK を manifest へ operation / operands 付きで登録する。

- XML は `fast-xml-parser` の `processEntities:false`、DTD / custom entity / external entity / XInclude / schema fetch 禁止。§13 の body、深さ、要素、property、値上限を parse 中に適用する。
- PROPFIND は `allprop`、`propname`、指定 `prop`、Depth 0/1。infinity は parse 後 403。件数 / rows / response を preflight し、超過は開始前 507、partial 207 を返さない。
- PROPPATCH は document order で検証し、全 property を一 transaction にする。保存 dead property / LOCK owner を raw XML として連結しない。
- `Destination` は構成済み HTTPS app origin と port の完全一致、query / fragment / userinfo 無し、`/dav/` prefix 必須。外部 URI を fetch しない。
- `Depth` parser は `0|1|infinity` だけを受け、未指定時の既定を含む method ごとの RFC 規則でさらに狭める。`Timeout` は単一 `Second-N`、N は §13 以下。`Infinite` と複数候補は拒否し、実際に採用した `Second-N` を応答する。
- `Range` は単一 bytes range だけを実装する。複数 range は 416 にせず Range を無視して budget を予約できる場合だけ全体 200、できなければ開始前 429/413。範囲外の単一 range は 416。HEAD は R2 body を読まない。
- `If` は header byte / list / condition / tagged URI / token 長を制限し、boolean 評価と lock token 提示を分離する。重複 Authorization / Content-Length、不正 Base64、巨大整数を拒否する。

### 7.3 `LockDO(spaceId)` と RFC 整合

- lock の正準 resource は `node_id`。owner path、shared mount alias、casefold 表記が同じ node を解決すれば同じ lock が効く。lock-null は空 node を作り node ID を割り当てる。
- collection depth lock は root node ID と current ancestor relation で検査する。overwrite target と destination ancestor の lock も検査する。
- token hash、creator principal fingerprint、creator credential ID、node ID、display URI、depth、expiry、generation、epoch を SQLite に保存する。DAVのcreator principal同一性は `user_id + credential_id` とし、別app passwordは別principalとして扱う。
- locked resource の PUT、PROPPATCH、DELETE、MOVE、overwrite 等は、current write 権限と `If` header による対象 lock token の提示で許可し、通常 mutation では creator 一致を要求しない。token を他 principal の `lockdiscovery` に返さない。
- refresh は有効 token 提示だけを要求する。UNLOCK は token に加え lock creator principal または同 space owner に限定し、異なる principal は 403。管理強制解除は別の監査付き operation とする。
- MOVE 成功時に source lock を destination へ引き継がない。source lock を commit と同時に終了し、destination ancestor / overwrite target の既存 lock は通常どおり満たす。node ID による alias 解決と lock 継承を混同しない。
- `LockDO.beginCommit(expectedGeneration,epoch)` 中は交差 LOCK を 423 / 短時間待機にする。LockDO は起動時 epoch 不一致なら `stale` にして全操作を 409 で拒否する。
- collection ETag は strong `"<node_id>-<revision>"`。同 URI の node 置換で一致しない。HTTP `If-Match` の strong comparison と DAV `If` 内 ETag 評価を混同しない。必須 `If-Match` は file content PUT だけで、collection / PROPPATCH は内部 revision CAS 競合を 409 とする。

---

## 8. share

### 8.1 capability、URL、Cookie

link secret は 256-bit とし、D1 には HMAC/hash だけ保存する。share root、current subtree、action、expiry、share version に限定し、password / permission / root / expiry 変更と revoke で version を進める。

共有 URL は `/s/<shareId>#<secret>` とする。fragment は server / Workers Logs / Referrer に送られず、landing JS が読み、history から即時除去して POST body で unlock / ticket API に渡す。JS 無効時に token を path で受ける `/s/<shareId>/t/<secret>` は実装しない。招待 API / QR も同形式だけを出力する。

unlock 成功時は §4.5 の host-only `__Host-` Cookie を設定する。値に `share_id`、version、session ID、kid を含め、他 share で無効。`POST .../logout` は D1 session を revoke して当該 Cookie を削除する。全 share session の一括失効は share version を進める。

### 8.2 download ticket / cache / budget

- file ticket は node、blob、epoch、aud、exp、kid、jti に加え、private user用は principal fingerprint / credential / grant version、share用は share / version / sessionを含む。発行 / 配信ごとに対応するcurrent user / credentialまたはshare / sessionと `EffectiveLive`、認可 root 到達性を primary で検査する。blob は固定 generation として pin する。
- ZIP / gallery / archive page / EPUB / audio ticket も元 node と capability root を束縛する。CONTENT_HOST 交換で byte budget を新規付与しない。
- 署名、typ、epoch、expiry を検証する前に ticket ID 由来の DO state を作らない。
- TicketDO は TTL、対象 size 比 bytes、request、並列を厳密に消費する。`If-Range` 不一致の全体 200 も全 bytes を先に予約する。
- content / JSON / HTML は `private, no-store`。thumb と不変 archive index のみ §13 の private short cache。206 / redirect / error にも安全 header を付ける。

### 8.3 upload-only / internal / public edit

- upload-only は create と自分の同 credential receipt / upload status だけを許可し、list、read、overwrite、任意 node ID、rename、delete を禁止する。
- name collision は server が `name (n)` へ変更し、常に同形 201 receipt だけを返す。確定名、競合 flag、異なる timing / error を出さない。
- public edit は manifest に明示した endpoint だけで、全 operand、EffectiveLive、capability action、version、Origin / CSRF を検査する。複数 share Cookie を一操作へ合成しない。
- internal share は `read|edit`。保存先 owner の quota を使う。祖先 trash で即時 read 拒否し、restore で自動復活させない。
- WebDAV mount は `/dav/Shared/<stable-mount>/`。別名を認可・lock の別 resource としない。

---

## 9. Web UI

stack は React、TypeScript、Vite、Tailwind CSS、shadcn/ui、TanStack Router / Query / Virtual。dependency は package manifest で固定する。

- My Drive、Shared、Recent、Starred、Trash、Gallery、Bookshelf、Audio、quota、upload panel、job progress を提供する。
- name conflict、restore destination、bulk cancel / retry、項目別結果を表示する。upload-only uploader には server 確定名を表示しない。
- optimistic update は 412 / 409 で rollback し、同 principal / credential の間だけ idempotency key を再利用する。
- virtual list は screen reader metadata、roving focus、non-virtual fallback、touch、reduced motion、AA contrast を持つ。
- PWA は versioned shell asset だけを cache し、auth response、API、content、share page を保存しない。logout は §4.4 の削除と他 tab 通知後に Access logout へ遷移する。
- filename、タグ、EXIF、error は React text node として表示し、`dangerouslySetInnerHTML` を禁止する。Markdown だけは §10.4 の sanitizer 出力を専用 isolated component へ渡す。
- font / avatar は同梱または local。外部 CDN、外部画像 proxy は使わない。

---

## 9A. メディアライブラリ (ギャラリー / 本棚 / オーディオ)

### 9A.1 Gallery

任意 folder の画像・動画を対象とし、recursive option を許可する。`node_media` は current blob の header / EXIF から width、height、taken_at、duration、orientation、dominant color、任意 camera make/model を抽出する。GPS と機微 EXIF は保存しない。

- variant は `sm=256px`、`md=768px`、`lg=1600px`。`lg` は初回要求時 lazy job とし、同一 `(blob,variant,generatorVersion)` を一回だけ変換する。
- `GET /api/v1/nodes/:id/gallery?recursive=1&cursor=&sort=taken_at|name|updated_at` は keyset cursor、最大 200 件。幅、高さ、dominant color を返す。recursive は深さ64、候補50,000まで。
- public share は `/api/v1/public/shares/:shareId/gallery` を使い、同じ share session と EffectiveLive を適用する。
- UI は justified / masonry 仮想 scroll、日付 grouping、timeline scrubber、dominant-color placeholder、Lightbox、前後2件 prefetch、pinch zoom、keyboard、slideshow、Range 動画再生、EXIF panel を提供する。selection から download / share / delete / MOVE を各 operation の権限で実行する。

### 9A.2 Bookshelf / reader

| format | v1 の扱い |
|---|---|
| EPUB | ZIP container を索引化し、XHTML/CSS/image/font を CONTENT_HOST の sandbox iframe で script 無し表示。単一 host は attachment のみで reader 無効。 |
| ZIP / CBZ | stored / deflate entry を索引化し、image page 単位で配信。その他 method は `unsupported`。 |
| PDF | pdf.js client 描画。表紙は client-generated thumb。外部 URL / 添付を自動取得しない。 |
| folder images | current children list を本の index として開く。 |
| CBR / RAR / 7z | `unsupported`。展開しない。 |

EPUB OPF (`dc:title` / creator 等)、CBZ `ComicInfo.xml` を bounded parser で抽出し、無い場合は filename / parent から `[Author] Title 第01巻` 等の versioned allowlist pattern で候補を作る。metadata は user が編集でき、`library_items.revision` で競合制御する。タグは汎用 `tags/node_tags` を使い、series / author / tag / unread / reading / finished で絞る。

archive index job `{jobId,nodeId,blobId,generatorVersion}` は R2 Range GET で末尾の EOCD / ZIP64 EOCD（探索最大1 MiB）と central directory（最大8 MiB）だけを読み、次の bounded JSON を `u/<ownerId>/x/<blobId>/index-g<gen>.json` へ保存する。

```text
path, method, compressed_size, uncompressed_size,
local_header_offset, crc32, is_image, is_dir
```

path は NFC relative とし、absolute、drive、UNC、backslash、control、`.` / `..`、重複 canonical path、symlink を拒否する。page は jpeg/png/webp/gif/avif だけ、数字を数値比較する natural sort。D1 は件数、state、index key だけを持つ。認可済み browser へ返す index JSON は `Cache-Control: private, max-age=3600` と `ETag: <index_key>` を使い、share expiry / version と EffectiveLive を再検査する。

`GET /api/v1/library/:nodeId/pages/:n` と EPUB 用 `/entries/*path` は、index の offset から local header（固定30 byte + bounded name/extra）と compressed data を別 Range GET し、stored は直接、deflate は `DecompressionStream('deflate-raw')` で output bytes を数えながら streaming 展開する。CRC / size 不一致は response 開始前、または stream error で失敗し cache しない。`GET /api/v1/library/:nodeId/pages/:n/thumb` は展開画像を Images で 256px WebP にし、`u/<ownerId>/x/<blobId>/p/<n>-sm-g<gen>.webp` へ lazy 保存する。並行生成は本ごと4、各 page / generation 一回。cover は ComicInfo 指定または最初の image page。

共有 reader は `/api/v1/public/shares/:shareId/library/:nodeId/...` を使い、同じ entry index / ticket を capability subtree と share session に束縛する。

reader UI:

- image reader: single / spread、right-to-left / left-to-right、日本語 comic は既定 right、vertical scroll、keyboard / swipe、前後3 page prefetch、fit width/height/original、thumb strip、fullscreen。
- EPUB reader: TOC、pagination / scroll、font size、line height、dark / sepia、`writing-mode: vertical-rl` 尊重、CFI 位置保存。sandbox から親への message は schema / origin / source window を検証する。
- reading state は user のみ。CFI / page / percent を5秒 debounce で保存・復帰する。share principal には保存しない。
- bookshelf: dominant-color placeholder 付き cover grid、series grouping、continue / unread shelf、added/title/author/last-read sort。`library_roots` へ folder を登録すると current subtree の対応 file を候補化し、変更 outbox から index job を投入する。

### 9A.3 Audio library

MP3 (ID3v2.3/2.4, ID3v1)、FLAC (Vorbis comment + PICTURE)、OGG/Opus、M4A/MP4 (`ilst`)、WAV (`INFO`) を対象とする。tag job は先頭2 MiBと末尾128 byteだけを基本にし、MP4 `moov` 探索だけ最大4 MiB。上限を超える / duration を header から得られない場合は全体を読まず、metadata を `unsupported` または duration `null` とする。

- title、artist、album、album_artist、track/disc、duration、codec、bitrate、sample rate を UTF-8 NFC にし、各 field 1 KiB 以下。`user_override` は抽出結果を表示上書きし、不変 blob を書き換えない。
- APIC / PICTURE / `covr` は20 MiB以下だけを Images で `sm/md` WebP へ再 encode し、元 byte は配信しない。無ければ同 folder の `cover.jpg|folder.jpg|単一 *.jpg` を `node_media` から候補表示する。
- folder を作品単位とし、`disc_no, track_no, natural(name)` で最大2,000 track を並べる。album tag が揃わなければ folder 名を使い、超過時は folder 分割を案内する。
- content は既存 single Range endpoint と CONTENT_HOST ticket を使う。`Accept-Ranges: bytes`、sniff 済み audio MIME、206 を返す。
- playback state は user ごとに5秒 debounce で保存し、`last_opened_at` も更新する。
- UI は title fallback filename、artist、duration、cover、total time を React text node で表示し、tag 文字列を `Content-Disposition` filename に流用しない。root 直下の `<audio>` により SPA navigation 中も mini-player を維持し、queue、continuous、shuffle、repeat、speed、sleep timer、keyboard、MediaSession、Range seek、resume を提供する。
- Audio view は作品 cover grid、recent / unplayed、artist / tag filter を持つ。title / artist / album は §12 の search index へ入れる。共有では `GET /api/v1/public/shares/:shareId/tracks` を同じ capability / EffectiveLive 契約で提供する。

### 9A.4 共通認可・費用

media route は manifest の `read` / `write` / `library.read` / `library.write` と全 operand を使い、EffectiveLive、current blob、share root、credential scope を検査する。index / tag / thumbnail job は outbox、epoch、saved principal、generation、unique result claim、attempt budget を使い、stale blob の結果を公開しない。上限と費用単位は §13、配信 matrix は §10.4 を正本とする。

---

## 10. thumbnail、Queue job、preview、content delivery

### 10.1 派生物と費用冪等

server derivative key は generation 付き immutable key とする。thumbnail は `u/<ownerId>/t/b/<blobId>/<variant>-g<generatorVersion>.webp`、archive index / page は §9A、audio cover は `u/<ownerId>/t/<blobId>/cover-<variant>-g<gen>.webp`。

重処理前に result table の unique tuple `(kind,blob_id,variant_or_index,generator_version)` を conditional claim する。`ready` / terminal `failed` は再処理せず、claim lease の一 worker だけが実行する。attempt 上限で `failed` 固定。consumer は epoch、saved principal、node EffectiveLive、current blob を公開前に再検査する。

### 10.2 Queue job catalog

| job | input / 読取り | output | 固有 guard |
|---|---|---|---|
| media metadata | image/video header、bounded EXIF | `node_media` + sm/md、lg lazy | GPS破棄、pixel/frame上限 |
| archive index | EOCD探索≤1MiB + central dir≤8MiB | immutable index JSON + `library_items` | zip bomb / path / method上限 |
| page thumbnail | local header + one entry data | 256px WebP | per-book並列4、entry output上限 |
| EPUB metadata | bounded OPF / container XML | `library_items` metadata | DTD/entity禁止、script保存なし |
| audio tags | head≤2MiB + tail128B、MP4探索≤4MiB | `node_audio` + re-encoded cover | field / atom / cover上限 |
| search / tag sync | current normalized metadata | `node_search` | current revision / blob CAS |

全 job は namespace mutation と同じ outbox から発行し、`{jobId,nodeId,blobId,generatorVersion,epoch,principal,credentialId}` を持つ。Queue duplicate は保存済み result を返し、R2 書込み key は generation で不変にする。

### 10.3 transform safety / client thumb

Images / WASM の input、pixel、frame、memory、retry 上限は §13。安全に header を読めない、unsupported、上限超過は transform しない。server image derivative は metadata / EXIF / comment を除去して WebP へ再 encode する。

client thumb は node 権限境界の `u/<ownerId>/t/n/<nodeId>/<variant>-c.webp`。対象 node write、current blob、generation を検査し、read-only principal は保存できない。COW derivative と lifecycle を分離する。

### 10.4 content delivery matrix

全 response に server-sniffed `Content-Type`、`X-Content-Type-Options:nosniff`、`Referrer-Policy:no-referrer`、適切な `Cache-Control` を付け、206 / error でも落とさない。CONTENT_HOST は app Cookie の Domain を共有せず、credential CORS、private router、SPA fallback、Service Worker 登録を許可しない。short-lived audience 固有 ticket だけを受ける。

`sandbox CSP` は `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'`。iframe にも sandbox を設定し、`allow-scripts` と `allow-same-origin` を同時付与しない。

| 種別 | server Content-Type | CONTENT_HOST あり | 単一 host | CSP / sandbox |
|---|---|---|---|---|
| image | sniffed `image/jpeg|png|webp|gif|avif` | inline | inline | active SVGをimage扱いしない、script禁止 |
| video | sniffed allowlist | inline / Range | inline / Range | media専用、外部接続なし |
| audio | sniffed allowlist | inline / Range | inline / Range | media専用、外部接続なし |
| PDF | `application/pdf` | inline、sandbox viewer | inline、検証済み pdf.js / browser viewer | object/base/form/connectを禁止、外部URLを取得しない |
| plain text | `text/plain; charset=utf-8` | inline | inline | strict CSP、HTML解釈しない |
| Markdown | `text/plain; charset=utf-8` | inline取得後client sanitize | attachment | server renderなし、下記allowlist |
| HTML | `text/html; charset=utf-8` | inline | attachment | sandbox CSP、script禁止 |
| SVG | `image/svg+xml` | inline | attachment | sandbox CSP、script / 外部resource禁止 |
| Office / executable | sniffed type / octet-stream | attachment | attachment | `default-src 'none'` |
| その他 | `application/octet-stream` | attachment | attachment | `default-src 'none'` |
| archive image page | sniffed image allowlist | inline | attachment | 展開上限・nosniff、元archiveもattachment |
| EPUB XHTML | `application/xhtml+xml` | inline | attachment | sandbox CSP、script禁止 |
| EPUB CSS/image/font | allowlisted exact type | inline、EPUB ticket scope | attachment | XHTML sandboxから同一ticket resourceだけ、外部通信禁止 |

Markdown は server で HTML 化せず、client parser の raw HTML を無効化し、sanitize allowlist (`p,br,em,strong,code,pre,blockquote,ul,ol,li,h1-h6,a,img`) だけを DOM node として構築する。link は `https` と同一 app 内 relative、image は認可済み同一 app resource または size-bounded `data:image/jpeg|png|webp|gif|avif` のみ許可する。`javascript:`、画像以外の `data:`、data SVG、style/event 属性を禁止し、外部画像は proxy せず非表示にする。

app / share landing は `frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`。preview は埋込み可能な app origin だけを `frame-ancestors` に指定する。単一 host で matrix 外の active preview は無効にする。

### 10.5 出力先別 encoding

| 出力先 | 契約 |
|---|---|
| `Content-Disposition` | RFC 6266 `filename*=UTF-8''<percent-encoded>` + CR/LF/NULを除いた quoted ASCII fallback。直接連結禁止。 |
| React / HTML | text node の文脈別 escape。`dangerouslySetInnerHTML` 禁止。URL属性は scheme検証。 |
| PROPFIND / LOCK XML | XML writer で text / attribute escape、制御文字除去。href は path encode 後 XML escape。 |
| CSV | RFC quoting に加え、BOM / space / controlを検査上読み飛ばした最初の文字が `= + - @ \t \r` の cell を安全なtextとしてquote/prefixし、表計算試験を行う。 |
| JSON | 標準 serializer、safe integer / schema、raw fragment連結禁止。 |
| ZIP | 認可済み安全 tree から entry名を再生成し、危険名・重複は全体拒否。 |
| log | secret mask 後の構造化 JSON。request object / raw header / URL を丸ごと出さない。 |

---

## 11. trash、version、GC、backup / recovery

### 11.1 delete / restore / purge

- delete は `trash_ops.state='deleting'` を作り root を先に不可視化する。この瞬間から `EffectiveLive` が全 descendant read を拒否する。
- restore は `trashed` だけを CAS claim し、元 parent の EffectiveLive、space、tree generation、name conflict、epoch を `fsMutation` で再検査する。
- purge は `trashed→purging` を claim 後に current subtree manifest を再生成する。別 trash subtree は hidden のまま safe root へ reparent して op ID を変えない。
- FK-bearing media state (`user_reading_state`,`user_playback_state`,`node_media`,`node_audio`,`library_items`,`node_tags`,`library_roots`) を既存 user state / props / share / version / search と共に子→親順で削除する。
- R2 object は purge 中に削除せず、参照減算と GC candidate までを D1 で確定する。

### 11.2 versions / GC

current から外れた blob は §13 policy で保持する。GC は current、versions、uploads、outbox、media indexes / derivatives、pins を primary で確認し、`candidate→deleting` を不可逆点としてから R2 を削除する。`deleting` への新参照は禁止し、成功 / object absent 後だけ physical bytes を減らす。

### 11.3 ControlDO と recovery

ControlDO は D1 restore の外に epoch、maintenance、gc pause を保持する。D1 `control.epoch` は進行中 commit を閉じる複製 guard である。

1. maintenance と GC pause を有効化し、新受付を止める。D1 `control.epoch` を条件付きで +1 し、その後 ControlDO epoch を同値へ確定する。途中不一致は全 mutation を fail closed にする。
2. Queue / Cron / HTTP commit permit を quiesce し、既に不可逆 `deleting` の GC inventory を確定する。旧 request は D1 epoch barrier で commit 不能。
3. D1 を restore / migrate し、`control.epoch` を新 epoch へ上書きする。UploadDO / LockDO は wake 時に不一致を `stale` として 409 を返す。
4. R2 existence、quota、ref、operation、upload、outbox、journal、media index / derivative を再計算する。旧 epoch row は実行しない。
5. share は recovery-disabled + version 更新、app password は再発行、service / user disable と bootstrap identity は再確認。lock は全失効、upload は D1 正本から commit 修復または abort。
6. restore drill gate 後だけ maintenance、最後に GC を再開する。

RPO / RTO、retention、GC grace は §13。R2 だけから namespace を再構築できるとは主張しない。

---

## 12. search

`node_search` と FTS external content を使う。保存名は NFC、検索値は NFKC + locale 非依存 Unicode casefold + かな統一。bigram は候補抽出だけで、最終照合は normalized value で行う。

name に加え、library title / author / series / tag と audio title / artist / album を bounded column として index する。trigger / outbox は current node / blob / metadata revision と generation を検査する。

全 result、snippet、count、facet、cursor は `authorize` と `EffectiveLive` を通し、owner / internal grant / share capability root 外を漏らさない。一文字 query は認可 root 内 bounded fallback。scan / pattern 上限は §13。

---

## 13. 制限、security、audit、運用費

### 13.1 数値の唯一の正本

| 定数 / 項目 | v1 値・契約 |
|---|---|
| `MAX_REQUEST_BYTES` | 95,000,000 bytes。body付きrouteはContent-Length必須。 |
| JSON | body≤1MiB、nesting≤32、route schema、未知/重複key拒否、配列/文字列はroute別上限。 |
| URL / header | URL≤8KiB、query項目≤100、header数≤100、個別credential/token長≤2KiB。 |
| name / tree | NFC UTF-8≤255 bytes かつ255文字未満、path深さ≤64。 |
| XML / PROPFIND | body≤1MiB、深さ≤32、要素≤10,000、属性合計≤20,000、namespace宣言≤100、property≤100/request、value≤8KiB、response≤32MiB。 |
| DAV `If` | header≤8KiB、list/tagged URI≤16、条件≤64、token≤2KiB。 |
| DAV controls | Destination=設定済み同一HTTPS origin + `/dav/`、Depth=`0|1|infinity`、Timeout=`Second-N`, N≤604800。 |
| Range | 単一bytes range。複数はRangeを無視した全体200。巨大整数/重複header拒否。 |
| upload part | default 64MiB、8–90MiB、parts≤10,000、file≤min(partSize×parts,500GiB)。 |
| upload lifetime / cost | progressから24h、作成から6日、同part 3 attempts、calls≤parts×3、受信≤declared×3、in-flight4、part15分。 |
| quota headroom | `PHYSICAL_HEADROOM_FACTOR=1.2`。 |
| versions / recovery | 直近10または30日、Time Travel30日、D1 backup5日、GC grace35日、RPO24h。 |
| ticket | TTL≤6h、bytes≤size×3、request≤1,024、並列≤8。share expiryを越えない。 |
| cache | private API / content / share JSON / HTML=`private,no-store`、thumb=`private,max-age=300`、archive index=`private,max-age=3600` + `ETag=index_key`。 |
| share / auth secret | bearer既定256-bit、最低128-bit。unlock同時16、app password20/user、default90日/max365日。 |
| KDF | PBKDF2-HMAC-SHA256 600,000、salt16B、DK32B。試行 share10/min、IP30/min、global600/min、同時20。 |
| v1 ZIP download | entry≤1,000、payload<4GiB、各entry<4GiB、R2 GET≤1,000、manifest≤8MiB、全output≤UINT32_MAX、STOREのみ。 |
| archive index | entry≤10,000、単entry uncompressed≤64MiB、合計≤8GiB、central dir≤8MiB、EOCD探索≤1MiB、stored/deflateのみ。 |
| archive page | local name+extra≤64KiB、compressed dataはindex値以下、stream output≤64MiB、per-book thumb並列4。 |
| Gallery | page≤200、recursive深さ≤64、候補≤50,000、Lightbox prefetch前後2。 |
| Audio | tracks/folder≤2,000、head≤2MiB、tail=128B、MP4 moov探索≤4MiB、tag field≤1KiB、cover≤20MiB。 |
| image transform | input≤20MiB、≤40MP、frame≤1、WASM input≤8MiB/12MP、attempt≤3/tuple。 |
| user metadata | node≤200,000/user、children≤2,000/folder、COW refs≤1,000/blob。 |
| dead property | total≤8KiB/node、≤8MiB/user、value≤8KiB。 |
| search / bulk | pattern≤50B、candidate/fallback≤10,000 rows、bulk≤100,000 node / 16MiB manifest。 |
| audit / terminal | D1 90日、R2 archive1年、operation/outboxは90日後compact。 |

Cloudflare platform limit は release ごとに公式資料で確認する。現在の設計入力は Worker memory 128MB、Paid CPU default30s/config max300s、subrequest default10,000、outbound connection6、R2 multipart10,000 parts、D1 10GB/DB・bind100・query30s・1,000 queries/invocation、Queue message128KiB/batch100/retention14日/consumer wall15分。app 上限は platform 上限より常に狭くする。

### 13.2 CSRF / CSP / MIME

- private browser mutation: strict Origin + custom header、GET mutation禁止。
- public JSON mutation: exact app Origin、`Origin:null` / missing拒否、`Sec-Fetch-Site:same-origin`、JSON Content-Type、one-time CSRF。
- WebDAV: Cookie無し、CORS無し、Origin付きrequest拒否、Basicのみ。
- response matrix と CSP は §10.4 を正本とし、R2 / content direct public URL を発行しない。

### 13.3 audit / log

`activity` は application principal に対して append-only。Cloudflare account / D1 管理者は trust boundary 内であり、その管理者への暗号学的改竄耐性は保証外。

Workers Logs の invocation logs が request URL を自動記録する前提で、capability / credential / PII を URL と query に置かない。Authorization、Cookie、JWT、Basic、Service Token、password、CSRF、upload capability、ticket、fragment から受けた share secret、D1 bind 値を application log / trace / exception に出さない。logger は allowlist field の構造化 JSON だけを出し、mask 後に serialize する。Tail の heuristic redactionや `Referrer-Policy` を platform log / browser history のsecret除去保証に使わない。Workers Logs、Tail、Logpush、trace、WAF / HTTP log、D1 error を canary で棚卸しする。

CSV export は §10.5 の formula neutralization を行う。管理者操作、Access / secret / deploy 設定変更は MFA、最小権限、承認、外部 audit archive を要求する。

### 13.4 monitoring / cost

D1 size / rows、Queue / outbox age、UploadDO / LockDO stale、quota差分、GC、trash、ticket、ZIP、transform、archive/audio attempts、backup / journal、epoch、JWKS refresh / KDF rate、unauthenticated route test を監視する。

release 時の公式単価を `P_*` とし telemetry から low/base/high worksheet を作る。最低限、次を別行で積算する。

- Gallery page: D1 rows ≤200 + thumb cache miss時 Images unique transform + R2 derivative read。
- archive index: R2 Range 最大 `1MiB + 8MiB`、Queue、index R2 write。page view は原則 R2 Class B×2（local header + data）、thumb miss は Images×1 + R2 write。
- EPUB resource: entryごと header/data Range、ticket request/byte budget。Audio tag は通常 head+tail 2 read、MP4 は探索 read を上限化。
- R2 Class A/B、D1 rows、Images transform、DO request/duration、Queue、backup / GC / retryを含め、Workers Paid基本料だけを総費用としない。

---

## 14. config、deploy、secrets、ControlDO、Cron / job

### 14.1 Wrangler / environment

```jsonc
{
  "name": "next-cloud-flare",
  "main": "packages/worker/src/index.ts",
  "workers_dev": false,
  "preview_urls": false,
  "assets": {
    "directory": "packages/web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },
  "triggers": { "crons": ["17 * * * *", "23 2 * * *", "0 3 * * SUN"] },
  "observability": {
    "logs": { "enabled": true, "invocation_logs": true }
  }
}
```

`unsafe.bindings` を使わない。development / staging / production の D1、R2、KV、DO、Queue、Access app、custom domain、key を分離する。Workers Logs の `invocation_logs` と URL 記録範囲は各 environment の IaC review / canary test で明示し、raw request logging を実装しない。canary secretが残るlog productはrelease前に`invocation_logs`または当該sinkを無効化し、allowlist型application auditだけを残す。

`DEV_BYPASS_ACCESS` は `env.production` / `env.staging` に定義不可と CI schema で拒否する。code は `env.ENVIRONMENT !== 'development'` なら値が存在しても無視して起動 warning / security event を出し、local auth adapter を登録しない。文字列 truthiness で判定しない。

### 14.2 secret inventory / rotation

| 名称 | 保管 | 用途 |
|---|---|---|
| `SIGNING_KEYS` | `wrangler secret`、`[{kid,status,key}]` JSON | unlock、ticket、upload、CSRF HMAC。environment別。 |
| `APP_PASSWORD_HMAC_KEYS` | `wrangler secret` key ring | app password digest。signing keyと分離。 |
| Cloudflare deploy token | CI secret manager | deploy限定。runtimeへ渡さない。 |
| Service Token client secret | 利用client側secret store | D1 / frontend / logへ保存しない。 |
| Access issuer/AUD、CONTENT_HOST、limits | vars | 非secretだが変更承認対象。 |
| `OWNER_EMAILS` | vars | 初回だけのPII/権限設定。bootstrap後無視。 |

鍵は用途 / environment ごとに `openssl rand -base64 32` で最低256 bitを生成し、値を shell history / Git に残さず `wrangler secret put <NAME> --env <env>` で登録する。

通常 `SIGNING_KEYS` rotation は (1) 新 `kid` を active 追加、(2) 全 instance 配備後24h待つ、(3) 旧 keyを verify-only、(4) 7日後に削除。token TTL はこの窓を越えない。緊急時は旧 key 削除、epoch +1、share session / ticket / upload capabilityを全失効する。通常 rotation と recovery epoch は混同しない。

app-password key rotation は新 key で発行し旧 keyを verify-onlyにする。旧 keyで成功した credentialは同一 transactionで新 digestへ再hashする。7日後に未移行 credentialを revokeして旧 keyを削除し、利用者へ再発行を要求する。secret変更、Access policy、custom domain、deployはMFA + two-person approval + audit対象。

### 14.3 ControlDO / job / deploy gate

全 mutation / job は ControlDO と D1 epoch、maintenanceを確認する。schedule は upload / trash / outbox repair、daily export / activity archive、weekly R2 orphan reconciliation、media index / search repairに分ける。各 job は node、blob、Range bytes、D1/R2 call、CPU/wallを別予算にしcheckpointから再開する。

Access policyはmanifestから生成 / diffする。deploy後、private SPA/API、service route、public share、DAV、content host、未知 route、想定外 host、workers.dev、preview URL、R2 public access、HTTPSを実HTTPで検査する。CONTENT_HOSTにprivate APIがなく、全host/aliasで同じ境界が効くことを確認する。

---

## 15. test plan / acceptance

### 15.1 normal / protocol / media

- unit / integration: tree CTE、EffectiveLive、authorize matrix、manifest被覆、epoch barrier、quota、全state machine、search、JSON/XML/header parser、output encoding。
- WebDAV: litmus basic / copymove / props / locks、rclone、cadaver、Finder、Explorer。alias、lock-null、複合 `If`、MOVE lock終了、strong collection ETagを含む。
- media: gallery 50,000候補境界、EXIF GPS破棄、ZIP64/EOCD/central directory/path/CRC/zip bomb、deflate stream上限、EPUB CSP、audio atom/tag/cover上限、stale generation job。
- E2E: upload resume、share fragment、unlock logout、upload-only non-oracle、trash、bulk、Access logout、PWA cache、reader/player state、a11y。
- cost: Range、part resend、duplicate Queue、Depth:1、ZIP disconnect、archive page、thumb/tag retryが§13内で停止すること。

### 15.2 security / failure release gate

- 間違った AUD / issuer / alg、未来 `nbf` / `iat`、未知 kid 連打、Cookieのみ、重複header、user/service混同を拒否し、JWKS refreshが10/minを越えたら503となる。
- 別 Access app JWT、Bypass routeへのJWT添付、CONTENT_HOSTからprivate API、old alias、HTTP DAVを拒否する。
- `P/S/F` の `P` をtrash開始した直後、S共有からcontent / thumb / children / search / count / ZIP / gallery / tracks / library / ticketを拒否する。
- credential revoke / expiry / scope縮小 / user停止 / share version更新後、upload part/status/complete、job、terminal result再生を拒否し、metadataを漏らさない。
- 旧epochで認証・R2 I/Oまで進めたHTTP mutationをrecovery後に再開しても、D1 control barrierでcommitできない。UploadDO/LockDOがstale 409となる。
- public JSON mutationへのcross-origin、missing / `Origin:null`、CONTENT_HOST origin、wrong Sec-Fetch-Site、non-JSON、CSRF replayを拒否する。
- HTML / SVG / PDF / Markdown / Office / archive page / EPUB resourceと悪意あるfilename/tag/propertyを全surface、直接URL、206、errorで開き、matrix、CSP、sanitize、encodingを満たす。
- lock tokenを知る別principalはcurrent write権限があれば通常mutation可能、権限無しなら403。UNLOCKはcreator/space owner以外403、refreshはtokenで可能、MOVE後source lockは継承されず、weak ETagをIf-Matchへ使わない。
- canary JWT、Cookie、Basic、Service secret、share secret、CSRF、upload capability、ticketを含むrequestがWorkers Logs / Tail / Logpush / trace / WAF / exception / D1 errorへ残らない。
- 同一revision PUT、D1 response loss、各step zero-row、claim競合、lock inspect/commit race、part barrier、trash/restore/purge、GC/delete response loss、outbox/Queue/backup lossをfailure injectionし、barrierと冪等性を証明する。
- bootstrapは同一iss+subで一度だけ成功し、email再利用、別sub、Access IdP追加、recovery巻戻りでownerを増やさない。

### 15.3 staging cloud / browser gate

Miniflareだけで合格にしない。zone body / framing、D1 batch / Time Travel、R2 multipart / Range、DO restart、Queue duplicate、Images peak、JWKS rotation、Access logout伝播、実Set-Cookie、Origin / Sec-Fetch-Site、Workers Logs canary、CONTENT_HOST sandbox、実DAV client、restore drillを分離stagingで実測する。

---

## 16. 実装 phase

1. **Foundation / invariants**: manifest、JWT user/service、schema/control、principal/operand認可、EffectiveLive、operation/epoch barrier、tree/lock generation、quota、failure injection。
2. **Files core**: immutable blob、metadata/content ETag、create/rename/MOVE、COW、cross-owner copy、Range、safe delivery matrix。
3. **Multipart**: UploadDO全状態、stale epoch、public/private route、resume、reconciliation。
4. **Trash / GC / recovery**: exclusive state、FK purge、pins、irreversible GC、journal backup、epoch restore drill。
5. **Search / stats**: FTS、bounded fallback、folder aggregation、metadata quota。
6. **Thumbnail / preview**: outbox、result claim、client thumb、CONTENT_HOST、CSP/browser gate。
7. **Sharing**: fragment secret、unlock session、typed ticket、internal/upload-only/public edit、ZIP budget。
8. **WebDAV**: Class 1、Class 2、RFC lock、commit reservation、real client matrix。
9. **Media library**: **Gallery → Bookshelf → Audio**。各段階でindex/tag cost gateとsandbox acceptanceを通す。
10. **Operations / polish**: admin/DLQ、cost metric、PWA、i18n、a11y。

Foundation の invariants と §15 failure gate が通るまで Files core へ進まない。各 phase は migration test、lint、typecheck、unit、relevant integrationを必須にする。

---

## 17. 機能提供 roadmap

| 項目 | 判定 | 内容 |
|---|---|---|
| file history | v1 / 後段 | v1は内部保持、UI/user restoreは§18。 |
| sync conflict | v1 | file PUT strong ETag 412。conflicted copyなし。 |
| change token | 後段 | v1は標準PROPFINDをtruncateしない。 |
| team / group share | 後段 | v1はpersonal owner space。 |
| app credential / user disable | v1 | scope、finite TTL、revoke、primary照合、epoch。 |
| bulk / search / backup | v1 | bounded job、name/media metadata search、限定recovery window。 |
| Gallery | v1 | folder image/video、timeline、Lightbox、share view。 |
| Bookshelf | v1 | EPUB、ZIP/CBZ、PDF、folder images、reading state。 |
| Audio | v1 | bounded tags、folder album、Range player、playback state。 |
| OCR / full-text / DRM | 非目標 | v1では実装しない。 |

---

## 18. 後段・staging で確定する事項

v1 で安全な制限が置けない機能は有効化しない。

1. **ZIP64 download**: v1.1候補。archive indexはZIP64 EOCDをboundedに読めるが、download ZIP生成はSTORE/non-ZIP64のまま。
2. **大容量CLI / Nextcloud chunking / change token**: v1.1以降。DAVは単発request上限。
3. **version history UI、team/group/reshare、通知、user import/export**: data modelと認可を別reviewする。
4. **Service TokenのDAV対応**: v1不採用。REST mapping実績後に再reviewする。
5. **codec / runtime**: Images/WASM peak、PDF viewer、PBKDF2 latencyをstagingで測る。scrypt `N=2^15,r=8,p=1` はruntime実装、memory、global concurrencyがgateを満たす場合だけPBKDF2の代替としてversioned configへ採用し、requestごとの選択は許さない。
6. **cross-owner copy throughput / D1容量 / search / backup journal**: 実datasetとrestore drill後に上限を再reviewし、一発stream copyへ戻さない。
7. **RAR/CBR/7z、波形、歌詞同期、外部metadata照合、サーバEPUB変換**: v1.1以降の候補。v1は`unsupported`で、archiveを全体展開しない。
8. **CONTENT_HOSTの別account化、R2 replication、長期backup**: v1の同一account threat modelを越えるoption。CONTENT_HOST自体はv1のactive content / EPUB reader標準構成で、単一host fallbackではそれらをattachmentにする。
9. **WebDAV client差異**: Finder / Explorer / rcloneのsidecar、case-only rename、lock-null、複合`If`をsupport matrixに固定する。
10. **料金とplatform可変値**: release時公式値でworksheet、Wrangler、JWKS/logout/log挙動を更新し、安全性の根拠を暗黙のplan値に置かない。
