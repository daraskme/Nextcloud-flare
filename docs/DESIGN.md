# Next-cloud-flare — 設計・実装方針 (v0.2)

Cloudflare のサービスだけで完結する、Google Drive / Nextcloud ライクなセルフホスト型ストレージ管理アプリ。

> ステータス: **Astra ラウンド1 反映済み**。ストレージの確定点・認可境界・障害復旧・Cloudflare 制限を v0.2 の実装契約とする。
>
> 制限定義と公式仕様の確認基準日: 2026-09-21。契約・環境依存値はリリース時に staging で再確認する。

---

## 0. ゴール、非ゴール、提供範囲

### 0.1 ゴール

- **Cloudflare 完結**: Workers、Workers Static Assets、R2、D1、KV、Durable Objects、Queues、Cron Triggers、Cloudflare Access のみを実行基盤とする。Google IdP は Access の認証元としてのみ利用し、アプリから Google API や外部 CDN へ接続しない。
- **正本の分離**: R2 は不変のファイル内容、D1 は論理名前空間・参照・権限・状態の正本とする。
- **共通の安全境界**: REST、WebDAV、upload complete、Queue consumer の全書き込みを `fsMutation` に集約し、認可、WebDAV ロック、操作 ID、期待 revision、クォータ予約を同じ順序で検査する。
- **必須機能**: Web UI、WebDAV Class 1/2、期限・パスワード付きリンク共有、内部共有、upload-only 共有、回収箱、名前検索、再開可能 multipart、プレビュー、サムネイル、クォータ、監査。
- **障害復旧**: 日次 D1 エクスポート、D1 Time Travel、GC 停止を含む手動復旧手順を持ち、復旧演習をリリース条件とする。
- **UI**: モダンなファイル管理 UI、日本語・英語、キーボード・タッチ・支援技術に対応する。

### 0.2 非ゴール

- Office/Collabora 相当の同時編集、E2E 暗号化、デスクトップ同期クライアント、本文検索・OCR、サーバ側マルウェア検査、厳密な DRM。
- Nextcloud 固有の discovery、capability、chunking、全 API との互換。**WebDAV 対応と Nextcloud クライアント互換は別であり、後者は非目標**とする。
- R2 バケットの直接操作。R2 を rclone で見ても論理パスにはならず、直接書き込みは禁止する。
- 無料プランでの動作保証。Workers Paid は Queues、DO、CPU 等のための前提だが、HTTP リクエストボディ上限を引き上げるものではない。上限はゾーンプラン依存である。

### 0.3 クライアント・転送サポート表

| 経路 | v1 の扱い | 上限・競合 |
|---|---|---|
| Web UI | 専用 multipart で大容量対応 | 公称 500 GiB、最大 10,000 parts。ETag 競合は 412。 |
| REST 単発 | 1 HTTP request | `MAX_REQUEST_BYTES` 既定 95 MB、`Content-Length` 必須。 |
| 通常 WebDAV | Class 1/2、1 request PUT | 既定 95 MB まで。独自 multipart は使わない。 |
| CLI 大容量 | v1.1 の専用 API client | v1 は通常 WebDAV 上限まで。 |
| Nextcloud client | 非目標 | 基本 WebDAV が動く範囲のみ。固有 chunking 等は保証しない。 |

同期競合では `If-Match` を要求し、競合時は 412 を返す。サーバは conflicted copy を自動生成せず、再取得・別名保存はクライアント責務とする。

---

## 1. Cloudflare サービス選定と役割

| 役割 | サービス | 設計上の扱い |
|---|---|---|
| API / WebDAV / 共有ページ | Workers + Hono + TypeScript | 全 surface を同一 router と共通サービスへ集約する。 |
| SPA | Workers Static Assets | `run_worker_first` でシェルを含む全要求を Worker に通し、private shell に Access を必須化する。 |
| 内容・派生物・バックアップ | R2 | 本体は不変 blob。public access と `r2.dev` は無効。 |
| 名前空間・状態 | D1 | 名前空間、blob 参照、権限、クォータ、操作台帳、outbox、監査の正本。 |
| WebDAV lock | `LockDO(spaceId)` | space は保存先 owner の user ID。SQLite に URI lock を永続化する。 |
| multipart | `UploadDO(uploadId)` | SQLite に session、parts、etag、size、状態機械を永続化する。 |
| サムネイル | Queues + Images binding / 制限付き WASM | at-least-once を前提に世代付き job と outbox を使う。 |
| 短命 cache | KV | JWKS、読み取り専用 path cache、機能 flag。認可・mutation・mutex の権威にはしない。 |
| 定期処理 | Cron Triggers | lease を取得し、再開可能 job を起動する。Cron 自体で全件完遂しない。 |
| 認証 | Cloudflare Access | private app の入口。公開共有と WebDAV は Worker 自身が認証する。 |
| rate limit | Workers Rate Limiting binding + DO | binding は近似的な一次防御、重要上限は DO で補完する。 |
| 監視 | Workers Logs / Analytics Engine（任意） | 構造化・マスキング済みログとメトリクスを送る。 |

Images binding はアカウント契約と環境で利用可否が異なるため、binding 有り・無しの Wrangler 環境を分ける。

---

## 2. 全体アーキテクチャとルート境界

```text
Browser ─ Access ─┐                         ┌─ D1: namespace/auth/state/outbox
                  ├─ Worker / routes.ts ────┼─ R2: immutable blobs/derivatives/backups
WebDAV ─ Basic ───┤   authorize + fsMutation├─ LockDO(space) / UploadDO(upload)
Share capability ─┘                         └─ Queue / Cron / KV(read cache only)
```

### 2.1 モノレポ

```text
Next-cloud-flare/
  pnpm-workspace.yaml
  package.json
  wrangler.jsonc
  packages/
    worker/
      src/index.ts
      src/routes.ts              # route manifest の唯一の定義
      src/auth/                   # principal, Access, app password, capability
      src/api/                    # private/public REST
      src/dav/                    # WebDAV protocol adapter
      src/services/               # authorize, fsMutation, blob, quota, audit
      src/do/                     # LockDO, UploadDO, RateLimitDO
      src/jobs/                   # dispatcher, consumers, cron jobs
      migrations/
      test/
    web/
      dist/                       # Static Assets の唯一の出力先
    shared/
  docs/
```

### 2.2 単一ルート表

`routes.ts` は Hono、Static Assets、CSRF、CORS、Access IaC 生成、未認証 smoke test が共有する。URL は percent decode を一度だけ行い、`U+0000`、encoded slash、backslash、二重 decode の余地を拒否してから照合する。

| surface | 絶対パス | Access | Worker 側認証 / CORS |
|---|---|---|---|
| private SPA/API | `/`, assets, `/api/v1/*`（public を除く） | 必須 | 有効な Access user。CORS 非公開。 |
| public API | `/api/v1/public/*` | Bypass | share capability / CSRF。未知 route は 404。 |
| share page | `/s`、`/s/*` | Bypass | SSR capability flow。未知 route は 404。 |
| WebDAV | `/dav`、`/dav/*` | Bypass | Basic app password を既定。Cookie 不使用、CORS 非公開。 |
| well-known | 明示 allowlist の個別 path のみ | 必要時だけ Bypass | v1 は wildcard `/.well-known/*` を公開しない。 |

- `/api/v1/public/*`、`/s/*`、`/dav/*` の三 prefix と明示した well-known 以外を Bypass しない。
- 公開 prefix 配下の未知 route は private router や SPA へフォールスルーさせない。
- Static Assets は `run_worker_first: true` とし、private SPA shell も Worker の Access 検査後だけ返す。公開 shell は置かない。
- Access JWT が Bypass route に付いていても principal を自動で user へ昇格・合成しない。
- `workers.dev` と preview URL は本番で無効、想定 custom domain 以外は 404、R2 public access / `r2.dev` は無効にする。

