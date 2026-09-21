# Next-cloud-flare — 設計・実装方針 (v0.6)

Cloudflare のサービスだけで完結する、Google Drive / Nextcloud ライクなセルフホスト型ストレージ管理アプリ。

> ステータス: **Astra ラウンド1〜5 反映済み（R5 No-Go 是正版）**。本書は v1 の実装契約であり、「要確認」は §18 の staging gate を通るまで有効化しない。
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
| byte / request budget | `BudgetDO(budget_id)` | content-session ごとの耐久 counter、10分 lease、alarm 精算。 |
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
                  ├─ Worker / manifest ─────┼─ R2: immutable blob/derivative/export
WebDAV ─ Basic ───┤ authn → authorize       ├─ LockDO / UploadDO / BudgetDO
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

`Env` は `DB, BLOBS, BACKUPS, CACHE, LOCKS, UPLOADS, BUDGETS, CONTROL, JOBS, IMAGES, EDGE_LIMITER, ASSETS` を必須とする。起動 smoke test は binding の存在と environment marker を検査し、不足・cross-environment ID・Images 無しを 503 で fail closed にする。D1/R2/KV/Queues/DO/Access AUD/custom domain/key ring は staging と production で共有しない。配備可能な `wrangler.jsonc` は §14.1 を正本とする。

---

## 3. データモデルと不変条件 (D1 / R2)

### 3.1 core schema

全 TEXT 主鍵は明示的に `NOT NULL` とし、全 size/count/quota/revision/state に CHECK を置く。以下は規範 DDL の抜粋で、`control` DDL の唯一の正本である。完全な table/column/FK/index、operation/scope/error enum、状態遷移は Phase 1 で機械可読 contract と migration に固定し、D1 と SQLite の双方で検査する。

```sql
CREATE TABLE _assert (v INTEGER NOT NULL CHECK (v = 0)) STRICT;

CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY,
  access_iss TEXT NOT NULL, access_sub TEXT NOT NULL, email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('member','app_admin')),
  quota_bytes INTEGER NOT NULL CHECK(quota_bytes>=0),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
  physical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(physical_bytes>=0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
  disabled_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(access_iss,access_sub)
) STRICT;

CREATE TABLE control (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  bootstrap_done_at INTEGER, bootstrap_iss TEXT, bootstrap_sub TEXT,
  backup_barrier_op TEXT, updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO control(singleton,epoch,updated_at) VALUES(1,1,unixepoch());

CREATE TABLE settings (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  signup_enabled INTEGER NOT NULL DEFAULT 0 CHECK(signup_enabled IN (0,1))
) STRICT;
INSERT INTO settings(singleton,signup_enabled) VALUES(1,0);

CREATE TABLE spaces (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  root_node_id TEXT NOT NULL UNIQUE,
  tree_generation INTEGER NOT NULL DEFAULT 1 CHECK(tree_generation>=1),
  UNIQUE(owner_id)
) STRICT;

CREATE TABLE blobs (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size>=0),
  sha256_verified TEXT, client_sha256 TEXT,
  content_etag TEXT NOT NULL, r2_etag TEXT, mime_sniffed TEXT,
  ref_count INTEGER NOT NULL CHECK(ref_count>=0),
  state TEXT NOT NULL CHECK(state IN
    ('staging','committed','orphan','gc_candidate','deleting','deleted')),
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
CREATE TABLE trash_members (
  trash_op_id TEXT NOT NULL REFERENCES trash_ops(op_id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY(trash_op_id,node_id)
) STRICT;

CREATE TABLE nodes (
  id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id), owner_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES nodes(id), name TEXT NOT NULL, name_ci TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('root','folder','file')),
  current_blob_id TEXT REFERENCES blobs(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  client_mtime INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, deleted_op_id TEXT REFERENCES trash_ops(op_id), orig_parent_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)), last_op_id TEXT,
  CHECK((kind='root' AND parent_id IS NULL) OR (kind<>'root' AND parent_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX nodes_parent_name_live ON nodes(parent_id,name_ci) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX nodes_one_root_live ON nodes(space_id) WHERE kind='root' AND deleted_at IS NULL;
CREATE INDEX nodes_children_keyset
  ON nodes(parent_id,name_ci,id,name,kind,revision,current_blob_id,updated_at)
  WHERE deleted_at IS NULL;
CREATE INDEX nodes_children_updated_live ON nodes(parent_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX nodes_children_deleted ON nodes(parent_id,deleted_at,id);
CREATE INDEX nodes_space_parent_live ON nodes(space_id,parent_id,id) WHERE deleted_at IS NULL;
CREATE INDEX nodes_blob ON nodes(current_blob_id) WHERE current_blob_id IS NOT NULL;

CREATE TRIGGER nodes_parent_insert BEFORE INSERT ON nodes
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM nodes p WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id
    AND p.owner_id=NEW.owner_id AND p.kind IN ('root','folder') AND p.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'invalid parent'); END;
CREATE TRIGGER nodes_parent_update BEFORE UPDATE OF parent_id,space_id,owner_id ON nodes
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM nodes p WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id
    AND p.owner_id=NEW.owner_id AND p.kind IN ('root','folder') AND p.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'invalid parent'); END;
```

`spaces.owner_id = root.owner_id`、root の `space_id`、blob owner と node owner の一致は、循環 FK を避けて create/update batch の SQL assertion で保証し、repair job も全件検査する。`nodes.current_blob_id`、`node_versions.blob_id`、`blob_pins`（実装名。旧 `gc_pins` を統合）の全参照追加は、同一 batch に `NOT EXISTS (SELECT 1 FROM blobs WHERE id=? AND state IN ('deleting','deleted'))` assertion を含める。

Operation/permit/outbox は §5.2、upload は §6、GC は §11、FTS は §12 を正本とする。`node_versions`、`shares`、`share_grants`、`share_sessions`、`content_sessions`、`app_passwords`、`service_principals`、`node_props`、`activity`、`bulk_jobs`、`job_leases`、`backup_runs` は migration で FK/CHECK/index を明示する。share password と app password record は `kdf`,`kdf_params`（iterations を含む canonical JSON）,`kid` を保存する。`folder_stats` は永続化せず要求時に bounded 集計する。journal は廃止する。大きい manifest/archive index/target 集合は R2 または durable row に置き、token 内には集合 ID と hash だけを置く。

Media は `node_media`、`library_items`、`user_reading_state`、`tags`、`node_tags`、`library_roots`、`node_audio`、`user_playback_state` を持つ。列名は `duration_ms`、`dominant_color` に固定する。抽出値と user metadata override は別列にし、reading/playback state は `(user_id,node_id,blob_id)` に束縛して current blob 変更時に position を無効化する。current blob と `generator_version` を必須 guard にし、FK 参照列にも index を作る。GPS、任意 EXIF、未検証 XML/HTML、埋込み原画像は保存しない。

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

blob key は `u/<ownerId>/b/<blobId>`、derivative は generation 付き key とし上書きしない。same-owner COPY は COW、cross-owner COPY は source pin + destination reservation + Range/multipart job。path/KV hint は `tree_generation` を持ち、利用時に現在 path と EffectiveLive を primary で再検証する。`ref_count = current node refs + node_versions refs + blob_pins refs` とし、各参照の追加・削除と同じ D1 batch で増減する。repair は三集合の `COUNT(*)` の和から再計算する。

| validator | 形式 | 変化する時点 |
|---|---|---|
| file content | strong `content_etag` | current blob の変更 |
| DAV file / metadata | strong `"<node_id>-<revision>"` | content または node metadata / dead property 変更 |
| collection | strong `"<node_id>-<revision>"` | §7.3 の child/PROPPATCH event |
| R2 object | `r2_etag` / `httpEtag` | 不変 object 作成時のみ。HTTP validator に流用しない |

R2 ETag、D1 content ETag、metadata revision を混同しない。

### 3.4 D1 query / bind rules

権威 read は Session replica に依存せず primary binding へ直接発行する。`withSession('first-primary')` は session 全 query の primary 保証ではない。各 statement の bind を生成時に数え、`k` bind/row + 共通 `r` なら chunk は `floor((100-r)/k)` 以下。`IN (...)` は100 bindを越える前に分割し、atomic mutation を別 batch に分割しない。read ID 集合は size-bounded JSON + `json_each(?)` も使えるが row / value / `duration_ms` 予算を同時に検査する。

一覧 / PROPFIND / Gallery / ancestor の SQL は §12、fixture 予算は §15.1。返却件数を `rows_read` とみなさない。

---

## 4. 認証、principal、認可、初期化

### 4.1 JWT / principal

private/service route は重複のない単一 `Cf-Access-Jwt-Assertion` header だけを受ける。Cookie/raw Service Token header/query/bodyへ fallback しない。JOSE は `alg=RS256`,`typ=JWT`、payload `type=app`、固定 `iss`、route-environment 別単一 AUD、有限整数 `iat,exp`、user は `nbf,sub,email`、service は `common_name` を検査する。skew 60秒、`iat` から24時間超を拒否する。JWKS は issuer 単位 KV 1時間、既知 key stale 24時間、未知 kid single-flight、10 refresh/分、negative 64、timeout 5秒、256KiB、RSA 16鍵とする。email が同じでも `iss+sub` の identity を自動結合しない。

```text
user(iss,sub,user_id,credential_id=access-session)
app_password(user_id,credential_id,scope,optional_root)
link_share(share_id,share_version,session_id,actions,root)
service(service_principal_id,credential_id,mapped_user,space,scope)
job(actor_principal,credential_id,grant_snapshot,epoch,claim_fence,operation)
system(kind,epoch,claim_fence,explicit_operands)
```

actor、credential、current grant、実行 claim/fence は別 field として保存・再検査する。service は read-only の `/api/v1/automation/*` list/metadata だけで、v1 に service upload/repair mutation は提供しない。`system` は GC/repair/backup の列挙 operation だけで user read 権限を持たない。

### 4.2 authorize contract

scope enum は `account:read,node:read,node:create,node:write,node:delete,node:star,state:write,tag:write,share:manage,upload:create,upload:write,library:read,library:write,credential:manage,job:read,job:cancel,admin:user,admin:lock,admin:dlq,admin:repair` に固定する。v1 の `app_admin` は他 user の file content read を禁止し、admin scope は列挙 operand に限る。次表が operation enum の正本で、manifest の全 operation は CI でちょうど一行へ対応させる。

| operation | 必要 scope / share action | 必須 operand tuple |
|---|---|---|
| `spa.read`,`public.asset.read`,`share.landing`,`reader.shell` | surface policy / public manifest | `[currentUser? ,assetManifest?,shareId?]` |
| `account.read`,`account.logout`,`csrf.issue` | self | `[currentUser]` |
| `node.read`,`search.read`,`recent.read`,`starred.read`,`shared.read`,`trash.read` | `node:read` / read | `[scopeRoot,node?,ancestors?,currentBlob?,cursor?]` |
| `node.create` | `node:create` / create | `[parent,space]` |
| `node.content.write` | `node:write` / edit | `[node,parent,oldBlob?,newBlob]` |
| `node.rename` | `node:write` / edit | `[node,parent]` |
| `node.move` | `node:write` / edit | `[source,sourceParent,destinationParent,overwriteTarget?,sourceAncestors,destinationAncestors]`。cross-space は拒否 |
| `node.copy` | `node:read` + `node:create` | `[source,destinationParent,overwriteTarget?,sourceAncestors,destinationAncestors,copyManifest]` |
| `node.trash` | `node:delete` / edit | `[source,parent,trashOp,descendantSet]` |
| `node.restore` | `node:create` | `[trashOp,root,destinationParent]` |
| `node.purge` | `node:delete` | `[trashOp,root,memberSet]` |
| `node.star` | `node:star` | `[currentUser,node]` |
| `zip.create`,`zip.read` | `node:read` / download | `[root,manifest,nodes,blobs,budgetId]` |
| `gallery.read`,`audio.read`,`library.read` | `library:read` / read | `[root,node?,currentBlob?,index?,cursor?]` |
| `library.write`,`audio.metadata.write` | `library:write` | `[node,currentBlob,extractedMetadata,override]` |
| `reading_state.write` | `state:write` | `[currentUser,node,currentBlob,position]` |
| `playback_state.write` | `state:write` | `[currentUser,node,currentBlob,position]` |
| `tag.read`,`tag.create`,`tag.update`,`tag.delete` | read / `tag:write` | `[currentUser,tag,nodes?]` |
| `upload.create` | `upload:create` / upload | `[parent,target?,space,declaredSize,mode]` |
| `upload.read`,`upload.write`,`upload.abort` | `upload:write` / upload | `[upload,parent,target?,part?]` |
| `upload.complete` | `upload:write` / upload | `[upload,parent,target?,blob]` |
| `share.read`,`share.manage`,`share.disable` | read / `share:manage` | `[share,root,owner]` |
| `share.unlock`,`share.logout` | public-form / session | `[share,session?]` |
| `content.session.create`,`content.session.accept` | current read/share action | `[targetSetId,targetSetHash,nodes,blobs,budgetId]` |
| `ticket.cancel` | ticket issuer/current share action | `[ticket,session,budgetId]` |
| `content.read` | session target purpose/current grant | `[session,node,blob,index?,entry?,budgetId]` |
| `credential.read`,`credential.create`,`credential.revoke` | `credential:manage` | `[currentUser,credential?]` |
| `job.read`,`job.cancel`,`job.retry` | `job:read` / `job:cancel` | `[job,originalOperands,claimFence]` |
| `operation.read` | original operation scope | `[operation,originalOperands]` |
| `admin.user.disable`,`admin.transfer` | `admin:user` | `[actor,targetUser,newAdmin?]` |
| `admin.lock.force_unlock` | `admin:lock` | `[actor,lock,node]` |
| `admin.dlq`,`admin.repair` | `admin:dlq` / `admin:repair` | `[actor,jobOrRepairKind,explicitOperands]` |
| `automation.list`,`automation.metadata.read` | service `node:read` | `[service,mappedUser,space,scopeRoot,node?]` |
| `dav.options` | valid app password | `[credential,source]` |
| `dav.read`,`dav.propfind` | `node:read` | `[credential,source,ancestors,properties?,locks?]` |
| `dav.put`,`dav.mkcol`,`dav.proppatch`,`dav.copy`,`dav.move`,`dav.delete`,`dav.lock`,`dav.unlock` | 対応する node scope | §7 profile の source/destination/parent/lock tuple |

