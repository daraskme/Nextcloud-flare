# Next-cloud-flare — 設計・実装方針 (v0.5)

Cloudflare のサービスだけで完結する、Google Drive / Nextcloud ライクなセルフホスト型ストレージ管理アプリ。

> ステータス: **Astra ラウンド1〜4 反映済み**。本書は v1 の実装契約であり、「要確認」は §18 の staging gate を通るまで有効化しない。
>
> 制限定義と一次資料の確認基準日: 2026-09-21。Cloudflare 数値の正本は §13、アプリの安全側上限も §13 に一元化する。

---

## 0. ゴール、非ゴール、提供範囲

### 0.1 ゴール

- Workers Paid、Workers Static Assets、R2、D1、KV、SQLite-backed Durable Objects、Queues、Cron Triggers、Images binding、Cloudflare Access だけを実行基盤とする。
- R2 は不変 content / derivative、D1 は namespace・権限・quota・operation・outbox、`ControlDO` は D1 restore 外の epoch / maintenance / GC pause の正本とする。
- REST、WebDAV、upload complete、Queue job の namespace 書込みを `fsMutation` へ集約し、principal、credential、全 operand、revision、tree generation、epoch、LockDO permit を検査する。
- Web UI、WebDAV Class 1/2、link/internal/upload-only share、trash、name / media metadata search、multipart、preview、Gallery、Bookshelf、Audio、監査、backup / restore を提供する。
- 曖昧な platform 挙動は Phase 0 と staging で実測し、未合格機能は fail closed または v1 で縮小する。

### 0.2 非ゴール

Office 同時編集、E2E 暗号化、desktop sync、malware scan、OCR、本文全文検索、DRM EPUB、固定レイアウト EPUB、media overlay、出版物 JavaScript、RAR/CBR/7z、server EPUB→画像変換、外部 metadata DB、波形・歌詞同期、Nextcloud 固有 API / chunking は v1 非目標とする。R2 の public access、`r2.dev`、論理 path を含む R2 key、直接 bucket 操作も禁止する。

Cloudflare account 全権管理者は trust boundary 内である。Workers Paid は zone の HTTP body plan 上限を引き上げない。

### 0.3 client / transfer support

| 経路 | v1 契約 | 競合・上限 |
|---|---|---|
| Web UI | single PUT または専用 multipart | §13。既存 file PUT は strong `If-Match` 必須。 |
| REST | body 一つを stream | `Content-Length` 必須、`MAX_REQUEST_BYTES` 以下。 |
| WebDAV | Class 1/2、一 request PUT | 独自 multipart 無し。DAV COPY/MOVE は §7.3 の同期上限。 |
| CLI / Nextcloud client | 基本 WebDAV の範囲 | 固有 chunking / change token /互換性は保証しない。 |

file content の `If-Match` 失敗は 412、create の `If-None-Match:*` 失敗は 412、その他 revision CAS は 409、lock は 423、quota は 507 とする。server は conflicted copy を自動生成しない。

---

## 1. Cloudflare サービス選定と役割

| 役割 | サービス / binding | 契約 |
|---|---|---|
| API / DAV / share | Workers + Hono + TypeScript | §5 の route manifest 以外を dispatch しない。 |
| SPA / public landing | Workers Static Assets | `run_worker_first=true`。private と public bundle を分離。 |
| content / derivative / backup | R2 | private bucket、不変 generation key、Range stream。 |
| namespace / auth / state | D1 | primary が権威。DB は単一 thread 前提で予算化。 |
| lock / commit permit | `LockDO(spaceId)` | lock、permit、expiry 照合、quiesce。 |
| multipart | `UploadDO(uploadId)` | part、in-flight、complete reconciliation。 |
| recovery control | singleton `ControlDO` | epoch、maintenance、`gc_paused`。 |
| byte / request budget | `TicketDO(jti)` | 耐久 lease と期限回収。 |
| background | Queues + Cron | outbox、at-least-once、fenced result claim。 |
| image derivative | Images binding | environment ごとに binding 必須。fallback で隠さない。 |
| short cache | KV | JWKS、read hint、feature flagだけ。認可・mutex・失効に使わない。 |
| edge throttle | Rate Limiting binding | PoP local の一次防御。厳密な全体会計は DO。 |
| authentication | Access | private user / service の入口。DAV / public share は Worker 認証。 |

D1 `prepare().bind()` は positional `?` / `?NNN` だけを使う。`batch()` は暗黙 transaction で、statement が一つでも SQL error なら全 rollback されるが、zero-row は error ではない。R2 `resumeMultipartUpload()` は handle を同期生成するだけで実在確認ではなく、`put(...,{onlyIf})` の条件不成立は例外ではなく `null` である。Queues の enqueue 成功は job 完了ではない。Images は `await input(...).transform(...).output({format})` の結果を使う。Rate Limiting の `{success}` は厳密会計にしない。

---

## 2. 全体アーキテクチャと binding / route 境界

```text
Browser ─ Access ─┐                         ┌─ D1: namespace/auth/op/outbox/control
                  ├─ Worker / manifest ─────┼─ R2: immutable blob/derivative/backup
WebDAV ─ Basic ───┤ authn → authorize       ├─ LockDO / UploadDO / TicketDO
Public share ─────┘       → fsMutation       └─ Queues / Cron / Images / KV
                                      ControlDO(epoch,maintenance,gc_paused)
```

### 2.1 repository / runtime

```text
packages/worker/src/{index,routes,auth,api,dav,services,do,jobs}/
packages/worker/migrations/
packages/worker/test/{unit,integration,fixtures}/
packages/web/{src,dist}/
packages/shared/
wrangler.jsonc
```

Module Worker は `fetch`、`queue`、`scheduled` と SQLite-backed DO class を export する。`blockConcurrencyWhile()` は constructor の短い永続 state 初期化だけに使い、R2 転送、D1 batch、part 待機を囲まない。`compatibility_date` と `nodejs_compat` は §14.1 で固定する。

### 2.2 host / Access 境界

| surface | path | Access | Worker auth |
|---|---|---|---|
| private app | `/`, `/assets/*`, private `/api/v1/*` | user app 必須 | Access user JWT |
| service | `/api/v1/automation/*` の完全 manifest | Service Auth | Access service JWT + mapping |
| share | `/s`, `/s/:shareId`, public API | Bypass | share secret / session / CSRF |
| public assets | `/public-assets/:asset` | Bypass | build manifest `auth:public` + exact file |
| DAV | `/dav`, `/dav/*path` | Bypass | app password Basic |
| content host | `/session`, `/c/*`, `/reader/*` | Bypass | content-session Cookie |

`workers.dev`、preview URL、R2 public access、想定外 host / alias を無効化する。public / service prefix の未知 method-template は 404 とし private router / SPA / assets へ fallthrough しない。Bypass request に Access JWT が付いても principal を user / service へ昇格しない。DAV の HTTP request は credential を読む前に拒否し redirect しない。

URL、DAV `Destination`、tagged URI は一度だけ percent decodeし、不正 UTF-8 / percent、NUL、encoded slash、backslash、dot segment、二重 decode を拒否する。JSON 名は percent decode しない。

### 2.3 binding contract

`Env` は `DB, BLOBS, BACKUPS, CACHE, LOCKS, UPLOADS, TICKETS, CONTROL, JOBS, IMAGES, EDGE_LIMITER, ASSETS` を必須とする。起動 smoke test は binding の存在と environment marker を検査し、不足・cross-environment ID・Images 無しを 503 で fail closed にする。D1/R2/KV/Queues/DO/Access AUD/custom domain/key ring は staging と production で共有しない。配備可能な `wrangler.jsonc` は §14.1 を正本とする。

---

## 3. データモデルと不変条件 (D1 / R2)

### 3.1 core schema

全 TEXT 主鍵は明示的に `NOT NULL`。全 size / count は非負 CHECK を持つ。以下は migration の規範部分であり、migration test は D1 と SQLite の双方で実行する。

```sql
CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY,
  access_iss TEXT NOT NULL, access_sub TEXT NOT NULL, email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('member','app_admin')),
  quota_bytes INTEGER, used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
  physical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(physical_bytes>=0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
  disabled_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(access_iss,access_sub)
) STRICT;

CREATE TABLE control (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  bootstrap_done_at INTEGER,
  bootstrap_iss TEXT, bootstrap_sub TEXT,
  backup_barrier TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO control(singleton,epoch,bootstrap_done_at,updated_at)
VALUES(1,1,NULL,unixepoch());

CREATE TABLE spaces (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  root_node_id TEXT NOT NULL UNIQUE,
  tree_generation INTEGER NOT NULL DEFAULT 1 CHECK(tree_generation>0),
  UNIQUE(owner_id)
) STRICT;

CREATE TABLE blobs (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size>=0),
  sha256_verified TEXT, client_sha256 TEXT,
  content_etag TEXT NOT NULL, r2_etag TEXT, mime_sniffed TEXT,
  ref_count INTEGER NOT NULL CHECK(ref_count>=0),
  state TEXT NOT NULL CHECK(state IN ('staging','committed','gc_candidate','deleting','deleted')),
  created_at INTEGER NOT NULL, last_op_id TEXT
) STRICT;

CREATE TABLE trash_ops (
  op_id TEXT NOT NULL PRIMARY KEY,
  actor_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id),
  root_node_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('pending','trashed','restoring','restored','purging','purged')),
  reason TEXT, created_at INTEGER NOT NULL, purge_after INTEGER,
  checkpoint TEXT, epoch INTEGER NOT NULL
) STRICT;

CREATE TABLE nodes (
  id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id), owner_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES nodes(id), name TEXT NOT NULL, name_ci TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('root','folder','file')),
  current_blob_id TEXT REFERENCES blobs(id), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  client_mtime INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, deleted_op_id TEXT REFERENCES trash_ops(op_id), orig_parent_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)), last_op_id TEXT,
  CHECK((kind='root' AND parent_id IS NULL) OR (kind<>'root' AND parent_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX nodes_parent_name_live ON nodes(parent_id,name_ci) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX nodes_one_root_live ON nodes(space_id) WHERE kind='root' AND deleted_at IS NULL;
CREATE INDEX nodes_children_name_live ON nodes(parent_id,name_ci,id) WHERE deleted_at IS NULL;
CREATE INDEX nodes_children_updated_live ON nodes(parent_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX nodes_children_deleted ON nodes(parent_id,deleted_at,id);
CREATE INDEX nodes_space_parent_live ON nodes(space_id,parent_id,id) WHERE deleted_at IS NULL;
CREATE INDEX nodes_blob ON nodes(current_blob_id) WHERE current_blob_id IS NOT NULL;

CREATE TRIGGER nodes_parent_insert BEFORE INSERT ON nodes
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM nodes p
  WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id
    AND p.owner_id=NEW.owner_id AND p.kind IN ('root','folder') AND p.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'invalid parent'); END;
CREATE TRIGGER nodes_parent_update BEFORE UPDATE OF parent_id,space_id,owner_id ON nodes
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM nodes p
  WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id
    AND p.owner_id=NEW.owner_id AND p.kind IN ('root','folder') AND p.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'invalid parent'); END;
```

Operation / outbox / GC schema は §5.2 と §11、upload schema は §6、FTS schema は §12 を正本とする。`node_versions`、`shares`、`share_sessions`、`app_passwords`、`service_principals`、`node_props`、`user_node_state`、`activity`、`bulk_jobs`、`job_leases`、`backup_runs`、`mutation_journal`、`folder_stats` は migration で FK / CHECK / index を明示する。大きい manifest / archive index は D1 row に置かず R2 に置く。

Media は `node_media`、`library_items`、`user_reading_state`、`tags`、`node_tags`、`library_roots`、`node_audio`、`user_playback_state` を持つ。current blob と generator version を必須 guard にし、FK 参照列 `node_id/blob_id/user_id` の非先頭列にも index を作る。GPS、任意 EXIF、未検証 XML/HTML、埋込み原画像は D1 に保存しない。

### 3.2 tree / EffectiveLive invariants

- space は root node を一つだけ持つ。root の rename / MOVE / trash / purge を拒否する。
- create / rename / MOVE / COPY / trash / restore / purge は `spaces.tree_generation` を期待値付きで更新する。同一 space の構造 mutation は LockDO permit で直列化し、競合 retry は最大3回、その後 409。
- read は次の一 query で node から root までを検証する。深さ64超、cycle、deleted ancestor、別 space、root 未到達を拒否する。