---

## 3. データモデルと不変条件 (D1 / R2)

### 3.1 中核テーブル

以下は論理スキーマであり、CHECK、外部キー、部分索引を migration で固定する。

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  access_iss TEXT NOT NULL,
  access_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  quota_bytes INTEGER,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  UNIQUE(access_iss, access_sub)
);
CREATE INDEX users_email ON users(email);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
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
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX nodes_parent_name
  ON nodes(parent_id, name_ci) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX nodes_one_root
  ON nodes(owner_id) WHERE kind = 'root' AND deleted_at IS NULL;

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  sha256_verified TEXT,
  content_etag TEXT NOT NULL,
  mime_sniffed TEXT,
  ref_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL
);

CREATE TABLE node_versions (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  PRIMARY KEY(node_id, revision)
);

CREATE TABLE trash_ops (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  root_node_id TEXT NOT NULL REFERENCES nodes(id),
  created_at INTEGER NOT NULL,
  purge_after INTEGER,
  state TEXT NOT NULL
);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  actor_id TEXT,
  parent_id TEXT NOT NULL REFERENCES nodes(id),
  target_node_id TEXT,
  name TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  declared_size INTEGER NOT NULL,
  sha256_declared TEXT,
  reserved_bytes INTEGER NOT NULL,
  part_size INTEGER NOT NULL,
  r2_upload_id TEXT,
  state TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  result_node_id TEXT,
  result_revision INTEGER,
  created_at INTEGER NOT NULL,
  last_progress_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  grantee_user_id TEXT,
  permission TEXT NOT NULL,
  password_kdf TEXT,
  share_version INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