`Authorized<Operation>` は operation ごとの discriminated tuple を返し、一般 `Operand[]` を handler に渡さない。folder COPY は開始時に固定 manifest を作り、衝突方針、dead props 引継ぎ、全成功または部分結果なしを束縛する。route の型検査は補助であり、意味的な認可 matrix fixture を必須とする。

Idempotency-Key は `(principal fingerprint,credential_id,space_id,operation kind,canonical request digest)` に束縛する。同じ key と異なる payload は 409、同じ intent は同一 operation を照合する。terminal replay は同一 principal/credential に限り、current user/credential/grant/share version と結果 node の開示権限を再検査する。成功は operation ID/HTTP status/現在見える node ID/revisionだけ、失敗は安定 error codeだけを返す。purge 済み node 名/pathは返さない。

### 4.3 bootstrap / revocation

bootstrap は Google IdP + MFA policy に加え、`OWNER_EMAILS` または `OWNER_IDENTITIES`（`iss+sub`）へ一致する identity の初回 login だけを許す。`control.bootstrap_done_at IS NULL` を同一 batch の条件付き UPDATE で一度だけ app_admin/personal space に固定し、bootstrap 前は owner 候補以外の全 login を拒否する。`settings.signup_enabled` は既定 false。bootstrap 後の新規 user は明示 signup/admin 操作だけで作る。

最後の有効な `app_admin` の停止・削除・降格は SQL assertion で拒否する。admin 移譲は「新 admin 昇格」成功後に別 operation で「旧 admin 降格」する二操作とし、常に一人以上を維持する。user disable batch は当該 user 所有の public share を全て disabled にする。

| 事象 | Access session | private API | app password | share | content-session Cookie | ticket / BudgetDO | job | 最大遅延 |
|---|---|---|---|---|---|---|---|---|
| user disable | Access policy + D1 | D1で拒否 | 拒否 | owner share全停止 | D1 session拒否 | 新lease拒否・既存≤10分 | chunk前拒否 | request/chunk時、転送leaseは≤10分 |
| app logout | Access logout | D1 session終了 | 維持 | 維持 | `content_sessions.revoked_at` | 新lease拒否 | current credential再検査 | 即時〜進行中request終了 |
| app password revoke/expiry | 対象外 | 対象外 | D1で拒否 | 対象外 | 対象credentialなら拒否 | 新lease拒否 | chunk前拒否 | request/chunk時 |
| share disable/version更新 | 対象外 | 管理のみ | 対象外 | D1で拒否 | version不一致 | 個別cancel、expiry clamp | chunk前拒否 | request/chunk時、lease≤10分 |
| share owner disable | owner session停止 | 拒否 | 拒否 | 全停止 | 拒否 | cancel | 拒否 | user disable と同じ |
| epoch bump | 再認証 | old epoch拒否 | old token拒否 | old token拒否 | old epoch拒否 | old lease拒否 | old claim拒否 | 次request/chunk |

`POST /api/v1/auth/logout` は app auth state、unlock/upload capability、IndexedDB/memory/Cache Storage を削除する前に、当該 app session が発行した `content_sessions.revoked_at` を D1 で更新し、`BroadcastChannel` 通知後に Access logout へ 303 redirect する。受信済み stream byte は回収できず、新 request/lease から拒否する。

### 4.4 token / KDF

HMAC token は canonical JSON、`typ,kid,aud,iat,exp,epoch` と用途 claim を必須にし、CSPRNG 256-bit（最低128-bit）。secret を URL、operation result、audit、error、log に保存しない。target 集合は durable storage に保存し、token は集合 ID + hash だけを含む。

| token | 主な束縛 | 期限 / storage |
|---|---|---|
| share link | share ID/version/root/actions | D1 は HMAC/hashだけ。fragment→POST |
| unlock | share/version/session/kid/epoch | `__Host-ncf_share_*`; Secure; HttpOnly; SameSite=Lax; Path=/; ≤7日 |
| app password | credential ID/user/scope/epoch | digest + `kdf/kdf_params/kid`、既定90日/最大365日、20/user |
| upload | upload/principal/credential/share version/aud | deadline以下、Cookie無し |
| DAV lock | random token/node/creator/epoch | `opaquelocktoken`、hashだけ、≤604800秒 |
| content session | session ID/target set ID+hash/scope/epoch/aud/budget ID | §8.2 Cookie、≤600秒 |
| content ticket | purpose=`content|thumb|page|zip|track`、node/blob/share/session | 個別 cancel、share expiry 以下 |
| archive entry | index内 entry ID | bearerではなく current node/blob/index 認可と併用 |
| job/operation | DB参照ID | bearerではない |

share password は PBKDF2-HMAC-SHA256 **100,000回**、salt 16B、DK 32B、入力 UTF-8≤1KiB を v1 既定にする。全 password record に `kdf`,`kdf_params.iterations`,`kid` を保存する。per-share 10/min、client IP 30/min、global DO 600/min、同時 KDF 20。ただし isolate 内は一 request ずつ実行し global 20 を memory 保証に使わない。600,000回は §18 staging gate 合格時だけ一括で引き上げ、scrypt は不採用。用途別 key と rotation は §14.1 を正本とする。

---

## 5. REST API、route manifest、共通 mutation

### 5.1 完全 route manifest

以下が v1 の全 HTTP route である。各行は method/template を一意に登録し、記載のない route は404。`operands` の各 ID は request schema から型付きに束縛し、`adminOnly` を生成 testで固定する。