```sql
WITH RECURSIVE a(id,parent_id,space_id,kind,deleted_at,depth,path) AS (
  SELECT id,parent_id,space_id,kind,deleted_at,0,'/'||id||'/' FROM nodes WHERE id=?1
  UNION ALL
  SELECT p.id,p.parent_id,p.space_id,p.kind,p.deleted_at,a.depth+1,a.path||p.id||'/'
  FROM nodes p JOIN a ON p.id=a.parent_id
  WHERE a.depth<64 AND p.space_id=a.space_id AND instr(a.path,'/'||p.id||'/')=0
)
SELECT CASE WHEN COUNT(*) BETWEEN 1 AND 65
  AND MIN(deleted_at IS NULL)=1
  AND SUM(kind='root' AND parent_id IS NULL)=1
  AND MAX(CASE WHEN kind='root' THEN id END)=?2
  THEN 1 ELSE 0 END AS effective_live FROM a;
```

content、HEAD/Range、children、search/count、thumb、ZIP、Gallery、Tracks、Library、ticket 発行は全てこの集合化された証明を通る。共有 root 到達性は別 CTE で証明する。ancestor が `trashed` commit した瞬間に share / ticket は無効で、restore しても旧 internal share は復活しない。

### 3.3 path / name / R2 invariants

検証順は decode 一回（URLだけ）→ UTF-8 / separator / control 拒否 → NFC → portable check → byte / scalar count → version 固定 Unicode casefold。空、`.`、`..`、末尾 dot / space、Windows 予約名、colon、slash、backslash、NULを拒否する。`.DS_Store` / `._*` は hidden で保存可能。

blob key は `u/<ownerId>/b/<blobId>`、derivative は generation 付き key とし上書きしない。same-owner COPY は COW、cross-owner COPY は source pin + destination reservation + Range/multipart job。current / version / pin の ref count は同じ D1 batch で更新する。R2 ETag、D1 content ETag、metadata revision を混同しない。

### 3.4 D1 query / bind rules

権威 read は Session replica に依存せず primary binding へ直接発行する。`withSession('first-primary')` は session 全 query の primary 保証ではない。各 statement の bind を生成時に数え、`k` bind/row + 共通 `r` なら chunk は `floor((100-r)/k)` 以下。`IN (...)` は100 bindを越える前に分割し、atomic mutation を別 batch に分割しない。read ID 集合は size-bounded JSON + `json_each(?)` も使えるが row / value / duration 予算を同時に検査する。

一覧 / PROPFIND / Gallery / ancestor の SQL は §12、fixture 予算は §15.1。返却件数を `rows_read` とみなさない。

---

## 4. 認証、principal、認可、初期化

### 4.1 JWT / principal

private/service route は重複のない単一 `Cf-Access-Jwt-Assertion` header だけを受ける。Cookie / raw Service Token header / query / bodyへ fallback しない。JOSE は `alg=RS256`,`typ=JWT`、payload `type=app`、固定 `iss`、route-environment別単一 AUD、有限整数 `iat,exp`、user は `nbf,sub,email`、service は `common_name` を検査する。skew60秒、`iat`から24h超を拒否する。JWKS は issuer 単位 KV 1h、既知 key stale24h、未知 kid single-flight、10 refresh/分、negative64、timeout5秒、256KiB、RSA16鍵とする。

```text
user(iss,sub,user_id,credential_id=access-session)
app_password(user_id,credential_id,scope,optional_root)
link_share(share_id,share_version,session_id,actions,root)
service(service_principal_id,credential_id,mapped_user,space,scope)
job(saved_principal,credential_id,epoch,operation)
system(kind,epoch,explicit_operands)
```

service は `/api/v1/automation/*` だけ。`system` は GC / repair / backup の列挙 operation だけで user read 権限を持たない。

### 4.2 authorize contract

scope enum は `account:read, node:read, node:create, node:write, node:delete, share:manage, upload:create, upload:write, library:read, library:write, job:read, job:cancel, admin:dlq, admin:repair` に固定する。v1 の `app_admin` は他 user の file content read を禁止し、`admin:repair` は maintenance 中の明示 operand に限る。

| operation | 必須 operand tuple / 権限 |
|---|---|
| `node.create` | `[parent,space]`: parent create |
| `node.content.write` | `[node,parent,oldBlob?,newBlob]`: node write + current parent write |
| `node.rename` | `[node,parent]`: node write + parent write |
| `node.move` | `[source,sourceParent,destinationParent,overwriteTarget?,sourceAncestors,destinationAncestors]`: source/parents write、target write |
| `node.copy` | `[source,destinationParent,overwriteTarget?,sourceAncestors,destinationAncestors]`: source read、destination create、target write |
| `node.trash` | `[source,parent,descendantSet]`: source delete + parent write |
| `node.restore` | `[trashOp,root,destinationParent]`: trash owner + destination create |
| `read` | `[node,ancestors,currentBlob?]`: node read + EffectiveLive |
| `upload.complete` | `[upload,parent,target?,blob]`: same credential + current parent create/write |
| `share.manage` | `[share,root]`: space owner only |
| `job.*` | `[job,originalOperands]`: same principal + credential + current grant |

`Authorized<Operation>` は operation ごとの discriminated tuple を返し、一般 `Operand[]` を handler に渡さない。route の型検査は補助であり、意味的な認可 matrix fixture を必須とする。

terminal replay は同一 principal fingerprint + 同一 `credential_id` に限り、current user / credential / grant / share version と結果 node 開示権限を再検査する。成功は operation ID / HTTP status /現在見える node ID/revisionだけ、失敗は安定 error codeだけを返す。purge 済み node 名/pathは返さない。credential 再発行後は replay 不可。

### 4.3 bootstrap / revocation

Google IdP + MFA policy の初回 `iss+sub` だけを `control.bootstrap_done_at IS NULL` 条件付き batch で app_admin / personal spaceへ固定する。以後 `OWNER_EMAILS` は無視する。user disable、app password revoke/expiry、share version/session、upload/job credential は request / part / chunk / terminal replay ごとに D1 primary で確認する。Access logoutだけでは DAV/shareを止めない。

logout は app auth state、unlock Cookie、upload capability、IndexedDB / memory / Cache Storage を削除し `BroadcastChannel` 通知後 `/cdn-cgi/access/logout` へ303。受信済み stream byteは回収できず、新 request から拒否する。

### 4.4 token / KDF

HMAC token は canonical JSON、`typ,kid,aud,iat,exp,epoch` と用途 claim を必須にし、CSPRNG 256-bit（最低128-bit）。secretを URL、operation result、audit、journal、error、log に保存しない。

| token | 主な束縛 | 期限 / storage |
|---|---|---|
| share link | share ID/version/root/actions | D1 は HMAC/hashだけ。fragment→POST。 |
| unlock | share/version/session/kid/epoch | `__Host-ncf_share_*`; Secure; HttpOnly; SameSite=Lax; Path=/; ≤7日 |
| app password | credential ID/user/scope/epoch | digestだけ、既定90日/最大365日、20/user |
| upload | upload/principal/credential/share version/aud | deadline以下、Cookie無し |
| DAV lock | random token/node/creator/epoch | `opaquelocktoken`、hashだけ、≤604800秒 |
| content session | allowed target set/scope/epoch/aud | §8.2 Cookie、≤600秒 |
| job/operation | DB参照ID | bearerではない |

share password は PBKDF2-HMAC-SHA256 **100,000回**、salt16B、DK32B、入力UTF-8≤1KiBを v1 既定にする。per-share 10/min、client IP 30/min、global DO 600/min、同時KDF20。ただし isolate 内は一 requestずつ実行し global20をmemory保証に使わない。600,000回は §18 staging で「APIが受理すること」とCPUを先に実測し、合格時だけ環境設定を一括で引き上げる。scrypt は memory上限を保証できないため不採用。

---

## 5. REST API、route manifest、共通 mutation

### 5.1 完全 route manifest

以下が v1 の全 HTTP route である。各行は method/template を一意に登録し、記載のない route は404。`operands` の各 ID は request schema から型付きに束縛し、`adminOnly` を生成 testで固定する。

