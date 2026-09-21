# Next-cloud-flare — 設計・実装方針 (v0.3)

Cloudflare のサービスだけで完結する、Google Drive / Nextcloud ライクなセルフホスト型ストレージ管理アプリ。

> ステータス: **Astra ラウンド1・2 反映済み**。本書を v1 の実装契約とし、未決事項は安全側の制限を置いて §18 へ送る。
>
> 制限定義と公式仕様の確認基準日: 2026-09-21。数値の正本は §13 とし、契約・環境依存値はリリース時に staging で再確認する。

---

## 0. ゴール、非ゴール、提供範囲

### 0.1 ゴール

- **Cloudflare 完結**: Workers、Workers Static Assets、R2、D1、KV、Durable Objects、Queues、Cron Triggers、Cloudflare Access のみを実行基盤とする。Google IdP は Access の認証元としてのみ利用する。
- **正本の分離**: R2 は不変のファイル内容、D1 は論理名前空間・参照・権限・操作状態の正本とする。D1 外の復旧制御は `ControlDO` を正本とする。
- **線形化された書き込み**: REST、WebDAV、upload complete、Queue consumer の名前空間変更を `fsMutation` に集約し、全 operand 認可、lock reservation、operation claim、期待 revision、tree generation、quota を一つの確定契約で扱う。
- **必須機能**: Web UI、WebDAV Class 1/2、期限・パスワード付きリンク共有、内部共有、upload-only 共有、回収箱、名前検索、再開可能 multipart、プレビュー、サムネイル、クォータ、監査。
- **障害復旧**: 日次 D1 export、D1 Time Travel、GC 停止、recovery epoch 更新を含む復旧手順と演習をリリース条件にする。
- **安全な既定値**: 仕様や実測が未確定な機能は v1 で狭く制限し、上限値は §13 に一元化する。

### 0.2 非ゴール

- Office/Collabora 相当の同時編集、E2E 暗号化、デスクトップ同期クライアント、本文検索・OCR、サーバ側マルウェア検査、厳密な DRM。
- Nextcloud 固有 discovery、capability、chunking、全 API との互換。WebDAV 対応と Nextcloud client 互換は別であり、後者は保証しない。
- R2 bucket の直接操作。R2 key は論理 path ではなく、直接書き込みと `r2.dev` 公開を禁止する。
- 無料 plan での動作保証。Workers Paid は前提だが、zone の HTTP body 上限を引き上げるものではない。

### 0.3 client / transfer support

| 経路 | v1 の扱い | 競合・上限 |
|---|---|---|
| Web UI | 専用 multipart | §13 の upload 上限。ETag 競合は 412。 |
| REST 単発 | 一つの HTTP request | `MAX_REQUEST_BYTES`。`Content-Length` 必須。 |
| WebDAV | Class 1/2、一 request PUT | `MAX_REQUEST_BYTES`。独自 multipart は使わない。 |
| CLI 大容量 | 後段 | v1 は通常 WebDAV 上限まで。 |
| Nextcloud client | 非目標 | 基本 WebDAV が動く範囲のみ。固有 chunking は保証しない。 |

同期競合では `If-Match` を要求する。server は conflicted copy を自動生成せず、再取得・別名保存は client 責務とする。

---

## 1. Cloudflare サービス選定と役割

| 役割 | サービス | 設計上の扱い |
|---|---|---|
| API / WebDAV / share page | Workers + Hono + TypeScript | 全 surface を単一 route manifest と共通 service へ集約する。 |
| SPA | Workers Static Assets | `run_worker_first` で shell を含む全 request を Worker に通す。 |
| 内容・派生物・backup | R2 | 本体は不変 blob。public access は無効。 |
| 名前空間・状態 | D1 | node、参照、quota、operation、outbox、audit の正本。 |
| WebDAV lock | `LockDO(spaceId)` | `node_id` 単位 lock と lock generation / commit reservation の正本。 |
| multipart | `UploadDO(uploadId)` | session、part、in-flight barrier、terminal result の正本。 |
| 復旧制御 | singleton `ControlDO` | D1 外の `epoch`、`gc_paused`、maintenance mode の正本。 |
| download budget | `TicketDO(ticketId)` | ticket の byte、request、並列 budget を厳密に消費する。 |
| thumbnail | Queues + Images binding / 制限付き WASM | result claim と outbox により at-least-once を費用面でも制限する。 |
| 短命 cache | KV | JWKS、read-only path hint、feature flag。認可・mutation・mutex には使わない。 |
| 定期処理 | Cron Triggers | lease と checkpoint で再開可能 job を起動する。 |
| 認証 | Cloudflare Access | private app の入口。share と WebDAV は Worker が認証する。 |
| rate limit | Workers Rate Limiting binding + DO | binding は一次防御、重要上限は DO で厳密化する。 |

Images binding 有り・無しの Wrangler environment を分け、binding 不足を runtime fallback で隠さない。

---

## 2. 全体アーキテクチャとルート境界