| host | method | template | auth | operation | operands | adminOnly | CSRF profile |
|---|---|---|---|---|---|---|---|
| app | GET | `/` | access | `spa.read` | `currentUser` | false | same-origin-json |
| app | GET | `/assets/:asset` | access | `spa.read` | `currentUser,assetManifest` | false | same-origin-json |
| app | GET | `/public-assets/:asset` | public | `public.asset.read` | `publicAssetManifest` | false | same-origin-json |
| app | GET | `/s` | public | `share.landing` | `publicAssetManifest` | false | same-origin-json |
| app | GET | `/s/:shareId` | public | `share.landing` | `shareId,publicAssetManifest` | false | same-origin-json |
| app | GET | `/api/v1/me` | access | `account.read` | `currentUser` | false | same-origin-json |
| app | POST | `/api/v1/auth/logout` | access | `account.logout` | `currentUser` | false | same-origin-json |
| app | POST | `/api/v1/csrf` | access | `csrf.issue` | `currentUser` | false | same-origin-json |
| app | GET | `/api/v1/operations/:id` | access | `operation.read` | `operation,originalOperands` | false | same-origin-json |
| app | GET | `/api/v1/search` | access | `search.read` | `scopeRoot,cursor` | false | same-origin-json |
| app | GET | `/api/v1/recent` | access | `recent.read` | `scopeRoot,cursor` | false | same-origin-json |
| app | GET | `/api/v1/starred` | access | `starred.read` | `scopeRoot,cursor` | false | same-origin-json |
| app | GET | `/api/v1/shared-with-me` | access | `shared.read` | `currentUser,mounts,cursor` | false | same-origin-json |
| app | GET | `/api/v1/stats` | access | `account.read` | `currentUser,space` | false | same-origin-json |
| app | GET | `/api/v1/nodes/:nodeId` | access | `node.read` | `node,ancestors` | false | same-origin-json |
| app | GET | `/api/v1/nodes/:nodeId/path` | access | `node.read` | `node,ancestors` | false | same-origin-json |
| app | GET | `/api/v1/nodes/:nodeId/children` | access | `node.read` | `node,children,cursor` | false | same-origin-json |
| app | GET | `/api/v1/nodes/:nodeId/content` | access | `node.read` | `node,ancestors,blob` | false | same-origin-json |
| app | HEAD | `/api/v1/nodes/:nodeId/content` | access | `node.read` | `node,ancestors,blob` | false | same-origin-json |
| app | GET | `/api/v1/nodes/:nodeId/thumb` | access | `node.read` | `node,ancestors,blob,variant` | false | same-origin-json |
| app | HEAD | `/api/v1/nodes/:nodeId/thumb` | access | `node.read` | `node,ancestors,blob,variant` | false | same-origin-json |
| app | GET | `/api/v1/nodes/:nodeId/preview` | access | `node.read` | `node,ancestors,blob` | false | same-origin-json |
| app | HEAD | `/api/v1/nodes/:nodeId/preview` | access | `node.read` | `node,ancestors,blob` | false | same-origin-json |
| app | POST | `/api/v1/nodes` | access | `node.create` | `parent,space` | false | same-origin-json |
| app | PATCH | `/api/v1/nodes/:nodeId` | access | `node.rename` | `node,parent` | false | same-origin-json |
| app | PUT | `/api/v1/nodes/:nodeId/content` | access | `node.content.write` | `node,parent,oldBlob,newBlob` | false | same-origin-json |
| app | DELETE | `/api/v1/nodes/:nodeId` | access | `node.trash` | `node,parent,descendants` | false | same-origin-json |
| app | POST | `/api/v1/nodes/:nodeId/move` | access | `node.move` | `source,sourceParent,destinationParent,overwriteTarget,sourceAncestors,destinationAncestors` | false | same-origin-json |
| app | POST | `/api/v1/nodes/:nodeId/copy` | access | `node.copy` | `source,destinationParent,overwriteTarget,sourceAncestors,destinationAncestors` | false | same-origin-json |
| app | PUT | `/api/v1/nodes/:nodeId/star` | access | `node.star` | `currentUser,node` | false | same-origin-json |
| app | POST | `/api/v1/nodes/:nodeId/zip` | access | `zip.create` | `root,subtree,blobs,budgetId` | false | same-origin-json |
| app | GET | `/api/v1/zips/:id` | access | `zip.read` | `manifest,nodes,blobs,budgetId,ticket` | false | same-origin-json |
| app | GET | `/api/v1/nodes/:nodeId/gallery` | access | `gallery.read` | `folder,candidates,cursor` | false | same-origin-json |
| app | GET | `/api/v1/nodes/:nodeId/tracks` | access | `audio.read` | `folder,tracks,cursor` | false | same-origin-json |
| app | PATCH | `/api/v1/nodes/:nodeId/audio` | access | `audio.metadata.write` | `node,blob,audioMetadata` | false | same-origin-json |
| app | PUT | `/api/v1/nodes/:nodeId/playback-state` | access | `playback_state.write` | `currentUser,node,blob` | false | same-origin-json |
| app | GET | `/api/v1/library/items` | access | `library.read` | `scopeRoot,cursor` | false | same-origin-json |
| app | GET | `/api/v1/library/items/:itemId` | access | `library.read` | `item,node,blob` | false | same-origin-json |
| app | PATCH | `/api/v1/library/items/:itemId` | access | `library.write` | `item,node,blob` | false | same-origin-json |
| app | GET | `/api/v1/library/:nodeId` | access | `library.read` | `node,blob,index` | false | same-origin-json |
| app | GET | `/api/v1/library/:nodeId/pages/:page` | access | `library.read` | `node,blob,index,page` | false | same-origin-json |
| app | HEAD | `/api/v1/library/:nodeId/pages/:page` | access | `library.read` | `node,blob,index,page` | false | same-origin-json |
| app | GET | `/api/v1/library/:nodeId/pages/:page/thumb` | access | `library.read` | `node,blob,index,page` | false | same-origin-json |
| app | HEAD | `/api/v1/library/:nodeId/pages/:page/thumb` | access | `library.read` | `node,blob,index,page` | false | same-origin-json |
| app | GET | `/api/v1/library/:nodeId/entries/:entryToken` | access | `library.read` | `node,blob,index,entry` | false | same-origin-json |
| app | HEAD | `/api/v1/library/:nodeId/entries/:entryToken` | access | `library.read` | `node,blob,index,entry` | false | same-origin-json |
| app | PUT | `/api/v1/library/:nodeId/reading-state` | access | `reading_state.write` | `currentUser,node,blob` | false | same-origin-json |
| app | GET | `/api/v1/library/roots` | access | `library.read` | `currentUser` | false | same-origin-json |
| app | POST | `/api/v1/library/roots` | access | `library.write` | `currentUser,rootNode` | false | same-origin-json |
| app | DELETE | `/api/v1/library/roots/:nodeId` | access | `library.write` | `currentUser,rootNode` | false | same-origin-json |
| app | POST | `/api/v1/uploads` | access | `upload.create` | `parent,target,space,declaredSize,mode` | false | same-origin-json |
| app | GET | `/api/v1/uploads/:uploadId` | access | `upload.read` | `upload,parent,target` | false | same-origin-json |
| app | PUT | `/api/v1/uploads/:uploadId/content` | access | `upload.write` | `upload,parent,target,knownLength` | false | same-origin-json |
| app | PUT | `/api/v1/uploads/:uploadId/parts/:partNumber` | access | `upload.write` | `upload,parent,target,part` | false | same-origin-json |
| app | POST | `/api/v1/uploads/:uploadId/complete` | access | `upload.complete` | `upload,parent,target,blob` | false | same-origin-json |
| app | DELETE | `/api/v1/uploads/:uploadId` | access | `upload.abort` | `upload,parent,target` | false | same-origin-json |
| app | GET | `/api/v1/trash` | access | `trash.read` | `space,cursor` | false | same-origin-json |
| app | POST | `/api/v1/trash/:opId/restore` | access | `node.restore` | `trashOp,root,destinationParent` | false | same-origin-json |
| app | POST | `/api/v1/trash/:opId/purge` | access | `node.purge` | `trashOp,root,members` | false | same-origin-json |
| app | GET | `/api/v1/shares` | access | `share.read` | `currentUser` | false | same-origin-json |
| app | POST | `/api/v1/shares` | access | `share.manage` | `currentUser,root` | false | same-origin-json |
| app | GET | `/api/v1/shares/:shareId` | access | `share.read` | `share,root` | false | same-origin-json |
| app | PATCH | `/api/v1/shares/:shareId` | access | `share.manage` | `share,root` | false | same-origin-json |
| app | DELETE | `/api/v1/shares/:shareId` | access | `share.disable` | `share,root,owner` | false | same-origin-json |
| app | GET | `/api/v1/tags` | access | `tag.read` | `currentUser,cursor` | false | same-origin-json |
| app | POST | `/api/v1/tags` | access | `tag.create` | `currentUser,tag` | false | same-origin-json |
| app | PATCH | `/api/v1/tags/:tagId` | access | `tag.update` | `currentUser,tag` | false | same-origin-json |
| app | DELETE | `/api/v1/tags/:tagId` | access | `tag.delete` | `currentUser,tag,nodes` | false | same-origin-json |
| app | POST | `/api/v1/content-session` | access | `content.session.create` | `targetSetId,targetSetHash,nodes,blobs,budgetId` | false | same-origin-json |
| app | DELETE | `/api/v1/tickets/:ticketId` | access | `ticket.cancel` | `ticket,session,budgetId` | false | same-origin-json |
| app | GET | `/api/v1/app-passwords` | access | `credential.read` | `currentUser` | false | same-origin-json |
| app | POST | `/api/v1/app-passwords` | access | `credential.create` | `currentUser` | false | same-origin-json |
| app | DELETE | `/api/v1/app-passwords/:credentialId` | access | `credential.revoke` | `currentUser,credential` | false | same-origin-json |
| app | GET | `/api/v1/jobs/:jobId` | access | `job.read` | `job,originalOperands` | false | same-origin-json |
| app | POST | `/api/v1/jobs/:jobId/cancel` | access | `job.cancel` | `job,originalOperands` | false | same-origin-json |
| app | POST | `/api/v1/jobs/:jobId/retry` | access | `job.retry` | `job,originalOperands` | false | same-origin-json |
| app | GET | `/api/v1/admin/dlq` | access | `admin.dlq` | `dlqCursor` | true | same-origin-json |
| app | POST | `/api/v1/admin/dlq/:jobId/requeue` | access | `admin.dlq` | `job,originalOperands` | true | same-origin-json |
| app | POST | `/api/v1/admin/users/:userId/disable` | access | `admin.user.disable` | `actor,targetUser` | true | same-origin-json |
| app | POST | `/api/v1/admin/transfer` | access | `admin.transfer` | `actor,targetUser,newAdmin` | true | same-origin-json |
| app | POST | `/api/v1/admin/locks/:lockId/force-unlock` | access | `admin.lock.force_unlock` | `actor,lock,node` | true | same-origin-json |
| app | GET | `/api/v1/automation/nodes` | service | `automation.list` | `service,mappedUser,space,scopeRoot,cursor` | false | same-origin-json |
| app | GET | `/api/v1/automation/nodes/:nodeId` | service | `automation.metadata.read` | `service,mappedUser,space,node,ancestors` | false | same-origin-json |
| app | GET | `/api/v1/public/shares/:shareId` | share | `share.read` | `share,root` | false | same-origin-json |
| app | GET | `/api/v1/public/shares/:shareId/children/:nodeId` | share | `share.read` | `share,node,ancestors,children` | false | same-origin-json |
| app | GET | `/api/v1/public/shares/:shareId/content/:nodeId` | share | `share.read` | `share,node,ancestors,blob` | false | same-origin-json |
| app | HEAD | `/api/v1/public/shares/:shareId/content/:nodeId` | share | `share.read` | `share,node,ancestors,blob` | false | same-origin-json |
| app | GET | `/api/v1/public/shares/:shareId/thumb/:nodeId` | share | `share.read` | `share,node,ancestors,blob` | false | same-origin-json |
| app | HEAD | `/api/v1/public/shares/:shareId/thumb/:nodeId` | share | `share.read` | `share,node,ancestors,blob` | false | same-origin-json |
| app | POST | `/api/v1/public/shares/:shareId/unlock` | public | `share.unlock` | `share` | false | public-form |
| app | POST | `/api/v1/public/shares/:shareId/logout` | share | `share.logout` | `share,session` | false | public-form |
| app | POST | `/api/v1/public/shares/:shareId/tickets` | share | `share.read` | `share,session,targetSetId,targetSetHash,budgetId` | false | public-form |
| app | DELETE | `/api/v1/public/shares/:shareId/tickets/:ticketId` | share | `ticket.cancel` | `share,ticket,session,budgetId` | false | public-form |
| app | POST | `/api/v1/public/shares/:shareId/content-session` | share | `content.session.create` | `share,session,targetSetId,targetSetHash,budgetId` | false | public-form |
| app | POST | `/api/v1/public/shares/:shareId/nodes/:nodeId/zip` | share | `zip.create` | `share,root,subtree,blobs,budgetId` | false | public-form |
| app | GET | `/api/v1/public/shares/:shareId/zips/:zipId` | share | `zip.read` | `share,manifest,nodes,blobs,budgetId,ticket` | false | public-form |
| app | GET | `/api/v1/public/shares/:shareId/gallery` | share | `gallery.read` | `share,root,candidates,cursor` | false | same-origin-json |
| app | GET | `/api/v1/public/shares/:shareId/tracks` | share | `audio.read` | `share,root,tracks,cursor` | false | same-origin-json |
| app | GET | `/api/v1/public/shares/:shareId/library/:nodeId` | share | `library.read` | `share,node,blob,index` | false | same-origin-json |
| app | GET | `/api/v1/public/shares/:shareId/library/:nodeId/pages/:page` | share | `library.read` | `share,node,blob,index,page` | false | same-origin-json |
| app | HEAD | `/api/v1/public/shares/:shareId/library/:nodeId/pages/:page` | share | `library.read` | `share,node,blob,index,page` | false | same-origin-json |
| app | GET | `/api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken` | share | `library.read` | `share,node,blob,index,entry` | false | same-origin-json |
| app | HEAD | `/api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken` | share | `library.read` | `share,node,blob,index,entry` | false | same-origin-json |
| app | POST | `/api/v1/public/shares/:shareId/nodes` | share | `node.create` | `share,parent` | false | public-form |
| app | PATCH | `/api/v1/public/shares/:shareId/nodes/:nodeId` | share | `node.rename` | `share,node,parent,ancestors` | false | public-form |
| app | DELETE | `/api/v1/public/shares/:shareId/nodes/:nodeId` | share | `node.trash` | `share,node,parent,ancestors` | false | public-form |
| app | POST | `/api/v1/public/shares/:shareId/uploads` | share | `upload.create` | `share,parent,target,declaredSize,mode` | false | public-form |
| app | GET | `/api/v1/public/shares/:shareId/uploads/:uploadId` | share | `upload.read` | `share,upload,parent,target` | false | public-form |
| app | PUT | `/api/v1/public/shares/:shareId/uploads/:uploadId/content` | share | `upload.write` | `share,upload,knownLength` | false | public-form |
| app | PUT | `/api/v1/public/shares/:shareId/uploads/:uploadId/parts/:partNumber` | share | `upload.write` | `share,upload,part` | false | public-form |
| app | POST | `/api/v1/public/shares/:shareId/uploads/:uploadId/complete` | share | `upload.complete` | `share,upload,parent,target,blob` | false | public-form |
| app | DELETE | `/api/v1/public/shares/:shareId/uploads/:uploadId` | share | `upload.abort` | `share,upload` | false | public-form |
| app | OPTIONS | `/dav/*path` | app_password | `dav.options` | `credential,source` | false | dav |
| app | PROPFIND | `/dav/*path` | app_password | `dav.propfind` | `source,ancestors,properties,locks` | false | dav |
| app | PROPPATCH | `/dav/*path` | app_password | `dav.proppatch` | `source,ancestors,properties,locks` | false | dav |
| app | MKCOL | `/dav/*path` | app_password | `dav.mkcol` | `sourceParent,ancestors,locks` | false | dav |
| app | GET | `/dav/*path` | app_password | `dav.read` | `source,ancestors,blob` | false | dav |
| app | HEAD | `/dav/*path` | app_password | `dav.read` | `source,ancestors,blob` | false | dav |
| app | PUT | `/dav/*path` | app_password | `dav.put` | `source,sourceParent,oldBlob,newBlob,ancestors,locks` | false | dav |
| app | DELETE | `/dav/*path` | app_password | `dav.delete` | `source,sourceParent,descendants,ancestors,locks` | false | dav |
| app | COPY | `/dav/*path` | app_password | `dav.copy` | `source,destinationParent,overwriteTarget,sourceAncestors,destinationAncestors,locks` | false | dav |
| app | MOVE | `/dav/*path` | app_password | `dav.move` | `source,sourceParent,destinationParent,overwriteTarget,sourceAncestors,destinationAncestors,locks` | false | dav |
| app | LOCK | `/dav/*path` | app_password | `dav.lock` | `source?,sourceParent,nodeCreate?,ancestors,locks` | false | dav |
| app | UNLOCK | `/dav/*path` | app_password | `dav.unlock` | `source,ancestors,lock` | false | dav |
| content | OPTIONS | `/session` | public | `content.session.accept` | `requestOrigin` | false | cross-origin-content |
| content | POST | `/session` | public | `content.session.accept` | `signedTicket,targetSetId,targetSetHash,budgetId` | false | cross-origin-content |
| content | GET | `/c/:nodeId/:blobId` | content_cookie | `content.read` | `session,node,blob,budgetId` | false | cross-origin-content |
| content | HEAD | `/c/:nodeId/:blobId` | content_cookie | `content.read` | `session,node,blob` | false | same-origin-json |
| content | GET | `/c/:nodeId/:blobId/pages/:page` | content_cookie | `content.read` | `session,node,blob,index,page` | false | same-origin-json |
| content | HEAD | `/c/:nodeId/:blobId/pages/:page` | content_cookie | `content.read` | `session,node,blob,index,page` | false | same-origin-json |
| content | GET | `/c/:nodeId/:blobId/entries/:entryToken` | content_cookie | `content.read` | `session,node,blob,index,entry` | false | same-origin-json |
| content | HEAD | `/c/:nodeId/:blobId/entries/:entryToken` | content_cookie | `content.read` | `session,node,blob,index,entry` | false | same-origin-json |
| content | GET | `/reader/index.html` | public | `reader.shell` | `readerAssetManifest` | false | same-origin-json |
| content | GET | `/reader/:asset` | public | `reader.shell` | `readerAssetManifest` | false | same-origin-json |