| host | method | template | auth | operation | operands | adminOnly |
|---|---|---|---|---|---|---|
| app | GET | `/` | access | `spa.read` | `currentUser` | false |
| app | GET | `/assets/:asset` | access | `spa.read` | `currentUser,assetManifest` | false |
| app | GET | `/public-assets/:asset` | public | `public.asset.read` | `publicAssetManifest` | false |
| app | GET | `/s` | public | `share.landing` | `publicAssetManifest` | false |
| app | GET | `/s/:shareId` | public | `share.landing` | `shareId,publicAssetManifest` | false |
| app | GET | `/api/v1/me` | access | `account.read` | `currentUser` | false |
| app | POST | `/api/v1/auth/logout` | access | `account.logout` | `currentUser` | false |
| app | GET | `/api/v1/search` | access | `search.read` | `scopeRoot,cursor` | false |
| app | GET | `/api/v1/recent` | access | `node.read` | `scopeRoot,cursor` | false |
| app | GET | `/api/v1/starred` | access | `node.read` | `scopeRoot,cursor` | false |
| app | GET | `/api/v1/stats` | access | `account.read` | `currentUser,space` | false |
| app | GET | `/api/v1/nodes/:nodeId` | access | `node.read` | `node,ancestors` | false |
| app | GET | `/api/v1/nodes/:nodeId/path` | access | `node.read` | `node,ancestors` | false |
| app | GET | `/api/v1/nodes/:nodeId/children` | access | `node.read` | `node,children,cursor` | false |
| app | GET | `/api/v1/nodes/:nodeId/content` | access | `node.read` | `node,ancestors,blob` | false |
| app | HEAD | `/api/v1/nodes/:nodeId/content` | access | `node.read` | `node,ancestors,blob` | false |
| app | GET | `/api/v1/nodes/:nodeId/thumb` | access | `node.read` | `node,ancestors,blob,variant` | false |
| app | HEAD | `/api/v1/nodes/:nodeId/thumb` | access | `node.read` | `node,ancestors,blob,variant` | false |
| app | GET | `/api/v1/nodes/:nodeId/preview` | access | `node.read` | `node,ancestors,blob` | false |
| app | HEAD | `/api/v1/nodes/:nodeId/preview` | access | `node.read` | `node,ancestors,blob` | false |
| app | POST | `/api/v1/nodes` | access | `node.create` | `parent,space` | false |
| app | PATCH | `/api/v1/nodes/:nodeId` | access | `node.rename` | `node,parent` | false |
| app | PUT | `/api/v1/nodes/:nodeId/content` | access | `node.content.write` | `node,parent,oldBlob,newBlob` | false |
| app | DELETE | `/api/v1/nodes/:nodeId` | access | `node.trash` | `node,parent,descendants` | false |
| app | POST | `/api/v1/nodes/:nodeId/move` | access | `node.move` | `source,sourceParent,destinationParent,overwriteTarget,sourceAncestors,destinationAncestors` | false |
| app | POST | `/api/v1/nodes/:nodeId/copy` | access | `node.copy` | `source,destinationParent,overwriteTarget,sourceAncestors,destinationAncestors` | false |
| app | POST | `/api/v1/nodes/:nodeId/zip` | access | `zip.create` | `root,subtree,blobs,ticket` | false |
| app | POST | `/api/v1/nodes/:nodeId/thumbs` | access | `thumb.create` | `node,blob` | false |
| app | GET | `/api/v1/nodes/:nodeId/gallery` | access | `gallery.read` | `folder,candidates,cursor` | false |
| app | GET | `/api/v1/nodes/:nodeId/tracks` | access | `audio.read` | `folder,tracks,cursor` | false |
| app | PATCH | `/api/v1/nodes/:nodeId/audio` | access | `library.write` | `node,blob,audioMetadata` | false |
| app | PUT | `/api/v1/nodes/:nodeId/playback-state` | access | `state.write` | `currentUser,node` | false |
| app | GET | `/api/v1/library/items` | access | `library.read` | `scopeRoot,cursor` | false |
| app | GET | `/api/v1/library/items/:itemId` | access | `library.read` | `item,node,blob` | false |
| app | PATCH | `/api/v1/library/items/:itemId` | access | `library.write` | `item,node,blob` | false |
| app | GET | `/api/v1/library/:nodeId` | access | `library.read` | `node,blob,index` | false |
| app | GET | `/api/v1/library/:nodeId/pages/:page` | access | `library.read` | `node,blob,index,page` | false |
| app | HEAD | `/api/v1/library/:nodeId/pages/:page` | access | `library.read` | `node,blob,index,page` | false |
| app | GET | `/api/v1/library/:nodeId/pages/:page/thumb` | access | `library.read` | `node,blob,index,page` | false |
| app | HEAD | `/api/v1/library/:nodeId/pages/:page/thumb` | access | `library.read` | `node,blob,index,page` | false |
| app | GET | `/api/v1/library/:nodeId/entries/:entryToken` | access | `library.read` | `node,blob,index,entry` | false |
| app | HEAD | `/api/v1/library/:nodeId/entries/:entryToken` | access | `library.read` | `node,blob,index,entry` | false |
| app | PUT | `/api/v1/library/:nodeId/reading-state` | access | `state.write` | `currentUser,node` | false |
| app | GET | `/api/v1/library/roots` | access | `library.read` | `currentUser` | false |
| app | POST | `/api/v1/library/roots` | access | `library.write` | `currentUser,rootNode` | false |
| app | DELETE | `/api/v1/library/roots/:nodeId` | access | `library.write` | `currentUser,rootNode` | false |
| app | POST | `/api/v1/uploads` | access | `upload.create` | `parent,target,space` | false |
| app | GET | `/api/v1/uploads/:uploadId` | access | `upload.read` | `upload,parent,target` | false |
| app | PUT | `/api/v1/uploads/:uploadId/parts/:partNumber` | access | `upload.write` | `upload,parent,target,part` | false |
| app | POST | `/api/v1/uploads/:uploadId/complete` | access | `upload.complete` | `upload,parent,target,blob` | false |
| app | DELETE | `/api/v1/uploads/:uploadId` | access | `upload.abort` | `upload,parent,target` | false |
| app | GET | `/api/v1/trash` | access | `trash.read` | `space,cursor` | false |
| app | POST | `/api/v1/trash/:opId/restore` | access | `trash.restore` | `trashOp,root,destinationParent` | false |
| app | POST | `/api/v1/trash/:opId/purge` | access | `trash.purge` | `trashOp,root,subtree` | false |
| app | GET | `/api/v1/shares` | access | `share.read` | `currentUser` | false |
| app | POST | `/api/v1/shares` | access | `share.manage` | `currentUser,root` | false |
| app | GET | `/api/v1/shares/:shareId` | access | `share.read` | `share,root` | false |
| app | PATCH | `/api/v1/shares/:shareId` | access | `share.manage` | `share,root` | false |
| app | DELETE | `/api/v1/shares/:shareId` | access | `share.manage` | `share,root` | false |
| app | POST | `/api/v1/content-session` | access | `content.session.create` | `targetSet,nodes,blobs` | false |
| app | GET | `/api/v1/app-passwords` | access | `credential.read` | `currentUser` | false |
| app | POST | `/api/v1/app-passwords` | access | `credential.create` | `currentUser` | false |
| app | DELETE | `/api/v1/app-passwords/:credentialId` | access | `credential.revoke` | `currentUser,credential` | false |
| app | GET | `/api/v1/jobs/:jobId` | access | `job.read` | `job,originalOperands` | false |
| app | POST | `/api/v1/jobs/:jobId/cancel` | access | `job.cancel` | `job,originalOperands` | false |
| app | POST | `/api/v1/jobs/:jobId/retry` | access | `job.retry` | `job,originalOperands` | false |
| app | GET | `/api/v1/admin/dlq` | access | `admin.dlq` | `dlqCursor` | true |
| app | POST | `/api/v1/admin/dlq/:jobId/requeue` | access | `admin.dlq` | `job,originalOperands` | true |
| app | POST | `/api/v1/automation/uploads` | service | `upload.create` | `service,space,parent,target` | false |
| app | POST | `/api/v1/automation/jobs/:jobId/cancel` | service | `job.cancel` | `service,job,originalOperands` | false |
| app | POST | `/api/v1/automation/repair/:kind` | service | `admin.repair` | `service,repairKind,explicitOperands` | true |
| app | GET | `/api/v1/public/shares/:shareId` | share | `share.read` | `share,root` | false |
| app | GET | `/api/v1/public/shares/:shareId/children/:nodeId` | share | `share.read` | `share,node,ancestors,children` | false |
| app | GET | `/api/v1/public/shares/:shareId/content/:nodeId` | share | `share.read` | `share,node,ancestors,blob` | false |
| app | HEAD | `/api/v1/public/shares/:shareId/content/:nodeId` | share | `share.read` | `share,node,ancestors,blob` | false |
| app | GET | `/api/v1/public/shares/:shareId/thumb/:nodeId` | share | `share.read` | `share,node,ancestors,blob` | false |
| app | HEAD | `/api/v1/public/shares/:shareId/thumb/:nodeId` | share | `share.read` | `share,node,ancestors,blob` | false |
| app | POST | `/api/v1/public/shares/:shareId/unlock` | public | `share.unlock` | `share` | false |
| app | POST | `/api/v1/public/shares/:shareId/logout` | share | `share.logout` | `share,session` | false |
| app | POST | `/api/v1/public/shares/:shareId/tickets` | share | `share.read` | `share,session,targetSet` | false |
| app | POST | `/api/v1/public/shares/:shareId/content-session` | share | `content.session.create` | `share,session,targetSet` | false |
| app | GET | `/api/v1/public/shares/:shareId/gallery` | share | `gallery.read` | `share,root,candidates,cursor` | false |
| app | GET | `/api/v1/public/shares/:shareId/tracks` | share | `audio.read` | `share,root,tracks,cursor` | false |
| app | GET | `/api/v1/public/shares/:shareId/library/:nodeId` | share | `library.read` | `share,node,blob,index` | false |
| app | GET | `/api/v1/public/shares/:shareId/library/:nodeId/pages/:page` | share | `library.read` | `share,node,blob,index,page` | false |
| app | HEAD | `/api/v1/public/shares/:shareId/library/:nodeId/pages/:page` | share | `library.read` | `share,node,blob,index,page` | false |
| app | GET | `/api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken` | share | `library.read` | `share,node,blob,index,entry` | false |
| app | HEAD | `/api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken` | share | `library.read` | `share,node,blob,index,entry` | false |
| app | POST | `/api/v1/public/shares/:shareId/nodes` | share | `node.create` | `share,parent` | false |
| app | PATCH | `/api/v1/public/shares/:shareId/nodes/:nodeId` | share | `node.rename` | `share,node,parent,ancestors` | false |
| app | DELETE | `/api/v1/public/shares/:shareId/nodes/:nodeId` | share | `node.trash` | `share,node,parent,ancestors` | false |
| app | POST | `/api/v1/public/shares/:shareId/uploads` | share | `upload.create` | `share,parent,target` | false |
| app | GET | `/api/v1/public/shares/:shareId/uploads/:uploadId` | share | `upload.read` | `share,upload,parent,target` | false |
| app | PUT | `/api/v1/public/shares/:shareId/uploads/:uploadId/parts/:partNumber` | share | `upload.write` | `share,upload,part` | false |
| app | POST | `/api/v1/public/shares/:shareId/uploads/:uploadId/complete` | share | `upload.complete` | `share,upload,parent,target,blob` | false |
| app | DELETE | `/api/v1/public/shares/:shareId/uploads/:uploadId` | share | `upload.abort` | `share,upload` | false |
| app | OPTIONS | `/dav/*path` | app_password | `dav.options` | `credential,source` | false |
| app | PROPFIND | `/dav/*path` | app_password | `dav.propfind` | `source,ancestors,properties,locks` | false |
| app | PROPPATCH | `/dav/*path` | app_password | `dav.proppatch` | `source,ancestors,properties,locks` | false |
| app | MKCOL | `/dav/*path` | app_password | `dav.mkcol` | `sourceParent,ancestors,locks` | false |
| app | GET | `/dav/*path` | app_password | `dav.read` | `source,ancestors,blob` | false |
| app | HEAD | `/dav/*path` | app_password | `dav.read` | `source,ancestors,blob` | false |
| app | PUT | `/dav/*path` | app_password | `dav.put` | `source,sourceParent,oldBlob,newBlob,ancestors,locks` | false |
| app | DELETE | `/dav/*path` | app_password | `dav.delete` | `source,sourceParent,descendants,ancestors,locks` | false |
| app | COPY | `/dav/*path` | app_password | `dav.copy` | `source,destinationParent,overwriteTarget,sourceAncestors,destinationAncestors,locks` | false |
| app | MOVE | `/dav/*path` | app_password | `dav.move` | `source,sourceParent,destinationParent,overwriteTarget,sourceAncestors,destinationAncestors,locks` | false |
| app | LOCK | `/dav/*path` | app_password | `dav.lock` | `source,ancestors,locks` | false |
| app | UNLOCK | `/dav/*path` | app_password | `dav.unlock` | `source,ancestors,lock` | false |
| content | POST | `/session` | public | `content.session.accept` | `signedTicket,targetSet` | false |
| content | GET | `/c/:nodeId/:blobId` | content_cookie | `content.read` | `session,node,blob` | false |
| content | HEAD | `/c/:nodeId/:blobId` | content_cookie | `content.read` | `session,node,blob` | false |
| content | GET | `/c/:nodeId/:blobId/pages/:page` | content_cookie | `content.read` | `session,node,blob,index,page` | false |
| content | HEAD | `/c/:nodeId/:blobId/pages/:page` | content_cookie | `content.read` | `session,node,blob,index,page` | false |
| content | GET | `/c/:nodeId/:blobId/entries/:entryToken` | content_cookie | `content.read` | `session,node,blob,index,entry` | false |
| content | HEAD | `/c/:nodeId/:blobId/entries/:entryToken` | content_cookie | `content.read` | `session,node,blob,index,entry` | false |
| content | GET | `/reader/index.html` | public | `reader.shell` | `readerAssetManifest` | false |
| content | GET | `/reader/:asset` | public | `reader.shell` | `readerAssetManifest` | false |

DAVの各行はrouter生成時に `/dav` と `/dav/*path` の二templateへ展開し、rootで意味を持たないmutationは405にする。`*path` は一度だけdecodeするbounded remainderであり、曖昧なrouter wildcardへ他surfaceを流さない。

Binary upload PUT は exact app Origin（private は Access済み、public は share landing）、`Sec-Fetch-Site:same-origin`、upload capability、expected part metadata を要求するが JSON Content-Type / CSRF token は要求しない。JSON mutation は exact Origin、`Origin:null` / missing拒否、same-origin Fetch Metadata、`application/json`、one-time CSRFを要求する。

### 5.2 `fsMutation` の完全 SQL 契約

`control` は次の一行 table、operation は続く schema とする。migration は二行目の挿入が一度だけ成功することを検証する。

```sql
CREATE TABLE control (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  bootstrap_done_at INTEGER,
  bootstrap_iss TEXT, bootstrap_sub TEXT,
  backup_barrier TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO control(singleton,epoch,bootstrap_done_at,updated_at)
VALUES(1,1,NULL,unixepoch());

CREATE TABLE operations (
  op_id TEXT NOT NULL PRIMARY KEY,
  principal_id TEXT NOT NULL, credential_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id), kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','committed','failed')),
  request_digest TEXT NOT NULL, epoch INTEGER NOT NULL,
  permit_id TEXT NOT NULL, permit_expires_at INTEGER NOT NULL,
  expected_steps INTEGER NOT NULL CHECK(expected_steps>=0),
  result_json TEXT, error_code TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE operation_steps (
  op_id TEXT NOT NULL REFERENCES operations(op_id),
  step_no INTEGER NOT NULL, kind TEXT NOT NULL, affected_id TEXT,
  PRIMARY KEY(op_id,step_no)
) STRICT;

CREATE TABLE outbox (
  outbox_id TEXT NOT NULL PRIMARY KEY, op_id TEXT NOT NULL REFERENCES operations(op_id),
  kind TEXT NOT NULL, payload_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','sent','completed','failed')),
  dispatch_token TEXT, dispatch_expires_at INTEGER, epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
```

1. R2 I/O を終え、LockDO から `{permit_id,expires_at}` を得る。permit は fence token として D1 `operations.permit_id` に記録する。
2. claim は単独 batch の次の一文。`meta.changes=1` を期待する。

```sql
INSERT INTO operations(
  op_id,principal_id,credential_id,space_id,kind,state,request_digest,
  epoch,permit_id,permit_expires_at,expected_steps,created_at,updated_at
)
SELECT ?1,?2,?3,?4,?5,'claimed',?6,?7,?8,?9,?10,unixepoch(),unixepoch()
WHERE (SELECT epoch FROM control WHERE singleton=1)=?7
ON CONFLICT(op_id) DO NOTHING;
```

影響行0なら primary で `op_id` を読み、principal / credential / kind / digest が違えば409。同じで terminalなら再認可後に終端結果を返し、`claimed` なら同じ `claimOperation` を再送して収束させる。

3. mutation batch の各 UPDATE / INSERT は revision、live、claimed operation、epochを同じ文に持つ。名前付き bind は使わない。代表 SQL は次のとおり。