```

追加テーブル:

- `app_passwords(id,user_id,device_name,secret_hmac,scope,folder_id,expires_at,last_used_at,revoked_at)`。
- `service_principals(id,access_client_id_hash,user_id,space_id,scope,disabled_at)`。
- `node_props(node_id,ns,name,value_xml)`。`node_id` は `ON DELETE CASCADE`。
- `user_node_state(user_id,node_id,starred,last_opened_at)`。`last_opened_at` は間引いて更新する。
- `thumbs(node_id,blob_id,variant,generator_version,status,source,dominant_color,r2_key,updated_at)`。`status` と `source(server|client)` を分離する。
- `outbox(id,type,payload,state,attempts,next_attempt_at,created_at)`、`operations`、`bulk_jobs`、`folder_stats`。folder 集計は mutation outbox から非同期更新し、freshness / calculating 状態を持ち、日次差分検査で再計算する。
- `gc_candidates(blob_id,reason,first_seen_at,delete_after,last_verified_at,state)`。
- `job_leases(job,holder,fence,expires_at,checkpoint)`。
- `activity(id,ts,actor_id,actor_kind,action,node_id,share_id,detail)`。
- `settings(key,value)`。最低限 `allow_signup=false`、`gc_paused=false`、世代保持、回収箱保持を持つ。

### 3.2 root とツリー不変条件

- user 作成時に実体の root node (`kind='root'`) を一つ作る。root のみ `parent_id IS NULL`、一般 node は `parent_id NOT NULL`。root 自体の rename、MOVE、trash、purge は禁止する。
- 名前は保存時 NFC、`name_ci` は決定的 Unicode casefold を適用した照合用値とし、比較は macOS 相当の case-insensitive とする。大小だけの rename は一時名を使わず、単一条件付き UPDATE で扱う。
- 親は同一 owner の未削除 `folder|root` でなければならない。削除中、回収箱内、別 owner、file を親にできない。
- 自身または子孫への MOVE を禁止する。移動後の対象 subtree の最大深さは 64 以下とする。
- owner をまたぐ MOVE は v1 では拒否し、copy + delete を明示操作として提供する。
- 内部共有先への作成は actor と owner を分離し、保存先 space の owner を node/blob/quota の owner とする。

### 3.3 名前と予約領域

`portable_names=true` を既定とし、空名、`.`、`..`、`/`、`\`、制御文字、末尾 `.` / 空白、Windows 予約名、UTF-8 255 bytes 超を拒否する。検証順は「URL decode 1回 → 区切り・制御文字拒否 → NFC → portable check → casefold」とする。

`.DS_Store` と `._*` は保存を許可して `hidden=1` とし、UI では既定非表示にする。`/dav/Shared/` は仮想予約 prefix とし、root 直下に実 folder `Shared` を作成できない。内部共有の mount 名は `<share_id短縮>-<name>` とし、表示名変更後も安定 ID で解決する。

### 3.4 不変 blob、世代、copy-on-write

- 本体 R2 key は `u/<ownerId>/b/<blobId>`。同じ key を上書きしない。blob state は `staging|committed|gc_candidate|deleting` とし、`committed` 以外を content API から配信しない。
- node metadata の ETag は `revision`、content ETag は `blobs.content_etag`。folder を含む node 更新ごとに `revision += 1` し、子追加・削除時は親 collection の revision も進める。
- 内容更新は新 blob を新 key に書き、実サイズ・checksum・MIME を確定してから、D1 で次を実行する。

```sql
UPDATE nodes
SET current_blob_id = ?, revision = revision + 1, updated_at = ?
WHERE id = ? AND revision = ? AND deleted_at IS NULL;
```

影響行 0 は `If-Match` 失敗なら 412、同時状態遷移なら 409 とする。新 blob は公開せず GC 候補へ送る。旧 blob は `node_versions` に残し、直近 N=10 世代 **または** 30 日以内を保持する。UI の version history / restore は v1.1 だが、内部保持は v1 で実装する。

- `ref_count` は current node と保持中 `node_versions` の参照数を数える。直接加減算せず、同じ D1 batch で参照行と整合させる。
- 同一 owner space の COPY は新 node が同じ blob を参照し、`ref_count += 1` する copy-on-write。元 revision/blob を開始時に固定する。
- owner をまたぐ COPY は R2 binding の `get()` → 新 key への `put()` による stream copy とし、対象 owner に新 blob とクォータを作る。Workers binding に存在しない `copy()` は前提にしない。
- folder COPY は manifest を固定した bulk job とし、dead properties の引継ぎは明示 option、share と lock はコピーしない。

### 3.5 D1 実装境界と索引

- D1 `batch()` の境界は行数ではなく、bind parameter **100/statement 以下**、SQL 100,000 bytes 以下、実行時間、query 数で決める。大規模操作は cursor/checkpoint 付き job にする。
- CAS に依存する batch の全従属 statement は同じ operation state / expected revision 条件で guard し、条件不成立を成功扱いにしない。
- 一覧は sort ごとの複合 keyset cursor を使う。offset pagination は管理用小規模画面以外で使わない。
- 必須索引は `shares(grantee_user_id,node_id)`、`uploads(state,expires_at)`、`activity(node_id,ts)`、`nodes(parent_id,deleted_at,name_ci)`、`nodes(owner_id,deleted_at,updated_at)`、`node_versions(blob_id)`、`gc_candidates(state,delete_after)`、`outbox(state,next_attempt_at)`。
- D1 read replica / Sessions API を使う場合も、書き込み直後、認可、share 失効、quota、lock 確定は primary を読む。
- path cache と authorization cache は分離する。path は一つの再帰 CTE で解決し、KV cache は `space_generation` を key に含む読み取り専用 hint とする。mutation 前には必ず primary で parent/name/revision を再検証する。

---

## 4. 認証、principal、認可、初期化

### 4.1 principal

```text
user(iss+sub)
app_password(user_id, scope=ro|rw, optional folder root)
link_share(share_id, share_version, capability root/actions/expiry)
service_token(service_principal mapping)
```

認証情報は暗黙に合成しない。route が期待する方式を一つ選び、より強い資格情報が同時に付いても自動昇格しない。全 content、thumb、preview、ZIP、children、upload complete は `authorize(principal,node,action)` を通る。

### 4.2 Access identity と owner bootstrap

- `iss + sub` を identity の主キー相当とし、email は属性として保持する。別 sub が既存 email と一致しても自動紐付けしない。
- JWT は許可 alg、署名、`iss`、`aud`（文字列・配列）、`exp`、`nbf`、必須 claim を検証する。未知 `kid` では JWKS を一度再取得し、取得・検証失敗は fail closed とする。
- `users.disabled_at` がある user は Access を通過しても 403 とする。
- vars `OWNER_EMAILS` は必須。そこに一致する identity だけが原子的な初期 bootstrap で owner になれる。未設定または Access 必須設定欠落時は **全 request を 503** にする。
- `allow_signup` の既定は false。Access が許可した domain の user でも owner が招待・許可するまで 403。
- owner 移譲を監査付き操作として用意し、最後の owner の停止・削除を禁止する。user 停止時は app password と進行 session を失効し、データ移譲または凍結を明示選択する。
- Service Token は `service_principals` により user、space、scope へ明示 mapping した場合だけ有効。v1 では任意機能で、単に Access client headers があるだけでは principal にしない。

### 4.3 操作 × principal 許可表

`user` の「共有」は有効な internal share の root とその子孫を意味する。再共有権限は owner のみとする。

| action | user owner/admin | user internal read | user internal edit | app password ro / rw | link read | link edit | link upload-only | service token |
|---|---|---|---|---|---|---|---|---|
| list / metadata / content | 許可 | 許可 | 許可 | scope root 内で許可 | capability root と有効な子孫のみ | capability root と有効な子孫のみ | **禁止** | mapping scope 次第 |
| 新規 file/folder | 許可 | 禁止 | 保存先 owner で許可 | rw のみ | 禁止 | capability root 内で許可 | 新規受取 file のみ | mapping scope 次第 |
| overwrite / rename / move / delete | 許可 | 禁止 | 許可 | rw のみ | 禁止 | capability root 内で許可 | **禁止** | mapping scope 次第 |
| COPY | 許可 | 読取元としてのみ | 許可 | rw のみ | 禁止 | capability root 内で許可 | 禁止 | mapping scope 次第 |
| share / reshare / quota 管理 | owner/admin のみ | 禁止 | 禁止 | 禁止 | 禁止 | 禁止 | 禁止 | 明示 admin scope のみ |
| write LOCK | 許可 | 禁止 | 許可 | rw のみ | 禁止 | 禁止 | 禁止 | write scope のみ |
| client thumb POST | write 権限時のみ | 禁止 | 許可 | rw のみ | 禁止 | current blob に許可 | 禁止 | write scope のみ |
| upload complete | 開始時・完了時に再認可 | 禁止 | 再認可 | rw のみ | 禁止 | root 内へ再認可 | 新規名・上限内のみ | mapping scope 次第 |

upload-only は一覧、既存内容の読み取り、上書き、指定 node ID、共有作成を一切許可しない。capability は対象 root、許可 action、expiry、share version に制限する。

### 4.4 資格情報

- app password は 32 bytes CSPRNG を一度だけ表示し、`HMAC-SHA256(APP_PASSWORD_HMAC_KEY, secret)` のみ保存、timing-safe 比較する。端末名、有効期限、`ro|rw`、任意 folder root、間引いた最終使用、個別・全失効を提供する。WebDAV の既定認証は app password。
- 共有 password はランダム salt と version 付き PBKDF2-SHA256。既定 300,000 iterations とし、staging の CPU 実測で調整する。
- 高コスト KDF の前に per-IP と per-share / per-credential の安価な rate limit を適用する。Rate Limiting binding は location ごとの近似値であり、password 試行・session 数など重要な全体上限は DO で補完する。

---

## 5. REST API と共通 mutation

### 5.1 API

private base は `/api/v1`、public base は `/api/v1/public` とする。

| Method | Path | 概要 |
|---|---|---|
| GET | `/api/v1/me` | user、quota、feature flags |
| GET | `/api/v1/nodes/:id`, `/children`, `/path`, `/content`, `/thumb`, `/preview` | metadata、keyset 一覧、Range content |
| POST | `/api/v1/nodes/:id/folders` | folder 作成 |
| PATCH | `/api/v1/nodes/:id` | rename / move、`If-Match` 必須 |
| POST | `/api/v1/nodes/copy` | copy-on-write / cross-owner stream copy |
| DELETE | `/api/v1/nodes` | trash operation を作成 |
| POST | `/api/v1/nodes/:id/zip` | 通常 ZIP の制限付き stream |
| POST | `/api/v1/uploads` | metadata、quota、blob、session を予約 |
| PUT | `/api/v1/uploads/:id/content` | 単発 body。JSON と生 body を混在させない |
| PUT | `/api/v1/uploads/:id/parts/:n` | multipart part |
| GET/POST/DELETE | `/api/v1/uploads/:id[/complete]` | 再開、冪等 complete、abort |
| GET/POST | `/api/v1/trash`, `/restore`, `/purge` | trash 一覧・復元・purge job |
| GET | `/api/v1/search` | scope 制約付き名前検索 |
| GET/POST/PATCH/DELETE | `/api/v1/shares[/id]` | link/internal share。`kind`、`granteeUserId` を含む |
| POST | `/api/v1/nodes/:id/thumbs` | client thumb。node/blob generation 必須 |
| GET/POST/DELETE | `/api/v1/app-passwords` | app credential 管理 |
| GET | `/api/v1/activity`, `/api/v1/jobs/:id` | 監査、bulk 進捗 |
| POST/DELETE | `/api/v1/jobs/:id/cancel`, `/retry` | cancel / retry |
| GET/POST | `/api/v1/admin/dlq`, `/requeue` | DLQ 閲覧・再投入 |
| GET/PATCH | `/api/v1/admin/settings`, `/users`, `/owners` | 管理 |
| GET/POST | `/api/v1/public/shares/:token[/unlock]` | 汎用 meta、password unlock |
| GET/POST | `/api/v1/public/shares/:token/children`, `/uploads` | capability に応じ list または新規受取 |
| POST/GET | `/api/v1/public/shares/:token/download-tickets`, `/content|zip|thumb` | session ticket 発行・配信 |

REST error は RFC 9457 Problem Details、WebDAV error は §7 の XML とする。

### 5.2 `fsMutation` 確定プロトコル

全書き込みは次の順序を変えない。

1. URL / node / principal を解決し、primary D1 で `authorize`、owner、削除状態、期待 revision、名前・tree 条件を検査する。
2. `LockDO(spaceId=保存先owner_id)` で source、ancestor、parent、Destination の URI lock を検査し、operation ID を予約する。
3. 必要なら D1 の条件付き UPDATE で quota を予約し、`operations` に expected revision、target、idempotency key を記録する。
4. 新内容があれば固有 blob key へ書き、実サイズ、R2 ETag、MIME、必要な checksum を確定する。
5. D1 batch で期待 revision 付き参照切替、`node_versions`、ref count、quota 確定、activity、outbox、operation result を一度だけ更新する。
6. 0 行 / 状態競合なら旧状態を維持して 412/409、新 blob と予約を GC / 解放処理へ送る。
7. 同じ operation ID の再試行には保存済み結果を返す。応答喪失後も二重確定しない。

R2 と D1 の分散 transaction は存在しないため、**D1 の参照切替が利用者から見た確定点**である。D1 に参照されない blob は配信しない。

### 5.3 条件要求、bulk、ZIP

- node API ETag は quoted revision、content ETag は blob `content_etag`、WebDAV collection `getetag` は revision。`If-Match` / `If-None-Match: *` 失敗は 412。
- bulk mutation は `Idempotency-Key` を受け、job ID、総数、成功・失敗、cursor、cancel 可否を返す。小規模同期処理でも項目別結果を保持する。
- 名前衝突 policy は `replace | skip | rename` を明示し、既定は安全な `rename`。大きな破壊操作は UI で対象数・容量を確認する。
- v1 ZIP は開始前に manifest を固定し、総 uncompressed size `< 4 GiB`、各 entry `< 4 GiB`、件数 `<= 65,000` を検査する。超過は 413 と分割案内。ZIP64 は v1.1 候補。
- ZIP stream は downstream backpressure を尊重し、先読みを制限する。entry path は NFC、相対 path 化、`..` / absolute / drive prefix 除去を行う。

---

## 6. アップロード、クォータ、再開

### 6.1 サイズと経路

- `MAX_REQUEST_BYTES`: 既定 **95 MB = 95,000,000 bytes**。
- `MAX_PART_BYTES`: 既定 **64 MiB**、設定可能範囲 8–90 MiB。
- `MAX_FILE_BYTES`: `partSize × 10,000` 未満へ丸め、既定・v1 公称上限 **500 GiB**。
- 開始時に `ceil(size/partSize) <= 10,000` を検査する。part size は R2 最低値と最終 part 例外も検査する。
- REST / WebDAV とも `Content-Length` 必須。検証した長さ情報を失わず R2 へ渡し、長さ不明 body は v1 では 411。server-side multipart 化は元の一 HTTP request の edge body 上限を回避しない。
- 100 GB（十進）は既定 64 MiB で約 1,491 parts、100 GiB は 1,600 parts となり、10,000 parts 未満である。
- edge が Worker より先に 413 を返す場合、独自案内を返せないことを UI と docs に明示する。

### 6.2 クォータ予約

開始時に次の条件付き UPDATE で原子的に予約し、影響行 0 は 507 とする。

```sql
UPDATE users
SET reserved_bytes = reserved_bytes + :new
WHERE id = :owner
  AND (quota_bytes IS NULL OR used_bytes + reserved_bytes + :new <= quota_bytes);