DAV の各行は router 生成時に `/dav` と `/dav/*path` の二 template へ展開し、root で意味を持たない mutation は 405 にする。`*path` は一度だけ decode する bounded remainder で、他 surface へ流さない。public edit の MOVE route は v1 非提供であり 404 とする。service automation upload/mutation も v1 非提供である。

| CSRF profile | 契約 |
|---|---|
| `same-origin-json` | 既定。mutation は exact `Origin=APP_ORIGIN`、`Sec-Fetch-Site:same-origin`、`application/json`、one-time CSRF。GET/HEAD は token 不要 |
| `cross-origin-content` | `/session` の POST/OPTIONS は `Origin` が app origin allowlist の固定値と一致する場合だけ許可し、固定 `Access-Control-Allow-Origin`、`Access-Control-Allow-Credentials:true`、必要 header/method の preflight を返す。content GET/HEAD は Cookie と同一 session budget を検査 |
| `dav` | HTTPS Basic のみ。CORS/CSRF Cookie を使わず browser Origin 付き request を拒否 |
| `public-form` | exact share landing Origin、share session/capability、one-time public CSRF。`Origin:null`/missing を拒否 |

Binary upload PUT は対応 profile の exact Origin、upload capability、known `Content-Length`、expected part metadata を要求するが JSON Content-Type は要求しない。single/multipart とも 411（length 欠落）、必要な `If-Match` 欠落は 428。manifest/scope/error/profile/state 遷移の全行を生成 test で被覆し、未知 method-template は 404 とする。

### 5.2 `fsMutation` の完全 SQL 契約

`control` と `_assert` の DDL は §3.1 だけを正本とする。mutation 基盤は次を必須とする。

```sql
CREATE TABLE permits (
  permit_id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','released','revoked'))
) STRICT;
CREATE INDEX permits_space_state ON permits(space_id,state,expires_at);

CREATE TABLE operations (
  op_id TEXT NOT NULL PRIMARY KEY,
  principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL,
  credential_id TEXT NOT NULL, credential_version INTEGER,
  space_id TEXT NOT NULL REFERENCES spaces(id), kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','committed','failed')),
  request_digest TEXT NOT NULL, epoch INTEGER NOT NULL,
  permit_id TEXT NOT NULL REFERENCES permits(permit_id),
  permit_expires_at INTEGER NOT NULL, claimed_expires_at INTEGER NOT NULL,
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

1. LockDO は permit 発行時、まず D1 primary に `permits(...,'open')` を INSERT し、成功後だけ `{permit_id,expires_at,epoch}` を Worker へ返す。`operations.claimed_expires_at = permits.expires_at` とする。claim は permit open/current epoch/current credential を条件に INSERT し、競合時は `(principal,credential,space,kind,request_digest)` を照合する。同じ op ID の別 payload は 409、terminal は現在認可後に replay、同じ `claimed` は同一 permit/fence の実行だけが再開できる。
2. **全 mutation batch の先頭**で permit、epoch、operation、現在認可を SQL error assertion にする。対象 principal に応じて user と credential/share を1〜2文含める。

```sql
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS (
  SELECT 1 FROM permits p JOIN operations o ON o.permit_id=p.permit_id
  WHERE p.permit_id=?1 AND p.state='open'
    AND p.epoch=(SELECT epoch FROM control WHERE singleton=1)
    AND o.op_id=?2 AND o.state='claimed' AND o.claimed_expires_at=p.expires_at
);
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE id=?3 AND disabled_at IS NULL
);
-- app password principal の場合
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS (
  SELECT 1 FROM app_passwords
  WHERE id=?4 AND user_id=?3 AND revoked_at IS NULL AND expires_at>unixepoch()
);
-- share principal の場合
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS (
  SELECT 1 FROM shares
  WHERE id=?4 AND version=?5 AND disabled_at IS NULL
    AND (expires_at IS NULL OR expires_at>unixepoch())
);
```

service は enabled mapping/mapped user/current scope、job は actor/credential/current grant/claim fence を同様に assertion する。文字列一致だけで commit 認可としない。

3. node/tree/quota/ref/audit/outbox/operation terminal の各必須 statement は revision、operation 別状態述語、epoch、permit を条件にし、**直後**に影響行 assertion を置く。live mutation は `deleted_at IS NULL`、restore/purge は `trash_members` と `trash_ops.state` を使い、全 node step に一律 live 条件を付けない。

```sql
UPDATE nodes
SET parent_id=?1,name=?2,name_ci=?3,revision=revision+1,
    updated_at=unixepoch(),last_op_id=?4
WHERE id=?5 AND revision=?6 AND deleted_at IS NULL;
INSERT INTO _assert(v) SELECT 1 WHERE changes() <> 1;

UPDATE spaces SET tree_generation=tree_generation+1
WHERE id=?1 AND tree_generation=?2;
INSERT INTO _assert(v) SELECT 1 WHERE changes() <> 1;

UPDATE users
SET reserved_bytes=reserved_bytes-?1,used_bytes=used_bytes+?2,
    physical_bytes=physical_bytes+?3
WHERE id=?4 AND reserved_bytes>=?1;
INSERT INTO _assert(v) SELECT 1 WHERE changes() <> 1;

INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
VALUES(?1,?2,?3,?4,'pending',?5,unixepoch(),unixepoch());
INSERT INTO _assert(v) SELECT 1 WHERE changes() <> 1;

UPDATE operations SET state='committed',result_json=?1,updated_at=unixepoch()
WHERE op_id=?2 AND state='claimed'
  AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?2)=expected_steps;