```sql
UPDATE nodes
SET parent_id=?1,name=?2,name_ci=?3,revision=revision+1,
    updated_at=unixepoch(),last_op_id=?4
WHERE id=?5 AND revision=?6 AND deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM operations
             WHERE op_id=?4 AND state='claimed' AND principal_id=?7
               AND credential_id=?8 AND epoch=?9)
  AND (SELECT epoch FROM control WHERE singleton=1)=?9;

UPDATE spaces
SET tree_generation=tree_generation+1
WHERE id=?1 AND tree_generation=?2
  AND EXISTS(SELECT 1 FROM operations WHERE op_id=?3 AND state='claimed' AND epoch=?4)
  AND (SELECT epoch FROM control WHERE singleton=1)=?4;

UPDATE users
SET reserved_bytes=reserved_bytes-?1, used_bytes=used_bytes+?2,
    physical_bytes=physical_bytes+?3
WHERE id=?4 AND reserved_bytes>=?1
  AND EXISTS(SELECT 1 FROM operations WHERE op_id=?5 AND state='claimed' AND epoch=?6)
  AND (SELECT epoch FROM control WHERE singleton=1)=?6;

INSERT INTO operation_steps(op_id,step_no,kind,affected_id)
SELECT ?1,?2,?3,n.id FROM nodes n
WHERE n.id=?4 AND n.last_op_id=?1 AND n.revision=?5
  AND n.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM operations WHERE op_id=?1 AND state='claimed' AND epoch=?6)
  AND (SELECT epoch FROM control WHERE singleton=1)=?6;

INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
SELECT ?1,?2,?3,?4,'pending',?5,unixepoch(),unixepoch()
WHERE EXISTS(SELECT 1 FROM operations WHERE op_id=?2 AND state='claimed' AND epoch=?5)
  AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?2)=?6
  AND (SELECT epoch FROM control WHERE singleton=1)=?5;
```

create INSERT もparent proofを同じ文に持つ。

```sql
INSERT INTO nodes(
  id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,
  revision,created_at,updated_at,hidden,last_op_id
)
SELECT ?1,p.space_id,p.owner_id,p.id,?2,?3,?4,?5,1,unixepoch(),unixepoch(),0,?6
FROM nodes p JOIN operations o ON o.op_id=?6
WHERE p.id=?7 AND p.revision=?8 AND p.deleted_at IS NULL
  AND p.kind IN ('root','folder') AND o.state='claimed' AND o.epoch=?9
  AND (SELECT epoch FROM control WHERE singleton=1)=?9;
```

node operandを持つ全step UPDATE/INSERTは同様に `revision=?`、`deleted_at IS NULL`、claimed operation、control epochを一文で検査する。MOVE は再帰 CTE で destination がsourceの子孫でないこと、深さ、同一space、両ancestor liveを同一batchで再検査する。permit_idの一致はproof条件に含めない。

4. batch 末尾は必ず次の barrier とする。

```sql
UPDATE operations
SET state='committed',result_json=?1,updated_at=unixepoch()
WHERE op_id=?2 AND state='claimed'
  AND (SELECT epoch FROM control WHERE singleton=1)=?3
  AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?2)=expected_steps;
```

> Cloudflare D1: “Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence.” [CF-D1API]

D1 `batch()` は暗黙 transaction で statement が一つでも SQL error なら全 rollback される。zero-row は成功なので、**claim batchとmutation batchの全statementについて `D1Result.meta.changes` を期待値（readは0、各proof/barrierは個別定義）と照合**する。いずれか不一致なら batch 自体が成功していても operation を論理失敗とし、次の別 batch を実行する。committed は failed へ戻さない。

```sql
UPDATE operations
SET state='failed',error_code=?1,updated_at=unixepoch()
WHERE op_id=?2 AND state='claimed'
  AND (SELECT epoch FROM control WHERE singleton=1)=?3;
```

5. catch を分離する。
   - D1 が statement error / batch rejection を応答した場合は rollback 済み。primaryで `claimed` を確認して failed 補償を書く。
   - timeout、connection loss、batch成功後の read loss は **commit不明**。補償も5xx応答もせず primaryで `operations` を再読し、同じ `claimOperation` / request digest を再送して `committed|failed` を確定する。client disconnect 時は outbox repair が同じ手順を継続する。
6. LockDO は permit 期限切れ時、D1 の当該 `operations` を読み `committed` か照合してから交差 lock を解放する。quiesce 完了条件は「space の open permit=0、かつ全期限切れ permit のD1照合完了」。MOVE は D1 commit 後に `release(permit_id,result)` を送って source lock を終了する。送信失敗は期限回収で収束する。

### 5.3 operation / outbox / derivative fencing

outbox producer は `completed` を `sent` へ戻さない。dispatch lease expiry で同じ outbox ID を再送し、consumer は result row を `(kind,blob,variant,generatorVersion)` + claim tokenでCASする。旧workerは claim token不一致なら derivativeを公開できない。job lease の checkpoint / fence / side effect は同一 D1 batch。Queue messageは小さいID参照だけとし、payloadはD1/R2から再読する。

---

## 6. upload、quota、再開

### 6.1 stream / hash contract

single PUT は zero-byte と5MiB未満を含む。multipart は最終 part以外5MiB以上かつ同一 size、最終 partだけ小さくてよい。expected sizeを受付前に決める。変換を挟む場合は `FixedLengthStream(expectedBytes)` の readable を R2へ渡し、producerとR2 consumerを同時開始する。先に `pipeTo` 完了を待たない。双方の失敗時はreader/writerをcancelする。

SHA-256 は `crypto.DigestStream('SHA-256')`。single PUT は全 stream digest と実size一致時だけ `sha256_verified` を保存する。multipart は各partのDigestStream結果を保存し、clientがcomplete時に順序付き全内容 `client_sha256` を申告する。part hashの連結をfile SHA-256と呼ばず、multipartの `sha256_verified` はNULL。hash-wasmは不採用。

### 6.2 UploadDO state machine

D1 `uploads` は `state IN ('created','uploading','completing','completed','failed','expired','aborted')`、`complete_attempts`,`r2_etag`,`cleanup_pending`,`client_sha256`,`physical_charge_state`,`epoch` を持つ。DOはpartを一行ずつ保存し、10,000 partを単一JSONにしない。

| from→to / event | 前提 | R2 / D1 / DO副作用 | 冪等鍵 | failure / response loss回収 |
|---|---|---|---|---|
| new→`created` / create | current auth、quota reservation成功 | D1 reservationとmodeを保存。multipartだけ`createMultipartUpload`→uploadIdをDO/D1保存し、zero-byte/5MiB未満はsingle PUT modeでuploadIdを作らない | `upload_id` | R2 multipart create後保存前はorphanをCronがabort。予約は`cleanup_pending`から解放 |
| `created`→`uploading` / first body or part | epoch/current credential、body/part budget | `accept_parts=1`。multipartはpart lease、singleは一つのbody leaseをSQLiteへ永続化 | `upload_id+part_no+attempt_id` | reset後はSQLiteから再構築。memory counterを使わない |
| `uploading`→`uploading` / part retry | 同part排他、既知length、期限内 | R2 `uploadPart(partNumber)`、DigestStream、成功したetag/hash/sizeだけCAS保存 | `part_no` | R2は同じpartNumber再送で上書き。最後に成功したetagだけ保持。旧attempt lease終了前に新attemptを開始しない |
| `uploading`→`completing` / complete | 全partとsize、in-flight=0、acceptPartsをCASでfalse | `complete_attempts++`、R2 complete、応答のetagを保存、single PUTはput | `upload_id+complete_attempts` | 応答喪失時は不変keyをR2 `head()`しsize/metadata/etagを照合。実在なら次へ、無い時だけcomplete再試行 |
| `completing`→`completed` | R2実在照合、current auth/revision/epoch | `fsMutation`でnode公開、reservation解放、logical/physical charge、`r2_etag`を**同じD1 batch** | operation ID | operationをprimary再読。completedは再課金しない |
| nonterminal→`failed` | fatal schema/hash/revision/attempt超過 | node非公開、cleanup_pending、reservation解放はR2実在/abort照合後 | upload ID | alarm→Cron repair。reason必須 |
| `created|uploading`→`expired` | deadline超過（request時にも検査） | acceptParts=false、R2 abort、cleanup_pending | upload ID | abort応答喪失はhead/abort再試行、課金台帳を先に減らさない |
| nonterminal→`aborted` | same credentialの明示abort | acceptParts=false、in-flight収束後R2 abort | upload ID | terminalでもcleanup_pendingを再試行可能 |

`resumeMultipartUpload()` を実在確認に使わず、Workers R2 bindingにListPartsを期待しない。D1 committed / DO非terminalはD1を正としてrepairする。old epoch uploadは `failed(reason='stale_epoch')` とし新epochに再利用しない。

### 6.3 quota / browser resume

`used_bytes` はcurrent/version/trashのowner内unique blob、`reserved_bytes`は未確定upload/copy、`physical_bytes`はstaging/orphan/GC待ちを含む実在R2 bytes。予約は `used+reserved≤quota` かつ `physical+reserved≤quota×1.2` の条件付きUPDATE。R2 completion後、`completed`確定batchでphysical chargeとlogical chargeを行い、R2 delete成功/absent確認後だけphysicalを減らす。

IndexedDBはupload ID、capability、epoch、file fingerprint、part stateだけを期限内保存し、logout/terminalで削除する。name,size,mtime,sample hashを再照合するがdedupe根拠にしない。

---

## 7. WebDAV (`/dav`, `/dav/*`) と lock

### 7.1 parser / Class 1 semantics

app password Basic over HTTPSのみ。CORS無し、browser Origin付きrequest拒否。`Authorization`は単一Basic、decode後512B以下。pathはEffectiveLiveで解決する。

XMLは `davXml.ts` adapterで fast-xml-parser を次に固定する。

```ts
{ preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
  trimValues: false, processEntities: false }
```

parse前に `<!DOCTYPE`（case-insensitive）、`<!ENTITY`、XIncludeを拒否する。`&amp; &lt; &gt; &quot; &apos;` だけを手動decodeし、他entityを拒否する。prefix文字列ではなくnamespace URI + localNameで解釈し、§13のbytes/depth/element/attribute/namespace/property予算をparse中に強制する。

PROPFINDは空body（allprop）、`allprop`,`propname`,`prop`、Depth 0/1。infinityは403 `propfind-finite-depth`。PROPPATCHはdocument order、全体transaction、失敗以降424。Destinationは設定済みHTTPS app origin、query/fragment/userinfo無し、`/dav/` prefix。Rangeは単一だけ、HEADはbodyを読まない。

### 7.2 規範 XML fixture（各30行以下）

```xml
<!-- PF-REQUESTS: empty body means allprop; the following are explicit forms -->
<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>
<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>
<D:propfind xmlns:D="DAV:" xmlns:X="urn:ncf:props">
  <D:prop><D:displayname/><D:getetag/><X:color/></D:prop>
</D:propfind>
```

```xml
<D:multistatus xmlns:D="DAV:" xmlns:X="urn:ncf:props">
 <D:response><D:href>/dav/a%20b.txt</D:href>
  <D:propstat><D:prop><D:displayname>a b.txt</D:displayname>
   <D:getetag>"node-7-3"</D:getetag></D:prop>
   <D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  <D:propstat><D:prop><X:missing/></D:prop>
   <D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
 </D:response>
 <D:response><D:href>/dav/folder/</D:href>
  <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
   <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>
```

```xml
<!-- PROPPATCH response: first property fails, dependent property is 424; DB rolls back -->
<D:multistatus xmlns:D="DAV:" xmlns:X="urn:ncf:props">
 <D:response><D:href>/dav/a.txt</D:href>
  <D:propstat><D:prop><D:getetag/></D:prop>
   <D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat>
  <D:propstat><D:prop><X:color/></D:prop>
   <D:status>HTTP/1.1 424 Failed Dependency</D:status></D:propstat>
 </D:response>
</D:multistatus>
```

```xml
<!-- LOCK existing=200, lock-null create=201; refresh has empty body + If token -->
<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
 <D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>
 <D:depth>Infinity</D:depth><D:timeout>Second-3600</D:timeout>
 <D:locktoken><D:href>opaquelocktoken:redacted</D:href></D:locktoken>
</D:activelock></D:lockdiscovery></D:prop>
<!-- UNLOCK success has status 204 and an empty body -->
```

```xml
<!-- Missing token: 423; Depth infinity PROPFIND: 403 -->
<D:error xmlns:D="DAV:"><D:lock-token-submitted>
 <D:href>/dav/locked.txt</D:href></D:lock-token-submitted></D:error>
<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>
```

