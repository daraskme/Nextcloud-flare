# Next-cloud-flare — 設計・実装方針 (v0.1 draft)

Cloudflare のサービスだけで完結する、Google Drive / Nextcloud ライクなセルフホスト型ストレージ管理アプリ。
参考実装: [Davflare](https://github.com/fanchenggang/Davflare) (Pages Functions + React + R2)、[R2-Explorer](https://github.com/G4brym/R2-Explorer) (Workers + Hono + Vue/Quasar + R2)。

> ステータス: ドラフト。Astra による 5 往復のレビュー（通常レビュー / 敵対的レビュー / 検証）を経て確定し、Sol が実装する。

---

## 0. ゴールと非ゴール

### ゴール
- **Cloudflare 完結**: Workers, R2, D1, KV, Durable Objects, Queues, Cron Triggers, Cloudflare Access(Zero Trust), Workers Static Assets のみ。外部 SaaS/サーバ不要。
- **Zero Trust 認証**: Cloudflare Access + 既存 Google IdP。アプリはパスワードを一切持たない。
- **必須機能**: Web UI / WebDAV / 期限付き・リンク共有 / 回収箱 / 検索 / 分塊(マルチパート)アップロード / プレビュー / サムネイル。
- **追加機能** (必要と判断したもの): 複数ユーザー＆個人スペース、フォルダ共有(内部)、お気に入り・最近使用、アクティビティログ、クォータ、フォルダ ZIP ダウンロード、アプリパスワード(WebDAV 用)、レート制限、ファイルバージョン(任意/後段)、Workers AI による画像タグ検索(任意/後段)。
- **UI**: モダンで洗練された見た目 (詳細 §9)。

### 非ゴール (v1)
- 同時編集(Office/Collabora 相当)、E2E 暗号化、リアルタイム同期クライアント(デスクトップ同期は WebDAV 経由で代替)。
- 無料プランでの動作保証。**Workers Paid ($5/mo) 前提**（Queues, DO, CPU 時間, 100MB 超のリクエストボディ緩和のため）。

---

## 1. Cloudflare サービス選定と役割

| 役割 | サービス | 理由 / 代替案との比較 |
|---|---|---|
| API / WebDAV / 共有ページ | **Workers** (Hono, TypeScript) | Pages Functions (Davflare) より Cron/Queues/DO/Static Assets を一つの `wrangler.jsonc` で扱いやすい。R2-Explorer と同じ Hono を採用。 |
| SPA 配信 | **Workers Static Assets** (`assets.directory = "dist/web"`, `not_found_handling = "single-page-application"`) | 追加サービス不要、`run_worker_first` で `/api/*`, `/dav/*`, `/s/*` を Worker に渡す。 |
| ファイル本体 | **R2** (バケット 1 つ) | オブジェクトキーは **不透明 ID** (`u/<userId>/o/<objectId>`)。パス構造は D1 側で持つ → rename/move が O(1)、大量ファイルの階層移動が R2 コピー不要になる。Davflare/R2-Explorer はパス=キーのため move がコピー＋削除。 |
| メタデータ | **D1** (SQLite) | ファイル木、共有、回収箱、ロック、監査、クォータ。FTS5 で名前検索。Davflare の「R2 全走査で検索」「JSON をバケットに散在保存」を回避。 |
| WebDAV ロック / アップロードセッション | **Durable Objects** (SQLite backed) | 強整合が必要な LOCK/UNLOCK とマルチパートの part 記録を DO に置き、D1 の競合を避ける。 |
| サムネイル・派生物生成 | **Queues** + (Cloudflare **Images binding** があれば使用、なければ WASM `@jsquash` フォールバック) | アップロード完了→Queue→非同期生成。失敗時は再試行/DLQ。 |
| 短命キャッシュ | **KV** | Access JWKS キャッシュ、共有トークンの解決キャッシュ、機能フラグ。 |
| 定期処理 | **Cron Triggers** | 回収箱の期限パージ、失効共有の掃除、未完了マルチパート abort、孤立オブジェクト GC。 |
| 認証 | **Cloudflare Access** (Self-hosted app、Google IdP) | UI/API は Access 必須。`/s/*`(公開共有) と `/dav/*`(アプリパスワード認証) は **Bypass ポリシー**または別 Access アプリで除外。 |
| レート制限 | **Workers Rate Limiting binding** | 共有ページのパスワード試行、WebDAV 認証失敗、API 乱用の抑止。 |
| 監視 | Workers Logs / Analytics Engine (任意) | 構造化ログ (`console.log(JSON)`)。 |

---

## 2. 全体アーキテクチャ

```
Browser (SPA: React + Vite + Tailwind)          WebDAV client (Finder/Explorer/rclone)
        │  Cloudflare Access (Google IdP)                 │  Basic auth (app password)
        ▼                                                 ▼
┌────────────────────────── Worker (Hono) ───────────────────────────┐
│  /api/*   REST+JSON        /dav/*  WebDAV Class 1/2    /s/:token 共有 │
│  middleware: access-jwt | app-password | share-token | ratelimit    │
│  services: fs(D1) · blobs(R2) · share · trash · search · thumbs     │
└───┬──────────┬──────────┬───────────┬──────────┬──────────┬────────┘
    │ D1       │ R2       │ DO:Lock   │ DO:Upload│ Queue    │ KV
    ▼          ▼          ▼           ▼          ▼          ▼
  metadata   blobs    webdav locks  multipart  thumbnail   jwks/cache
                                    sessions   consumer
                          ▲
                Cron: trash purge / share expiry / upload abort / orphan GC
```

### モノレポ構成 (pnpm workspaces)
```
Next-cloud-flare/
  package.json              # pnpm workspaces, scripts: dev/build/test/lint/typecheck/deploy
  wrangler.jsonc            # Worker + assets + bindings (D1/R2/KV/DO/Queues/Cron/Images/RateLimit)
  packages/
    worker/                 # Hono API + WebDAV + share + queue consumer + cron
      src/index.ts          # export default { fetch, queue, scheduled }
      src/auth/             # access.ts (JWT/JWKS), appPassword.ts, principal.ts
      src/api/              # files.ts uploads.ts shares.ts trash.ts search.ts users.ts
      src/dav/              # router.ts propfind.ts lock.ts xml.ts
      src/share/            # public.ts (SSR HTML + range download)
      src/services/         # fs.ts blobs.ts thumbs.ts quota.ts audit.ts
      src/do/               # LockDO.ts UploadDO.ts
      src/jobs/             # queue.ts scheduled.ts
      migrations/           # D1 SQL migrations (drizzle-kit generate)
      test/                 # vitest + @cloudflare/vitest-pool-workers
    web/                    # React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui + TanStack Query/Router
    shared/                 # zod schemas / API types (worker と web で共有)
  docs/                     # DESIGN.md, ADR/, REVIEW_LOG.md
```

---

## 3. データモデル (D1)

主要テーブル (drizzle-orm で定義、`drizzle-kit generate` で migration 生成)。

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,               -- ulid
  email TEXT NOT NULL UNIQUE,        -- Access JWT の email (小文字正規化)
  access_sub TEXT UNIQUE,            -- Access JWT sub
  display_name TEXT, avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  quota_bytes INTEGER,               -- NULL = unlimited
  used_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_seen_at INTEGER
);