```

- `users.reserved_bytes` と `uploads.reserved_bytes` を同じ operation ID で対応付ける。各従属更新も upload state で guard する。
- 各 part の `Content-Length` と受信実サイズ、最終合計と宣言サイズを照合する。不一致は complete せず abort 対象とする。
- `uploads.state` により予約の確定 / 解放を一度だけ行う。timeout、abort、競合失敗でもリークさせない。
- quota は owner space の物理 blob を一 blob 一回だけ数える。trash と内部保持中 version は課金対象、same-owner COW copy は追加 byte なし、cross-owner copy は全量予約する。派生 thumbnail は system overhead として user quota 外にする。
- upload-only share は share ごとの最大 file size、最大件数、合計 bytes、同時 session 数を持ち、owner quota と両方を満たす必要がある。残容量の正確な値は匿名利用者へ表示しない。

### 6.3 UploadDO 状態機械

```text
initiating -> active -> completing -> committed
                  \-> aborting  -> aborted
```

- `UploadDO(uploadId)` の SQLite が in-flight session / part sequencing の正本で、session、part number、etag、実サイズ、generation、operation ID を永続化する。D1 `uploads` は quota、全体一覧、expiry、terminal result の正本であり、reconciler が両者を照合する。
- 同一 part number は DO 内で直列化する。同じ size/etag の再送は冪等、異なる再送は `active` の間だけ明示置換し、`completing` 以後は 409。
- complete 開始時に part の重複・欠落・順序・サイズ・総量を固定し、新 part と abort を拒否する。R2 complete 後に停止しても固有 blob key で照合し、D1 確定を再開できる。
- complete は operation ID で冪等化し、`committed` なら同じ node ID / revision を返す。Cron abort は `active` のみを `aborting` へ CAS する。
- expiry は **最終進捗から 24h**、ただし作成から最大 7 日。R2 未完了 multipart の lifecycle / Cron abort は安全網として設定する。

### 6.4 browser 再開と checksum

- IndexedDB に upload ID、file fingerprint（name、size、mtime、先頭・末尾 sample hash）、part 状態を保存する。
- reload 後は File System Access API の handle、または再選択した file の fingerprint 一致を確認して再開する。
- SHA-256 は Web Worker 内の incremental WASM (`hash-wasm`) で計算する。`sha256_declared` と `sha256_verified` を分け、未検証値を dedupe、保存省略、owner をまたぐ参照共有の根拠にしない。
- browser の同時 part は既定 4 だが、network、6 connection 制約、memory に応じて下げる。

---

## 7. WebDAV (`/dav`, `/dav/*`) とロック

### 7.1 認証と path

v1 の `/dav` は app password の Basic over HTTPS **のみ**とし、Cookie 認証や Access JWT / Service Token へフォールバックしない。Service Token principal は明示 mapping した REST 自動化の任意機能であり、DAV credential にはしない。CORS は公開せず、browser 由来の `Origin` 付き WebDAV request は同 origin を含め拒否する。

path は一回 decode・正規化後、D1 の再帰 CTE 一 query で解決する。KV cache は読み取り hint に限り、PUT / MOVE 等の前に current path、parent、revision、`space_generation` を primary で再検証する。client mtime は `nodes.client_mtime` に保持し、`X-OC-Mtime` を互換 header として受理するが `updated_at` とは分離する。

### 7.2 Class 1/2 意味論

対応 method は OPTIONS、PROPFIND、PROPPATCH、MKCOL、GET、HEAD、PUT、DELETE、COPY、MOVE、LOCK、UNLOCK。

- PROPFIND は空 body を `allprop` と扱い、`allprop`、`propname`、指定 `prop` を実装する。property ごとに `propstat` 200 / 404 を返す。Depth は 0/1、`infinity` は 403 `propfind-finite-depth`。
- PROPPATCH は document order で検証し、全 property を一 transaction で成功または失敗させる。protected live property は 403、依存失敗は 424、結果は 207。
- dead property は namespace と mixed content を保つ canonical XML として保存する。DTD / entity / external entity を無効化する。XML body 1 MiB、nesting 32、property 256、各値 64 KiB を v1 上限とする。
- collection URL の末尾 `/` を canonical とし、必要なら 301 / Content-Location で揃える。Destination は同一 host、`/dav/` prefix、正規化後 path のみ許可する。
- COPY の Depth は file=0、collection=0/infinity、MOVE は infinity のみ。Overwrite `F` の既存先は 412、親不存在は 409、lock は 423、quota は 507。
- 成功 status は新規 201、置換 204、multi-status 207。事前検査できない子単位失敗は 207 で返し、依存子の冗長な status は省く。同期予算を超える collection COPY は mutation 前に 507 とし、Web UI bulk job を案内する。
- REST Problem Details と WebDAV XML error は共通内部 error から別々に変換する。未知 XML 要素は RFC に従い無視または 400 とし、namespace を失わない。

### 7.3 `LockDO(spaceId)`

- 単位は保存先 owner user ID。SQLite に token、principal、normalized URI、depth、timeout、expires_at を永続化し、alarm に依存せず各 request で expiry を検査する。
- exclusive write lock のみ、timeout 最大 1h。`Depth: 0|infinity`、LOCK refresh、`supportedlock`、`lockdiscovery` を実装する。
- 未存在 URL への LOCK は parent の作成権限・lock・quota を検査して空 file node（lock-null resource）を作り、lock を付ける。
- `If:` header は tagged / untagged list、`Not`、複数 condition list、ETag と lock token の論理を RFC 4918 に従って評価する。不正構文は 400、条件不成立は 412 / 423。
- refresh / UNLOCK は一致する token と取得時 principal / credential を要求し、失効 token は再利用しない。管理 recovery は別の監査付き操作とする。
- ancestor の Depth infinity、作成先 parent、COPY/MOVE Destination の lock を検査する。read-only principal の write LOCK は拒否する。
- lock は URI 名前空間の意味論であり、MOVE 元の lock を移動先へ引き継がない。成功時に元 URI lock を終了し、Destination には既存 lock 以外を新設しない。
- REST、WebDAV、upload complete、Queue consumer はすべて `fsMutation` を通るため、WebDAV 以外からも lock を迂回できない。

---

## 8. 共有

### 8.1 capability と失効

link token は 128-bit 以上の CSPRNG とし、D1 には hash を保存する。capability は share root とその有効な子孫、action、expiry、`share_version` に限定する。password / permission / root / expiry の変更、revocation では version を進める。

unlock Cookie / ticket は `share_id, share_version, exp, kid` を含む署名済み値とし、`HttpOnly; Secure; SameSite=Lax`、短い Max-Age を使う。`/s/*` と `/api/v1/public/*` の双方で必要な Cookie は host-only・`Path=/` とし、private route は解釈しない。1値 2 KiB、同時 unlock 16 shares を上限として古い値を消去し、key rotation は `kid` で行う。現在の D1 share 状態を重要操作ごとに照合し、KV の古い値だけで許可しない。

### 8.2 公開 page、cache、download session

- password 保護 share の未認証 SSR / OG は汎用 title と説明だけを返し、名前、size、thumbnail を漏らさない。`X-Robots-Tag: noindex`。
- 認証依存 JSON / HTML は `Cache-Control: no-store`。share content / thumb は `private, max-age=300` 程度とし、version を URL / validator に含める。
- `download_count` は **download ticket 発行数**と定義し、UI も「最大ダウンロードセッション数」と表示する。ticket は `share_id, share_version, blob_id` または固定 ZIP manifest、expiry を持つ。
- ticket 発行時に上限を原子的に消費し、同じ ticket の Range / retry は追加計上しない。HEAD、304、失敗、thumb は数えない。folder は file ticket または ZIP manifest ticket 一件として数える。
- 後続 request でも share 失効・node 削除を検査する。ただし既に受信・cache 済みの bytes や開始済み response の完全回収は保証しない。

### 8.3 upload-only と内部共有

- upload-only は新規受取のみ。list、read、overwrite、任意 node ID、rename、delete を禁止し、server が衝突回避名を決める。
- file size、件数、累積 bytes、同時 session、rate limit、owner quota を全て適用する。v1.1 の app 内通知までは owner の activity / inbox で受領を確認する。
- internal share は `read|edit`。受領 / 辞退 / 再共有と group share は v1.1。v1 は owner だけが共有を作成し、受け手は UI で非表示にできる。
- WebDAV は予約 prefix `/dav/Shared/<stable-mount>/` に mount する。作成した内容は保存先 owner の space / quota に属する。
- trash 移動時は `shares.disabled_reason='trashed'` とし、復元で自動再有効化しない。owner の明示操作で version を進めて再有効化する。

---

## 9. Web UI

**stack**: React、TypeScript、Vite、Tailwind CSS、shadcn/ui、TanStack Router / Query / Virtual。依存採用時は bundle、license、Worker/browser 対応を固定する。

- 左 navigation（My Drive、Shared、Recent、Starred、Trash、quota）、command bar、grid/list、details pane、upload panel を基本 layout とする。
- `starred` と recent は `user_node_state` から取得し、共有相手へ状態を伝播させない。
- name conflict は「置換 / skip / 別名」を選べる。restore 先選択、bulk job ID、進捗、cancel、失敗再試行、結果一覧を提供する。
- optimistic update は revision 競合時に rollback し、412 の内容を表示する。Idempotency-Key を browser reload 後も再利用する。
- virtual list は screen reader 用の総数・位置、roving focus、非 virtual fallback を持つ。touch selection、低性能端末、reduced motion、AA contrast、upload 中の離脱警告を受入条件にする。
- PWA は versioned shell asset だけを cache し、認証 response、API JSON、file、share page/content は既定で保存しない。logout 時に Service Worker cache、TanStack Query、memory credential を消す。
- font は同梱または system font、avatar は initials または R2 管理画像とし、外部 CDN / Google avatar を取得しない。
- PDF / video thumbnail は best effort。未生成でも generic icon で正常動作する。

---

## 10. サムネイル、プレビュー、内容配信

### 10.1 queue と派生物

D1 の blob 確定と同じ batch で outbox に記録し、dispatcher が Queue へ送る。

```json
{"jobId":"…","nodeId":"…","blobId":"…","variant":"s256","generatorVersion":1}
```

派生物 key は `u/<ownerId>/t/<blobId>/<variant>-g<generatorVersion>.webp`。consumer は個別 ack / retry し、重複を冪等化する。結果反映時に node が未削除かつ `current_blob_id == blobId` を検証し、古い結果で current thumb を上書きしない。pending 修復 job、DLQ 閲覧・再投入 API、恒久失敗 metric を用意する。

### 10.2 生成上限

- Images binding 入力は **20 MB 以下**。形式・pixel・frame 上限も header から事前判定する。
- WASM fallback は **8 MiB 以下かつ 12 MP 以下**の静止画像だけ。入力 header が安全に読めない画像、容量超過、未対応、不正、Images の契約起因失敗を無条件に WASM へ流さない。
- Queue batch は配信単位であり、画像 decode は原則一件ずつ行う。animated image は先頭 frame のみ、frame 数上限を超えれば unsupported。
- 超過・未対応は `status='unsupported'`、decode / transform 失敗は `failed`。`none|pending|ready|failed|unsupported|not_generated` を区別する。
- EXIF / GPS / comment は派生物から除去し、WebP へ再 encode する。

### 10.3 client-generated thumbnail

PDF / video は UI が必要範囲だけ取得して生成できる。POST は write 権限、node ID、blob ID、generator version を検証し、read-only principal の生成物を正式 thumb にしない。server は MIME、magic、dimensions、size を検査し、Images があれば再 encode する。WebDAV upload 直後に thumb がないことは正常系とする。

### 10.4 preview の security boundary

推奨構成では生 content を別 host `CONTENT_HOST`（例: `files.example.com`）の配信 Worker から、短命 authorization ticket で返す。アプリ origin から script 実行可能な content を返さない。

単一 host fallback は HTML / JS / SVG / Markdown raw HTML / CSV 等を `Content-Disposition: attachment`、`nosniff`、厳格 CSP で返す。preview iframe は別 origin を優先し `sandbox` と `frame-ancestors` を surface 別に設定する。Markdown は raw HTML と危険 URL scheme、外部 image を禁止し、name、note、XML property は出力 context ごとに escape する。

---

## 11. 回収箱、世代、GC、バックアップ

### 11.1 回収箱状態機械

- delete は `trash_ops(id,actor_id,root_node_id,created_at,purge_after,state)` を作り、root を先に不可視化する。同じ operation で **未削除の子孫だけ**に `deleted_at/deleted_op_id` を設定し、以前に削除済みの node は変更しない。
- 大きな tree は ancestor の active trash op でも不可視と判定し、cursor/checkpoint 付き job で子孫を処理する。request / job 再開で同じ node を二重計上しない。
- restore はその `deleted_op_id` に属する node だけを戻す。元親が削除済み、回収箱内、別 owner の場合は root 直下または user 指定の有効 folder へ戻す。名前衝突 policy を適用する。
- purge は固定 manifest を作り、share、node_props、thumb、node_versions、current blob 参照、node、quota の順で冪等処理する。`shares.node_id` / `node_props.node_id` は `ON DELETE CASCADE` だが、外部 object 削除前に D1 manifest と参照減算を確定する。
- `trash_retention_days=0` は delete 完了直後に purge job を enqueue し、毎時 Cron だけに依存しない。

### 11.2 内部世代保持

current から外れた blob は `node_versions` に保存し、各 node の直近 10 世代または 30 日以内を保持する。削除対象は「10 世代の外かつ 30 日より古い」ものだけ。version pruning は ref count を減らして GC candidate を作る。v1 では user UI / restore API は提供せず、運用復旧にだけ利用する。

### 11.3 GC ledger

- ref count が 0 になった blob を `gc_candidates` に記録し、**7 日の猶予**後に再検証してから R2 を削除する。
- 削除直前に primary D1 で current、versions、uploads、outbox、thumb / backup 区分を再確認する。D1 read failure は「参照なし」と解釈せず retry する。
- R2 削除成功後に blob row と課金 `used_bytes` を一度だけ確定する。R2 delete 後に D1 外部キーで失敗する順序を禁止する。
- 通常 GC は操作台帳を使う。全 R2 list は週次 `0 3 * * SUN` UTC の修復 job だけで行い、cursor を保存する。
- `settings.gc_paused=true`、backup / restore 実行中、schema 不整合、D1 障害時は GC を開始しない。旧 fence の worker は削除権限を失う。

### 11.4 D1 backup と復旧

- 日次 Cron は application-level の `wrangler d1 export` 相当 JSON / SQL export を keyset と mutation high-watermark で再開可能に生成し、manifest、schema version、件数、checksum と共に R2 `_meta/backups/YYYY/MM/DD/<runId>/` へ保存する。CLI 自体を Worker 内で実行するという意味ではない。
- export 中に変化した行は mutation journal / watermark で再走査し、manifest 検証に成功した generation だけを complete とする。保持・暗号鍵・R2 jurisdiction は deploy policy に従う。
- v1 目標は **RPO 24h、RTO 手動**。D1 Time Travel を第一選択、日次 export を第二選択とする。
- 復旧開始時に `gc_paused=true`、mutation を maintenance mode にし、D1 restore、schema migration、R2 blob 存在確認、ref count 再計算、未完了 operation / upload / outbox の調停を行う。照合完了前に GC を再開しない。
- R2 だけから論理名前空間を再構築できるとは主張しない。secret、Access / Wrangler 設定は別の管理者 backup から再投入し、DO の lock は失効、未完了 upload は照合または abort する。
- RPO 24h は誤操作・D1 障害の目標であり、同一 Cloudflare account 全体の侵害・削除には耐えない。IaC と key recovery material は account 外で管理し、別 account R2 複製は v1.1 の運用 option とする。
- restore drill と、Time Travel 後に正しい blob が GC されないことの試験を release gate とする。

---

## 12. 検索

```text
node_search(node_id, name_norm, name_bigram)
node_search_fts: FTS5 external content = node_search
```

- 保存名は NFC。検索用 `name_norm` は NFKC + Unicode casefold + かな統一（カタカナ→ひらがな）とし、保存名を変更しない。
- query も同じ正規化を行い、bigram を **候補抽出**に使った後、`name_norm` で文字順・連続性を最終照合する。利用者入力を FTS query language として解釈せず、token を生成・escape する。
- 1文字は許可された folder / owner scope に限定した LIKE fallback とし、candidate / scan 上限を設ける。D1 の LIKE pattern 50 bytes 上限を超える pattern は分割または拒否する。
- filter は extension、MIME 群、size、date、owner / sharer、star、trash を提供する。共有検索は許可 root の有効な子孫へ join し、snippet / 件数でも範囲外情報を漏らさない。
- trigger / outbox で `node_search` と FTS を同期し、不一致検出、rebuild、migration を管理 job にする。
- staging で node 数、平均 name 長、日本語比率別に DB 全体 / FTS 増分、rows read、p95、rename/delete、rebuild、誤検出を測る。保存済み検索は v1.1、本文検索 / OCR は非目標。

---

## 13. 制限、セキュリティ、監査、運用費

### 13.1 Cloudflare 制限値表

契約・公式仕様の変更を release ごとに確認する。HTTP 上限は十進 **MB**、アプリ内部 / R2 part は二進 **MiB / GiB** で表記する。

| 項目 | 確認値・設計への反映 |
|---|---|
| Worker request body | Workers Paid とは別。Free / Pro 100 MB、Business 200 MB、Enterprise は現行表でセルフサービス最大 5 GB。実 zone を確認し、既定 `MAX_REQUEST_BYTES=95 MB`。 |
| Worker memory | 128 MB / isolate（request 単位ではない、WASM を含む）。同時 decode を避ける。 |
| Worker HTTP CPU | Paid 既定 30s、設定最大 300s。transfer wall time と CPU は別。公開 API 全体へ無差別に 300s を与えない。 |
| Worker subrequests | Paid 現行表 10,000 / invocation。D1 query limit と分離して予算化する。 |
| 同時外向き connection | 6。response header 待ちの大量並列開始を避け、runtime で実測する。 |
| R2 multipart | 最大 10,000 parts、公称 5 MiB–5 GiB / part、最終以外同サイズ、最終だけ小さくできる。v1 は 8–90 MiB。 |
| R2 object size | 公称約 5 TiB、脚注は 5 TiB−5 GiB。厳密境界は API 別に要確認。v1 は 500 GiB。 |
| R2 same-key write | 同一 key は毎秒 1 write の記載。不変 blob / versioned derivative key で競合を避ける。 |
| R2 list / delete | list 最大 1,000（metadata 量で減少可）、delete 最大 1,000 keys / call。cursor を保存する。 |
| D1 DB | Paid 10 GB / DB、増枠不可。FTS、index、activity も含む。 |
| D1 row count | 固定の最大行数はないが、10 GB / DB と各 query 制限を受ける。 |
| D1 row / value | string / BLOB / row 最大 2,000,000 bytes。query result 全体 2 MB という意味ではない。 |
| D1 SQL | SQL 100,000 bytes、bind parameter 100 / query、LIKE/GLOB pattern 50 bytes、query 30s。 |
| D1 invocation | Paid 1,000 queries / Worker invocation。Worker subrequest と別。 |
| D1 result total | 今回確認した Limits では固定総量を確定できず要確認。keyset と response 上限を常に設ける。 |
| D1 transaction | `batch()` は transaction だが、JS / R2 I/O を挟む対話 transaction ではない。 |
| DO SQLite | Paid 10 GB / object。single-threaded でも外部 I/O 全体の自動排他ではない。 |
| DO CPU / blocking | CPU 既定 30s、最大 300s。`blockConcurrencyWhile()` callback は別途 30s timeout。長い転送を囲まない。 |
| Queues message | 128 KB（KB=1,000 bytes、内部 metadata 込み）。内容 / 巨大 manifest を送らない。 |
| Queues batch | consumer 最大 100 messages、`sendBatch` 最大 100件または 256 KB。consumer は一件ずつ重い処理をする。 |
| Queues delivery | at-least-once、Paid retention 最大 14日。outbox と idempotency 必須。 |
| Queues runtime | wall 最大 15分、CPU 既定30s〜最大300s。 |
| Cron | UTC、曜日 1–7 のため `SUN` 表記。Paid 250 triggers / account、wall 最大15分。CPU は実行間隔 1h 未満なら 30s、1h 以上なら最大15分の別枠。 |
| Images binding | `.input()` 最大 20 MB。Free は月 5,000 unique transformations、超過時に新規変換失敗。Workers Paid と別。 |
| Images formats | HEIC / AVIF 等は format と契約依存。対象 account、codec、Wrangler/local 対応を staging で確認する。 |

### 13.2 surface 別 CSRF / CSP

- Cookie based private REST mutation: strict Origin allowlist + `X-Requested-With`。GET で mutation しない。
- WebDAV: Cookie auth なし、CORS 非公開、`Origin` 付き request を拒否。Basic / mapped Service Token の明示 credential に限定する。
- share SSR form: one-time CSRF token + Origin 検証。custom header を要求しない。
- app CSP、share landing CSP、untrusted preview iframe CSP を別定義する。共通で `nosniff`、適切な `frame-ancestors`、`Referrer-Policy: no-referrer`。
- MIME は sniff 結果を優先し、危険形式は attachment。R2 / content host への public direct URL を発行しない。

### 13.3 audit とログ

- `activity` は application principal に対して append-only。Cloudflare account 管理者 / D1 管理者は信頼境界内であり、その者への暗号学的改竄耐性は v1 の保証外と明記する。
- D1 の activity は既定 90 日、日次で R2 `_meta/activity/` へ archive し、既定 1 年保持する。必要なら hash chain / 署名を v1.1 で検討する。
- log / trace / exception / analytics で Authorization、Cookie、app password、share password、CSRF、ticket、token を mask し、URL の `/s/<token>` と public path token も置換する。
- CSV export は RFC 4180 quote に加え、先頭が `=`, `+`, `-`, `@`, tab, CR の cell に `'` を付けて formula injection を防ぐ。

### 13.4 監視

D1 size / latency / rows read、Queue backlog / oldest / DLQ、outbox age、UploadDO state anomaly、active reservation、R2 GC candidate / orphan、quota 差分、trash backlog、reclaimed bytes、429 / 411 / 413 / 507、thumbnail failure、CPU / memory / subrequest、backup age / restore drill、Access unauthenticated smoke test を監視する。

### 13.5 月次費用試算

単価は変動するため、release 時の公式単価を `P_*` として deploy worksheet に固定し、included allowance 控除後に計算する。Workers Paid 基本料だけを総費用と表現しない。

| service | 想定量 / 月（基準ケース） | 単価変数 | 月額式 |
|---|---:|---:|---:|
| R2 storage | 500 GB-month | `P_R2_GB` | `500 × P_R2_GB` |
| R2 Class A | 10 million ops | `P_R2_A_M` | `10 × P_R2_A_M` |
| R2 Class B | 100 million ops | `P_R2_B_M` | `100 × P_R2_B_M` |
| D1 storage | 8 GB-month | `P_D1_GB` | `max(0, 8-included) × P_D1_GB` |
| D1 rows read | 5 billion | `P_D1_READ_B` | allowance 控除後 × 単価 |
| D1 rows written | 20 million | `P_D1_WRITE_M` | allowance 控除後 × 単価 |
| Images | 50,000 unique transforms | `P_IMG_K` | `max(0,50,000-5,000)/1,000 × P_IMG_K` |
| Durable Objects | 10 million requests + 1 million GB-s | `P_DO_REQ_M`, `P_DO_GBS_M` | `10×P_DO_REQ_M + 1×P_DO_GBS_M` |
| Queues | 3 million billable operations | `P_QUEUE_M` | allowance 控除後 × `P_QUEUE_M` |

基準、低利用、高利用の三ケースを staging telemetry から更新し、thumbnail 再生成、download Range、GC / backup の operation も含める。

---

## 14. 設定、デプロイ、Cron / job

### 14.1 Wrangler 方針

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
  "ratelimits": [
    { "name": "RL_SHARE", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }
  ],
  "triggers": { "crons": ["17 * * * *", "23 2 * * *", "0 3 * * SUN"] },
  "observability": { "enabled": true }
}
```

`unsafe.bindings` は使わない。development / staging / production の D1、R2、KV、DO、Queues、Access app を完全分離する。Images 有り・無しを別 environment にし、binding 不足を runtime fallback で隠さない。

vars: `ACCESS_AUD`、`ACCESS_TEAM_DOMAIN`、`OWNER_EMAILS`、`CONTENT_HOST`、各上限、retention、feature flags。secrets: `APP_PASSWORD_HMAC_KEY`、share cookie key ring、必要な service credential。識別子を secret と誤記しない。

`DEV_BYPASS_ACCESS` は local test のみ。本番 build / environment に存在したら CI と Worker startup の双方を失敗させる。

### 14.2 job lease と schedule

```sql
CREATE TABLE job_leases (
  job TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  fence INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  checkpoint TEXT
);
```

D1 の条件付き UPDATE で lease を取得し、取得ごとに fence を増やす。全副作用は現在 fence を照合し、期限切れの旧実行を排除する。KV mutex は使わない。

| schedule (UTC) | job |
|---|---|
| `17 * * * *` | trash purge、expired upload / share、outbox repair を予算内で進める |
| `23 2 * * *` | D1 application export、activity archive |
| `0 3 * * SUN` | R2 全走査による低頻度 repair / orphan reconciliation |

全 job は cursor / checkpoint、operation ID、冪等な状態遷移を持つ。node 数、blob 数、D1 / R2 API calls、CPU / wall time を別々に予算化し、backlog、oldest item、reclaimed bytes を記録する。

### 14.3 deploy gate

Access policy は `routes.ts` から生成・差分検査する。deploy 後に認証なしで private SPA / API が 401/403、public share / DAV が期待する Worker response、未知 public route が 404 になることを実 HTTP で確認する。R2 public access、workers.dev、preview URL、想定外 domain も検査する。

---

## 15. テスト計画と受入基準

### 15.1 通常試験

- Unit / integration: Vitest + Cloudflare Workers test pool。tree 不変条件、`authorize` 全 matrix、`fsMutation`、quota、state machine、検索正規化、XML parser を property-based / table-driven test する。
- WebDAV: litmus の basic / copymove / props / locks、rclone、cadaver、Finder、Explorer。case-only rename、sidecar、末尾 slash、lock-null、複合 `If:` を含む。
- E2E: Playwright で upload、reload resume、share、trash、restore、search、bulk cancel、logout cache clear、keyboard / touch / accessibility。
- 性能: 10万 node より大きい実データも使い、D1 size、FTS 倍率、p95、rows read、folder stats、GC throughput を測る。
- security: route boundary、CSRF、CSP、content host、path traversal、double decode、XML entity、MIME sniff、rate limit、log masking、CSV injection。

### 15.2 障害境界の必須受入試験

Astra M-17 の一覧をそのまま release gate にする。

- R2 成功直後、D1 確定直前の停止。
- D1 確定後、応答前の停止と再試行。
- complete／abort／期限切れの競合。
- 同名作成、同一ファイル上書き、相互 MOVE の競合。
- LOCK と REST 書き込みの競合。
- 内部共有取り消しと、進行中アップロード。
- 古い share Cookie、古い KV、古い JWT key。
- 削除済み子を持つ親の削除・復元。
- D1 Time Travel 後の R2 照合と GC 停止。
- パージ途中の再起動、外部キー制約。
- サイズ虚偽、パート欠落、重複、異なるサイズの再送。
- 4 GiB超 ZIP、画像展開爆弾、遅いダウンロード、切断。
- Access を誤って Bypass しても private API が閉じること。

### 15.3 staging 実クラウド実測

Miniflare だけでは合格にしない。分離した staging で次を実測する。

- zone の body 上限、95 MB / 90 MiB 境界、edge 413、411、専用 browser / API test client（WebDAV rclone ではない）による multipart 100 GB 級、10,000 part 計算。
- Access JWT の array audience、unknown kid / JWKS rotation、IaC Bypass、workers.dev / preview / R2 非公開。
- D1 primary / Sessions、100 bind、30s、DB / FTS 容量、Time Travel、日次 export restore。
- R2 multipart complete / abort、list / delete pagination、stream backpressure、immutable key reconciliation。
- DO restart、SQLite persistence、fencing、外部 I/O 競合、6 outbound connections。
- Queue 重複、outbox dispatcher failure、DLQ requeue、15分 wall / CPU budget。
- Images 20 MB、codec / contract、WASM 8 MiB / 12 MP の peak isolate memory、PBKDF2 300k latency。
- WebDAV 実 client、CONTENT_HOST / single-host CSP、PWA cache、ログ mask。

---

## 16. 実装フェーズ

1. **Foundation / invariants**: monorepo、route manifest、environment 分離、D1 schema、principal / 操作許可表、`fsMutation`、operation state machine、不変 blob / generation、quota reservation、Access bootstrap、failure injection harness。
2. **Files core**: root / tree 不変条件、metadata revision、単発 upload / content、Range、rename / move、COW copy、user state、name policy。
3. **Multipart**: UploadDO 永続 state machine、browser resume、checksum、abort / reconciliation、upload-only limits。
4. **Trash / versions / backup**: trash op、manifest purge、internal generation、GC ledger、D1 export / Time Travel drill。
5. **Search / stats**: `node_search` + FTS bigram、filters、folder async aggregation。
6. **Thumbnail / preview**: outbox、Queue、Images / WASM budgets、client generation、CONTENT_HOST。
7. **Sharing**: link capability、password、download ticket、internal share、public receive。
8. **WebDAV**: Class 1 semantics → litmus、Class 2 / LockDO、real client matrix。
9. **Admin / operations / polish**: activity archive、job / DLQ UI、cost metrics、PWA、i18n、a11y、staging acceptance。

Foundation で認可表、操作状態機械、blob 世代、予約クォータを確定しない限り Files core へ進まない。各 phase は独立 PR とし、lint、typecheck、unit、relevant integration、migration test を必須にする。

---

## 17. 機能提供ロードマップ

| 考慮項目 | 判定 | 内容 |
|---|---|---|
| ファイル履歴と上書き復旧 | v1 / v1.1 | v1 で内部世代を保持、v1.1 で履歴 UI / user restore。 |
| 同期衝突 | v1 | ETag / revision 競合は 412。conflicted copy は作らない。 |
| 差分同期・変更 token | v1.1 | `sync-collection` 等を検討。v1 は paged PROPFIND で、大規模同期性能を保証しない。 |
| mtime / checksum 互換 | v1 | `client_mtime`、`X-OC-Mtime`、declared / verified SHA-256 を分離。 |
| team folder / group share | v1.1 | 個人 owner から独立した共同 space、group、退職時移譲。 |
| share 受領・辞退・再共有 | v1.1 | app 内通知、辞退、再共有 permission。v1 は非表示のみ。 |
| 公開受取の運用 | v1 / v1.1 | v1 で上限・衝突回避・activity、v1.1 で app 内通知 / 受領 flow。 |
| app credential 管理 | v1 | expiry、device、ro/rw、folder scope、最終使用、全失効。 |
| user 停止・削除・移譲 | v1 | `disabled_at`、credential / job 停止、owner 移譲、最後の owner 保護。 |
| import / export | v1.1 | 論理 path と metadata を保つ user export、管理 import。R2 直接書込は禁止。 |
| 大量操作の進捗 | v1 | job ID、進捗、cancel、retry、結果、Idempotency-Key。 |
| folder 集計 | v1 | 件数・bytes を非同期集計し、「計算中」と freshness を表示。 |
| 実用検索 | v1 / v1.1 | v1 は名前・拡張子・owner / sharer・filter、v1.1 は保存済み検索。本文 / OCR は非目標。 |
| 通知 | v1.1 | app 内のみ。email / push 外部配信は非目標。 |
| malware 検査 | 非目標 | v1 は size / type / rate / 公開停止だけ。未検査であることを管理画面に明示。 |
| データ所在地 / 管理者閲覧 | v1 | R2 jurisdiction 設定で対応。管理者閲覧権限と activity を明示し、support access を監査。 |
| backup 保証 | v1 | RPO 24h / RTO 手動。D1 Time Travel + 日次 export、R2 不変 blob。secret / DO の範囲を明示。 |

---

## 18. 未決事項 / 次ラウンドで検証する点

### 18.1 ラウンド1の旧 §17 への確定回答

| 旧項目 | v0.2 の決定 |
|---|---|
| 不透明 R2 key | 採用。node / blob を分離し、D1 を名前空間の正本とする。直接 rclone 復元は不可、日次 backup 必須。 |
| WebDAV 認証 | v1 `/dav` は app password の Basic のみ。Service Token principal は任意の REST 自動化用途として分離する。 |
| 日本語 bigram | v1 の候補抽出として採用し、`name_norm` で最終照合。実効規模は staging で測定。 |
| PDF / video thumbnail | client best-effort を採用。WebDAV 直後の未生成を正常系とし、入力を検証。 |
| 100 GB 級 file | Web UI multipart では対応可能。通常 WebDAV は 95 MB まで。既定 part は 64 MiB、v1 最大 500 GiB。 |
| download count | download ticket 発行数。Range / retry は同一 ticket で追加計上しない。 |
| Access Bypass fail-safe | Worker の中央認証を必須とし、route manifest、no public shell、domain/R2閉鎖、deploy後未認証 test を追加。 |

### 18.2 次ラウンド / staging で確定する点

1. 対象 account の zone body 上限、edge 413 の応答、Enterprise / R2 上限脚注の実境界。v1 の公称値は確認にかかわらず 95 MB / 500 GiB を越えない。
2. Images binding の契約、HEIC / AVIF / animated format、Wrangler local support。不可なら unsupported とし、WASM 上限を緩めない。
3. WASM 8 MiB / 12 MP、PBKDF2 300k、thumbnail consumer 一件処理の peak memory / CPU 実測。
4. D1 FTS の index 倍率、10 GB 内での実用 node 数、1文字 fallback、rebuild 時間。固定件数を実測前に約束しない。
5. 日次 application export の mutation watermark 整合性と、Time Travel / export 双方からの復旧演習。
6. Finder / Explorer / rclone の `.DS_Store` / `._*`、case-only rename、lock-null、複合 `If:` の実機差。非互換は support matrix に明記する。
7. 推奨 `CONTENT_HOST` 構成の運用性。単一 host は attachment + nosniff + strict CSP の制限 mode のままにする。
8. release 時公式単価による低・基準・高利用の費用 worksheet。Workers Paid 基本料だけを予算としない。
9. ZIP64 writer と専用 CLI 大容量 client は v1.1 候補。検証完了までは通常 ZIP / WebDAV の v1 上限を変更しない。
10. Service Token、差分同期、version history UI、team space、通知、import/export の v1.1 詳細仕様。