```text
Browser ─ Access ─┐                         ┌─ D1: namespace/auth/state/outbox
                  ├─ Worker / routes.ts ────┼─ R2: immutable blobs/derivatives/backups
WebDAV ─ Basic ───┤ authorize + fsMutation ├─ LockDO / UploadDO / TicketDO
Share capability ─┘                         └─ Queue / Cron / KV(read hint)
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

### 2.2 route manifest と型境界

`routes.ts` を Hono、Static Assets、CSRF、CORS、Access IaC、smoke test が共有する唯一の route 定義とする。URL、Request URI、DAV `Destination`、tagged URI は同じ decoder で percent decode を一度だけ行い、NUL、encoded slash、backslash、二重 decode の余地を拒否する。

| surface | 絶対 path | Access | Worker 側認証 |
|---|---|---|---|
| private SPA/API | `/`、assets、`/api/v1/*` の private allowlist | 必須 | Access user。 |
| public API | `/api/v1/public/*` の完全一致 allowlist | Bypass | share capability / CSRF。 |
| share page | `/s` と `/s/*` の完全一致 allowlist | Bypass | SSR capability flow。 |
| WebDAV | `/dav` と `/dav/*` | Bypass | app password Basic のみ。 |
| well-known | 個別 allowlist path のみ | 必要時だけ Bypass | wildcard は置かない。 |

- public prefix 配下は allowlist の完全一致だけを dispatch し、未知 method/path は 404。private router、SPA、asset へ fallthrough しない。
- private handler は `AuthedContext` を引数に取る型だけ登録できる。Access middleware だけが `Context` を `AuthedContext` へ変換でき、型なし handler を private manifest に登録すると compile error にする。
- `run_worker_first=true` とし、private SPA shell も Worker の Access 検査後だけ返す。public shell は置かない。
- Bypass request に Access JWT が付いても user principal へ昇格・合成しない。
- 本番では `workers.dev`、preview URL、想定外 host、R2 public access を無効化する。

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
  role TEXT NOT NULL,
  quota_bytes INTEGER,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  physical_bytes INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(access_iss, access_sub)
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

CREATE TABLE node_versions (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  operation_id TEXT NOT NULL,
  PRIMARY KEY(node_id, revision)
);

CREATE TABLE trash_ops (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  root_node_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('deleting','trashed','restoring','purging','purged','failed')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  purge_after INTEGER,
  checkpoint TEXT
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  principal_fingerprint TEXT NOT NULL,
  space_id TEXT NOT NULL,
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

`trash_ops.root_node_id` は監査用の論理 ID であり `nodes` への FK にしない。これにより `nodes.deleted_op_id` との循環 FK を作らない。terminal upload の `parent_id` は `ON DELETE SET NULL` とし、`parent_snapshot_id` を監査用に残す。`activity`、完了 job、operation result の node ID も論理 ID とし、purge を妨げる FK にしない。

追加 table:

- `uploads(id,owner_id,creator_fingerprint,credential_id,share_id,share_version,parent_id,parent_snapshot_id,target_node_id,name,blob_id,declared_size,reserved_bytes,physical_charge_state,state,reason,operation_id,result_node_id,result_revision,...)`。
- `shares`、`app_passwords`、`service_principals`、`node_props`、`user_node_state`。
- server derivative 用 `derivative_results(blob_id,variant,generator_version,state,attempts,claim_expires_at,r2_key,...)` と client thumb 用 `client_thumbs(node_id,blob_id,variant,generator_version,...)`。
- `gc_candidates(blob_id,reason,first_seen_at,delete_after,last_verified_at,state)`、`blob_pins(blob_id,pin_type,pin_id,expires_at)`。
- `outbox`、`job_leases`、`backup_runs`、`mutation_journal`、`bulk_jobs`、`folder_stats`、`node_search`、`activity`。

### 3.2 tree invariants

- space 作成時に実体 root node を一つ作る。root だけ `parent_id IS NULL`。root の rename、MOVE、trash、purge は禁止する。
- 親は同一 space の未削除 `folder|root`。削除中、別 space、file は親にできない。
- namespace 構造変更は `spaces.tree_generation` を期待値付きで `+1` する statement と同じ D1 batch で確定する。MOVE、COPY、create、rename、DELETE、restore、purge は同一 space 内で直列化される。
- MOVE の確定 statement は再帰 CTE を使い、destination が source の子孫でないこと、深さ上限、全祖先の未削除、space 一致を同じ batch 内で再確認する。更新は `INSERT ... SELECT ... WHERE NOT EXISTS(...)` で step proof を作り、事前検査だけに依存しない。
- owner / space をまたぐ MOVE は v1 では拒否する。cross-owner は copy job 完了後の明示 delete とする。
- 名前は NFC、`name_ci` は決定的 Unicode casefold。保存名 policy と深さ等の上限は §13 を正本とする。

### 3.3 path と予約領域

検証順は「decode 一回 → separator / control 拒否 → NFC → portable check → casefold」。`.DS_Store` と `._*` は `hidden=1` で保存できる。`/dav/Shared/` は仮想予約 prefix とし、root 直下の実 folder 名として禁止する。mount 名は share ID 由来の stable ID を含み、表示名変更で解決先を変えない。

### 3.4 immutable blob、generation、COW

- 本体 key は `u/<ownerId>/b/<blobId>`。同じ key を上書きしない。`committed` blob だけ content API から配信する。
- metadata ETag は revision、content ETag は `content_etag`。DAV path validator は §7 の node identity 付き形式を使う。
- 内容更新は新 key へ書き、R2 object の実在と実 size を容量台帳へ反映してから、期待 revision 付き D1 参照切替を確定する。D1 参照切替が利用者から見た確定点である。
- `ref_count` は current node、保持中 version、明示 pin の参照を同じ batch で整合させる。直接の無条件加減算は禁止する。
- same-owner COPY は COW とし、元 node / blob generation を固定する。blob ごとの COW 参照上限は §13。
- cross-owner COPY は source pin と destination quota reservation を先に作り、Range GET と destination multipart upload を checkpoint 付き job で実行する。一発の巨大 `get() -> put()` を公称 file 上限の根拠にしない。成功時だけ destination node を公開し、失敗時は §6 の物理台帳に従って回収する。
- folder COPY は開始時 snapshot manifest ではなく、source `tree_generation` と pin 付き cursor を使う。share、lock、client thumb は copy しない。

### 3.5 D1 boundary

- D1 `batch()` は bind、SQL、query、実行時間の §13 budget で分割する。大規模操作は checkpoint 付き job にする。
- 条件付き statement の影響行ゼロは SQL error ではない。`fsMutation` は §5.2 の step proof と commit barrier で、単なる row count 後確認を atomicity の代用にしない。
- list は複合 keyset cursor。offset pagination は管理用小規模画面以外で使わない。
- 認可、share 失効、quota、operation claim、tree / lock 確定は primary を読む。read replica / KV は権威にしない。
- path cache key は `space_id + tree_generation`。mutation 前は再帰 CTE で primary の現在 path / ancestor を再検証する。

---

## 4. 認証、principal、認可、初期化

### 4.1 principal と operand

```text
user(iss, sub)
app_password(user_id, credential_id, scope, optional_root)
link_share(share_id, share_version, session_id, actions, root)
service_token(service_principal_id, mapped_user, space, scope)
```

認証情報は暗黙に合成しない。認可 API は node 一個ではなく次を唯一の形とする。

```ts
authorize(principal, operation, operands: Operand[]): AuthorizationProof
```

`Operand` は source node / source parent / destination parent / overwrite target / ancestor chain / blob generation / upload / job / share / ticket / operation key を型付きで表す。MOVE / COPY は両側、DELETE / restore / complete は対象と全祖先、bulk は manifest の各 scope を検査する。内部 share の表示 path は認可 root で打ち切り、private ancestor 名を返さない。

`upload_id`、`job_id`、`share_id`、ticket、operation / idempotency key は、作成 principal fingerprint または同じ space の owner にだけ結び付ける。ID の推測困難性を認可に使わない。同じ key を異なる principal、space、operation kind、request digest で再利用した場合は拒否する。

### 4.2 Access identity と bootstrap

- identity key は `iss + sub`。email は属性であり、同一 email の別 sub を自動結合しない。
- JWT は許可 algorithm、署名、issuer、audience、expiry、not-before、必須 claim を検証する。未知 key ID では JWKS を一度更新し、失敗は fail closed。
- disabled user は Access 通過後も 403。
- `OWNER_EMAILS` は必須。該当 identity だけが atomic bootstrap で owner になれる。未設定または Access 設定欠落時は全 request を 503。
- signup は既定無効。owner 移譲は監査し、最後の owner の停止・削除を禁止する。
- Service Token は mapping 済み REST automation だけで使い、WebDAV credential にはしない。

### 4.3 operation permission

| action | owner/admin | internal read | internal edit | app password | link read/edit | upload-only | service token |
|---|---|---|---|---|---|---|---|
| list / metadata / content | 許可 | 許可 | 許可 | scope 内 | capability subtree | 禁止 | mapping scope |
| create | 許可 | 禁止 | destination に許可 | rw scope | edit subtree | 新規受取のみ | mapping scope |
| overwrite / rename / MOVE / delete | 許可 | 禁止 | 全 operand に許可 | rw scope | edit subtree | 禁止 | mapping scope |
| COPY | 両 operand に許可 | source のみ | source read + destination write | scope 内 | edit subtree | 禁止 | mapping scope |
| share / quota | owner/admin | 禁止 | 禁止 | 禁止 | 禁止 | 禁止 | admin scope |
| LOCK | 許可 | 禁止 | 許可 | rw scope | 禁止 | 禁止 | 禁止 |
| client thumb | node write | 禁止 | node write | rw scope | edit node | 禁止 | write scope |
| upload complete | commit 時再認可 | 禁止 | commit 時再認可 | rw scope | commit 時再認可 | receipt upload のみ | mapping scope |

### 4.4 credential と recovery epoch

- app password は CSPRNG secret を一度だけ表示し、`HMAC-SHA256(APP_PASSWORD_HMAC_KEY, epoch || typ || secret)` のみ保存して timing-safe 比較する。epoch 上昇後は全 app password を再発行する。
- share password は random salt と versioned PBKDF2-SHA256。iteration と token entropy は §13。
- unlock Cookie、download / ZIP ticket、upload session capability、job / lease token は `typ`、`aud`、`epoch` と型ごとの必須 claim を持ち、署名 / HMAC 入力を `epoch || typ || payload` とする。route は期待 `typ` 以外、余分な用途 claim、許可外 algorithm / key を拒否する。
- 高コスト KDF の前に per-IP と per-share / credential の安価な rate limit を適用し、重要な全体上限は DO で補完する。

---

## 5. REST API、共通 mutation、状態機械

### 5.1 API surface

private base は `/api/v1`、public base は `/api/v1/public`。

| Method | Path | 概要 |
|---|---|---|
| GET | `/api/v1/me` | user、quota、feature flag |
| GET | `/api/v1/nodes/:id` と children / path / content / thumb / preview suffix | metadata / content |
| POST/PATCH/DELETE | `/api/v1/nodes...` | folder、rename、MOVE、COPY、trash |
| POST | `/api/v1/nodes/:id/zip` | 制限付き ZIP ticket |
| POST/PUT/GET/DELETE | `/api/v1/uploads...` | private upload create / content / part / status / complete / abort |
| GET/POST | `/api/v1/trash`、`.../restore`、`.../purge` | trash operation |
| GET/POST/PATCH/DELETE | `/api/v1/shares...` | link / internal share |
| POST | `/api/v1/nodes/:id/thumbs` | node 単位 client thumb |
| GET/POST/DELETE | `/api/v1/app-passwords` | credential 管理 |
| GET/POST/DELETE | `/api/v1/jobs...` | progress / cancel / retry |
| GET/POST | `/api/v1/admin/dlq[/requeue]` | DLQ operation |
| GET/POST | `/api/v1/public/shares/:token` と unlock / children / download-tickets suffix | public share |
| POST | `/api/v1/public/shares/:token/uploads` | public upload create |
| GET/PUT/POST/DELETE | `/api/v1/public/shares/:token/uploads/:uploadId`、`.../parts/:n`、`.../complete` | public status / part / complete / abort |
| GET | `/api/v1/public/shares/:token/content`、`.../zip`、`.../thumb` | typed ticket 配信 |

public multipart は private upload path を Bypass せず、public allowlist 内の専用 path だけで完結する。REST error は RFC 9457、DAV error は §7 の XML。

### 5.2 `fsMutation` 確定 protocol

R2 transfer は先に終え、lock reservation は短い namespace commit だけを囲む。`claimOperation` は primary 上の既存 operation を調べ、同じ principal / space / kind / digest の `committed` なら保存済み結果、`failed` なら同じ失敗を返す。未登録時だけ一回限りの `claimToken` を生成する。

```ts
async function fsMutation(req: MutationRequest): Promise<MutationResult> {
  const control = await ControlDO.read();
  assertWritable(control);

  const claim = await claimOperation(req.opId, req.principal, req.digest, control.epoch);
  if (claim.terminal) return claim.result;

  const snapshot = await readOperandsAndAncestorsPrimary(req.operands);
  const auth = authorize(req.principal, req.operation, snapshot.allOperands);
  assertOwnerBindings(req.ids, req.principal, snapshot.spaceOwner);

  const preparedBlob = await finishOrVerifyImmutableR2Object(req);
  await chargePhysicalBeforeReservationRelease(preparedBlob, req.uploadId);

  const inspected = await LockDO.inspectCanonicalNodes({
    spaceId: snapshot.spaceId,
    nodeIds: snapshot.lockOperands,
    submittedTokens: req.lockTokens,
    principal: req.principal
  });
  const permit = await LockDO.beginCommit({
    operationId: req.opId,
    expectedGeneration: inspected.generation,
    nodeIds: snapshot.lockOperands
  });

  try {
    const statements = [
      insertClaim(req, claim.claimToken, permit.generation),
      ...conditionalOperandUpdates(req, auth, claim.claimToken),
      verifyAndIncrementTreeGeneration(req, snapshot.treeGeneration, claim.claimToken),
      ...dependentReferenceQuotaAndActivityUpdates(req, claim.claimToken),
      ...stepProofsUsingReturningOrImmediateSelect(req, claim.claimToken),
      insertOutboxAndItsStepProof(req, claim.claimToken),
      commitOperationOnlyIfEveryStepExists(req, claim.claimToken),
      insertFinalBarrierThatRequiresCommittedCompositeFK(req, claim.claimToken)
    ];

    const result = await D1.batch(statements);
    assertEveryReturningCount(result, req.expectedCounts);
    return await readCommittedResultPrimary(req.opId);
  } catch (error) {
    const concurrent = await resolveConcurrentClaim(req, claim.claimToken, error);
    if (concurrent) return concurrent;

    await recordFailedClaimCompensation({
      operationId: req.opId,
      claimToken: claim.claimToken,
      error: classifyMutationFailure(error)
    });
    throw mapMutationError(error);
  } finally {
    await LockDO.endCommit(permit);
  }
}
```

確定規則:

1. claim INSERT は `operations.id` PK 競合で冪等化する。全従属 statement は `claim_token` と `state='claimed'` を条件にし、他 request の claim を利用できない。事前 read 後に同じ ID の claim が競合した場合は loser batch を rollback し、principal / space / kind / digest が一致する既存 result を待って返す。不一致なら 409 とし、相手の claim を `failed` にしない。
2. node / parent / ancestor / share version / credential / upload / job / expected revision / tree generation を commit batch 内で再検査する。upload complete は parent の存在、未削除、space 一致も同時に証明する。
3. 各更新と outbox INSERT は `RETURNING` または直後の `SELECT` で operation 固有の `last_op_id` / step row を証明する。全 statement の expected step がある時だけ operation を `committed` にする。
4. 最後の commit barrier は `(operation_id,'committed',claim_token)` への composite FK または同等の migration-tested trigger で SQL error を強制する。別 request の committed row では claimant token が一致しない。条件付き UPDATE の影響行ゼロだけでは batch が失敗しないため、この barrier が一件でも欠けた batch 全体を rollback する。
5. claim 競合以外の rollback 後は、別の補償 transaction で claim を `failed` に INSERT / UPDATE する。`claim_token` が一致しない既存 operation は変更しない。未公開 blob は GC candidate、予約は §6 の物理課金を残したまま解放する。
6. outbox row とその step proof は final barrier より前の同じ atomic batch に置く。D1 commit 後の Queue dispatch は応答と独立し、response は保存済み operation result から返す。
7. `LockDO.beginCommit(gen)` は generation が変わっていれば再検査を要求する。permit と交差する新規 LOCK は 423 または短時間待機とし、permit expiry まで成功させない。D1 operation に lock generation を保存し、Worker 停止時は短い lease expiry で解放する。
8. lock permit は R2 upload 全体を囲まない。upload / copy の長時間 I/O と namespace commit を分離する。

### 5.3 conditional request、bulk、ZIP

- `If-Match` / `If-None-Match:*` 失敗は 412。revision 以外の状態競合は 409、lock は 423、quota は 507。
- bulk は principal / space / digest に束縛した `Idempotency-Key`、job ID、cursor、項目別結果、cancel state を返す。job 全体の受付上限も §13 で検査する。
- v1 ZIP は STORE 方式に固定し、manifest の UTF-8 file name、local header、data descriptor、central directory、EOCD を含む正確な出力 size を開始前に計算する。entry、R2 GET、manifest、単体、payload、最終 offset の全上限は §13。超過時は 413 と page 分割案内を返し、途中までの ZIP は開始しない。
- 一つの ZIP は一つの typed ticket を使い、ticket に entry manifest hash、各 `node_id + blob_id`、share ID / version、epoch を束縛する。各 entry は発行時と配信時に認可する。
- path は relative NFC にし、absolute、drive prefix、`..` を除去する。disconnect 時は upstream R2 read を cancel し、TicketDO の budget は保守的に消費済みとする。

### 5.4 UploadDO 状態機械

`reason` は全 terminal failure に必須。D1 の `nodes.revision` と operation result が commit の真実で、DO は cache / coordination state である。

| 状態 | event | 次状態 | 副作用 | 失敗時 |
|---|---|---|---|---|
| `initiating` | D1 reservation と R2 multipart ID を照合 | `active` | ID、epoch、creator、part policy を永続化 | deadline / orphan は `expired`、理由と回収 job |
| `active` | valid part slot 取得 | `active` | expected size を upload 前検査し in-flight を登録 | budget 超過は `failed`、I/O failure は slot 解放 |
| `active` | complete claim | `completing` | 新 part / abort を拒否し in-flight barrier を閉じる | barrier deadline は `failed` |
| `completing` | in-flight zero、R2 complete、D1 commit 成功 | `committed` | `node_id/revision` を DO に保存 | DO 保存前停止は reconciler が D1 から修復 |
| `completing` | auth / revision / parent / share / tree guard 失敗 | `failed` | blob を物理課金済み GC candidate、予約解放 | 同じ reason を冪等に返す |
| `completing` | R2 lifecycle / checksum / size failure | `failed` | multipart abort / orphan repair | retry で terminal を変えない |
| `initiating` / `active` | explicit abort | `aborting` | 新 part を拒否し、存在する R2 upload の in-flight を cancel / drain | deadline 超過は repair 継続 |
| `aborting` | R2 abort 確認 | `aborted` | reservation を一度だけ解放 | R2 不明は `failed` + repair |
| `initiating` / `active` | expiry | `expired` | upload capability 無効化、R2 abort、予約解放 | orphan list repair |
| terminal | retry / status | 同じ terminal | 保存済み result / reason を返す | 状態を巻き戻さない |

D1 が committed で DO が非 terminal なら DO を `committed` へ修復する。DO が committed でも D1 result が異なる場合は D1 を正として DO の node ID / revision を上書きし、二重課金・再確定しない。

### 5.5 trash_ops 状態機械

| 状態 | event | 次状態 | 副作用 | 失敗時 |
|---|---|---|---|---|
| `deleting` | delete chunk | `deleting` | `state='deleting' AND deleted_op_id IS NULL` guard で tag | checkpoint から retry |
| `deleting` | 全 subtree tag 完了 | `trashed` | share を disabled、operation result 確定 | invariant failure は `failed` |
| `trashed` | restore CAS claim | `restoring` | `WHERE state='trashed'` で排他取得 | 0行は 409 |
| `restoring` | restore chunk | `restoring` | target op の tag だけ解除、tree generation guard | retryable は checkpoint、fatal は `failed` |
| `restoring` | 完了 | row removal | restore result / activity を残し active ledger を閉じる | old delete job は state 不一致で停止 |
| `trashed` | purge CAS claim | `purging` | claim 後に現在 subtree manifest を再生成 | 0行は 409 |
| `purging` | purge chunk | `purging` | target op / state guard と子→親順で D1 削除 | checkpoint から retry |
| `purging` | 全 D1 参照解除 | `purged` | blob を GC candidate 化。R2 はまだ削除しない | fatal invariant は `failed` |
| `failed` | admin repair | prior safe state | 監査付き invariant repair のみ | 自動で公開しない |

### 5.6 gc_candidates 状態機械

| 状態 | event | 次状態 | 副作用 | 失敗時 |
|---|---|---|---|---|
| `candidate` | pin 作成 | `pinned` | COPY / ZIP / ticket / backup pin を記録 | pin 不明は削除しない |
| `pinned` | 最終 pin 解放 | `candidate` | grace を再計算 | retry |
| `candidate` | grace 終了、参照 / pin 無し、GC permit | `deleting` | 条件付き UPDATE で不可逆点を確定 | 0行は停止 |
| `deleting` | R2 delete 成功 / already absent | `deleted` | `physical_bytes` を一度だけ減算、blob tombstone | retry。参照追加は禁止のまま |
| `deleted` | retry | `deleted` | 保存済み result | blob 復元を試みない |

### 5.7 job_leases 状態機械

| 状態 | event | 次状態 | 副作用 | 失敗時 |
|---|---|---|---|---|
| `idle` / `expired` | epoch 一致で acquire | `leased` | fence increment、holder、expiry、checkpoint | 0行は他 holder に譲る |
| `leased` | heartbeat | `leased` | 同じ epoch / fence で expiry 更新 | 失敗後は副作用禁止 |
| `leased` | checkpoint commit | `leased` | D1 副作用と同じ batch で fence guard | 0行は rollback |
| `leased` | pause / epoch change | `quiescing` | 新 work を取らず外部 I/O を収束 | deadline 後は expired 扱い |
| `leased` / `quiescing` | release / complete | `idle` | checkpoint と結果を保存 | retryable release |
| `leased` | expiry | `expired` | 新 fence だけが D1 更新可能 | 外部副作用は対象別 protocol で冪等化 |

lease fence だけで R2 delete を安全にしない。GC は §5.6 の不可逆 state、thumbnail は unique result claim、backup は immutable generation key を併用する。

### 5.8 outbox 状態機械

| 状態 | event | 次状態 | 副作用 | 失敗時 |
|---|---|---|---|---|
| `pending` | dispatcher claim | `dispatching` | outbox ID を論理 job ID に固定 | claim expiry で pending |
| `dispatching` | Queue send accepted | `sent` | delivery ID / attempt 保存 | send 不明は同じ ID で再送 |
| `sent` | consumer result commit | `completed` | result table と同じ batch で完了 | duplicate は保存済み result |
| `sent` | retention / ack 欠損を repair が検出 | `pending` | terminal result が無い時だけ再送 | attempt budget 超過は `failed` |
| `pending` / `dispatching` / `sent` | permanent error | `failed` | DLQ / admin reason | 手動 requeue は新 attempt ledger |
| `completed` / `failed` | retry delivery | 同じ terminal | no-op | 状態を巻き戻さない |

### 5.9 backup journal 状態機械

`mutation_journal` は commit 順 sequence、table、primary key、`upsert|delete`、row image または tombstone を同じ D1 mutation batch で記録する。

| 状態 | event | 次状態 | 副作用 | 失敗時 |
|---|---|---|---|---|
| `scanning` | start watermark 後に base keyset scan | `scanning` | immutable export part と checksum | checkpoint retry |
| `scanning` | base 完了 | `catching_up` | end watermark を固定 | watermark 取得失敗は retry |
| `catching_up` | journal upsert / tombstone 適用 | `catching_up` | commit 順に export generation 更新 | current row 再読だけで delete を推測しない |
| `catching_up` | end watermark 到達 | `verifying` | manifest、schema、件数を固定 | gap は `failed` |
| `verifying` | checksum / restore probe 成功 | `complete` | generation を公開し、verified watermark 以前の journal は §13 retention 終了後だけ prune | mismatch は `failed` |
| nonterminal | error | `failed` | incomplete generation を非公開、journal を保持 | 新 run で再開 / 再生成 |

---

## 6. upload、quota、再開

### 6.1 size / route

全 size、part、deadline、retry 値は §13。REST / WebDAV は `Content-Length` 必須で、長さ不明 body は 411。edge が Worker より先に 413 を返す場合がある。UI は選択した part size から `partSize × MAX_PARTS` を計算し、公称値ではなく実効 file 上限を表示する。

public upload-only multipart も §5.1 の public route で同じ UploadDO を使う。part number から導く expected size と宣言 size を R2 upload 前に検査し、complete 時だけの検査に遅延しない。

### 6.2 logical / physical quota ledger

- `used_bytes`: 利用者から参照可能または version / trash として論理保持する、owner 内 unique blob の bytes。
- `reserved_bytes`: 未確定 upload / cross-owner copy の宣言 bytes。
- `physical_bytes`: R2 に実在する owner の全本体 blob。current、version、失敗 upload、orphan 確認済み blob、GC 待ちを含み、server derivative は含めない。

予約は一つの条件付き UPDATE で次の両方を満たす時だけ成功する。`PHYSICAL_HEADROOM_FACTOR` の値は §13。

```sql
UPDATE users
SET reserved_bytes = reserved_bytes + :new
WHERE id = :owner
  AND (quota_bytes IS NULL OR used_bytes + reserved_bytes + :new <= quota_bytes)
  AND (quota_bytes IS NULL OR physical_bytes + reserved_bytes + :new
      <= quota_bytes * :physical_headroom_factor)
RETURNING id;
```

R2 object が完成したら reservation を解放する前に `physical_bytes` と upload の `physical_charge_state` を同じ D1 batch で確定する。公開成功時は `used_bytes` も増やす。認可 / CAS 失敗時は reservation を解放しても `physical_bytes` は GC 完了まで残す。論理参照が最後に外れた時に `used_bytes` を減らし、R2 delete 成功時だけ `physical_bytes` を減らす。purge は物理容量を減らさない。

R2 完成と D1 charge の間で停止した object は reserved bytes を保持し、reconciler が object 実在を確認して charge または abort するまで新規予約の余地に戻さない。

### 6.3 part cost / barrier

- 同じ part number の送信試行、session 全体の uploadPart call、累積受信 bytes、in-flight、wall deadline は §13 で制限する。同じ size / ETag の再送も call budget を消費する。
- `completing` 遷移は UploadDO 内で `acceptParts=false` と barrier generation を永続化し、開始済み part slot が zero になるまで待つ。開始済み part は generation 一致時だけ結果を記録できる。
- R2 multipart lifecycle より十分前に application deadline を置く。lifecycle により消滅した upload は `failed` terminal にする。
- owner quota と upload-only share の file / count / cumulative bytes / concurrent session budget をそれぞれ atomic に予約する。匿名利用者へ残量を表示しない。

### 6.4 browser resume / checksum

IndexedDB に upload ID、epoch、file fingerprint、part state を保存する。再選択時は name、size、mtime、sample hash を照合する。SHA-256 は Web Worker の incremental implementation で計算し、declared と verified を分離する。未検証 checksum を dedupe や保存省略の根拠にしない。

---

## 7. WebDAV (`/dav`, `/dav/*`) と lock

### 7.1 auth / path

v1 WebDAV は app password の Basic over HTTPS のみ。Cookie、Access JWT、mapped Service Token へ fallback しない。CORS は公開せず、browser 由来の `Origin` 付き request は拒否する。

path は再帰 CTE で解決し、mutation 前に current node、parent、ancestor、revision、tree generation を primary で再検証する。`X-OC-Mtime` は `client_mtime` として受け、server `updated_at` と分ける。

### 7.2 Class 1/2 semantics

OPTIONS、PROPFIND、PROPPATCH、MKCOL、GET、HEAD、PUT、DELETE、COPY、MOVE、LOCK、UNLOCK を実装する。

- PROPFIND は `allprop`、`propname`、指定 `prop`、Depth 0/1。infinity は明示 error。件数・rows read・XML response を preflight し、§13 budget 超過時は response 開始前に 507 を返す。partial 207 を pagination として返さない。
- PROPPATCH は document order で検証し、全 property を一 transaction で成功または失敗させる。protected property は expanded name で判定する。
- XML parser は DTD / entity / external entity を無効化し、body、nesting、property count / value / cumulative metadata の §13 上限を適用する。
- `Destination` は同一 host、`/dav/` prefix、同じ decoder を通った path だけ許可する。source、source parent、destination parent、overwrite target の全 scope を認可する。
- COPY / MOVE の Depth / Overwrite / status は RFC 4918 に従う。大規模 collection operation は mutation 前に拒否して Web UI bulk job を案内する。

### 7.3 `LockDO(spaceId)`

- lock の正準 resource は `node_id`。URI は表示属性で、owner path、shared mount alias、casefold 表記が同じ node を解決すれば同じ lock が効く。lock-null resource も空 node を作って node ID を割り当てる。
- collection depth lock は root node ID と現在の ancestor relation で検査する。MOVE 後も同じ node の lock は継続し、display URI だけ更新する。overwrite target と destination ancestor の lock も検査する。
- SQLite に token hash、creator principal fingerprint、node ID、display URI、depth、expiry、generation を保存する。各 request で expiry を検査する。
- `If:` の boolean 評価と、対象 resource に必要な lock token の提出検査を分離する。tagged / untagged list、`Not`、ETag を RFC 通り評価し、常真 branch だけで lock を満たしたことにしない。他 space の token は拒否する。
- valid write 権限と対象 lock token の提示で許可される mutation は RFC の token semantics に従う。UNLOCK と refresh は token に加え creator principal 一致を必須とする。`lockdiscovery.owner` は表示情報であり認可主体ではない。token は creator principal 以外の `lockdiscovery` response に返さない。
- `fsMutation` は inspect generation の後に `beginCommit(expectedGeneration)` を取り、短い commit reservation 中に交差する新規 LOCK を 423 / 待機にする。reservation は §5.2 の D1 commit 直後に解放する。
- collection `getetag` は `W/"<node_id>-<revision>"`。同じ URI に別 node が配置されても stale validator は一致しない。
- timeout 等の数値は §13。管理 recovery は token を偽装せず監査付き強制解除を行う。

---

## 8. share

### 8.1 capability / typed token

link token は §13 の entropy を持ち、D1 には hash だけ保存する。capability は share root、その現在の子孫、action、expiry、share version に限定する。password、permission、root、expiry の変更と revocation で version を進める。

unlock Cookie は `typ=share-unlock`、download は `typ=download`、ZIP は `typ=zip-download`、content-host は `typ=content-host`、upload は `typ=share-upload` とする。各 token は `aud`、epoch、share ID / version と用途固有 claim を持ち、別種 token の流用を拒否する。

### 8.2 download ticket / cache / budget

- file ticket は `node_id + blob_id + share_id + share_version + epoch` を含む。配信ごとに share が有効で、node が未削除かつ現在も share root の子孫であることを primary の tree generation で検査する。blob は ticket 発行時の固定 generation として pin する。
- ZIP ticket は §5.3 の manifest hash と entry ごとの node / blob を持つ。
- ticket 発行数を `download_count` とし、発行時に atomic に上限を消費する。同一 ticket の Range は追加 download count にしない。
- ticket は単一 IP / User-Agent に束縛しない。`TicketDO` が §13 の TTL、対象 size 比の総転送 bytes、request 数、並列数を厳密に制限し、Range 並列を許しつつ増幅を止める。share / owner / global の rate budget も適用する。
- share content は `Cache-Control: private, no-store`。thumbnail だけ §13 の private short cache。受信済み bytes の回収は保証しない。

### 8.3 upload-only / internal share

- upload-only は create だけを許可し、list、read、overwrite、任意 node ID、rename、delete を禁止する。
- name collision は常に server が `name (n)` 形式で自動 rename し、collision の有無にかかわらず 201 と同形の receipt ID だけを返す。匿名 response に確定名、競合 flag、異なる timing / error を出さず存在 oracle を作らない。
- internal share は `read|edit`。保存先 owner の space / quota を使う。trash 時は disabled とし、restore で自動復活させない。
- WebDAV mount は `/dav/Shared/<stable-mount>/`。別名を認可・lock の別 resource として扱わない。

---

## 9. Web UI

stack は React、TypeScript、Vite、Tailwind CSS、shadcn/ui、TanStack Router / Query / Virtual。採用 dependency は package manifest で固定する。

- My Drive、Shared、Recent、Starred、Trash、quota、upload panel、job progress を提供する。
- name conflict、restore destination、bulk cancel / retry、項目別結果を表示する。upload-only uploader には server 確定名を表示しない。
- optimistic update は 412 / 409 で rollback し、Idempotency-Key を reload 後も再利用する。
- virtual list は screen reader metadata、roving focus、non-virtual fallback、touch、reduced motion、AA contrast を持つ。
- PWA は versioned shell asset だけを cache し、auth response、API、content、share page は保存しない。logout で browser cache と memory credential を消す。
- font / avatar は同梱または local。外部 CDN を取得しない。

---

## 10. thumbnail、preview、content delivery

### 10.1 server derivative と費用冪等

server derivative key は `u/<ownerId>/t/b/<blobId>/<variant>-g<generatorVersion>.webp`。`variant` と generator version は allowlist からだけ選ぶ。

重い変換前に `derivative_results` の unique key `(blob_id,variant,generator_version)` を conditional claim する。`ready` / terminal `failed` は再変換しない。claim lease を一 worker だけが持ち、失敗 budget は §13。上限到達で `failed` 固定とする。結果保存前の停止は claim lease 後に同じ attempt として再開し、別 worker が並列変換しない。owner ごとの生成 rate / storage budget も適用する。

thumbnail は namespace / content を変更しない派生物なので WebDAV write lock の対象外。consumer は node が未削除かつ current blob 一致の時だけ表示参照を更新し、長期 lock で retry / DLQ を消費しない。

### 10.2 transform safety

Images / WASM の input、pixel、frame、memory、retry 上限は §13。header を安全に読めない、上限超過、unsupported format は transform しない。EXIF、GPS、comment は除去し、WebP へ再 encode する。isolate 内の同時 invocation を含む peak memory は staging gate とする。

### 10.3 client-generated thumbnail

client thumb は node 権限境界で保存し、key は `u/<ownerId>/t/n/<nodeId>/<variant>-c.webp`。COW 共有 server derivative と参照・削除を分離する。POST は対象 node の write 権限、current blob、variant、generation を検査し、read-only principal は保存できない。`(node_id,current_blob_id,variant,generator_version)` の unique result claim を再 encode 前に取得し、同じ tuple は一つの論理変換だけを共有し、失敗 attempt は §13 で打ち切る。node purge はその node の client thumb だけを削除する。

### 10.4 preview security

推奨構成は別 host `CONTENT_HOST` の配信 Worker と typed short-lived ticket。app origin から script 実行可能 content を inline で返さない。単一 host fallback は危険 MIME を attachment、`nosniff`、strict CSP で返す。preview iframe は sandbox と surface 別 `frame-ancestors` を使う。

---

## 11. trash、version、GC、backup / recovery

### 11.1 delete / restore / purge

- delete は `trash_ops.state='deleting'` を作り、root を先に不可視化する。chunk は `state='deleting'` と operation ID の両方を guard し、restore claim 後の旧 delete job は一行も変更できない。
- restore は `state='trashed'` だけを conditional UPDATE して `restoring` を claim する。元 parent の有効性、space、tree generation、name conflict を `fsMutation` で再検査する。
- purge は `state='trashed' -> 'purging'` を claim してから manifest を再生成する。以前固定した manifest を再利用しない。
- target subtree 内に別 trash operation の node が残る場合、その独立 trash subtree root を同じ space の root 直下へ hidden のまま reparent し、その `deleted_op_id` を変えない。これにより古い child FK が parent purge を妨げない。
- active upload は purge 前に失敗終端へ移し、terminal upload の `parent_id` は NULL にする。監査用 snapshot ID は FK を持たない。
- FK-bearing data は各 batch で `node.deleted_op_id=:op AND trash_ops.state='purging'` を再検査し、次の順で消す: `user_node_state` → `node_props` → `shares`（node delete の CASCADE を含む）→ `node_versions` → `node_search` → `nodes`。node は子から親へ削除する。client thumb は node CASCADE と対応する R2 cleanup ledger で処理する。
- R2 object は purge 中に削除しない。参照減算と GC candidate 作成までを D1 で確定し、物理 quota は GC だけが精算する。

### 11.2 versions

current から外れた blob は §13 の count / age policy で保持する。pruning は ref count と `used_bytes` を同じ batch で更新し、最後の論理参照が消えた時だけ GC candidate を作る。v1 の user-facing history UI は §18。

### 11.3 GC irreversible point / pins

- grace は `GC_GRACE_DAYS` とし、`TIME_TRAVEL_DAYS + D1_BACKUP_RETENTION_DAYS` 以上にする。値と関係は §13。
- COPY、ZIP / download ticket、backup export が blob を必要とする間は `blob_pins` を作る。単なる manifest 作成を pin の代用にしない。
- delete 直前に primary で current、versions、uploads、outbox、pins、candidate state を確認し、`candidate -> deleting` を conditional UPDATE で確定する。これが不可逆点である。
- `deleting` blob への新しい node / version / pin 参照を全 write path と FK / trigger で禁止する。以降に D1 restore しても blob を復元・再参照しない。
- R2 delete は lease fence を理解しない。したがって lease は作業重複防止、`deleting` は R2 副作用の安全性に使う。成功または object absent を確認した後だけ `deleted` と物理容量減算を確定する。

### 11.4 ControlDO と recovery

`ControlDO` は D1 restore の外にあり、`epoch`、`gc_paused`、`maintenance` を durable storage に保持する。全 request / job は epoch を読み、job、lease、download / ZIP / unlock / upload ticket、app password HMAC に含める。

Time Travel / export recovery 手順:

1. `ControlDO` で maintenance と `gc_paused` を有効化し、epoch を increment する。旧 job、lease、ticket、upload capability、app password は直ちに無効。
2. Queue / Cron の新規取得を止め、job を quiesce する。既に `deleting` の GC は不可逆なので完了 / inventory 確定まで待つ。
3. D1 を restore し schema migration を適用する。restore 後 DB の `deleting|deleted` / R2 absent blob は再参照せず、参照する recovery point は不適格として別 point を選ぶ。
4. R2 existence、physical / used / ref count、operation、upload、outbox、journal を再計算する。旧 epoch row は実行しない。
5. 全 link share を recovery-disabled にして `share_version` と token を更新し、owner の明示操作まで再公開しない。app password は再発行、service principal と復旧で巻き戻り得る user disable は管理者が再確認する。lock は全失効、未完了 upload は D1 正本で commit 修復または abort。
6. 照合と restore drill gate 合格後だけ maintenance を解除し、最後に GC を再開する。

RPO / RTO、Time Travel、D1 backup retention、GC grace は §13。R2 だけから論理 namespace を再構築できるとは主張しない。

---

## 12. search

`node_search(node_id,name_norm,name_bigram)` と FTS external content を使う。保存名は NFC、検索値は NFKC + Unicode casefold + かな統一。bigram は候補抽出だけに使い、最終的な順序・連続性を `name_norm` で照合する。

一文字 query は認可 folder / owner scope 内の bounded fallback。共有検索は現在の tree generation と capability root の子孫へ join し、snippet / count でも scope 外情報を漏らさない。trigger / outbox で同期し、rebuild job を持つ。scan / pattern 上限は §13。

---

## 13. 制限、security、audit、運用費

### 13.1 数値の唯一の正本

他章の symbolic limit はこの表を参照する。変更は migration / config version、staging 実測、security review を伴う。

| 定数 / 項目 | v1 値・契約 |
|---|---|
| `MAX_REQUEST_BYTES` | 95,000,000 bytes。 |
| `DEFAULT_PART_BYTES` / range | 64 MiB / 8–90 MiB。 |
| `MAX_PARTS` / `MAX_FILE_BYTES` | 10,000 / `min(partSize × MAX_PARTS, 500 GiB)`。 |
| upload expiry | 最終 progress から 24h、作成から最大 6日。R2 incomplete multipart lifecycle は 7日以上に固定し、application failure を先に確定。 |
| part cost budget | 同一 part number 3 attempts、uploadPart call は予定 parts × 3、累積受信 bytes は declared × 3、browser in-flight 4、part wall deadline 15分。 |
| `PHYSICAL_HEADROOM_FACTOR` | 1.2。logical quota を守り、GC 待ち物理量には 20% のみ余裕。 |
| version retention | node ごと直近 10 generation または 30日以内。prune は両条件の外だけ。 |
| `TIME_TRAVEL_DAYS` / `D1_BACKUP_RETENTION_DAYS` / `GC_GRACE_DAYS` | 30日 / 5日 / 35日。`GC_GRACE_DAYS >= TIME_TRAVEL_DAYS + D1_BACKUP_RETENTION_DAYS` を維持。古い export metadata を長期保存しても blob recovery 保証は backup retention まで。 |
| backup objective | RPO 24h、RTO 手動。 |
| ticket | TTL 6h、転送 byte 上限は対象 size × 3、request 1,024、並列 8。単一 IP / UA binding なし。 |
| share cache | content / JSON / HTML は `private, no-store`。thumb のみ `private, max-age=300`。 |
| v1 ZIP | entry ≤ 1,000、payload total < 4 GiB、各 entry < 4 GiB、R2 GET ≤ 1,000、manifest ≤ 8 MiB、全 header 込み output / offset ≤ UINT32_MAX。STORE のみ。 |
| user metadata | node ≤ 200,000 / user、children ≤ 2,000 / folder、COW refs ≤ 1,000 / blob。 |
| dead property | total ≤ 8 KiB / node、≤ 8 MiB / user、property count ≤ 256 / request、単一 value ≤ 8 KiB。 |
| PROPFIND / XML | body ≤ 1 MiB、nesting ≤ 32、response ≤ 32 MiB、Depth 0/1。preflight 超過は 507、partial response 禁止。 |
| name / tree | UTF-8 name ≤ 255 bytes、tree depth ≤ 64。portable names を既定。 |
| lock | timeout ≤ 1h。commit reservation は 30s lease。 |
| share token / Cookie | token entropy ≥ 128 bits、cookie value ≤ 2 KiB、同時 unlock ≤ 16。 |
| PBKDF2 | SHA-256 300,000 iterations を基準に staging CPU gate。 |
| Images / WASM | Images input ≤ 20 MB。WASM input ≤ 8 MiB かつ ≤ 12 MP。transform attempts ≤ 3 / `(blob,variant,generatorVersion)`。 |
| audit | D1 90日、R2 archive 1年。operation / outbox terminal は 90日後 compact。 |
| search | LIKE/GLOB pattern ≤ 50 bytes、candidate / fallback scan は request 当たり 10,000 rows。 |
| bulk acceptance | node ≤ 100,000、manifest ≤ 16 MiB / job。超過は分割。 |

Cloudflare platform limits は release ごとに公式資料で確認する。現在の設計入力:

| platform 項目 | 確認値・反映 |
|---|---|
| Worker body | zone plan 依存。app は `MAX_REQUEST_BYTES` 以下。 |
| Worker memory | 128 MB / isolate。thumbnail 同時 decode を避ける。 |
| Worker HTTP CPU | Paid default 30s、config max 300s。wall time と別。 |
| Worker subrequests | Paid default 10,000 / invocation。ZIP は app 上限をさらに狭くする。 |
| outbound connections | 6。stream 並列を bounded にする。 |
| R2 multipart | 10,000 parts、公称 5 MiB–5 GiB。app range は上表。 |
| R2 object | 公称約 5 TiB。app は上表。 |
| R2 list / delete | 最大 1,000 / call。cursor 必須。 |
| D1 DB | Paid 10 GB / DB、増枠不可。 |
| D1 row / value | 最大 2,000,000 bytes。 |
| D1 SQL | SQL 100,000 bytes、bind 100、query 30s。 |
| D1 invocation | Paid 1,000 queries / invocation。 |
| D1 transaction | `batch()` は atomic。条件付き更新ゼロは error ではない。 |
| DO SQLite | 10 GB / object。single-threaded は外部 I/O の自動排他ではない。 |
| Queue | message 128 KB、batch 100、at-least-once、retention 最大 14日、consumer wall 最大15分。 |
| Cron | UTC、Paid trigger 上限と interval 別 CPU を release 時確認。 |

### 13.2 CSRF / CSP / MIME

- private Cookie REST mutation: strict Origin allowlist + custom header。GET mutation 禁止。
- WebDAV: Cookie auth なし、CORS 非公開、Origin 付き request 拒否、app password Basic のみ。
- share SSR form: one-time CSRF + Origin check。
- app、share landing、untrusted preview の CSP を分離し、`nosniff`、surface 別 `frame-ancestors`、`Referrer-Policy: no-referrer`。
- R2 / content host の public direct URL を発行しない。

### 13.3 audit / log

`activity` は application principal に対して append-only。Cloudflare account / D1 管理者は trust boundary 内であり、その管理者への暗号学的改竄耐性は v1 保証外。Authorization、Cookie、password、CSRF、ticket、token、share URL token を全 log / trace で mask する。CSV export は formula injection を neutralize する。

### 13.4 monitoring / cost

D1 size / rows、Queue / outbox age、UploadDO anomaly、reservation、physical / logical quota 差分、GC state、trash backlog、ticket bytes / request、ZIP abort、thumbnail attempts、backup age / journal gap、epoch、unauthenticated route test を監視する。

単価は release 時の公式単価 `P_*` と telemetry から low / base / high worksheet を作る。R2 Class A/B、D1 rows、Images unique transform、DO request / duration、Queue、backup / GC / Range retry を含め、Workers Paid 基本料だけを総費用としない。

---

## 14. config、deploy、ControlDO、Cron / job

### 14.1 Wrangler

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
  "observability": { "enabled": true }
}
```

`unsafe.bindings` を使わない。dev / staging / production の D1、R2、KV、DO、Queue、Access app を分離する。vars は Access audience / domain、owner emails、content host、versioned limit config。secrets は HMAC / Cookie key ring。`DEV_BYPASS_ACCESS` は local test のみで、本番に存在すれば CI と startup を失敗させる。

### 14.2 ControlDO / lease

全 mutation と job は `ControlDO` の epoch / maintenance を先に確認する。lease row は epoch、state、holder、fence、expiry、checkpoint を持つ。D1 副作用は同じ batch の fence guard、R2 副作用は §5 の対象別 protocol で保護する。

schedule は upload / trash / outbox repair、daily export / activity archive、weekly R2 orphan reconciliation に分ける。正確な cron と platform budget は §13 / Wrangler config を正本とする。各 job は node、blob、D1 / R2 call、CPU / wall time を別予算にし、checkpoint から再開する。

### 14.3 deploy gate

Access policy は route manifest から生成・diff する。deploy 後に private SPA / API の未認証拒否、public share / DAV の expected response、未知 public route の 404、想定外 host、workers.dev、preview URL、R2 public access を実 HTTP で検査する。TypeScript test は `AuthedContext` なしの private handler 登録が compile 失敗することも確認する。

---

## 15. test plan / acceptance

### 15.1 normal / protocol / cost

- unit / integration: tree CTE、authorize operand matrix、operation barrier、quota ledger、全 §5 state machine、search normalization、XML parser。
- WebDAV: litmus basic / copymove / props / locks、rclone、cadaver、Finder、Explorer。alias mount、lock-null、複合 `If:`、URI ABA を含む。
- E2E: upload resume、share、upload-only non-oracle response、trash / restore / purge、bulk、logout cache clear、a11y。
- cost: ticket Range、part resend、duplicate Queue、Depth:1 allprop、zero-byte node、COW、ZIP disconnect が §13 budget 内で停止すること。

### 15.2 failure boundary release gate

- 同一 revision PUT と D1 response loss。全 step の一つをゼロ行にして batch 全体が rollback すること。
- 相互 MOVE、MOVE と upload complete、share revoke / ancestor MOVE / DELETE と complete。
- LOCK inspect と commit の間の新 LOCK、mount alias、permit holder crash。
- upload initiating / in-flight part / completing / R2 lifecycle / D1 committed-DO stale の全遷移。
- delete chunk と restore、restore と purge、別 op の deleted child、全 FK 順序。
- GC candidate / pin / deleting、R2 delete response loss、recovery pause と不可逆 worker。
- Time Travel 後に epoch が上がり、旧 app password、ticket、job、lease、upload capability が無効なこと。
- outbox send response loss、Queue retention loss、consumer response loss、backup delete tombstone / journal gap。
- physical quota を CAS 失敗 upload の反復で迂回できないこと。
- ZIP exact output preflight、ticket byte budget、thumbnail transform claim / retry 固定。
- public multipart が public route だけで完了し、private router へ fallthrough しないこと。

### 15.3 staging cloud gate

Miniflare だけで合格にしない。zone body / edge 413、D1 batch assertion / Time Travel、R2 multipart lifecycle / Range / delete、DO restart / SQLite、Queue duplicate / retention、Images contract / peak memory、Access route IaC、実 WebDAV client、CONTENT_HOST、restore drill を分離 staging で実測する。

---

## 16. 実装 phase

1. **Foundation / invariants**: route 型境界、schema、ControlDO、principal / operand 認可、operation barrier、tree / lock generation、logical / physical quota、failure injection。
2. **Files core**: immutable blob、metadata / content ETag、create / rename / MOVE、COW、cross-owner copy job、Range。
3. **Multipart**: UploadDO 全状態、barrier、public / private route、browser resume、reconciliation。
4. **Trash / GC / recovery**: exclusive trash state、FK purge、pins、irreversible GC、journal backup、epoch restore drill。
5. **Search / stats**: FTS、bounded fallback、folder aggregation、metadata quota。
6. **Thumbnail / preview**: outbox、result claim、node client thumb、CONTENT_HOST。
7. **Sharing**: typed capability、TicketDO、internal / upload-only、ZIP budget。
8. **WebDAV**: Class 1、Class 2、node lock、commit reservation、real client matrix。
9. **Operations / polish**: admin / DLQ、cost metric、PWA、i18n、a11y。

Foundation の invariants と §15 failure gate が通るまで Files core へ進まない。各 phase は migration test、lint、typecheck、unit、relevant integration を必須にする。

---

## 17. 機能提供 roadmap

| 項目 | 判定 | 内容 |
|---|---|---|
| file history | v1 / 後段 | v1 は内部保持、UI / user restore は §18。 |
| sync conflict | v1 | revision / ETag 412。conflicted copy なし。 |
| change token | 後段 | v1 は標準 PROPFIND を途中 truncate しない。 |
| mtime / checksum | v1 | client mtime と server time、declared / verified hash を分離。 |
| team / group share | 後段 | v1 は personal owner space。 |
| share accept / reshare / notification | 後段 | v1 は owner 作成と activity。 |
| app credential | v1 | scope、expiry、revoke、epoch invalidation。 |
| user disable / transfer | v1 | credential / job 停止、owner transfer。 |
| user import / export | 後段 | operational backup は v1。R2 direct write 禁止。 |
| bulk progress | v1 | job ID、result、cancel / retry、budget。 |
| search | v1 | name / filter。full-text / OCR は非目標。 |
| backup | v1 | §11 / §13 の限定 recovery window。 |

---

## 18. 後段・staging で確定する事項

v1 で安全な制限が置けない機能は有効化しない。

1. **ZIP64**: v1.1 候補。v1 は STORE / non-ZIP64 と §13 の exact output 上限を維持する。
2. **大容量 CLI / Nextcloud chunking / change token**: v1.1 以降。v1 DAV は単発 request 上限のまま。
3. **version history UI / user restore、team space、group / reshare、通知、user import / export**: data model と認可を別設計 review する。
4. **Service Token の DAV 対応**: v1 では不採用。REST mapping の実績後に credential semantics を再 review する。
5. **Images codec / contract、WASM peak memory、PBKDF2 latency**: staging 結果で対応 format を狭めることはできるが、§13 上限を無検証で緩めない。
6. **cross-owner copy の最大実効 throughput**: Range multipart job と source pin の実測後に UI 公称値を決める。一発 stream copy へ戻さない。
7. **D1 FTS / DB 容量、search fallback、backup journal throughput**: 実 dataset と restore drill で測り、node / metadata 上限を緩める場合は migration と再 review を行う。
8. **CONTENT_HOST、別 account R2 replication、長期 backup**: v1 の同一 account threat model を越える option として設計する。
9. **WebDAV client 差異**: Finder / Explorer / rclone の sidecar、case-only rename、lock-null、複合 `If:` を support matrix に固定する。
10. **料金と platform 可変値**: release 時公式値で worksheet と Wrangler budget を更新する。安全性の根拠を課金 plan の暗黙値に置かない。