CREATE TABLE nodes (                 -- ファイル木 (ファイル & フォルダ)
  id TEXT PRIMARY KEY,               -- ulid
  owner_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES nodes(id),   -- NULL = ユーザールート
  name TEXT NOT NULL,                -- NFC 正規化、'/' 禁止、大小区別あり
  kind TEXT NOT NULL,                -- 'file' | 'dir'
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  r2_key TEXT,                       -- file のみ: u/<owner>/o/<id>
  etag TEXT,                         -- R2 httpEtag (WebDAV getetag / If-Match)
  sha256 TEXT,                       -- 任意 (クライアント計算 or 後段算出)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER,                -- 回収箱: NULL 以外なら trash
  trash_root INTEGER NOT NULL DEFAULT 0, -- 回収箱一覧に出す「削除操作のトップ」
  orig_parent_id TEXT,               -- 復元先
  thumb_status TEXT DEFAULT 'none',  -- none|pending|ready|failed|unsupported
  starred INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX nodes_parent_name ON nodes(owner_id, parent_id, name) WHERE deleted_at IS NULL;
CREATE INDEX nodes_parent ON nodes(parent_id, deleted_at);
CREATE INDEX nodes_trash ON nodes(owner_id, deleted_at) WHERE trash_root = 1;

CREATE VIRTUAL TABLE nodes_fts USING fts5(name, content='nodes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
-- INSERT/UPDATE/DELETE トリガーで同期

CREATE TABLE node_props (            -- WebDAV dead properties
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ns TEXT NOT NULL, name TEXT NOT NULL, value_xml TEXT NOT NULL,
  PRIMARY KEY (node_id, ns, name)
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,               -- ulid (内部)
  token TEXT NOT NULL UNIQUE,        -- 128bit random, base64url (URL 用)
  node_id TEXT NOT NULL REFERENCES nodes(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'link', -- 'link' | 'internal'(ユーザー間)
  grantee_user_id TEXT,              -- internal のとき
  permission TEXT NOT NULL DEFAULT 'read',  -- 'read' | 'upload'(フォルダへの受け取り) | 'edit'
  password_hash TEXT,                -- PBKDF2-SHA256 (WebCrypto) + salt, NULL = なし
  expires_at INTEGER,                -- NULL = 無期限
  max_downloads INTEGER, download_count INTEGER NOT NULL DEFAULT 0,
  allow_zip INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at INTEGER NOT NULL, revoked_at INTEGER, last_access_at INTEGER
);

CREATE TABLE app_passwords (         -- WebDAV / API 用
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL, username TEXT NOT NULL UNIQUE,  -- 例: hiroshi-macbook (ユーザーが指定)
  secret_hash TEXT NOT NULL,         -- PBKDF2-SHA256, 32byte random secret を1度だけ表示
  scope TEXT NOT NULL DEFAULT 'rw',  -- 'ro' | 'rw'
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);

CREATE TABLE uploads (               -- マルチパートセッション (DO と二重化: D1 は一覧/GC 用)
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL,
  r2_key TEXT NOT NULL, r2_upload_id TEXT NOT NULL, size INTEGER, mime TEXT,
  part_size INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'  -- active|completed|aborted
);

CREATE TABLE activity (              -- 監査/アクティビティ
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  actor_id TEXT, actor_kind TEXT NOT NULL,   -- user|app_password|share|system
  action TEXT NOT NULL,              -- upload|download|rename|move|delete|restore|purge|share.create|share.access|...
  node_id TEXT, share_id TEXT, detail TEXT   -- JSON
);
CREATE INDEX activity_actor_ts ON activity(actor_id, ts DESC);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- trash_retention_days, default_quota, allow_signup, ...
```

### R2 キー設計
- 本体: `u/<ownerId>/o/<nodeId>` — 名前変更/移動で R2 操作なし。
- サムネイル: `u/<ownerId>/t/<nodeId>/<variant>.webp` (variant = `s256`, `m1024`)。
- 一時: マルチパート中は同じ本体キーに直接書く (R2 は complete まで可視化されない)。
- **回収箱はキー移動なし** (`deleted_at` フラグのみ)。パージ時に R2 delete。→ Davflare の trash prefix コピーより速く安全。
- `customMetadata` には `nodeId`, `ownerId`, `sha256` を入れ、D1 消失時の再構築 (Admin の `rebuild-index` コマンド) に使う。

### 整合性ルール
- R2 が真、D1 は索引: 書き込みは **R2 成功 → D1 insert**、削除は **D1 mark → (パージ時) R2 delete → D1 delete**。
- 孤立 R2 オブジェクト (D1 に対応なし) は Cron の GC で `uploaded < now-24h` のものを削除。
- `used_bytes` は D1 トランザクション内で加減算 (`UPDATE users SET used_bytes = used_bytes + ?`)。週 1 の Cron で `SUM(size)` と突き合わせて補正。

---

## 4. 認証・認可

### 4.1 Web UI / REST API — Cloudflare Access
- Access アプリ (Self-hosted) を `drive.example.com` に作成、ポリシー: 既存 Google IdP + 許可メール/ドメイン。
- Worker は毎リクエスト `Cf-Access-Jwt-Assertion` ヘッダ (または `CF_Authorization` Cookie) を検証:
  - JWKS を `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` から取得し KV に 1h キャッシュ。
  - `aud` == `ACCESS_AUD` (env)、`iss` == team domain、`exp` を検証 (`jose` ライブラリ)。
  - 初回ログイン時に `users` に upsert (`email`, `sub`)。`settings.allow_signup=false` なら未登録メールは 403。
- **Access Bypass 対象パス**: `/s/*` (公開共有), `/dav/*` (アプリパスワード), `/api/public/*` (共有ページ用 JSON), `/.well-known/*`。Access 側で「Bypass」ポリシーの別アプリとして定義 (Terraform/API 例を `docs/deploy.md` に記載)。
- Worker 側でも **二重防御**: Access を通るべきルートで JWT が無ければ 401。Bypass ルートでも Access JWT が付いていれば通常ユーザーとして扱う (ログイン済みユーザーが自分の共有を見るときの UX 向上)。
- ログアウト: `/cdn-cgi/access/logout` へリダイレクト。

### 4.2 WebDAV — アプリパスワード (Basic auth over HTTPS)
- Access の Google ログインは WebDAV クライアントが通れないため、ユーザーは UI で **アプリパスワード**を発行 (`username` + 32byte ランダム secret、1 度だけ表示)。
- `/dav/*` は `Authorization: Basic` を PBKDF2 (100k iter) で検証。失敗はレート制限 (IP+username で 10/min)。
- 代替: Access **Service Token** (`CF-Access-Client-Id/Secret`) にも対応 (rclone 等ヘッダ設定可能なクライアント向け)。この場合 Access アプリ側で `/dav/*` を Service Auth ポリシーにする構成も文書化。
- スコープ `ro` は PROPFIND/GET/HEAD/OPTIONS/LOCK/UNLOCK のみ許可。

### 4.3 認可モデル
- 各 `node` は `owner_id` の個人スペース配下。アクセス判定は「owner 本人」or「`shares(kind='internal')` で祖先フォルダが grantee に付与」or「`shares(kind='link')` の token 経由」。
- 祖先解決は `WITH RECURSIVE` (深さ上限 64)。
- admin/owner ロール: 設定変更、ユーザー管理、クォータ、全体の回収箱パージ。

---

## 5. REST API (Hono + zod-openapi、`/api/v1`)

| Method | Path | 説明 |
|---|---|---|
| GET | `/me` | ユーザー情報、クォータ、機能フラグ |
| GET | `/nodes/:id` / `/nodes/root` | ノード詳細 |
| GET | `/nodes/:id/children?cursor&limit&sort` | 一覧 (keyset pagination, 200/page) |
| GET | `/nodes/:id/path` | パンくず |
| POST | `/nodes/:id/folders` `{name}` | フォルダ作成 (409 on conflict) |
| PATCH | `/nodes/:id` `{name?, parentId?, starred?}` | rename / move / star (If-Match 対応) |
| POST | `/nodes/copy` `{ids[], targetId}` | コピー (R2 copy、>5GB は multipart copy… v1 は 5GB 上限) |
| DELETE | `/nodes` `{ids[]}` | 回収箱へ (子孫も `deleted_at` を一括更新) |
| GET | `/nodes/:id/content?download=1` | 本体 (Range 対応、ETag/If-None-Match、`Content-Disposition`) |
| GET | `/nodes/:id/thumb?v=s256` | サムネイル (未生成なら 202 + Retry-After) |
| GET | `/nodes/:id/preview` | プレビュー用メタ (text 抜粋 / pdf ページ数 等) |
| POST | `/nodes/:id/zip` `{ids[]}` | ZIP ストリーミング (store 方式, `fflate` streaming) |
| POST | `/uploads` `{parentId,name,size,mime,sha256?}` | 単発 (<= 95MB) は同 API に `?direct=1` でボディ直接 PUT。それ以外はマルチパート開始 → `{uploadId, partSize, r2Key}` |
| PUT | `/uploads/:id/parts/:n` (body) | パート (partSize 固定、最後のみ短い) → `{etag}` |
| POST | `/uploads/:id/complete` `{parts:[{n,etag}]}` | 完了 → node 作成、Queue へサムネイル job |
| DELETE | `/uploads/:id` | 中断 |
| GET | `/uploads/:id` | 進捗 (DO から) — 再開用 |
| GET | `/trash?cursor` | 回収箱一覧 (`trash_root=1`) |
| POST | `/trash/restore` `{ids[]}` / `/trash/purge` `{ids[]?}` | 復元 / 完全削除 |
| GET | `/search?q&type&mime&from&to&cursor` | FTS5 名前検索 + フィルタ |
| GET/POST | `/shares` | 一覧/作成 `{nodeId, expiresAt?, password?, maxDownloads?, permission}` |
| PATCH/DELETE | `/shares/:id` | 更新/取り消し |
| GET/POST/DELETE | `/app-passwords` | WebDAV 用 |
| GET | `/activity?cursor` | アクティビティ |
| GET/PATCH | `/admin/settings`, `/admin/users` | 管理 |
| GET | `/public/shares/:token` (Access bypass) | 共有メタ (`passwordRequired`, `isDir`, name, size) |
| POST | `/public/shares/:token/unlock` `{password}` | → 短命 Cookie (HMAC 署名, 1h) |
| GET | `/public/shares/:token/children`, `/content`, `/zip`, `/thumb/:nodeId` | 共有内容 |

エラーは RFC 9457 Problem Details (`application/problem+json`)。全 mutation は `activity` に記録。

---

## 6. アップロード (分塊/マルチパート)

- クライアント (Web UI): `size <= 95MiB` → 単発 PUT。それ以上 → マルチパート。
  - `partSize`: サーバが決定。`max(8MiB, ceil(size / 9000))` を 1MiB 単位に丸め (R2: 最大 10,000 パート、全パート同サイズ、最終パートのみ短い、パート ≥ 5MiB)。Worker ボディ上限 (Paid 100MiB → Business/Enterprise で拡張) を超えない範囲で `partSize ≤ 90MiB`。
  - 並列 4 本、失敗パートは指数バックオフで再送。ブラウザ再読込後は `GET /uploads/:id` で完了済みパートを取得して**再開**。
  - `sha256` はクライアントで WebCrypto ストリーミング計算 (任意) → 完了時に保存、重複検出に利用。
- サーバ: `POST /uploads` で `bucket.createMultipartUpload(key, {httpMetadata, customMetadata})`、DO `UploadDO(uploadId)` に `{parts: Map<n, etag>}` を保持。`complete` は DO のパート表で検証してから `R2MultipartUpload.complete()`。
- 期限: 24h 未完了は Cron が `abort()` + D1/DO クリーンアップ。
- クォータ: `POST /uploads` 時に `used_bytes + size <= quota` を先行チェック、完了時に確定。
- WebDAV PUT は単発 (Worker ボディ上限まで)。上限超は 413 と UI 誘導メッセージ。`Transfer-Encoding: chunked` の PUT は `Content-Length` 不明のため一時 R2 キーへストリーム → complete で rename ではなく、**そのまま本体キーへストリーム PUT** (R2 の `put()` は長さ不明ストリームも受けるが最大 5GiB、Worker 側は body 上限に依存)。

---

## 7. WebDAV (`/dav/`)

- Class 1 + 2 (LOCK/UNLOCK)。メソッド: OPTIONS, PROPFIND (Depth 0/1、`infinity` は 403 `propfind-finite-depth`), PROPPATCH (dead props を `node_props`), MKCOL, GET/HEAD, PUT, DELETE, COPY, MOVE (Overwrite ヘッダ), LOCK/UNLOCK (exclusive write、timeout 最大 1h、`If:` ヘッダ検証)。
- パス → node 解決: `/dav/<segments>` を D1 で親から順に解決 (深さ n で n クエリ、KV に 60s キャッシュ)。
- 応答 XML は手書きテンプレート + `fast-xml-parser` (PROPFIND/PROPPATCH/LOCK ボディ解析)。名前は NFC 正規化、URL エンコード RFC 3986。
- DELETE は回収箱へ (Nextcloud 互換の挙動)。`/dav/` 以下の隠し `.trash` は出さない。
- macOS Finder 対策: `._*` `.DS_Store` はデフォルトで保存を拒否 (設定で切替)。Windows Explorer 対策: `MS-Author-Via: DAV` ヘッダ、`Depth: 1` の PROPFIND 応答に `getcontentlength/getlastmodified/resourcetype/getetag/displayname/quota-used-bytes/quota-available-bytes` を含める。
- ロックは `LockDO(userId)` に保持 (token, path, owner, depth, timeout, expiresAt)。DO alarm で失効削除。

---

## 8. 共有

### リンク共有 (`/s/:token`)
- token: 128bit CSPRNG → base64url (22 文字)。D1 UNIQUE。
- 期限 / パスワード / 最大 DL 数 / 権限 (`read` | `upload` = フォルダへの「ファイル受け取り箱」) / 取り消し。
- ランディングは **Worker SSR** の軽量 HTML (JS 最小、Davflare 同様のゼロ JS でも閲覧可能) + 画像/動画/音声/PDF/テキストのインラインプレビュー、フォルダはリスト＋ZIP DL。
- パスワード: `POST /unlock` 成功で `HttpOnly; Secure; SameSite=Lax` の HMAC Cookie (`share_<id>`)。試行はレート制限 (token+IP 5/min)。
- 状態コード: 期限切れ 410、取り消し/不存在 404 (列挙防止のため同一応答)、パスワード不一致 403、DL 上限 410。
- `download_count` は `GET /content` の 200/206 開始時にインクリメント (Range の分割 DL は同一 Cookie セッション内で 1 回とカウント)。
- OG メタタグ (ファイル名・サイズ・サムネイル) を SSR し、チャットでのリンクプレビューを綺麗にする。`X-Robots-Tag: noindex`。

### 内部共有 (ユーザー間)
- `shares(kind='internal', grantee_user_id)`。受け手の UI に「共有アイテム」セクション。権限 read/edit。WebDAV では `/dav/Shared/<owner>/<name>` に仮想マウント。

---

## 9. Web UI

**スタック**: React 19 + TypeScript + Vite、Tailwind CSS v4 + shadcn/ui (Radix)、TanStack Router/Query/Virtual、`motion` (Framer Motion 後継) でアニメーション、`lucide-react` アイコン、`@uppy`-非依存の自作アップローダ (再開対応)。

**デザイン方針 (モダンで洗練)**:
- ライト/ダーク/システム追従、OLED 向け true-black バリアント。アクセントカラーはユーザー選択 (CSS 変数)。
- レイアウト: 左サイドバー (マイドライブ / 共有アイテム / 最近 / スター / 回収箱 / 容量メーター) + 上部コマンドバー (パンくず、検索 `Ctrl/⌘+K` コマンドパレット、表示切替、並び替え) + メイン (グリッド/リスト仮想スクロール) + 右側詳細パネル (プレビュー、メタ、アクティビティ、共有)。
- ガラス質 (backdrop-blur) のヘッダ・モーダル、控えめなシャドウ、角丸 12px、8pt グリッド、Inter/Noto Sans JP。
- インタラクション: ドラッグ＆ドロップ (フォルダ／ファイル／外部ファイルのドロップアップロード)、範囲選択・Shift/Ctrl 選択、右クリックコンテキストメニュー、キーボード操作 (矢印・Enter・Delete・F2)、スケルトンローディング、楽観的更新、トースト、アップロードキューのフローティングパネル。
- サムネイルは `s256` を遅延ロード (IntersectionObserver)、ぼかしプレースホルダー (dominant color を D1 に保存)。
- プレビューモーダル: 画像 (ピンチ/ホイールズーム、EXIF)、動画/音声 (`<video>` Range 再生)、PDF (`pdf.js`)、テキスト/コード (`shiki` ハイライト、Markdown レンダリング、CSV テーブル)、Office 系は「ダウンロード」+ 将来拡張ポイント。
- i18n: 日本語 / 英語 (`i18next`)、日付は `Intl`。
- アクセシビリティ: Radix によるフォーカス管理、`prefers-reduced-motion` 尊重、コントラスト AA。
- PWA (manifest + SW でシェル キャッシュ、Web Share Target で「共有→アップロード」)。

---

## 10. サムネイル・プレビュー

- 生成トリガー: アップロード完了 / WebDAV PUT 完了 → `THUMBS` Queue に `{nodeId}`。
- コンシューマ (同 Worker、`queue()` ハンドラ、batch 10、max_retries 3、DLQ):
  - 画像 (jpeg/png/webp/gif/avif/heic※): **Images binding** (`env.IMAGES.input(stream).transform({width:256, fit:'cover'}).output({format:'image/webp'})`) があれば使用。無い/失敗なら WASM (`@jsquash/jpeg|png|webp|resize`) で 256/1024 を生成。HEIC は Images binding のみ対応、無ければ `unsupported`。
  - PDF: v1 はサーバ生成しない → **クライアント側**で `pdf.js` の 1 ページ目を canvas → `POST /nodes/:id/thumb` でアップロード (Davflare 方式)。動画も同様に `<video>` からフレーム抽出してアップロード。サーバは `thumb_status='client'` を許容。
  - SVG: サニタイズ (`DOMPurify` on Worker の `linkedom`) 不採用 → SVG は `<img>` で表示するため XSS リスク低、ただし `Content-Security-Policy: sandbox` と `Content-Disposition` で応答。
- 上限: 元画像 > 40MP or > 50MB は `unsupported`。Worker CPU 上限 (Paid 既定 30s, `limits.cpu_ms` で最大 300s) 内に収める。
- サムネイルは `Cache-Control: private, max-age=31536000, immutable` (URL に etag を含める)。

---

## 11. 回収箱

- 削除 = 対象ノードとその子孫に `deleted_at=now`、対象のみ `trash_root=1`、`orig_parent_id` 記録。一覧は `trash_root=1` のみ表示。
- 復元 = `deleted_at=NULL` を子孫まで、`orig_parent_id` が消えていればルートへ。名前衝突は ` (restored)` サフィックス。
- 保持期間 `settings.trash_retention_days` (既定 30、0 = 即時、-1 = 無期限)。Cron (毎時) が期限切れを 500 件/回パージ (R2 delete → D1 delete → `used_bytes` 減算)。
- 回収箱内も検索・プレビュー可能、共有リンクは削除時点で無効化 (`shares.revoked_at` はセットせず、`nodes.deleted_at IS NOT NULL` で 404)。

---

## 12. 検索

- v1: D1 **FTS5** (`unicode61 remove_diacritics 2`) による名前検索 + 前方一致 (`name LIKE`)。フィルタ: 種別 (画像/動画/文書/…、mime 群)、更新日範囲、サイズ、スター、回収箱含む。owner/内部共有スコープで絞り込み。
- 日本語: FTS5 unicode61 は分かち書きしないため、`nodes_fts` に **bigram 列** (`name_bi`) を追加し、アプリ側で 2-gram 化して投入 (`trigram` tokenizer は 3 文字未満に弱いため bigram を自前生成)。
- v2 (任意): Workers AI (`@cf/llava` / CLIP 系) で画像に自動タグ → `node_tags` テーブル → 検索対象に追加。Vectorize は「Cloudflare 完結」に含めてよいが v1 では見送り。

---

## 13. 制限・信頼性・セキュリティ

**Cloudflare 制限の織り込み**
- Worker リクエストボディ: Paid 100MiB / Business 200MiB / Enterprise 500MiB → パートサイズ上限を env `MAX_PART_BYTES` で調整。
- R2: 単発 put 5GiB、マルチパート合計 5TiB、パート 5MiB–5GiB (最終除く)、最大 10,000 パート。copy 単発 5GiB。
- D1: 10GB/DB、1 クエリ結果 ~ (行数制限なしだがレスポンス上限)、書き込みは単一リージョン → 一覧は必ず keyset pagination、bulk 更新は 100 行単位でバッチ (`db.batch`)。
- サブリクエスト 1,000/req (Paid) → フォルダ ZIP は 1 リクエストで最大 ~900 ファイル、超える場合は分割 ZIP を案内。
- CPU: `limits.cpu_ms = 300000` (Paid の最大) 。
- DO: 1 オブジェクト逐次処理 → ロックは user ごと、アップロードは uploadId ごとに分散。

**セキュリティ**
- 全レスポンスに CSP (`default-src 'self'`; 共有ページは `sandbox` + `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`。
- ユーザー由来の `Content-Type` はホワイトリスト化、HTML/JS/SVG は `Content-Disposition: attachment` 強制 (プレビューは `<img>`/`<iframe sandbox>`)。
- パス/名前: NFC 正規化、`..`・制御文字・末尾ドット/空白・255 バイト超を拒否、Windows 予約名 (`CON`, `NUL`…) は WebDAV 経由でも警告。
- CSRF: Access Cookie 依存のため、mutation は `Origin` ヘッダ検証 + カスタムヘッダ (`X-Requested-With`) 必須。
- 共有トークン/アプリパスワードはハッシュ or ランダム 128bit 以上、ログにトークンを出さない。
- 監査ログ (`activity`) は改竄防止のため append-only、admin UI で閲覧・CSV エクスポート。
- 依存は `pnpm audit`、Renovate。Secrets は `wrangler secret` のみ (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, `SHARE_COOKIE_KEY`)。

**信頼性**
- R2 が真、D1 は再構築可能 (`pnpm admin rebuild-index` = R2 list + customMetadata から nodes 復元、パスはフォルダ marker `u/<owner>/d/<nodeId>.json` を併置して復元可能に)。
- D1 は Time Travel (30 日) でロールバック可。
- 全 Cron ジョブは冪等、ロック (KV `lock:<job>` with TTL) で多重実行防止。

---

## 14. 設定・デプロイ

```jsonc
// wrangler.jsonc (抜粋)
{
  "name": "next-cloud-flare",
  "main": "packages/worker/src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "packages/web/dist", "binding": "ASSETS",
              "not_found_handling": "single-page-application",
              "run_worker_first": ["/api/*", "/dav/*", "/s/*"] },
  "limits": { "cpu_ms": 300000 },
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "ncf-data" }],
  "d1_databases": [{ "binding": "DB", "database_name": "ncf", "database_id": "…", "migrations_dir": "packages/worker/migrations" }],
  "kv_namespaces": [{ "binding": "KV", "id": "…" }],
  "durable_objects": { "bindings": [
    { "name": "LOCKS", "class_name": "LockDO" }, { "name": "UPLOADS", "class_name": "UploadDO" } ] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["LockDO", "UploadDO"] }],
  "queues": { "producers": [{ "binding": "THUMBS", "queue": "ncf-thumbs" }],
              "consumers": [{ "queue": "ncf-thumbs", "max_batch_size": 10, "max_retries": 3, "dead_letter_queue": "ncf-thumbs-dlq" }] },
  "triggers": { "crons": ["17 * * * *", "0 3 * * 0"] },
  "images": { "binding": "IMAGES" },
  "unsafe": { "bindings": [{ "name": "RL_SHARE", "type": "ratelimit", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }] },
  "vars": { "ACCESS_TEAM_DOMAIN": "example.cloudflareaccess.com", "TRASH_RETENTION_DAYS": "30" },
  "observability": { "enabled": true }
}
```

デプロイ手順 (`docs/deploy.md` に詳述): `wrangler login` → `pnpm setup:cf` (bucket/D1/KV/Queue 作成 + `wrangler.jsonc` に ID 反映) → `wrangler d1 migrations apply` → `pnpm build && wrangler deploy` → Access アプリ 2 つ作成 (メイン: Google IdP Allow、バイパス: `/s/*` `/dav/*` `/api/public/*`) → `wrangler secret put ACCESS_AUD` 等 → 初回アクセスで最初のユーザーが `owner` に。GitHub Actions で `wrangler deploy` (CI: lint/typecheck/test → deploy on main)。

---

## 15. テスト計画

- **Unit/Integration**: `vitest` + `@cloudflare/vitest-pool-workers` (miniflare で R2/D1/DO/Queues/KV をローカル再現)。fs サービス、共有の状態遷移、回収箱の期限、マルチパート再開、Access JWT 検証 (テスト用 JWKS)。
- **WebDAV 互換**: `litmus` (Docker) を CI で `wrangler dev` に対して実行 (basic/copymove/props/locks スイート)、加えて rclone `rclone test` と cadaver スモーク。
- **E2E**: Playwright (アップロード→プレビュー→共有→回収箱→復元→検索)。Access はローカルでは `DEV_BYPASS_ACCESS=1` + 固定ユーザーで代替。
- **性能**: 10 万ノードの D1 で一覧/検索 p95 < 300ms を `wrangler dev --remote` で計測。100 GB ファイルのマルチパート (partSize 90MiB, 1,200 パート) を rclone で検証。
- **セキュリティ**: 共有トークン列挙 (404 一律)、パスワード試行レート制限、CSP ヘッダ、パストラバーサル、Content-Type スニッフィングのテスト。

---

## 16. 実装フェーズ (Sol への引き渡し単位)

1. **Foundation**: モノレポ、wrangler.jsonc、D1 スキーマ + migration、Access JWT ミドルウェア、`/me`、SPA シェル (レイアウト/テーマ)。
2. **Files core**: nodes CRUD、一覧/パンくず、単発アップロード、ダウンロード (Range)、rename/move/copy、D&D。
3. **Multipart**: UploadDO、再開、進捗 UI、クォータ、Cron abort。
4. **Trash**: 削除/復元/パージ、Cron、UI。
5. **Search**: FTS5 + bigram、フィルタ UI、コマンドパレット。
6. **Thumbnails/Preview**: Queue、Images binding/WASM、クライアント生成 (PDF/動画)、プレビューモーダル。
7. **Sharing**: リンク共有 (SSR ページ、パスワード、期限、DL 上限、ZIP)、内部共有。
8. **WebDAV**: Class 1 → litmus 合格 → Class 2 (LockDO)、アプリパスワード UI。
9. **Admin & polish**: 設定/ユーザー/クォータ、アクティビティ、PWA、i18n、a11y、E2E、deploy ドキュメント。

各フェーズは独立 PR、CI (lint/typecheck/test) 必須。

---

## 17. 未決事項 / レビューで特に検証してほしい点

1. R2 キー = 不透明 ID 方式のトレードオフ (D1 消失時の復旧可能性、`rclone` 直接バケット参照不可)。
2. WebDAV 認証: アプリパスワード vs Access Service Token のどちらを既定にするか。
3. 日本語検索 (bigram) の妥当性と D1 FTS5 の実サイズ上限。
4. PDF/動画サムネイルをクライアント生成に頼る方針の是非 (WebDAV 経由アップロードではサムネイルが出ない)。
5. Worker ボディ上限に依存するパートサイズと、Business 以上でない環境での 100 GB 級ファイルの現実性 (1,100 パート × 90MiB)。
6. 共有ページの `download_count` セマンティクス (Range 分割時)。
7. Access Bypass の設定ミス時のフェイルセーフ (Worker 側の二重チェックで十分か)。