INSERT INTO _assert(v) SELECT 1 WHERE changes() <> 1;
```

事前条件は `INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS (...)` を使う。例:

```sql
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS (
  SELECT 1 FROM nodes WHERE id=?1 AND revision=?2 AND deleted_at IS NULL
);
```

`_assert.v=1` の CHECK 違反は SQL error であるため D1 `batch()` 全体が rollback される。`meta.changes` の JS 検査は二次診断だけで、成功/rollback の条件に使わない。Phase 0 gate 1 は D1 batch 内の `changes()` が直前 statement を指すことを実 D1 で証明する。失敗時は各 statement の後に、`last_op_id`、revision、step row 等を読む **EXISTS 型 assertion のみ**を置く fallback へ切り替え、`changes()` に依存しない。

4. D1 が明確な statement error/batch rejection を返した場合は rollback 済みである。primary で operation がなお `claimed` の場合だけ、current permit/fence を条件に別 batch で `failed` にする。`committed` は `failed` に戻さない。
5. `batch()` が network/timeout 例外を返し commit/rollback が不明な場合、operation を最大3回、合計5秒以内で primary から再読する。`committed|failed` なら現在認可後に結果を返す。それ以外は **503** と `Operation-Id: <op_id>`、`Retry-After` を返す。client は `GET /api/v1/operations/:id` を同 credential で照合し、同じ Idempotency-Key で再送する。例外を rollback と仮定して補償しない。
6. permit 期限切れ回収は、LockDO が D1 batch で `permits.state='open'→'revoked'` とし、同 permit の `operations.state='claimed'` だけを `failed` にしてから、新 permit を発行する。旧 Worker の batch は open permit assertion で必ず失敗する。正常 release は `open→released`。quiesce は open permit=0、expiry/revoke batch 完了、関連 claimed=0 を全て満たす。MOVE は commit 後の release で source lock を終了し、送信喪失は期限回収で収束する。

### 5.3 operation / outbox / derivative fencing

outbox producer は `completed` を `sent` へ戻さない。`dispatching`/`sent` の lease expiry を Cron が同じ outbox ID で回収し、D1 result 未確定なら再送する。Queue consumer は実行前に D1 claim を取得し、result/terminal/outbox を D1 で確定した後だけ message を ack する。ack 喪失は同一 claim/result CAS で冪等に収束する。

consumer は server derivative result row を `(kind,blob,variant,generator_version)` + claim token で CAS する。旧 Worker は claim token 不一致なら公開できない。derivative job は namespace LockDO を保持せず、current blob/generation の publish fence だけを使う。job lease の checkpoint/fence/side effect は同一 D1 batch、actor/credential/current grant/epoch を chunk ごとに再検査する。Queue message は小さい ID 参照だけとし payload は D1/R2 から再読する。client thumbnail 受付は v1 無効で result type/route を持たない。

---

## 6. upload、quota、再開

### 6.1 stream / hash contract

`POST /api/v1/uploads`（public upload-only では対応 public route）は `{mode:'single'|'multipart',declared_size,...}` を受け、current auth と reservation を確定して application upload ID/capability を返す。0 byte は `single` 固定。single body は `PUT /api/v1/uploads/:id/content` の**その request 内**で、既知 `Content-Length` と宣言 size を照合しながら不変 staging key `u/<owner>/b/<blobId>` へ `R2.put(key,request.body,{sha256?})` で stream 保存する。body を Worker/DO/D1 に一時保存しない。その後 `POST .../:id/complete` が metadata を commit する。public も同じ3段階である。

multipart は最終 part 以外5MiB以上かつ同一 size、最終 part だけ小さくてよい。expected size は受付前に決める。変換を挟む場合は `FixedLengthStream(expectedBytes)` の readable を R2 へ渡し、producer と R2 consumer を同時開始して双方の失敗時に cancel する。SHA-256 は `crypto.DigestStream('SHA-256')`。single は全 stream digest と実 size 一致時だけ `sha256_verified`、multipart は part digest と client 申告 `client_sha256` を分離し、`sha256_verified` は NULL。hash-wasm は不採用。

### 6.2 UploadDO state machine

D1 `uploads.state` は `created|uploading|completing|completed|aborting|failed|expired|aborted`、`blobs.state` は §3.1 の値だけを使う。`physical_charge_state` は設けない。DO は part/attempt/in-flight を一行ずつ保存し、10,000 part を単一 JSON にしない。

| from→to / event | 前提 | R2 / D1 / DO副作用 | failure / response loss回収 |
|---|---|---|---|
| new→`created` | current auth、owner/share reservation | mode/declared size/blob ID/deadline/epoch を D1 保存。multipart R2 upload ID は作成後ただちに永続化 | 永続化前停止は bucket lifecycle「incomplete multipart uploads を7日で abort」で回収 |
| `created`→`uploading` / single content | known length、single lease | request body を不変 key へ `put`。成功確認後 `blobs.staging` と physical 増額を D1 で記録 | 応答不明は `head()` で size/metadata を照合。台帳行のない object は orphan scan |
| `created|uploading`→`uploading` / part | current credential/epoch、同 part 排他 | attempt ID/lease を永続化し `uploadPart`、成功 etag/hash/size だけ CAS 保存 | part ごと最大3 attempts、calls≤parts×3、bytes≤declared×3 |
| `uploading`→`aborting` / part結果不明 | 旧 R2 I/O の成功/失敗を確定不能 | `accept_parts=0`、新 attempt を開始せず upload 全体を R2 abort | client は新 application upload と新 R2 upload ID で再開 |
| `uploading`→`completing` | 全 part/size、in-flight=0、`accept_parts` CAS false | multipart complete、single は既存 staging objectを利用。R2実在後 `blobs.staging` + physical を一度だけ記録 | 応答不明は不変 key `head()` で収束。実在なら再 complete しない |
| `completing`→`completed` | R2実在、current auth/revision/permit/epoch | `fsMutation` で node 公開、blob `staging→committed`、reservation→logical charge、R2 etag を同一 D1 batch | operation照合。`completed` は再課金しない |
| `completing` / abort request | complete が不可逆処理中 | 状態を変えず **409** | complete 応答不明は `head()` + operation照合で収束 |
| nonterminal→`failed|expired|aborted` | fatal/deadline/明示 abort | node非公開、R2 abort/deleteを収束。R2完成物は `blobs.orphan`、reservation解放 | physical は object delete/absent 確認後だけ減算。alarm→Cron repair |

`resumeMultipartUpload()` を実在確認に使わず、Workers API に list multipart を期待しない。R2 bucket lifecycle の7日 abort は release inventory で検証する。old epoch upload は `failed(reason='stale_epoch')` とし再利用しない。control/data/cleanup の counter を分け、cleanup は data budget 枯渇後も実行可能にする。

### 6.3 quota / browser resume

`used_bytes` は current/version/trash の owner 内 unique blob、`reserved_bytes` は未確定 upload/copy、`physical_bytes` は staging/orphan/GC待ちを含む実在 R2 bytes。予約は `used+reserved≤quota` かつ `physical+reserved≤quota×1.2` の条件付き UPDATE。upload-only は share 単位 reservation 上限も同じ batch で取得する。R2 実在確認後すぐ physical を一度だけ計上し、complete 失敗なら `orphan` のまま保持する。R2 delete success/absent 後だけ physical を減らす。

R2 object key `u/*/b/*` を bounded list し、`blobs` に無い key は発見時刻を記録して **35日 grace** 後に orphan GC する。IndexedDB は upload ID/capability/epoch/file fingerprint/part stateだけを期限内保存し logout/terminal で削除する。再選択時は File System Access handle があれば permission を再取得し、なければ name/size/mtime/sample hash を再照合する。browser incremental hash は Phase 0 で採用実装を承認するまで必須にせず、dedupe 根拠にしない。

---

## 7. WebDAV (`/dav`, `/dav/*`) と lock

### 7.1 parser / Class 1 semantics

app password Basic over HTTPS のみ。CORS 無し、browser Origin 付き request 拒否。`Authorization` は単一 Basic、decode 後512B以下。path は EffectiveLive で解決する。content PUT/COPY/MOVE/PROPPATCH 等で `If-Match` を必須とする箇所の欠落は 428、body 必須 route の `Content-Length` 欠落は 411。

XML は `davXml.ts` adapter で fast-xml-parser を次に固定する。

```ts
{ preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
  trimValues: false, processEntities: false }
```

parse 前に `<!DOCTYPE`（case-insensitive）、`<!ENTITY`、XInclude、外部/内部 entity 宣言を拒否する。標準5 entity と numeric character reference `&#...;` / `&#x...;` だけを bounded 手動 decode し、Unicode scalar でない値を拒否する。prefix ではなく namespace URI + local name で解釈し、§13 予算を parse 中に強制する。

| DAV protocol profile | v1 契約 |
|---|---|
| `If` header | tagged/untagged list、`Not`、複数 condition/listを受理。list≤16、各 list の token≤16。各 list は条件のAND、複数 list はORで、いずれか真なら通過。評価結果とは別に、request 内で提示された全 lock token の集合を収集し lock-token submission 検査へ渡す |
| collection revision | child create/delete/rename、move-in、move-out、当該 collection の PROPPATCH ごとに同じ `fsMutation` で増やす |
| Shared mount | `/dav/Shared/<mount>`。`Shared` と `.ncf-*` は通常名の予約語。mount は `<share_id_short>-<name>`、share作成時に確定し rename 後も不変。`GET /api/v1/shared-with-me` が同じ対応表を返す |
| dead property | `(node_id,namespace_uri,local_name)` を key とし、値は正規化 XML 断片文字列。mixed content 可、1 value≤8KiB、node≤100、user≤100,000 |
| protected live property | `getetag,getcontentlength,getlastmodified,resourcetype,lockdiscovery,supportedlock,creationdate`。PROPPATCH は 403 |
| PROPPATCH failure | document orderで検証するが D1 は全 rollback。直接失敗 property は 4xx、先に成功したはずの property と未実行 property も全て `424 Failed Dependency` |
| lock-null 相当 | 未存在 URL の LOCK は parent に対する `node.create` operand と current lock/permit を要求し、RFC 4918 §7.3 の locked empty resource（空 file node）を作る |
| COPY/MOVE | `Destination` は設定済み HTTPS app origin、query/fragment/userinfo無し。cross-space MOVE拒否。collection COPY は開始時固定 manifest、props引継ぎ、衝突方針を検査 |

PROPFIND は空 body（allprop）、`allprop`,`propname`,`prop`、Depth 0/1。infinity は403 `propfind-finite-depth`。Range は単一だけ、HEAD は body を読まない。

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

- lock 正準 resource は node ID。未存在 URL の LOCK は §7.1 の parent `node.create` 認可で locked empty file を作る。depth lock は current ancestor relation、overwrite target、destination ancestorにも効く。
- creator principal は **user ID**。app password は user principal の代理なので、同一 user の別 app password は creator 一致。service token は DAV 非対応。
- [RFC 4918 §6.4](https://www.rfc-editor.org/rfc/rfc4918.html#section-6.4)に従い、locked mutation は current write 権限、lock token submission、認証 principal=lock creator を全て要求する。refresh/UNLOCK も同じで、管理強制解除だけ別 admin operation。
- token hash、creator user/credential（監査用）、node、display URI、depth、expiry、generation、epoch を DO SQLite へ保存し、他 principal へ token を表示しない。
- permit は §5.2 の D1 `open` INSERT 成功後だけ返す。期限回収は D1 `revoked` + claimed operation failed の完了前に交差 lock を grant しない。MOVE commit 後の release で source lock を終了し destination へ継承しない。
- recovery は maintenance 下で D1 permit/operation を収束し、ControlDO 発行の新 epoch で再初期化する。永久 stale 409 にしない。

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

URL は `/s/<shareId>#<secret>`。public landing JS が fragment を読み history から直ちに除去して POST body へ渡し、token を path/query に置かない。share root/current subtree/action/expiry/version へ限定し、変更/revoke で version を進める。internal share は read/edit、ancestor trash で即時無効、restore で旧 grant を復活させない。

upload-only は create/upload receipt/status だけを許可し、list/read/overwrite/delete を禁止する。同名時は server が自動 rename し、成功・衝突のいずれも同形の `201 {receipt_id,status_url}` だけを返して確定名・競合差を開示しない。share 単位 reservation と owner reservation の双方を取得する。

### 8.2 CONTENT_ORIGIN ticket 搬送

採用方式は D1 `content_sessions` が権威の短命 content-session Cookie と `BudgetDO(budget_id)` である。

1. Access 認証 SPA または share UI は、許可する node/blob/purpose の bounded target 集合を D1 に保存する。ticket には集合本体でなく `target_set_id + hash`、purpose=`content|thumb|page|zip|track`、epoch、credential/share version、`budget_id` を入れる。
2. app は audience=`CONTENT_ORIGIN`、expiry≤600秒かつ share expiry 以下の署名 ticket を返す。ticket は個別 cancel 可能で、`content_sessions.revoked_at` と ticket cancel row を毎 request 検査する。
3. browser は `POST <CONTENT_ORIGIN>/session` を `credentials:'include'` で呼ぶ。§5.1 の OPTIONS/POST 固定 allowlist CORS を使う。
4. content origin は opaque session ID の `__Host-ncf_cs` を `Secure; HttpOnly; SameSite=None; Path=/; Max-Age≤600` で設定する。`content_sessions` は user/share/credential/target set/budget ID/expiry/revoked_at を持つ。
5. 同じ user+share（private は user+credential）の session 更新・別 tab 発行は、期限内の既存 `budget_id` を再利用する。新 session で budget を増やさない。budget 上限は対象合計 bytes×3、1,024 requests/10分、parallel≤8。
6. `/c` content、thumb、page、entry、track、ZIP、対応 public route の全 byte/request/HEAD/Range を同じ BudgetDO へ接続する。BudgetDO storage は≤1MiB、lease TTL 10分、disconnect/cancel は明示精算し、漏れは alarm が回収する。

単一 host 構成も同じ host-only Cookie を使うが §10 の CSP/attachment 制限は維持する。fetch→blob URL は≤32MiB の plain text、sanitized Markdown input、pdf.js inputだけ。大容量 audio/video/image/EPUB を blob 化しない。

### 8.3 ZIP / ticket budgets

ZIP ticket は purpose=`zip`、manifest hash、node+blob集合、share version、epoch、budget ID を束縛する。manifest 作成から配信終了まで blob pin を保持する。v1 ZIP は **STORE のみ**で、圧縮差による予算ずれを作らない。exact output size は実配信と同じ serializer を dry-run して local header/data descriptor/central directory を含め算出し、その hash/size を manifest に保存する。R2 reader は小さい固定並列で backpressure を待ち、disconnect は reader/serializer/budget lease を cancel する。

---

## 9. Web UI

React、TypeScript、Vite、Tailwind、shadcn/ui、TanStack Router/Query/Virtual を browser だけで使う。My Drive、Shared、Recent、Starred、Trash、Gallery、Bookshelf、Audio、quota、upload/job panel を v1 で提供する。optimistic update は409/412で rollback。PWA/Service Worker は **v1.1** とし、v1 bundle へ登録 code を含めない。

`/s/*` の JS/CSS は別 entry の `public-share.[hash].js/css` とし `/public-assets/*` から配信する。pure な表示 component の source 共有は可だが、server/private chunk、auth client、secret、開発 bypass の public bundle 混入は CI で build failure にする。manifest は `auth:'public'` と SRI hash を持ち、landing は `integrity`+`crossorigin` を必須にする。filename/tag/EXIF/error は React text node、`dangerouslySetInnerHTML` 禁止。

---

## 9A. メディアライブラリ (Gallery / Bookshelf / Audio)

### 9A.1 Gallery

folder 内画像/動画、任意 recursive を対象にし keyset 最大200件。`node_media` は `width,height,taken_at,duration_ms,orientation,dominant_color` と bounded camera 情報だけ。GPS破棄。thumbnail は sm256/md768/lg1600、lg は lazy unique claim。recursive 候補は SQL で50,000を強制し、§15 gate 未合格時は10,000へ縮小する。v1 UI は grid/list、folder/recursive 切替、lightbox、次/前、共有閲覧を必須とし、高度 layout は v1.1。

2026-09-22 確定要件: 事前エンコード済みの AVIF 画像と AV1 動画（MP4/WebM、Opus 音声付き/音声無し）を必須対応とする。原本を保持し、画像表示/動画再生は認可済み content URL へ直接接続する。実 codec/bit depth を取得して再生可否を判定し、未対応端末では download 導線を提供する。詳細は [`MEDIA_FORMATS.md`](MEDIA_FORMATS.md)。

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

- reader shell はアプリの静的 asset で、**スクロール中心の reflow、TOC、CFI位置保存、theme/font-size**を v1 必須とする。
- server Queue job が XHTML を sanitize し、`script`,`on*`,`javascript:`,外部 URL を除去して immutable derivative として R2 へ保存する。shell は sanitize 済み DOM を解析し、内側 frame 更新は新しい `srcdoc` を生成して行う。
- inner CSP は `default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:`。publication 由来 script を許可しない。
- pagination は browser/CFI round-trip gate 合格後の v1 option、未合格なら v1.1。固定 layout、media overlay、JS依存EPUB、vertical pagination保証は非目標。Bookshelf v1 UI は cover/list、open、TOC、前回位置 resume、共有閲覧を必須とする。

### 9A.3 Audio

MP3/FLAC/OGG/Opus/M4A/MP4/WAV の bounded tag parser。通常 head≤2MiB+tail128B、MP4 moov探索≤4MiB。cover の追加 Range は offset/length を検証し、≤20,000,000B かつ全体 budget 内だけ実行する。field≤1KiB、folder≤2,000 tracks。content-session Cookie + single Range で再生する。v1 UI は track list、play/pause、前/次、volume、position保存、共有再生を必須とし、timeline scrubber、queue高度操作、複数layoutは v1.1。

Opus は Ogg（`.opus`/`.ogg`/`.oga`）、WebM、MP4 を対応対象とし、client MIME/拡張子だけで codec を確定しない。再エンコードを原本再生の前提にしない。MP4 の codec parameter は `Opus`、Ogg/WebM は `opus` とする。

### 9A.4 共通認可 / job

全media routeはEffectiveLive、capability root、current blob、generation、credential scopeを検査する。index/tag/sanitize/thumb jobはoutbox、saved principal、epoch、fenced result claimを使いstale結果を公開しない。

---

## 10. stream、derivative、preview、content delivery

### 10.1 R2 delivery

`R2Bucket.get()` null は、D1 に対応する committed/current blob が無い通常の未存在 resource なら404、D1 が committed blob を指すのに object が無ければ整合性障害として 503 + repair enqueue とする。conditional get の body無しは304、HEAD は `head()` で body を読まない。single Range は206/416、multi-range は全 size budget を先取りできる時だけ Range を無視して200。D1 content ETag と R2 `httpEtag` を混同せず、client 由来 `Content-Encoding` を転記しない。

### 10.2 ZIP / archive stream

ZIP 生成は STORE の同期 serializer（fflate を使う場合は `Zip`,`ZipPassThrough` だけ）とし、`ZipDeflate`/`Async*` は禁止。dry-run と本配信に同じ serializer/version/entry metadata を使う。bounded output queue（≤1MiB）を drain してから次 input chunk を push し、1,000 R2 object の `Promise.all` や片側だけ先行する `tee()` を禁止する。CRC/header/data descriptor/central directory を exact size に含め、non-ZIP64 かつ output **≤4,294,967,295 bytes** とする。

ZIP展開は自前central directory parser + `DecompressionStream('deflate-raw')`。fflateを展開に使わない。local/centralのmethod/flags/name/size一致、暗号化拒否、safe integer、CRC、output≤64MiBを検査する。stream開始後CRC不一致はstream errorでありstatus変更を保証しない。

### 10.3 derivative / Images

server derivative key は immutable generation。claim tuple+fence で一 Worker だけを公開者にする。Images input は20,000,000B以下、dimension/frame/app pixel budget を header で先に検査し、WebPへ re-encode して metadata を除く。AVIF input は staging 確認し未対応なら derivative だけを unsupported とする。AVIF 原本の保存/表示は対応対象であり、detail は原本、grid は placeholder に fallback する。**v1 は client thumbnail 受付を無効化し route/result row/key を作らない。** 将来有効化する条件は §18。

### 10.4 delivery matrix / CSP

全 response に sniff 済み Content-Type、`X-Content-Type-Options:nosniff`,`Referrer-Policy:no-referrer`、適切な Disposition を付ける。認可済み API/content/page/entry/track/ZIP/public-share 応答は **`Cache-Control: private, no-store`** とし、206/errorでも落とさない。`CONTENT_ORIGIN` に private router、SPA fallback、Service Worker を置かない。password 保護 share の OG metadata は file/share 名を含まない固定汎用文言だけを返す。

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

`trash_ops.state` は **`pending → trashed → (restoring → restored) | (purging → purged)`** のみ。trash commit batch は root を隠す前に、同時点で live な root+descendant だけを `trash_members(trash_op_id,node_id)` へ確定する。既に `deleted_at IS NOT NULL` の子や別 `deleted_op_id` の子は含めない。root revision、membership、root不可視化、tree generation、share/ticket失効、state=`trashed` の全必須 step は §5.2 assertion を直後に置く。

```sql
-- 全 restore/purge chunk の規範 guard（permit/current auth assertionも同batch）
UPDATE nodes SET /* operation別の更新 */
WHERE id IN (SELECT node_id FROM trash_members WHERE trash_op_id=?1)
  AND EXISTS (SELECT 1 FROM trash_ops WHERE op_id=?1 AND state=?2);