```xml
<!-- COPY/MOVE: Overwrite is T|F; collection COPY Depth is 0|infinity; MOVE Depth is infinity -->
<D:multistatus xmlns:D="DAV:" xmlns:N="urn:next-cloud-flare:error">
 <D:response><D:href>/dav/src/bad.txt</D:href>
  <D:status>HTTP/1.1 423 Locked</D:status></D:response>
 <D:response><D:href>/dav/src/dependent.txt</D:href>
  <D:status>HTTP/1.1 424 Failed Dependency</D:status></D:response>
</D:multistatus>
<!-- Preflight limit rejection is 403 with <N:too-large-for-dav/>; never 507/job fallback -->
```

```http
COPY /dav/src/ HTTP/1.1
Destination: https://app.example.com/dav/dst/
Depth: infinity
Overwrite: F

MOVE /dav/src/ HTTP/1.1
Destination: https://app.example.com/dav/dst/
Depth: infinity
Overwrite: T
```

成功はCOPY新規201/上書き204、MOVE新規201/上書き204。preflight後の複数resource失敗だけ上記207 fixtureを返す。

### 7.3 Class 2 / LockDO

- lock正準resourceはnode ID。lock-nullは空nodeを作る。depth lockはcurrent ancestor relation、overwrite target、destination ancestorにも効く。
- creator principalは**user ID**。app passwordはuser principalの代理なので、同一userの別app passwordはcreator一致。service tokenは別principalでDAV非対応。
- [RFC 4918 §6.4](https://www.rfc-editor.org/rfc/rfc4918.html#section-6.4)に従い、locked mutation（PUT/DELETE/MOVE/COPY/PROPPATCH/MKCOL配下）はcurrent write権限、lock token提示、認証principal=lock creatorを全て要求する。refreshとUNLOCKも同じ規則。管理強制解除だけ別admin operation。
- token hash、creator user、creator credential（監査用）、node、display URI、depth、expiry、generation、epochをDO SQLiteへ保存する。他principalへtokenを表示しない。
- permitは`permit_id+expires_at`。期限切れでもD1 operation照合前に交差lockをgrantしない。MOVE commit後の `release(permit_id,result)` でsource lockを終了しdestinationへ継承しない。
- recoveryはmaintenance下で旧lock/permitをD1照合し、旧epochを無効化して同じDOを新epochへ再初期化する。永久stale 409にしない。

同期 DAV COPY/MOVE は同一owner、≤1,000 nodes、合計≤10GiBだけ。超過は **403** と次を返し、507やREST jobへ自動fallbackしない。

```xml
<D:error xmlns:D="DAV:" xmlns:N="urn:next-cloud-flare:error">
  <N:too-large-for-dav/>
</D:error>
```

collection ETagは strong `"<node_id>-<revision>"`。MOVE後のURI aliasとlock継承を混同しない。

---

## 8. share、ticket、content-session

### 8.1 share capability

URLは `/s/<shareId>#<secret>`。public landing JSがfragmentを読みhistoryから直ちに除去してPOST bodyへ渡す。tokenをpath/queryに置かない。share root/current subtree/action/expiry/versionへ限定し、変更・revokeでversionを進める。upload-onlyはcreateと同credential receipt/statusだけを許可しlist/read/overwrite/deleteを禁止する。internal shareはread/edit、ancestor trashで即時無効、restoreで自動復活しない。

### 8.2 CONTENT_HOST ticket 搬送

採用方式は短命 content-session Cookie。

1. Access認証SPAは `POST /api/v1/content-session`、share UIは対応public routeへ `{node_id|share_id,blob_id,scope}` のbounded集合を送る。
2. appはaudience=CONTENT_HOST、epoch、target集合、expiry≤600秒の署名ticketを返す。
3. browserは `POST https://<content>/session` を `fetch({credentials:'include'})` で呼ぶ。CORSは構成済みapp origin一つだけ、`Access-Control-Allow-Credentials:true`。
4. content hostは `__Host-ncf_cs=<opaque>` を `Secure; HttpOnly; SameSite=None; Path=/; Max-Age≤600` で設定する。以後 `/c/<node_id>/<blob_id>` とpage/entry routeはCookieで認可し、URLにsecretを置かない。
5. Cookieはtarget/scope/epoch、current credential/share version、TicketDO byte/request/concurrency budgetを毎request検査する。Range/HEAD/206/416を実装する。

単一host構成も同じhost-only `__Host-ncf_cs` を使うが、§10のCSP/attachment制限は維持する。fetch→blob URLは≤32MiBのplain text、sanitized Markdown入力、pdf.js入力だけ。大容量audio/video/image/EPUBをblob化しない。disconnect時のTicketDO並列枠は耐久lease期限で回収する。

### 8.3 ZIP / ticket budgets

ZIP ticketはmanifest hash、node+blob集合、share version、epochを束縛する。manifest作成から配信終了までblob pinを保持する。R2 readerは小さい固定並列、downstream backpressureを待つ。disconnect時はR2 reader、ZIP producer、ticket leaseをcancelする。

---

## 9. Web UI

React、TypeScript、Vite、Tailwind、shadcn/ui、TanStack Router/Query/Virtualをbrowserだけで使う。My Drive、Shared、Recent、Starred、Trash、Gallery、Bookshelf、Audio、quota、upload/job panelを提供する。optimistic updateは409/412でrollback。PWAはversioned shellだけcacheし、API/content/share/auth responseを保存しない。

`/s/*` のJS/CSSは private SPAと共有しない別bundle `public-share.[hash].js` / `public-share.[hash].css` とし、`/public-assets/*` から配信する。build manifestは `auth:'public'` とSRI hashを持ち、landingは`integrity`+`crossorigin`を必須にする。private chunkをpublic bundleへimportしたらbuild失敗。filename/tag/EXIF/errorはReact text node、`dangerouslySetInnerHTML`禁止。

---

## 9A. メディアライブラリ (Gallery / Bookshelf / Audio)

### 9A.1 Gallery

folder内画像/動画、任意recursiveを対象にし、keyset最大200件。`node_media`はwidth/height/taken_at/duration/orientation/dominant colorとbounded camera情報だけ。GPS破棄。thumbnailはsm256/md768/lg1600、lgはlazy unique claim。recursive候補50,000は§15 rows_read gateを満たす環境だけ有効にし、未合格時は10,000へ縮小する。

### 9A.2 Bookshelf / EPUB reader

EPUB、ZIP/CBZ、PDF、folder imagesをv1対象とし、CBR/RAR/7zはunsupported。archive indexはEOCD≤1MiB、central directory≤8MiBをRangeで読み、path/method/flags/size/offset/CRCを検査してR2へ保存する。entryはcentral/local header一致、暗号化/unsupported拒否、safe integer/offset overflow、enqueue前output上限、CRCを検査する。

EPUBは二重iframe。

```text
app origin
  └─ iframe https://<content>/reader/index.html
       sandbox="allow-scripts allow-same-origin"  ← trusted reader shell
       CSP: script-src 'self'
       └─ iframe sandbox                         ← publication; scripts disabled
            srcdoc = server-sanitized XHTML
```

- reader shellはアプリの静的assetで、CFI/pagination/TOC/theme/font-sizeを実装する。
- server Queue jobがXHTMLをsanitizeし、`script`,`on*`,`javascript:`,外部URLを除去してimmutable derivativeとしてR2へ保存する。shellはsanitize済みDOMを解析し、内側frame更新は新しい`srcdoc`を生成して行う。
- inner CSPは `default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:`。publication由来scriptを許可しない。
- v1はreflow、TOC、CFI位置、font size/themeのみ。固定layout、media overlay、JS依存EPUB、vertical pagination保証は非目標。

### 9A.3 Audio

MP3/FLAC/OGG/Opus/M4A/MP4/WAVのbounded tag parser。通常head≤2MiB+tail128B、MP4 moov探索≤4MiB。coverを読む追加Rangeはmetadataが示すoffset/lengthを検証し、≤20,000,000Bかつ全体Range budget内だけ実行する。field≤1KiB、folder≤2,000 tracks。content-session Cookie + single Rangeで再生する。

### 9A.4 共通認可 / job

全media routeはEffectiveLive、capability root、current blob、generation、credential scopeを検査する。index/tag/sanitize/thumb jobはoutbox、saved principal、epoch、fenced result claimを使いstale結果を公開しない。

---

## 10. stream、derivative、preview、content delivery

### 10.1 R2 delivery

`R2Bucket.get()` nullは404、conditional getのbody無しは304、HEADは`head()`でbodyを読まない。single Rangeは206/416と`Content-Range`をWorkerが構成する。multi-rangeは全size budgetを先取りできる時だけRangeを無視して200。D1 content ETagとR2 `httpEtag`を混同しない。client由来`Content-Encoding`を転記せずbyte-transparent identityで配信する。

### 10.2 ZIP / archive stream

ZIP生成は fflateの同期stream API **`Zip`,`ZipPassThrough`,`ZipDeflate` だけ**。`Async*`は禁止。`ondata`がPromiseをawaitすると思わず、bounded output queue（≤1MiB）をdrainしてから次input chunkをpushする。1,000 R2 objectの`Promise.all`、片側だけ先行する`tee()`は禁止。CRC/header/data descriptor/central directoryをoutput sizeへ含め、non-ZIP64かつUINT32_MAX未満。

ZIP展開は自前central directory parser + `DecompressionStream('deflate-raw')`。fflateを展開に使わない。local/centralのmethod/flags/name/size一致、暗号化拒否、safe integer、CRC、output≤64MiBを検査する。stream開始後CRC不一致はstream errorでありstatus変更を保証しない。

### 10.3 derivative / Images

result keyはimmutable generation。claim tuple+fenceで一workerだけを公開者にする。Images inputは20,000,000B以下、dimension/frame/app pixel budgetをheaderで先に検査し、WebPへre-encodeしてmetadataを除く。AVIF inputはEnterprise有無をstaging確認し、未対応ならunsupported。固定client thumb keyの429はbackoffし上書き競合をCASする。

### 10.4 delivery matrix / CSP

全responseにsniff済みContent-Type、`nosniff`,`Referrer-Policy:no-referrer`、private cache、適切なDispositionを付ける。206/errorでも落とさない。CONTENT_HOSTにprivate router、SPA fallback、Service Workerを置かない。

| 種別 | content host | single host | 規則 |
|---|---|---|---|
| image/video/audio | inline + Range | inline + Range | SVGをraster image扱いしない |
| PDF | pdf.jsへの≤32MiB blobまたはRange viewer | 同左 | external URL/attachment自動取得禁止 |
| text/Markdown | text、≤32MiB blob | text/Markdownはsanitize | raw HTML無効、allowlist DOM |
| HTML/SVG/Office/executable | sandbox / attachment | attachment | `default-src 'none'` |
| archive page | inline image | attachment | bounded展開 |
| EPUB shell | trusted `/reader/` | content hostと同一host時のみ | §9A.2二重iframe |
| EPUB publication | inner sandbox | attachment fallback | sanitized derivativeのみ |

app/share landingは `frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`。reader shellはapp originだけをframe ancestorに許可する。

### 10.5 output encoding

Content-DispositionはRFC 6266 `filename*` +安全ASCII fallback。Reactはtext node。DAV XMLはwriterでtext/attribute escape。JSONは標準serializer。CSVはformula prefixをneutralize。ZIP pathは認可treeから再生成し危険名/重複一件で全体拒否。logはallowlist構造化JSONでraw Request/header/URLを出さない。

---

## 11. trash、version、GC、backup / recovery

### 11.1 trash / restore / purge

`trash_ops.state` は **`pending → trashed → (restoring → restored) | (purging → purged)`** のみ。

```sql
-- 公開停止点: rootを不可視化しopをtrashedへする同一batch
UPDATE nodes SET deleted_at=unixepoch(),deleted_op_id=?1,revision=revision+1,last_op_id=?1
WHERE id=?2 AND revision=?3 AND deleted_at IS NULL
  AND (SELECT state FROM trash_ops WHERE op_id=?1)='pending'
  AND (SELECT epoch FROM control WHERE singleton=1)=?4;
UPDATE trash_ops SET state='trashed'
WHERE op_id=?1 AND state='pending' AND epoch=?2
  AND (SELECT epoch FROM control WHERE singleton=1)=?2;

-- restore claim。purgingへ入った後は不可能
UPDATE trash_ops SET state='restoring'
WHERE op_id=?1 AND state='trashed' AND epoch=?2
  AND (SELECT epoch FROM control WHERE singleton=1)=?2;

-- purge不可逆点
UPDATE trash_ops SET state='purging'
WHERE op_id=?1 AND state='trashed' AND epoch=?2
  AND NOT EXISTS(SELECT 1 FROM gc_candidates g WHERE g.trash_op_id=?1 AND g.pinned_by IS NOT NULL)
  AND (SELECT epoch FROM control WHERE singleton=1)=?2;
```

共有/ticketが失効する公開時点は`trashed` commit。restoreは全descendant処理と旧share失効記録を終えた最後のbatchでrootをlive化し`restored`へする。purge staging parentは実体nodeを作らず、manifest cursorで子→親順に削除する。`purging`がrestore不可の不可逆点。

### 11.2 GC / pins

```sql
CREATE TABLE blob_pins (
  pin_id TEXT NOT NULL PRIMARY KEY, blob_id TEXT NOT NULL REFERENCES blobs(id),
  purpose TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX blob_pins_blob ON blob_pins(blob_id);
CREATE TABLE gc_candidates (
  blob_id TEXT NOT NULL PRIMARY KEY REFERENCES blobs(id),
  trash_op_id TEXT, state TEXT NOT NULL CHECK(state IN ('candidate','deleting','deleted')),
  pinned_by TEXT, not_before INTEGER NOT NULL, last_error TEXT
) STRICT;
```

`gc_candidates.pinned_by` は現在GCを止めるpin/fence ID（複数pinの権威は`blob_pins`行）。pin追加/削除とmaterialized `pinned_by`を同batchで更新する。`deleting`遷移はref=0、pin row無し、`pinned_by IS NULL`を同じ文で再検査し、ここをR2 deleteの不可逆点とする。delete成功/absent後だけphysical bytesを減らす。

### 11.3 logical backup / restore with FTS

D1 exportはvirtual tableを含むDBで未対応 [CF-D1EXPORT]。backup対象は**通常tableだけ**で、`operations`,`operation_steps`,`outbox`,`mutation_journal`を含む。FTS virtual/shadow tableは含めない。

1. backup開始時、短いwrite barrier batchで新しいULID `control.backup_barrier` を書き、そのbarrier以降の全mutationをjournalへ記録する。
2. bounded logical scanをR2へ書き、start/end watermark間のupsert/tombstoneをcommit順に適用する。checksumとrestore probe後だけgenerationを公開する。
3. restoreはmaintenance + GC pause、permit quiesce後に通常tableを復元する。
4. FTS shadow tableを空の状態で作り、次の実SQLでbase tableから `search_index` を再構築する。

```sql
INSERT INTO search_index(rowid,normalized_name,title,author,series,tags,audio)
SELECT rowid,normalized_name,title,author,series,tags,audio
FROM node_search ORDER BY rowid;
```

5. backup barrier以降のoperation IDを `failed(error_code='RESTORE_BARRIER')` とし、outbox/leaseを再生成する。
6. `control.epoch += 1` を確定してControlDOへ同期し、旧UploadDOをfailed(stale_epoch)、LockDOを旧permit照合後に新epoch再初期化する。
7. R2 existence/quota/ref/bootstrap/share version/app passwordを照合後にmaintenance、最後にGCを解除する。

日次backup、D1 Time Travel、月1回のstaging restore drillを運用条件とする。R2だけからnamespaceを再構築できるとは主張しない。

---

## 12. list、search、Gallery、ancestor SQL

### 12.1 children / PROPFIND Depth:1

REST一覧は最大200/pageのkeyset。次のcovering index/queryによりfolder全体をoffset scanしない。

```sql
CREATE INDEX nodes_children_keyset
ON nodes(parent_id,name_ci,id) WHERE deleted_at IS NULL;
SELECT id,name,kind,revision,current_blob_id,updated_at
FROM nodes INDEXED BY nodes_children_keyset
WHERE parent_id=?1 AND deleted_at IS NULL
  AND (name_ci>?2 OR (name_ci=?2 AND id>?3))
ORDER BY name_ci,id LIMIT ?4;
```

PROPFIND Depth:1は親のEffectiveLiveを一回証明し、最大1,000 childを一 queryで集合取得する。propertyはLEFT JOINで集合化し、nodeごとのD1/DO callを禁止する。1,000超はcount preflight後507、lockdiscoveryはLockDOへnode ID集合をbounded JSON一回で照会する。

```sql
SELECT n.id,n.name,n.kind,n.revision,n.current_blob_id,p.name AS prop_name,p.value AS prop_value
FROM nodes n LEFT JOIN node_props p ON p.node_id=n.id
WHERE (n.id=?1 OR n.parent_id=?1) AND n.deleted_at IS NULL
ORDER BY CASE WHEN n.id=?1 THEN 0 ELSE 1 END,n.name_ci,n.id;
```

### 12.2 FTS / scope-aware search

```sql
CREATE TABLE node_search (
  rowid INTEGER PRIMARY KEY, node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id),
  space_id TEXT NOT NULL, normalized_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
  series TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
  audio TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL
) STRICT;
CREATE INDEX node_search_scope ON node_search(space_id,node_id);
CREATE VIRTUAL TABLE search_index USING fts5(
  normalized_name,title,author,series,tags,audio,
  content='node_search',content_rowid='rowid',tokenize='unicode61'
);
```

日本語bigramはapplicationでversion固定tokenをbase columnへ生成する。FTS候補を10,000で打切り、scope subtree / EffectiveLiveと集合joinして最大200を返す。候補打切り時は`incomplete=true`を返しcount/facetを推定値にしない。

```sql
WITH RECURSIVE scope(id,depth) AS (
 SELECT ?1,0 UNION ALL
 SELECT n.id,scope.depth+1 FROM nodes n JOIN scope ON n.parent_id=scope.id
 WHERE n.deleted_at IS NULL AND scope.depth<64
), hits AS (
 SELECT ns.node_id,bm25(search_index) rank
 FROM search_index JOIN node_search ns ON ns.rowid=search_index.rowid
 WHERE search_index MATCH ?2 AND ns.space_id=?3 LIMIT 10000
)
SELECT n.id,n.name,n.kind,h.rank
FROM hits h JOIN scope s ON s.id=h.node_id JOIN nodes n ON n.id=h.node_id
WHERE n.deleted_at IS NULL ORDER BY h.rank,n.id LIMIT ?4;
```

LIKE fallbackはescape追加後pattern≤50B、scope内10,000候補まで。一文字global scanは禁止。

### 12.3 Gallery / media list

recursive Galleryは一つのsubtree CTEで候補集合を作り、`node_media`をjoinしてkeysetで200件を返す。候補ごとのancestor queryは禁止。

```sql
WITH RECURSIVE sub(id,depth) AS (
 SELECT ?1,0 UNION ALL
 SELECT n.id,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id
 WHERE n.deleted_at IS NULL AND sub.depth<?2
)
SELECT n.id,n.name,m.width,m.height,m.taken_at,m.duration_ms
FROM sub JOIN nodes n ON n.id=sub.id JOIN node_media m ON m.node_id=n.id
WHERE (COALESCE(m.taken_at,n.updated_at)<?3 OR
      (COALESCE(m.taken_at,n.updated_at)=?3 AND n.id>?4))
ORDER BY COALESCE(m.taken_at,n.updated_at) DESC,n.id LIMIT 200;
```

---

## 13. 制限、error mapping、依存ライブラリ、security

### 13.1 Cloudflare platform limit の正本

| 対象 | 公式値 / v1扱い | 一次資料 |
|---|---|---|
| HTTP | body Free/Pro 100MB、Business 200MB、Enterprise最大5GB。URL16KB、request/response header各128KB、response body強制上限無し | [CF-W] |
| Worker | Paid CPU default30s/max300s、memory128MB/**isolate**、subrequest10,000、初期接続待ち6、`waitUntil`最大30s | [CF-W] |
| bundle/assets/Cron | bundle非圧縮64MiB、startup1s、Paid assets100,000、1file25MiB、Cron250/account、wall15min、<1h CPU30s/≥1h CPU15min | [CF-W] |
| D1 | 10GB/DB、1TB/account既定、1,000query/invocation、bind100/**statement**、SQL100,000B、row/string/blob2,000,000B、100 columns、LIKE/GLOB50B、queryおよびbatch全体30s、Time Travel30日/10 restore per10min | [CF-D1L] |
| SQLite DO | 10GB/object、key+value/row2MB、SQL100KB、bind100、soft1,000req/s、CPU30s/max300s | [CF-DOL] |
| DO alarm | objectごと同時1、at-least-once、2秒から指数backoff、最大6 retry | [CF-DOA] |
| Queues | message128KB（decimal、内部metadata約100B含む）、consumer batch100、sendBatch100件かつ256KB、retry≤100、5,000msg/s、consumer並列250、wall15min、retention既定4日/最大14日 | [CF-QL] [CF-QC] |
| R2 | key1,024B、metadata8,192B、object約5TiB、multipart≤10,000、part5MiB–5GiB（最終以外同size、最終だけ小可）、同key write 1/s | [CF-R2L] [CF-R2U] |
| Images | binding input最大20MB=20,000,000B。AVIF inputはEnterprise条件。dimension/animation制限も適用 | [CF-IMG] [CF-IMGL] |
| KV | key512B、metadata1,024B、value25MiB、same-key write1/s、cacheTtl≥30s、1,000 ops/invocation | [CF-KVL] |
| Rate limit | period10/60秒、PoP local・permissive・eventual | [CF-RL] |

KVの1,000 opsとWorkers共通subrequest表の関係は文書脚注に曖昧さがあるため、v1はKV≤1,000/invocationで実装し staging で要確認。DO `blockConcurrencyWhile` callbackの30秒timeout [CF-DOS] もstaging fault test対象とし、長いI/Oには使わない。

### 13.2 app limits

| 項目 | v1の安全側上限 |
|---|---|
| request/header | `MAX_REQUEST_BYTES=95,000,000`、URL≤8KiB、header合計≤64KiB、header数≤100、token≤2KiB |
| JSON/XML | JSON≤1MiB/depth32。XML≤1MiB/depth32/elements10,000/attributes20,000/namespaces100/properties100/value8KiB/response32MiB |
| name/tree | NFC UTF-8≤255BかつUnicode scalar<255、casefold列≤1,024B、depth≤64 |
| upload | default64MiB、非最終part8–90MiB（platform最低5MiB）、最終part>0–90MiB、≤10,000 parts、file≤500GiB、zero-byteはsingle PUT、in-flight4、part15min、作成6日/無進捗24h |
| Queue | app message≤120,000B、sendBatch合計≤240,000B、delivery retry≤10、app transform attempt≤3、retention14日を明示設定 |
| image | input≤20,000,000B、width/height各≤12,000、area≤40MP、frame1、WASM image transform不採用 |
| list/search | REST page200、DAV Depth:1 children1,000、Gallery page200/candidate50,000、search candidate10,000、tracks2,000 |
| DAV COPY/MOVE | same-owner、≤1,000 nodes、≤10GiB。超過403 custom error |
| ZIP/archive | output<4GiB/non-ZIP64、entries1,000、archive entries10,000、entry output64MiB、total8GiB、CD8MiB、EOCD1MiB |
| ticket/content session | ticket≤6h、session Cookie≤600s、bytes≤size×3、requests≤1,024、parallel≤8、blob URL≤32MiB |
| KDF | PBKDF2-SHA256 100,000、salt16B、DK32B。600,000はstaging gate |
| retention | versionsは「直近10件**または**30日のいずれか長い方」、operation/audit90日、R2 audit1年、backup5世代、GC grace35日、RPO24h、RTOは要確認(staging drill) |
| D1 capacity | node≤200,000/userに加えDB 10GBの70%で新規user停止、80%でwrite alert、90%でmaintenance |

### 13.3 Cloudflare exception → HTTP mapping

| source / condition | HTTP | client retry | 規則 |
|---|---:|---|---|
| edge body上限 / app body超過 | 413 | no | multipartへ切替 |
| malformed/unknown schema/XML budget | 400 | no | RFC9457 / DAV XML |
| D1 constraint / revision CAS | 409/412 | conditional | fresh state取得、同op IDはreplay |
| D1 overloaded/timeout、commit不明 | 503ではなくまず照合 | yes | §5.2で終端確定後だけ応答 |
| DO overloaded / reset | 503 | yes | `Retry-After` + idempotency key |
| old UploadDO epoch | 409 | no | 新upload作成 |
| lock missing/mismatch | 423 | after token | `lock-token-submitted` |
| quota | 507 | after freeing | DAV大規模COPY/MOVEには使わない |
| R2 conditional put `null` | 412 | after refresh | 例外扱いしない |
| R2 absent | 404 / repair503 | conditional | D1 committed blob不在はrepair503 |
| R2 same-key 429 | 503 | yes | jitter backoff、不変key/claim照合 |
| Queue 429 / backlog full | 503 to producer | internal yes | outboxをpendingのままretry |
| Images size/format | 413/415 | no | original attachmentは可能 |
| Rate Limiting `{success:false}` | 429 | yes | `Retry-After`、厳密quotaに使わない |
| Worker CPU/memory 1102 | 503 | idempotent only | algorithm縮小、streaming |

### 13.4 security / audit

CSP/MIMEは§10.4、CSRFは§5.1を正本とする。secret/PIIをURLに置かず、Authorization/Cookie/JWT/Basic/Service secret/share secret/CSRF/upload capability/ticket/D1 bindをlogしない。Workers Logs/Tail/Logpush/trace/WAF/D1 errorをcanaryで検査する。admin/deploy/secret/Access policy変更はMFA、最小権限、two-person approval、外部audit archive。

### 13.5 dependency contract

全versionは`package.json`でexact固定しlockfileをcommitする。Phase 0時点で7日未満のreleaseは採用しない。

| 名前 | 用途 | Workers上の制約 | 禁止API / 用法 |
|---|---|---|---|
| `hono` | route / middleware | binary routeでbody parserを通さない | manifest外route |
| `@hono/zod-openapi` | schema / OpenAPI | Hono/Zod互換版をexact固定 | 別package `zod-openapi`との混同 |
| `fast-xml-parser` | DAV XML lexical parse | 必ず`davXml.ts` adapter + §7設定 | direct import、DTD/entity自動処理 |
| `fflate` | ZIP生成 | sync streamingだけ、bounded queue | `Async*`, worker API、ZIP展開 |
| Web Crypto | SHA/KDF/HMAC | `crypto.DigestStream`, `subtle` | hash-wasm、全body `subtle.digest` |
| `pdfjs-dist` | browser PDF | worker/CMapをpublic/static bundle、CSP調整 | Worker server側DOM/Canvas |
| React/TanStack | browser UI | SSR無し、private/public bundle分離 | runtime WorkerでDOM利用 |
| `@cloudflare/vitest-pool-workers` | integration test | version固定、Miniflare fidelityを過信しない | staging gateの代替 |

[CF-W]: https://developers.cloudflare.com/workers/platform/limits/
[CF-D1L]: https://developers.cloudflare.com/d1/platform/limits/
[CF-D1API]: https://developers.cloudflare.com/d1/worker-api/d1-database/
[CF-D1EXPORT]: https://developers.cloudflare.com/d1/best-practices/import-export-data/
[CF-DOL]: https://developers.cloudflare.com/durable-objects/platform/limits/
[CF-DOS]: https://developers.cloudflare.com/durable-objects/api/state/
[CF-DOA]: https://developers.cloudflare.com/durable-objects/api/alarms/
[CF-R2L]: https://developers.cloudflare.com/r2/platform/limits/
[CF-R2U]: https://developers.cloudflare.com/r2/objects/upload-objects/
[CF-QL]: https://developers.cloudflare.com/queues/platform/limits/
[CF-QC]: https://developers.cloudflare.com/queues/configuration/configure-queues/
[CF-IMG]: https://developers.cloudflare.com/images/optimization/binding/
[CF-IMGL]: https://developers.cloudflare.com/images/get-started/limits/
[CF-KVL]: https://developers.cloudflare.com/kv/platform/limits/
[CF-RL]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
[CF-WR]: https://developers.cloudflare.com/workers/wrangler/configuration/

---

## 14. config、deploy、DO容量、運用

### 14.1 deployable `wrangler.jsonc`

設定キーはWrangler一次資料 [CF-WR] に合わせる。`<...>` はCI secret/resource inventoryで実値へ置換してschema validation後にdeployする。bindingはenvへ継承されないためstaging/productionに全て明記する。

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "next-cloud-flare",
  "main": "packages/worker/src/index.ts",
  "compatibility_date": "2026-09-21",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "limits": { "cpu_ms": 300000 },
  "assets": {
    "directory": "packages/web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },
  "d1_databases": [{
    "binding": "DB", "database_name": "ncf-dev", "database_id": "<DEV_D1_ID>",
    "migrations_dir": "packages/worker/migrations"
  }],
  "r2_buckets": [
    { "binding": "BLOBS", "bucket_name": "ncf-dev-blobs" },
    { "binding": "BACKUPS", "bucket_name": "ncf-dev-backups" }
  ],
  "kv_namespaces": [{ "binding": "CACHE", "id": "<DEV_KV_ID>" }],
  "durable_objects": { "bindings": [
    { "name": "LOCKS", "class_name": "LockDO" },
    { "name": "UPLOADS", "class_name": "UploadDO" },
    { "name": "TICKETS", "class_name": "TicketDO" },
    { "name": "CONTROL", "class_name": "ControlDO" }
  ]},
  "migrations": [{
    "tag": "v1-sqlite-do",
    "new_sqlite_classes": ["LockDO", "UploadDO", "TicketDO", "ControlDO"]
  }],
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "ncf-dev-jobs" }],
    "consumers": [{
      "queue": "ncf-dev-jobs", "max_batch_size": 10, "max_batch_timeout": 5,
      "max_retries": 10, "dead_letter_queue": "ncf-dev-jobs-dlq", "max_concurrency": 8
    }]
  },
  "images": { "binding": "IMAGES" },
  "ratelimits": [{
    "name": "EDGE_LIMITER", "namespace_id": "1001",
    "simple": { "limit": 300, "period": 60 }
  }],
  "triggers": { "crons": ["17 * * * *", "23 2 * * *", "0 3 * * SUN"] },
  "vars": {
    "ENVIRONMENT": "development", "APP_ORIGIN": "https://dev.invalid",
    "CONTENT_ORIGIN": "https://content.dev.invalid", "ACCESS_ISSUER": "<DEV_ACCESS_ISSUER>",
    "ACCESS_USER_AUD": "<DEV_USER_AUD>", "ACCESS_SERVICE_AUD": "<DEV_SERVICE_AUD>",
    "PBKDF2_ITERATIONS": "100000", "OWNER_EMAILS": "<DEV_OWNER_EMAILS>"
  },
  "env": {
    "staging": {
      "name": "next-cloud-flare-staging",
      "routes": [
        { "pattern": "staging-app.example.com", "custom_domain": true },
        { "pattern": "staging-content.example.com", "custom_domain": true }
      ],
      "d1_databases": [{
        "binding": "DB", "database_name": "ncf-staging", "database_id": "<STAGING_D1_ID>",
        "migrations_dir": "packages/worker/migrations"
      }],
      "r2_buckets": [
        { "binding": "BLOBS", "bucket_name": "ncf-staging-blobs" },
        { "binding": "BACKUPS", "bucket_name": "ncf-staging-backups" }
      ],
      "kv_namespaces": [{ "binding": "CACHE", "id": "<STAGING_KV_ID>" }],
      "durable_objects": { "bindings": [
        { "name": "LOCKS", "class_name": "LockDO" },
        { "name": "UPLOADS", "class_name": "UploadDO" },
        { "name": "TICKETS", "class_name": "TicketDO" },
        { "name": "CONTROL", "class_name": "ControlDO" }
      ]},
      "queues": {
        "producers": [{ "binding": "JOBS", "queue": "ncf-staging-jobs" }],
        "consumers": [{
          "queue": "ncf-staging-jobs", "max_batch_size": 10, "max_batch_timeout": 5,
          "max_retries": 10, "dead_letter_queue": "ncf-staging-jobs-dlq", "max_concurrency": 8
        }]
      },
      "images": { "binding": "IMAGES" },
      "ratelimits": [{
        "name": "EDGE_LIMITER", "namespace_id": "2001",
        "simple": { "limit": 300, "period": 60 }
      }],
      "vars": {
        "ENVIRONMENT": "staging", "APP_ORIGIN": "https://staging-app.example.com",
        "CONTENT_ORIGIN": "https://staging-content.example.com", "ACCESS_ISSUER": "<STAGING_ACCESS_ISSUER>",
        "ACCESS_USER_AUD": "<STAGING_USER_AUD>", "ACCESS_SERVICE_AUD": "<STAGING_SERVICE_AUD>",
        "PBKDF2_ITERATIONS": "100000", "OWNER_EMAILS": "<STAGING_OWNER_EMAILS>"
      }
    },
    "production": {
      "name": "next-cloud-flare-production",
      "routes": [
        { "pattern": "app.example.com", "custom_domain": true },
        { "pattern": "content.example.com", "custom_domain": true }
      ],
      "d1_databases": [{
        "binding": "DB", "database_name": "ncf-production", "database_id": "<PRODUCTION_D1_ID>",
        "migrations_dir": "packages/worker/migrations"
      }],
      "r2_buckets": [
        { "binding": "BLOBS", "bucket_name": "ncf-production-blobs" },
        { "binding": "BACKUPS", "bucket_name": "ncf-production-backups" }
      ],
      "kv_namespaces": [{ "binding": "CACHE", "id": "<PRODUCTION_KV_ID>" }],
      "durable_objects": { "bindings": [
        { "name": "LOCKS", "class_name": "LockDO" },
        { "name": "UPLOADS", "class_name": "UploadDO" },
        { "name": "TICKETS", "class_name": "TicketDO" },
        { "name": "CONTROL", "class_name": "ControlDO" }
      ]},
      "queues": {
        "producers": [{ "binding": "JOBS", "queue": "ncf-production-jobs" }],
        "consumers": [{
          "queue": "ncf-production-jobs", "max_batch_size": 10, "max_batch_timeout": 5,
          "max_retries": 10, "dead_letter_queue": "ncf-production-jobs-dlq", "max_concurrency": 8
        }]
      },
      "images": { "binding": "IMAGES" },
      "ratelimits": [{
        "name": "EDGE_LIMITER", "namespace_id": "3001",
        "simple": { "limit": 300, "period": 60 }
      }],
      "vars": {
        "ENVIRONMENT": "production", "APP_ORIGIN": "https://app.example.com",
        "CONTENT_ORIGIN": "https://content.example.com", "ACCESS_ISSUER": "<PRODUCTION_ACCESS_ISSUER>",
        "ACCESS_USER_AUD": "<PRODUCTION_USER_AUD>", "ACCESS_SERVICE_AUD": "<PRODUCTION_SERVICE_AUD>",
        "PBKDF2_ITERATIONS": "100000", "OWNER_EMAILS": "<PRODUCTION_OWNER_EMAILS>"
      }
    }
  }
}
```

queue作成後に `wrangler queues update <queue> --message-retention-period-secs 1209600` をstaging/productionで適用しIaC driftを検査する。secretは`SIGNING_KEYS`,`APP_PASSWORD_HMAC_KEYS`を`wrangler secret`で環境別登録する。`DEV_BYPASS_ACCESS`はstaging/production schemaで禁止。

### 14.2 DO capacity / alarm / eviction

| DO | v1 in-flight / storage上限 | alarm retry枯渇 | eviction / stale再初期化 | 必須試験 |
|---|---|---|---|---|
| LockDO | open permit≤64/space、lock≤10,000/space、SQLite警戒8GiB | 6 retry後repair flag、hourly CronがD1照合 | SQLiteからlock/permit復元。old epochはmaintenance+D1照合後に全失効しnew epochへ | reset中permit expiry、同一space負荷、parallel slot leak |
| UploadDO | part in-flight≤4/upload、part rows≤10,000、SQLite警戒64MiB | 6 retry後cleanup_pending、CronがR2 head/abort | SQLite part/leaseから復元。old epochはfailed(stale_epoch) | upload中reset、same part競合、complete loss、slot leak |
| ControlDO | mutation admission≤32/account、KDF実行1/instance、待ちqueue≤256 | 6 retry後maintenance維持、外部Cron/管理probe | 自身SQLiteのepochを正本として復元しD1 controlと不一致ならfail closed | overload、epoch切替、queue leak、single point load |

alarmは最短deadline一つに集約し処理後に次を設定する。alarm遅延に備え全requestでexpiryを検査する。shutdown hook/finallyをlease回収根拠にしない。

### 14.3 operations

deploy後にAccess path、Bypass、public asset、content CORS/Cookie、unknown route、host/alias、workers.dev、preview URL、R2 public access、HTTPSを実HTTP検査する。backup/restore drillは月1回。D1 70/80/90%閾値、DO storage、Queue/outbox age、alarm repair、permit、upload cleanup、GC pin、KDF、R2 429、rows_readを監視する。

---

## 15. test plan / acceptance

### 15.1 D1 query budget fixtures

`rows_read` とdurationは実D1 `meta` で測る。Tはrelease gateであり、local成功だけでは確定しない。超過時はindex/queryを修正し上限を広げない。

| fixture / path | query数 N | bind/statement | rows_read M | duration T | 期待 |
|---|---:|---:|---:|---:|---|
| children 1,000 / REST page200 | ≤2 | ≤8 | ≤450 | ≤50ms | 200 + cursor |
| children 10,000 / REST page200 | ≤2 | ≤8 | ≤450 | ≤50ms | offset無しで同予算 |
| children 1,000 / PROPFIND Depth:1 | ≤4 | ≤12 | ≤5,000 | ≤150ms | ≤32MiB 207 |
| children 10,000 / PROPFIND Depth:1 | ≤2 preflight | ≤4 | ≤10,100 | ≤150ms | stream前507 |
| search candidate10,000 | ≤3 | ≤12 | ≤20,000 | ≤250ms | max200/incomplete flag |
| Gallery candidate50,000 | ≤3 | ≤12 | ≤60,000 | ≤300ms | max200、未達ならcandidate10,000 |
| ancestor depth64 | 1 | 2 | ≤65 | ≤50ms | EffectiveLive true |
| MOVE src+dst depth64 | ≤4 | ≤16 | ≤260 | ≤150ms | cycle/epoch/CAS proof |

200件/pageは「返却200=rows_read200」ではなく、covering keyset indexによりM≤450を実測する契約。`IN`分割 fixtureは99/100/101/2,000 IDsで各statement≤100 bindを検査する。

### 15.2 CI 三段階

1. **unit**: Vitest pure TypeScript。decoder、normalization、authorize matrix、state machine、XML budget/entity、ZIP central parser、error mapping、manifest completeness。
2. **integration**: `@cloudflare/vitest-pool-workers` + Miniflare。D1 migration/FK/FTS/batch rollback/meta.changes、R2 multipart/Range、DO SQLite/reset/alarm、Queues duplicate/ack/retry、stream backpressure、outbox fence、failure injection。
3. **staging smoke**: `wrangler deploy --env staging` で実Cloudflareへ配備。Access Bypass/Service Auth、CONTENT_HOST Cookie+CORS+Range、PBKDF2 100k/600k受理、Images 20MB/codec、Queue実配信、D1 rows_read/30s、R2 response loss、DO eviction、restore drill、platform log canaryを検査する。

Miniflareで確認できる範囲と、localでは再現または保証できずstagingが必須の範囲:

| 対象 | unit / Miniflare integration | staging必須 |
|---|---|---|
| Access | fixture JWT、issuer/AUD、route境界 | edge policy、IdP/MFA、header付与、logout伝播、実Cookie |
| edge HTTP | app 95MB制限、stream byte count | zone body limit、CL/TE正規化、実client framing |
| Worker | bounded algorithm、cancel/slow consumer | production CPU/memory enforcement、isolate concurrency、runtime update |
| D1 | migration/FK/FTS/batch rollback | actual rows_read/duration、overload、replica lag、Time Travel |
| R2 | multipart/Range基本API | same-key 1/s、lifecycle、各response loss、実整合性 |
| DO | SQLite/state/alarm handler/reset fault | placement/eviction/overload/version混在、alarm retry枯渇 |
| Queues | producer→consumer、duplicate/ack/retry | consumer concurrency、実delivery/retention/DLQ |
| Images | offline width/height/rotate/format | codec/metadata除去/20MB境界/AVIF plan、service負荷 |
| Rate limit | local simulationの分岐/key/429 | multi-PoP/isolateの緩い整合性 |
| Cron | `scheduled` handler明示呼出し | scheduler伝播、重複、実wall/CPU |
| browser/DAV | Playwright/litmus/rclone automation | SameSite=None、browser差、Finder/Explorer実機 |

### 15.3 failure / protocol release gate

- D1 statement errorは全rollback、全zero-rowはlogical failed補償、commit response lossはoperation照合まで5xxを返さない。
- permit期限、DO reset、release loss、old request再開、quiesce条件を注入しlock違反無し。
- part retry、late old part、complete response loss、abort/expire、physical chargeを収束。
- trash公開点、restore最終公開、purging不可逆、複数GC pinを検証。
- wrong JWT issuer/AUD/alg/time、unknown kid、credential revoke、ancestor trash、CSRF、secret log漏えいを拒否。
- XML fixture、litmus、PROPFIND finite depth、creator一致、COPY/MOVE 403 custom errorを検証。
- reader二重iframe、publication script/event/external URL除去、public bundle SRI、content-session Cookie、Rangeを実browser検証。
- ZIP slow consumer/disconnect、archive CRC/ZIP64/暗号化/overflow、fflate Async import禁止を検証。

---

## 16. 実装 phase / deliverable

完了欄の `M/U/I/R` は migration / unit / integration / rollback手順を意味し、該当しない場合も `N/A` を記録する。

| ID | deliverable | 導入する不変条件 | 依存 | 完了条件 |
|---|---|---|---|---|
| 0.1 | runtime/binding + PBKDF2/Images spike | 固定date/flag、全binding、100k/600k受理、20MB境界 | none | M:N/A, U:Env/KDF vector, I:staging binding/KDF/Images, R:100k+前version |
| 0.2 | D1 batch barrier spike | error rollback、zero-row/meta判定、commit不明分類 | 0.1 | M:probe schema, U:result classifier, I:実D1 loss injection, R:probe DB破棄 |
| 0.3 | R2 stream/Range/Digest/fflate spike | known length、206/416、SHA、Async無し、bounded ZIP | 0.1 | M:N/A, U:range/hash/CRC, I:95MB/slow client/ZIP, R:object cleanup |
| 1.1 | complete migration + primary adapter | FK/CHECK/index/control/FTS、権威read、bind≤100 | 0.2 | M:up/down rehearsal, U:schema/SQL counter, I:D1 migration, R:restore snapshot |
| 1.2 | route/auth foundation | manifest外404、principal分離 | 0.1,1.1 | M:auth tables, U:manifest/JWT, I:Access fixture, R:routes disable |
| 1.3 | authorize tuples / EffectiveLive | 全operand・ancestor認可 | 1.2 | M:indexes, U:matrix, I:depth64/trash, R:deny-all flag |
| 1.4 | LockDO core / permits | permit期限はD1照合後解放 | 1.1,1.3 | M:DO schema, U:lock graph, I:reset/expiry, R:maintenance invalidate |
| 1.5 | one create mutation + outbox | proof/barrier/replay、at-least-once fenced publish | 1.4 | M:steps/outbox, U:expected changes/lease, I:failure/duplicate/DLQ, R:failed repair/requeue |
| 1.6 | fence / recovery foundation | epoch/quiesce/new LockDO epoch | 1.5 | M:epoch fields, U:state transitions, I:old request, R:maintenance |
| 2.1 | immutable blob transfer/read | R2不変、single SHA verified、Range | 0.3,1.5 | M:blob schema, U:ETag, I:stream, R:GC candidate |
| 2.2 | node create | parent proof、name unique、tree CAS | 1.5,2.1 | M:N/A, U:name/parent, I:claim race, R:failed op repair |
| 2.3 | overwrite content | new blob公開とold ref減算が同batch | 2.1,2.2 | M:version indexes, U:quota/ref, I:response loss, R:reconcile |
| 2.4 | rename / MOVE | cycle proof、tree CAS、MOVE lock release | 1.4,2.2 | M:N/A, U:cycle/path, I:permit race, R:journal replay |
| 2.5 | same-owner COW | ref/quota同batch | 2.3,2.4 | M:COW indexes, U:ref ledger, I:copy/delete, R:reconcile |
| 3.1 | upload create/reservation | state created、orphan回収 | 2.1,1.5 | M:upload tables, U:quota, I:create loss, R:abort orphan |
| 3.2 | multipart part/status/resume | durable in-flight、last etag | 3.1,0.3 | M:part rows, U:size/hash, I:retry/reset, R:abort |
| 3.3 | complete reconciliation | R2 head確認、physical charge同batch | 3.2,1.5 | M:complete fields, U:machine, I:response loss, R:repair |
| 3.4 | abort/expire/cleanup | terminalとcleanup分離 | 3.3 | M:cleanup fields, U:alarm, I:retry exhaustion, R:Cron repair |
| 3.5 | cross-owner copy job | pin+reservation+multipart | 2.5,3.4 | M:job checkpoint, U:budget, I:resume, R:cancel/reconcile |
| 4.1 | trash | trashedが同期公開停止点 | 2.4 | M:trash schema, U:SQL guards, I:share invalidation, R:restore |
| 4.2 | restore / purge / GC | root最終公開、purging不可逆、pins | 4.1,1.5 | M:GC tables, U:state/pin, I:delete loss, R:pause GC |
| 4.3 | logical backup / restore | normal tables only、FTS rebuild、epoch+1 | 4.2,1.6 | M:journal, U:watermark, I:restore drill, R:previous generation |
| 5.1 | list/search/FTS/stats | query/rows budget、scope join | 1.3,1.5,4.3 | M:FTS/index, U:tokenizer, I:§15 fixtures, R:disable FTS |
| 6.1 | content-session/delivery | URL secret無し、Cookie target budget | 2.1,1.2 | M:session tables, U:claims/CORS, I:browser Range, R:attachment only |
| 6.2 | sharing/public bundle/ZIP | public/private asset分離、SRI、pin | 6.1,0.3 | M:share tables, U:capability/ZIP, I:anonymous E2E, R:revoke version |
| 7.1 | WebDAV Class1/XML props | adapter budgets、集合PROPFIND | 5.1,2.4 | M:props, U:fixtures, I:litmus, R:disable DAV |
| 7.2 | WebDAV Class2/COPY-MOVE | creator一致、同期上限、permit | 7.1,1.4,2.5 | M:lock schema, U:If parser, I:clients/races, R:invalidate locks |
| 8.1 | Gallery / derivatives | generation fence、Images budget | 1.5,5.1 | M:media tables, U:EXIF, I:Images/cost, R:disable jobs |
| 8.2 | Bookshelf / EPUB/PDF | bounded archive、sanitized二重iframe | 6.1,8.1 | M:library tables, U:ZIP/XML sanitizer, I:browser CSP, R:attachment only |
| 8.3 | Audio / player | bounded tag/cover/Range | 6.1,8.1 | M:audio tables, U:parser, I:Range/player, R:metadata off |

各phaseの完了条件は、**そのphaseが導入する不変条件と、既存phaseに対する回帰試験**である。FoundationはSQL barrier、認可、epoch、fenceの最小fixtureを必須とし、未実装surfaceのrelease gate通過を要求しない。

---

## 17. 機能提供 roadmap

| 項目 | v1 | 後段 / 非目標 |
|---|---|---|
| files / versions | immutable blob、内部version保持 | version history UIは後段 |
| sharing | link/internal/upload-only/edit、ZIP | group/team/reshareは後段 |
| DAV | Class1/2、creator一致、bounded COPY/MOVE | Nextcloud固有API/change tokenは後段 |
| media | Gallery、reflow EPUB/CBZ/PDF、Audio | fixed EPUB/DRM/RAR/7z/波形は非目標 |
| search | name/media metadata | OCR/本文全文検索は非目標 |
| recovery | logical backup、FTS rebuild、monthly drill | cross-account backup/replicationは後段 |

---

## 18. 後段・staging で確定する事項

1. **PBKDF2**: production相当stagingで100,000回の受理/CPU/並列を確認し、さらに600,000回がAPIに受理され予算内なら環境設定で引上げる。未合格なら100,000を維持。scryptは採用しない。
2. **D1 query budget**: §15.1のrows_read/durationを実dataset（children1,000/10,000、depth64、search10,000、Gallery50,000）で測る。未合格時はpage/candidateを縮小。
3. **platform曖昧値**: KV call上限、DO `blockConcurrencyWhile` timeout、Images AVIF/codec、zone95MB、Rate Limiting PoP差を実測し、断定しない。
4. **RTO**: 月次restore drillで測定して運用SLOを決める。RPO24hだけを先に保証しない。
5. **WebDAV client差**: Finder/Explorer/rclone/cadaverのcase-only rename、lock-null、複合If、sidecarをsupport matrix化する。
6. **ZIP64 / large CLI / Nextcloud chunking / change token**: v1.1候補。v1 ZIPはnon-ZIP64、DAVは単発request。
7. **version UI / team/group / notification / import-export**: data modelと認可を別reviewする。
8. **RAR/CBR/7z、固定layout EPUB、media overlay、出版物JS、波形、歌詞同期、外部metadata**: v1 unsupported。
9. **CONTENT_HOST別account、R2 replication、長期backup**: 現threat model外のoption。
10. **料金 / capacity**: release時の公式値でD1 rows、R2 Class A/B、Images transform、DO duration、Queue、backup/GC/retryのlow/base/high worksheetを更新する。