INSERT INTO _assert(v) SELECT 1 WHERE changes() <> ?3;
```

全 descendant tagging/restore/purge chunk は membership + expected `trash_ops.state` + open permit/current epoch/current auth で fence する。共有/ticket が失効する公開点は `trashed` commit。restore は開始前に ControlDO `gc_paused=true`、進行中 GC R2-delete lease 期限経過、`gc_candidates.deleting=0` を待つ。全 member と旧 share 失効を処理し、最後の batch だけが root を live 化して `restored` にする。`purging` が restore 不可の不可逆点で、manifest cursor は実体 staging parent を作らない。

purge の FK 削除順序は次を正本とし、各段を member/state/permit で guard する。

| 順序 | table / action |
|---:|---|
| 1–6 | `node_tags`, `node_media`, `node_audio`, `library_items`, `user_reading_state`, `user_playback_state` |
| 7–12 | `shares`, `share_grants`, `node_versions`, `locks`, `uploads(parent)`, `search_index` |
| 13 | `nodes` を depth 降順（子→親） |

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

`gc_candidates.pinned_by` は materialized fence、複数 pin の権威は `blob_pins` 行。pin 追加時は §3.1 の deleting/deleted rejection assertion を使う。`deleting` 遷移は ref=0、pin row無し、`pinned_by IS NULL` を再検査し、**同じ D1 batch** で `blobs.state='deleting'` と `gc_candidates.state='deleting'` を更新する。R2 delete success/absent 後だけ同一 batch で両者を `deleted` にして physical bytes を減らす。response loss は `head()`、claim token、同一 candidate で収束する。maintenance job 一 invocation の共通予算は node≤1,000、blob≤1,000、R2 API≤2,000、wall≤25秒。

### 11.3 backup / restore with FTS

journal は廃止する。第一の復旧手段は D1 **Time Travel point-in-time restore（30日）**、第二は account喪失/別region向けの `wrangler d1 export` logical export である。virtual/shadow FTS は export せず、通常 table（operations/outbox/claimsを含む）から再構築する。

1. 日次 export は ControlDO の短い backup write barrier で新規 mutation admission を止め、open permit/claimed operation を収束してから、最新 `operations.state='committed'` の op ID を `control.backup_barrier_op` に記録する。その直後に export snapshot を開始し、開始確認後に barrier を解除する。watermark を含む export/checksum/manifest を同じ generation として公開し、「watermark 時点の状態」とする。
2. restore 前に maintenance、ControlDO `gc_paused=true` を設定し、新規 GC claim を止める。open permit を revoke、claimed operation を収束し、in-flight R2 delete/job lease の期限経過を待ってから D1 を restore する。
3. **ControlDO が唯一の epoch 発行者**である。maintenance 中に `bumpEpoch()` で単調増加値を発行し、restore 後 D1 `control.epoch` へ複製する。ControlDO storage 自体を失った場合の初期値は `max(D1 control.epoch, 現在時刻の秒)+1` とし、過去値を再使用しない。
4. Time Travel は選択時点、logical export は `backup_barrier_op` までの状態として復元する。snapshot に存在する committed/failed operation の terminal state を保存し、`failed` に書き換えない。watermark 後の operation は restore 後に存在しないため照合は404となり、client は「未確定・同じ Idempotency-Key で再送可」と扱う。
5. §12 の base `search_index` から FTS external-content index を再構築し、R2 existence、quota/ref、root/owner、bootstrap、share version、credential、permit/claim、outbox を検査する。旧 UploadDO は stale epoch failed、LockDO/BudgetDO は old epoch lease を無効化する。
6. 検証後に maintenance を解除し、最後に GC pause を解除する。月1回 staging restore drill を行う。

保持は Time Travel 30日 + logical export を **日次、最大年齢35日、最少5世代**の両条件で満たす。すなわち5世代を残しても35日超の export は復旧対象にせず、失敗時は alert して新しい5世代を再確保する。R2だけから namespace を再構築できるとは主張しない。

---

## 12. list、search、Gallery、ancestor SQL

### 12.1 children / PROPFIND Depth:1

REST 一覧は最大200/pageの keyset。cursor は署名して `scope root + filter + sort key/direction + last values + tree_generation` に束縛し、条件変更/改変は400にする。§3.1 の唯一の `nodes_children_keyset` は実 SELECT 列を含む。folder 全体を offset scan しない。

```sql
SELECT id,name,kind,revision,current_blob_id,updated_at
FROM nodes INDEXED BY nodes_children_keyset
WHERE parent_id=?1 AND deleted_at IS NULL
  AND (name_ci>?2 OR (name_ci=?2 AND id>?3))
ORDER BY name_ci,id LIMIT ?4;
```

PROPFIND Depth:1 は親の EffectiveLive を一回証明し最大1,000 childを集合取得する。property は LEFT JOIN、node ごとの D1/DO callは禁止。1,000超は count preflight 後507、lockdiscovery は LockDO へ node ID 集合を一回で照会する。node 100 properties/user 100,000 の上限を schema と mutation でも強制する。

```sql
SELECT n.id,n.name,n.kind,n.revision,n.current_blob_id,
       p.namespace_uri,p.local_name,p.value_xml
FROM nodes n LEFT JOIN node_props p ON p.node_id=n.id
WHERE (n.id=?1 OR n.parent_id=?1) AND n.deleted_at IS NULL
ORDER BY CASE WHEN n.id=?1 THEN 0 ELSE 1 END,n.name_ci,n.id;
```

### 12.2 FTS / scope-aware search

```sql
CREATE TABLE search_index (
  rowid INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id),
  space_id TEXT NOT NULL,
  text_norm TEXT NOT NULL,
  tokens TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1)
) STRICT;
CREATE INDEX search_index_scope ON search_index(space_id,node_id);
CREATE VIRTUAL TABLE search_fts USING fts5(
  text_norm,tokens,content='search_index',content_rowid='rowid',tokenize='unicode61'
);
```

`text_norm` は name/title/author/series/tags/audio の表示原文を NFKC + Unicode casefold + カタカナ→ひらがな統一した文字列、`tokens` は version 固定 bigram を空白区切りにした列で、両者を混同しない。fsMutation の同じ batch で base row と external-content FTS を同期する。update/delete は旧値を使う delete command の後に base update/delete と新 insert を行い、各 step を assertion する。

```sql
INSERT INTO search_fts(search_fts,rowid,text_norm,tokens)
VALUES('delete',?1,?2,?3); -- 旧値
DELETE FROM search_index WHERE rowid=?1;
-- insert/update 後
INSERT INTO search_fts(rowid,text_norm,tokens)
SELECT rowid,text_norm,tokens FROM search_index WHERE rowid=?1;
```

query bigram はそれぞれ `"..."` で quote し、内部 `"` を `""` に escape して AND 連結する。FTS は候補生成だけで、最終 substring は escaped `text_norm LIKE` で順序照合する。scope CTE 自体に `LIMIT 10000` を置き、候補/FTSも10,000で打ち切る。

```sql
WITH RECURSIVE scope(id,depth) AS (
  SELECT ?1,0 UNION ALL
  SELECT n.id,s.depth+1 FROM nodes n JOIN scope s ON n.parent_id=s.id
  WHERE n.deleted_at IS NULL AND s.depth<64
  LIMIT 10000
), hits AS (
  SELECT si.node_id,bm25(search_fts) rank
  FROM search_fts JOIN search_index si ON si.rowid=search_fts.rowid
  WHERE search_fts MATCH ?2 AND si.space_id=?3 LIMIT 10000
)
SELECT n.id,n.name,n.kind,h.rank
FROM hits h JOIN scope s ON s.id=h.node_id JOIN nodes n ON n.id=h.node_id
JOIN search_index si ON si.node_id=n.id
WHERE n.deleted_at IS NULL AND si.text_norm LIKE ?4 ESCAPE '\'
ORDER BY h.rank,n.id LIMIT ?5;
```

scope または hits が上限到達なら `truncated:true` を返し count/facet を確定値にしない。LIKE fallback は pattern≤50B、scope内10,000候補まで。一文字 global scanは禁止。

### 12.3 Gallery / media list

recursive Gallery は CTE candidate **LIMIT 50000**（gate 未合格時10,000）を SQL で強制し、current blob と generator を集合 guard して keyset 200件を返す。

```sql
WITH RECURSIVE sub(id,depth) AS (
  SELECT ?1,0 UNION ALL
  SELECT n.id,s.depth+1 FROM nodes n JOIN sub s ON n.parent_id=s.id
  WHERE n.deleted_at IS NULL AND s.depth<?2
  LIMIT 50000
)
SELECT n.id,n.name,m.width,m.height,m.taken_at,m.duration_ms
FROM sub JOIN nodes n ON n.id=sub.id JOIN node_media m ON m.node_id=n.id
WHERE n.current_blob_id=m.blob_id AND m.generator_version=?3
  AND (COALESCE(m.taken_at,n.updated_at)<?4 OR
      (COALESCE(m.taken_at,n.updated_at)=?4 AND n.id>?5))
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
| request/header | `MAX_REQUEST_BYTES=95,000,000`、URL≤8KiB、header合計≤64KiB、header数≤100、token≤2KiB（target集合はID+hash） |
| JSON/XML | JSON≤1MiB/depth32。XML≤1MiB/depth32/elements10,000/attributes20,000/namespaces100/properties100/value8KiB/response32MiB |
| name/tree | NFC UTF-8≤255BかつUnicode scalar<255、casefold列≤1,024B、depth≤64 |
| upload | default64MiB、非最終part8–90MiB、最終part>0–90MiB、≤10,000 parts、file≤500GiB、0Bはsingle、in-flight4、part15min、作成6日/無進捗24h。partごと3 attempts、calls≤parts×3、bytes≤declared×3。data/control/cleanup counter分離 |
| metadata / bulk | COW refs≤1,000/blob、dead property≤100/nodeかつ≤100,000/user、各value≤8KiB、bulk受付≤1,000 nodes |
| Queue / job | message≤120,000B、sendBatch≤240,000B、delivery retry≤10、transform attempt≤3、retention14日。owner別claim上限。maintenance 1 invocation: node≤1,000/blob≤1,000/R2 API≤2,000/wall≤25秒 |
| image | input≤20,000,000B、width/height各≤12,000、area≤40MP、frame1、WASM image transform不採用、client thumbnail受付無効 |
| list/search | REST page200、DAV Depth:1 children1,000、Gallery page200/candidate50,000、search scope/candidate10,000、tracks2,000 |
| DAV COPY/MOVE | same-owner、≤1,000 nodes、≤10GiB。超過403 custom error |
| ZIP/archive | output≤4,294,967,295 bytes/non-ZIP64、entries1,000、archive entries10,000、entry output64MiB、total8GiB、CD8MiB、EOCD1MiB、index JSON≤8MiB |
| ticket/content session | ticket≤share expiry、session Cookie≤600s、BudgetDO lease=10分、bytes≤target合計×3、requests≤1,024/10分、parallel≤8、storage≤1MiB、blob URL≤32MiB |
| KDF | PBKDF2-SHA256 100,000、salt16B、DK32B。600,000はstaging gate |
| retention | versionsは「直近10件**または**30日の長い方」、operation/audit90日、R2 audit1年、Time Travel30日、logical export日次・最大年齢35日・最少5世代、GC/orphan grace35日 |
| D1 capacity | node≤200,000/userに加えDB 10GBの70%で新規user停止、80%でwrite alert、90%でmaintenance |

### 13.3 Cloudflare exception → HTTP mapping

| source / condition | HTTP | client retry | 規則 |
|---|---:|---|---|
| edge body上限 / app body超過 | 413 | no | multipartへ切替 |
| malformed/unknown schema/XML budget | 400 | no | RFC9457 / DAV XML |
| D1 constraint / revision CAS | 409/412 | conditional | fresh state取得、同op IDはreplay |
| D1 overloaded/timeout、commit不明 | 最大3回/合計≤5秒照合後 503 | yes | 未終端は `Operation-Id` + `Retry-After`、GET operationで照合 |
| DO overloaded / reset | 503 | yes | `Retry-After` + Idempotency-Key |
| old UploadDO epoch | 409 | no | 新upload作成 |
| lock missing/mismatch | 423 | after token | `lock-token-submitted` |
| quota | 507 | after freeing | DAV大規模COPY/MOVEには使わない |
| R2 conditional put `null` | 412 | after refresh | 例外扱いしない |
| R2 absent + D1にもresource無し | 404 | no | 通常の未存在 |
| R2 absent + D1 committed/current | 503 | conditional | 整合性障害、repair enqueue |
| R2 same-key 429 | 503 | yes | jitter backoff、不変key/claim照合 |
| Queue 429 / backlog full | 503 to producer | internal yes | outboxをpendingのままretry |
| Images size/format | 413/415 | no | original attachmentは可能 |
| Rate Limiting `{success:false}` | 429 | yes | `Retry-After`、厳密quotaに使わない |
| Worker内でcatch可能なtimeout/例外 | 503 | idempotent only | budget前倒し、algorithm縮小 |
| platform CPU/memory 1102 | platform生成（Workerでcatch/503変換不能） | idempotent only | request自体が強制終了。operation照合、streaming/予算で予防 |

### 13.4 security / audit

CSP/MIMEは§10.4、CSRFは§5.1を正本とする。secret/PIIをURLに置かず、Authorization/Cookie/JWT/Basic/Service secret/share secret/CSRF/upload capability/ticket/D1 bindをlogしない。Workers Logs/Tail/Logpush/trace/WAF/D1 errorをcanaryで検査する。admin/deploy/secret/Access policy変更はMFA、最小権限、two-person approval、外部audit archive。

### 13.5 dependency contract

全versionは`package.json`でexact固定しlockfileをcommitする。Phase 0時点で7日未満のreleaseは採用しない。

| 名前 | 用途 | Workers上の制約 | 禁止API / 用法 |
|---|---|---|---|
| `hono` | route / middleware | binary routeでbody parserを通さない | manifest外route |
| `@hono/zod-openapi` | schema / OpenAPI | Hono/Zod互換版をexact固定 | 別package `zod-openapi`との混同 |
| `fast-xml-parser` | DAV XML lexical parse | 必ず`davXml.ts` adapter + §7設定 | direct import、DTD/entity自動処理 |
| `fflate` | ZIP STORE生成 | sync `Zip`/`ZipPassThrough`だけ、bounded queue | `ZipDeflate`,`Async*`, worker API、ZIP展開 |
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
    { "name": "BUDGETS", "class_name": "BudgetDO" },
    { "name": "CONTROL", "class_name": "ControlDO" }
  ]},
  "migrations": [{
    "tag": "v1-sqlite-do",
    "new_sqlite_classes": ["LockDO", "UploadDO", "BudgetDO", "ControlDO"]
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
        { "name": "BUDGETS", "class_name": "BudgetDO" },
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
        { "name": "BUDGETS", "class_name": "BudgetDO" },
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

queue作成後に `wrangler queues update <queue> --message-retention-period-secs 1209600` を staging/production で適用し IaC drift を検査する。`DEV_BYPASS_ACCESS` は staging/production schema で禁止する。

| key secret | 用途 / record kid | 通常 rotation | 緊急 rotation |
|---|---|---|---|
| `SIGNING_KEYS` (`kid` ring) | ticket/share capability署名 | 新 kid を primary 追加→旧検証を最長 token TTL 維持→削除 | 新 kid 配備、旧 kid denylist、epoch bump、全 ticket/share session再発行 |
| `CSRF_KEY` | one-time CSRF HMAC | 新旧2鍵を短い CSRF TTL だけ併用 | 即時交換、全 CSRF 無効化 |
| `CONTENT_SESSION_KEY` | content-session Cookie ID digest/署名 | 新 kid 発行、既存 session TTL≤600秒だけ旧検証 | 即時交換、`content_sessions` revoke、epoch bump |
| `APP_PASSWORD_PEPPER` | app password digest pepper | 新 record は新 kid、旧 record は成功時re-hash | 旧 kid失効、対象 app password全 revoke・再発行 |

share/app password record の `kdf`,`kdf_params`,`kid` と signing record の kid を監査する。secret 値は environment 別 `wrangler secret` で登録し、通常 rotation は dual-read/single-write、緊急 rotation は maintenance + epoch bump +失効表に従う。

### 14.2 DO capacity / alarm / eviction

| DO | v1 in-flight / storage上限 | alarm retry枯渇 | eviction / stale再初期化 | 必須試験 |
|---|---|---|---|---|
| LockDO | open permit≤64/space、lock≤10,000/space、SQLite警戒8GiB | 6 retry後repair flag、hourly CronがD1 permit/operation照合 | lockをSQLiteから復元。permitはD1 stateが権威、old epochはrevoke後に再初期化 | reset中permit expiry、旧Worker再開、parallel slot leak |
| UploadDO | part in-flight≤4/upload、part rows≤10,000、SQLite警戒64MiB | 6 retry後cleanup_pending、CronがR2 head/abort | SQLite part/leaseから復元。old epochはfailed(stale_epoch) | upload中reset、late part、complete/abort loss、slot leak |
| BudgetDO | parallel≤8/session、storage≤1MiB、lease TTL10分 | alarmでbyte/request/parallel lease精算、Cron repair | D1 content session/budget IDから再構築。old epoch lease拒否 | disconnect、複数tab更新、alarm遅延、budget迂回 |
| ControlDO | mutation admission≤32/account、KDF実行1/instance、待ちqueue≤256 | 6 retry後maintenance維持、外部Cron/管理probe | SQLite epoch正本。storage喪失時だけ `max(D1 epoch,unix秒)+1` で再初期化しD1へ複製 | overload、epoch非再使用、queue leak、storage喪失 |

alarmは最短deadline一つに集約し処理後に次を設定する。alarm遅延に備え全requestでexpiryを検査する。shutdown hook/finallyをlease回収根拠にしない。

### 14.3 operations

release ごとに environment 別 Cloudflare 運用 inventory を version 管理し drift を gate する: Access user/service/Bypass policy、custom domain/route、D1/R2/KV/DO/Queue/Images/Rate Limit resource ID、R2 public access off と incomplete multipart 7日 lifecycle、Queue retention/DLQ/concurrency、Cron、全 secret kid、workers.dev/preview off、zone body limit、alert/Logpush、Time Travel/export/restore 手順。deploy 後は content CORS/Cookie、unknown route、host/alias、HTTPS を実 HTTP 検査する。backup/restore drill は月1回。D1 70/80/90%閾値、DO storage、Queue/outbox/claim age、permit、upload/orphan cleanup、GC pin、KDF、R2 429、rows_read/duration_ms を監視する。

---

## 15. test plan / acceptance

### 15.1 D1 query budget fixtures

`rows_read` と `duration_ms` は実 D1 `meta` で測る。T は release gate であり local 成功だけでは確定しない。超過時は index/query を修正し上限を広げない。

| fixture / path | query数 N | bind/statement | rows_read M | duration_ms T | 期待 |
|---|---:|---:|---:|---:|---|
| children 1,000 / REST page200 | ≤2 | ≤8 | ≤450 | ≤50ms | 200 + cursor |
| children 10,000 / REST page200 | ≤2 | ≤8 | ≤450 | ≤50ms | offset無しで同予算 |
| children 1,000 × dead props 20 / PROPFIND Depth:1 | ≤4 | ≤12 | ≤25,000 | ≤250ms | ≤32MiB streamed 207、N+1無し |
| children 10,000 / PROPFIND Depth:1 | ≤2 preflight | ≤4 | ≤10,100 | ≤150ms | stream前507 |
| search scope/candidate10,000 | ≤3 | ≤12 | ≤20,000 | ≤250ms | max200 / `truncated:true` |
| Gallery candidate50,000 | ≤3 | ≤12 | ≤60,000 | ≤300ms | max200、未達ならcandidate10,000 |
| ancestor depth64 | 1 | 2 | ≤65 | ≤50ms | EffectiveLive true |
| MOVE src+dst depth64 | ≤4 | ≤16 | ≤260 | ≤150ms | cycle/epoch/CAS proof |

200件/pageは「返却200=rows_read200」ではなく、covering keyset indexによりM≤450を実測する契約。`IN`分割 fixtureは99/100/101/2,000 IDsで各statement≤100 bindを検査する。

### 15.2 CI 三段階

1. **unit**: Vitest pure TypeScript。decoder、normalization/bigram/escaping、authorize matrix、state machine、XML budget/entity/If、ZIP central parser/STORE size、error mapping、manifest completeness。
2. **integration**: `@cloudflare/vitest-pool-workers` + Miniflare。D1 migration/FK/FTS external sync/SQL-error rollback、R2 single/multipart/Range、DO SQLite/reset/alarm、Queues duplicate/ack/retry、stream backpressure、outbox/claim/permit fence、failure injection。
3. **staging smoke**: `wrangler deploy --env staging` で実 Cloudflare へ配備。Access/Bypass/Service Auth、CONTENT_ORIGIN Cookie+CORS+Range、PBKDF2、Images、Queue、D1 `changes()` gate/rows_read/duration_ms、R2 response loss/lifecycle、DO eviction、Time Travel/export restore drill、platform log canaryを検査する。

Miniflareで確認できる範囲と、localでは再現または保証できずstagingが必須の範囲:

| 対象 | unit / Miniflare integration | staging必須 |
|---|---|---|
| Access | fixture JWT、issuer/AUD、route境界 | edge policy、IdP/MFA、header付与、logout伝播、実Cookie |
| edge HTTP | app 95MB制限、stream byte count | zone body limit、CL/TE正規化、実client framing |
| Worker | bounded algorithm、cancel/slow consumer | production CPU/memory enforcement、isolate concurrency、runtime update |
| D1 | migration/FK/FTS/batch rollback | actual rows_read/duration_ms、`changes()`直前statement性、overload、replica lag、Time Travel/export |
| R2 | multipart/Range基本API | same-key 1/s、lifecycle、各response loss、実整合性 |
| DO | SQLite/state/alarm handler/reset fault | placement/eviction/overload/version混在、alarm retry枯渇 |
| Queues | producer→consumer、duplicate/ack/retry | consumer concurrency、実delivery/retention/DLQ |
| Images | offline width/height/rotate/format | codec/metadata除去/20MB境界/AVIF plan、service負荷 |
| Rate limit | local simulationの分岐/key/429 | multi-PoP/isolateの緩い整合性 |
| Cron | `scheduled` handler明示呼出し | scheduler伝播、重複、実wall/CPU |
| browser/DAV | Playwright/litmus/rclone automation | SameSite=None、browser差、Finder/Explorer実機 |

### 15.3 failure / protocol release gate

- **G01 regression fixture**: (a) node revision不一致でも tree/quota変更ゼロ、(b) tree generation不一致でも node/quota/outbox変更ゼロ、(c) trash root revision不一致でも root liveかつ `trash_ops.pending` のまま、を SQL error rollback で実証する。全必須 step の0行/constraint failureも副作用ゼロ。
- Phase 0 gate 1 で D1 batch 内 `changes()` が直前 statement を指すことを実証し、不合格時は EXISTS assertion-only fixtureを全 mutationへ適用する。
- commit response loss は3回/5秒照合、未確定503 + Operation-Id/Retry-After、GET operation、同一 Idempotency-Key再送を検証する。
- claim前停止、claimed放置、permit expiry/revoke、DO reset、release loss、old Worker再開、失効対commit、quiesceを注入し旧commit無し。
- single 0B/public upload、part retry/累積上限、late unknown attempt→aborting、complete response loss、complete対abort 409、orphan/physical charge/lifecycleを収束。
- 独立して削除済みの子、trash membership途中停止、restore最終公開、purge全FK順、deletingへの参照、複数pin、GC delete response loss/restore quiesceを検証。
- Time Travel/export watermark、terminal state保存、ControlDO epoch非再使用、404 operation再送、FTS rebuild、quota/ref再計算を restore drill で検証。
- wrong JWT issuer/AUD/alg/time、unknown kid、bootstrap allowlist競合、最後のadmin、credential/share/content-session失効、CSRF/CORS、secret log漏えいを拒否。
- XML numeric reference/DTD拒否、If式とtoken submission、PROPPATCH全rollback424、lock-null parent operand、Shared mount、collection revision、litmus/実clientを検証。
- search normalization/bigram quote/substring、scope10,000 truncated、Gallery current blob/generator/50,000、PROPFIND 1,000×20 propsを検証。
- Gallery E2E は grid/list・recursive・lightbox・共有、Bookshelf E2E は scroll/TOC/CFI resume・sandbox・共有、Audio E2E は basic player・Range・user別position・共有を必須とする。
- ZIP STORE dry-run exact size、pin/cancel、slow consumer/disconnect、archive CRC/ZIP64/暗号化/overflow、`ZipDeflate`/Async import禁止を検証する。
- public bundle に private/server/auth/bypass chunk がなく、pure表示source共有だけが許可されることを bundle graph で検証する。

---

## 16. 実装 phase / deliverable

完了欄の `M/U/I/R` は migration / unit / integration / rollback手順を意味し、該当しない場合も `N/A` を記録する。Phase 0 → 1 の順に着手し、quota/physical/ref/pin ledger、permit、operation claim、outbox/repair はすべて Foundation で導入して最初の mutation から適用する。journal は導入しない。

| ID | deliverable | 導入する不変条件 | 依存 | 完了条件 |
|---|---|---|---|---|
| 0.1 | exact toolchain/binding + PBKDF2/Images spike | 公開7日以上のNode/pnpm/Wrangler/TS/Vitest/依存をexact固定、全binding、KDF/20MB境界 | none | M:N/A, U:Env/KDF vector, I:staging binding/KDF/Images, R:承認済み前version |
| 0.2 | D1 SQL-error barrier gate 1 | assertion rollback、`changes()`直前statement性、EXISTS fallback、commit不明分類 | 0.1 | M:`_assert` probe, U:classifier, I:G01三反例+実D1 loss, R:probe DB破棄 |
| 0.3 | R2 stream/Range/Digest/STORE ZIP spike | known length、206/416、SHA、Async/Deflate無し、dry-run exact size | 0.1 | M:N/A, U:range/hash/CRC/size, I:95MB/slow client/ZIP, R:object cleanup |
| 1.1 | complete contract/migration + primary adapter | 全FK/CHECK/index/enum/state、control、FTS、quota/ref/pin ledger、bind≤100 | 0.2 | M:up/down rehearsal, U:schema/SQL counter, I:D1 migration, R:restore snapshot |
| 1.2 | route/auth foundation | manifest外404、principal分離 | 0.1,1.1 | M:auth tables, U:manifest/JWT, I:Access fixture, R:routes disable |
| 1.3 | authorize tuples / EffectiveLive | 全operand・ancestor認可 | 1.2 | M:indexes, U:matrix, I:depth64/trash, R:deny-all flag |
| 1.4 | LockDO + D1 permits | open INSERT後発行、revoke+claimed failed後再発行 | 1.1,1.3 | M:permit schema/DO, U:lock graph, I:reset/expiry/old Worker, R:maintenance revoke |
| 1.5 | one create + operation claim/outbox/repair | SQL-error barrier、commit auth、replay、consumer確定後ack | 1.4 | M:operations/steps/outbox, U:assertions/lease, I:G01/duplicate/DLQ, R:failed repair/requeue |
| 1.6 | fence / recovery foundation | ControlDO epoch、permit/job quiesce、bootstrap/失効 | 1.5 | M:epoch/auth fields, U:state transitions, I:old request/disable race, R:maintenance |
| 2.1 | immutable blob transfer/read | R2不変、single SHA verified、Range | 0.3,1.5 | M:blob schema, U:ETag, I:stream, R:GC candidate |
| 2.2 | node create | parent proof、name unique、tree CAS | 1.5,2.1 | M:N/A, U:name/parent, I:claim race, R:failed op repair |
| 2.3 | overwrite content | new blob公開とold ref減算が同batch | 2.1,2.2 | M:version indexes, U:quota/ref, I:response loss, R:reconcile |
| 2.4 | rename / MOVE | cycle proof、cross-space拒否、tree CAS、MOVE lock release | 1.4,2.2 | M:N/A, U:cycle/path, I:permit race, R:operation/reconcile |
| 2.5 | same-owner COW / folder COPY | fixed manifest、props、ref/quota同batch、refs≤1,000 | 2.3,2.4 | M:COW indexes, U:manifest/ref ledger, I:copy/delete/conflict, R:reconcile |
| 3.1 | upload create/reservation + single body | mode/size、0B、staging/orphan/physical、public同経路 | 2.1,1.5 | M:upload tables, U:quota, I:single/create loss, R:delete orphan |
| 3.2 | multipart part/status/resume | durable in-flight、3 attempts/calls/bytes、unknown→aborting | 3.1,0.3 | M:part rows, U:size/hash/budget, I:late retry/reset, R:abort |
| 3.3 | complete reconciliation | R2 head、staging→committed、complete/abort 409 | 3.2,1.5 | M:complete fields, U:machine, I:response loss, R:repair |
| 3.4 | abort/expire/cleanup | terminalとcleanup分離 | 3.3 | M:cleanup fields, U:alarm, I:retry exhaustion, R:Cron repair |
| 3.5 | cross-owner copy job | pin+reservation+multipart | 2.5,3.4 | M:job checkpoint, U:budget, I:resume, R:cancel/reconcile |
| 4.1 | trash membership | live members確定、trashedが同期公開停止点 | 2.4 | M:trash/member schema, U:SQL guards, I:独立削除子/share失効, R:restore |
| 4.2 | restore / purge / GC | 全chunk fence、FK順、root最終公開、state同期、GC quiesce | 4.1,1.5 | M:GC tables, U:state/pin, I:delete loss/deleting ref, R:pause GC |
| 4.3 | Time Travel / logical export restore | watermark/terminal保存、FTS rebuild、ControlDO bumpEpoch | 4.2,1.6 | M:backup metadata, U:watermark, I:両restore drill, R:previous point/generation |
| 5.1 | list/search/FTS/bounded stats | cursor束縛、external sync、scope/hit上限 | 1.3,1.5,4.3 | M:FTS/index, U:normalizer/bigram, I:§15 fixtures, R:disable FTS |
| 6.1 | content-session/BudgetDO/delivery | URL secret無し、purpose claim、budget継承、全route会計 | 2.1,1.2 | M:session tables, U:claims/CORS/budget, I:browser Range/tabs, R:attachment only |
| 6.2 | sharing/public bundle/ZIP STORE | non-disclosure receipt、source境界、pin/exact size | 6.1,0.3 | M:share tables, U:capability/ZIP, I:anonymous E2E, R:revoke version |
| 7.1 | WebDAV Class1/XML props/profile | bounded XML/numeric refs、props、Shared mount、collection revision | 5.1,2.4 | M:props/mounts, U:fixtures/If, I:litmus/1,000×20, R:disable DAV |
| 7.2 | WebDAV Class2/COPY-MOVE | creator/token submission、lock-null operand、sync上限、permit | 7.1,1.4,2.5 | M:lock schema, U:If parser, I:clients/races, R:invalidate locks |
| 8.1 | Gallery / server derivatives | generation/current blob fence、client thumb無効、基本UI | 1.5,5.1 | M:media tables, U:EXIF, I:Images/cost/E2E, R:disable jobs |
| 8.2 | Bookshelf / EPUB/PDF | bounded archive、sanitized二重iframe、scroll/TOC/CFI | 6.1,8.1 | M:library/state tables, U:ZIP/XML sanitizer, I:browser CSP/E2E, R:attachment only |
| 8.3 | Audio / basic player | bounded tag/cover/Range、user/node/blob state | 6.1,8.1 | M:audio/state tables, U:parser, I:Range/player/E2E, R:metadata off |

各phaseの完了条件は、**そのphaseが導入する不変条件と、既存phaseに対する回帰試験**である。FoundationはSQL barrier、認可、epoch、fenceの最小fixtureを必須とし、未実装surfaceのrelease gate通過を要求しない。

---

## 17. 機能提供 roadmap

| 項目 | v1 | 後段 / 非目標 |
|---|---|---|
| files / versions | immutable blob、内部version保持 | version history UIは後段 |
| sharing | link/internal/upload-only/edit、ZIP STORE | group/team/reshareは後段 |
| DAV | Class1/2、creator一致、bounded COPY/MOVE | Nextcloud固有API/change tokenは後段 |
| media | Gallery基本UI、scroll EPUB/CBZ/PDF、Audio基本player | pagination/timeline scrubberはv1.1、fixed EPUB/DRM/RAR/7zは非目標 |
| search | name/media metadata | OCR/本文全文検索は非目標 |
| recovery | Time Travel + logical export、FTS rebuild、monthly drill | cross-account replicationは後段 |
| PWA | 通常SPA（Service Worker無し） | PWA/Service Workerはv1.1 |

---

## 18. 後段・staging で確定する事項

1. **PBKDF2**: production相当 staging で100,000回の受理/CPU/並列を確認し、600,000回が予算内なら一括引上げる。未合格なら100,000を維持。scrypt不採用。
2. **D1 query budget**: §15.1 の `rows_read/duration_ms` を実 dataset で測る。未合格時は page/candidate を縮小。
3. **platform曖昧値**: KV call、DO `blockConcurrencyWhile`、Images AVIF/codec、zone 95MB、Rate Limiting PoP差を実測する。
4. **RTO**: 月次 Time Travel/export restore drill で測定して運用SLOを決める。
5. **WebDAV client差**: Finder/Explorer/rclone/cadaver の case-only rename、lock-null、複合 If、sidecarを support matrix 化する。
6. **client thumbnail**: v1 は無効。有効化する設計変更には `node_id` を含む claim/key、attempt付き immutable key、server再encode、node/current-blob/generator CAS、node単位認可/削除、COW分離の全てを必須とする。
7. **EPUB pagination**: scroll/TOC/CFI は v1。pagination は browser別 CFI round-trip/CSP/memory gate 合格時だけ有効化し、不合格なら v1.1。
8. **PWA、media高度UI、ZIP64 / large CLI / Nextcloud chunking / change token**: v1.1候補。v1 は Service Worker無し、ZIP non-ZIP64、DAV単発request。
9. **version UI / team/group / notification / import-export UI**: data model と認可を別 review する。
10. **RAR/CBR/7z、固定layout EPUB、media overlay、出版物JS、波形、歌詞同期、外部metadata**: v1 unsupported。
11. **CONTENT_ORIGIN別account、R2 replication、長期backup**: 現 threat model 外の option。
12. **料金 / capacity**: release時の公式値で D1 rows、R2 Class A/B、Images、DO duration、Queue、backup/GC/retry の low/base/high worksheetを更新する。
