# Next-cloud-flare — Implementation Brief for Sol

## 0. 作業開始条件

状態: **v0.6 で R5 ゲート項目を是正済み。Astra R6 再ゲート = 条件付き Go（`docs/reviews/round6-astra.md`）。Phase 0 → 1 の順に着手可。R6 の 10 条件は §8 の確定事項で閉じ、Phase 1 完了前に fixture で証明する。**

実装進捗: Phase 0 と Phase 1 の一部を実装。内部の atomic フォルダー作成・outbox producer・`node.created` consumer と Queue handler の admission gate まで実装。全 operation の認可、実 Queue/DLQ の検証、ControlDO 再開、repair/HTTP 接続と実環境 gate は未完了。再開は [`HANDOFF.md`](HANDOFF.md)、検証結果の正本は [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)、実装契約は [`FOUNDATION.md`](FOUNDATION.md) を参照。

- Phase 0 gate 1 で D1 `_assert`、`changes()`、EXISTS fallback と G01 三反例を最初に実証する。
- 設計の安全性に関わる空欄を実装者の推測で埋めず、`docs/DESIGN.md` v0.6 と `docs/reviews/round5-resolution.md` を正本とする。
- Phase 1 完了前に Files core、upload、trash/GC の本実装へ進まない。
- 各 phase の完了は、その phase の不変条件と既存回帰で判定する。
- `M/U/I/R` は migration/unit/integration/rollback・復旧手順を意味する。

## 1. 絶対に守る不変条件10か条

1. **正本を混同しない。**
   D1 は namespace/認可/台帳、R2 は不変 content、ControlDO は復旧外の単調増加 epoch/maintenance/GC pause の正本とする。

2. **失敗した mutation は部分確定させない。**
   node、tree、version/ref、quota、audit、outbox、operation terminal の必須変更は同一 D1 transaction で成立させ、必須条件不成立は `_assert` の SQL error で rollback する。

3. **旧実行を確定させない。**
   epoch、D1 open permit、job claim fence を commit 側で強制し、期限切れ/revoke/reset/lease奪取後の旧 Worker を無害化する。

4. **全 operand を現在の権限で認可する。**
   source、destination、親、置換先、share/upload/job/operation ID、credential scope と失効を commit batch で再検査し、owner/admin例外で制限 credential を拡張しない。

5. **読取りにも EffectiveLive を適用する。**
   HEAD、Range、304、thumb、search/count、ZIP、media、ticket を含め space root まで検証し、共有外の ancestor 名を返さない。

6. **tree を壊さない。**
   root一意、owner/space/parent整合、portable name一意、cycle禁止、depth≤64、構造変更CASを守る。

7. **容量と参照は一度だけ会計する。**
   reservation、logical、physical、current/version/pin の定義を固定し、staging/orphan/GC待ちを未課金にせず、物理削除確認前に physical を減らさない。

8. **転送と job は耐久状態機械で管理する。**
   受付停止、in-flight、attempt、deadline、cleanup を永続化し、外部 I/O の応答喪失を未実行と扱わず、R2完成だけで成功を返さない。

9. **削除と復旧を競合させない。**
   `trash_members` 外の既削除子を復活させず、restoreは最後に公開し、deleting blobへの参照を拒否し、GC quiesceと復旧検証前にサービスを再開しない。

10. **未信頼入力と秘密情報を境界外へ出さない。**
    bounded parser/stream/費用上限、用途別token、safe MIME/CSP、public/private asset境界、secret非記録を全経路で守る。v1 client thumbnail受付は実装しない。

## 2. 実装順序・完了条件・テスト

以下のパスは最終的な成果物名であり、すべてが現在存在することを意味しない。作成済み範囲は進捗記録を参照。

```text
W = packages/worker
B = packages/web
S = packages/shared
```

| Phase | 実装内容・順序 | 完了条件と必須テスト | 作成する主なファイル／パッケージ |
|---|---|---|---|
| **0：成立性検証** | 公開7日以上のtoolchain exact固定、binding、D1 `_assert`/`changes()`/EXISTS fallback、R2 known-length single stream、DigestStream、Range、STORE ZIP dry-run、KDF/Images | G01三反例で副作用ゼロ、SQL error全rollback、`changes()`が直前statementを指すこと、commit応答喪失分類、slow consumer/cancel、100k受理、Images境界を検証 | root `package.json`、`pnpm-workspace.yaml`、lockfile、`tsconfig`、`wrangler.jsonc`、W/B/S package manifest、`W/test/fixtures/`、spike tests |
| **1：Foundation** | complete contract→schema→primary adapter→ControlDO→auth/authorize→quota/physical/ref/pin→D1 permit/LockDO→operation claim/outbox/repair→一つのcreate | FK/CHECK、bind100、bootstrap競合、全principal negative matrix、深さ64、claim競合、permit revoke/expiry/reset/旧Worker、失効対commit、old epoch、outbox duplicate/ack lossを合格 | `W/migrations/*.sql`、`W/src/db/`、`W/src/routes/manifest.ts`、`W/src/auth/`、`W/src/do/{ControlDO,LockDO}.ts`、`W/src/services/{fsMutation,quota,refs}.ts`、`W/src/jobs/{outbox,claims,repair}.ts`、`S/src/{contracts,limits,errors}.ts` |
| **2：Files core** | immutable transfer/read→create→overwrite/version→rename/MOVE→same-owner COW→folder COPY manifest | 同名/並行PUT/相互MOVE、cross-space MOVE拒否、R2成功D1失敗、D1成功応答喪失、Range/HEAD/validator、COW quota/ref≤1,000、lock対REST、folder COPY props/衝突fixtureを合格 | `W/src/services/{nodes,blobs,versions,copy,content}.ts`、`W/src/api/nodes.ts`、`B/src/features/files/`、関連migration/tests |
| **3：Upload／copy job** | single create/content/complete→multipart create→part/status/resume→complete→abort/expire→cross-owner copy | 0B/public single、虚偽size、欠落part、3 attempts/calls/bytes、late unknown attempt→aborting、reset、complete/abort 409、staging/orphan/physical、R2 7日lifecycleを合格 | `W/src/do/UploadDO.ts`、`W/src/services/uploads/`、`W/src/api/uploads.ts`、`W/src/jobs/copy.ts`、`B/src/features/uploads/`、承認時のみbrowser hash worker |
| **4：Trash／GC／recovery** | trash membership→restore→purge→GC→Time Travel→logical export→restore drill | 独立削除子、全chunk fence、全FK、複数pin、参照追加対deleting、blob/GC state同batch、delete応答喪失、GC quiesce、両restore、terminal保存、epoch非再使用、quota/ref再計算を合格 | `W/src/services/{trash,pins,gc}.ts`、`W/src/jobs/{trash,purge,gc,backup,restore}.ts`、`W/src/backup/`、`B/src/features/trash/`、`scripts/restore-drill.*` |
| **5：List／search／stats** | keyset一覧→base/FTS external同期→scope-aware search→要求時bounded stats | NFKC/casefold/かな統一、bigram quote、substring、1文字検索、旧索引、無権限候補、scope/hit上限と`truncated:true`、cursor改変、Gallery 50k、PROPFIND 1,000×20、実D1予算を合格 | `W/src/services/{listing,search,stats}.ts`、`W/src/search/`、FTS migration、`B/src/features/search/` |
| **6：Share／content／ZIP** | shareモデル→CSRF/session→internal mount→upload-only→D1 content session/BudgetDO→public bundle→ZIP STORE | 匿名E2E、auto rename同形201、share失効、祖先trash、session更新/別tabでbudget増加なし、preflight/Cookie、purpose混同、全content/public route会計、ZIP exact size/pin/cancelを合格 | `W/src/do/BudgetDO.ts`、`W/src/auth/{share,csrf,tokens}.ts`、`W/src/api/{shares,public,contentSession}.ts`、`W/src/services/{tickets,zip}.ts`、`B/src/public-share/`、独立public build manifest |
| **7：WebDAV** | Class1→props/XML→条件header→Class2→COPY/MOVE→実client | XML/numeric reference fixture、DTD拒否、If式/token submission、creator、Shared mount、collection revision、lock-null parent operand、PROPPATCH全rollback424、Depth/Overwrite、403大規模拒否、litmus/rclone/Finder/Explorerを合格 | `W/src/dav/{router,path,davXml,properties,conditions,methods}.ts`、`W/test/fixtures/dav/`、DAV integration tests |
| **8A：Gallery** | metadata/Images→generation result→Gallery API→基本UI | GPS非保存、current blob/generator、client thumb route無し、変換前claim、retry費用、50k候補gate、grid/list/lightbox/共有E2Eを合格 | `W/src/media/images/`、`W/src/jobs/media.ts`、media migration、`B/src/features/gallery/` |
| **8B：Bookshelf** | archive index→page stream→PDF→EPUB sanitize→trusted reader→読書状態 | zip bomb/CRC/overflow/暗号化、危険path、CSS/URL sanitize、sandbox、scroll/TOC/CFI、user/node/blob state、公開共有/browser差を合格 | `W/src/media/{archive,epub}/`、`W/src/jobs/sanitize.ts`、library migration、`B/src/reader/`、`B/src/features/library/`、pdf.js assets |
| **8C：Audio** | bounded tag/cover→tracks→override→基本player/状態 | head/tail/moov/cover上限、未対応codec、Range seek、session更新、SPA遷移中再生、user/node/blob position、共有再生を合格 | `W/src/media/audio/`、audio migration、`B/src/features/audio/`、`B/src/player/` |
| **9：Release** | UI横断品質→監視→Cloudflare inventory→運用演習→support matrix→承認配備 | a11y/touch/低性能端末、upload離脱、logout全cache、R1〜R5回帰、log canary、費用/capacity、lifecycle、backup復旧、rollback rehearsalの証跡 | CI workflows、`scripts/{verify-config,staging-smoke,release-gate}.*`、監視設定、承認済み運用script |

**依存上の注意：**

- quota/physical/ref/pin、permit、claim/outbox/repair は Phase 1。後付けしない。
- Phase 4 の shared subtree 試験は fixture grant で先行し、Phase 6 で実 HTTP 経路を追加する。
- control/repair/outbox/claims は最終 polish ではなく Foundation。
- schema変更は migration と fixture を同時に変更する。
- phaseごとの rollback は前版へ戻せる範囲と maintenance/restore が必要な範囲を区別する。

## 3. 依存パッケージの方針

2026-09-22 の追加要件: 事前エンコード済み AVIF / AV1 / Opus を必須対応とする。コンテナ、MIME、再生判定、AVIF derivative 制限と原本 fallback、完了 fixture は [`MEDIA_FORMATS.md`](MEDIA_FORMATS.md) を各 media phase の gate に含める。

設計で採用済みの候補：

- Worker: `hono`、`@hono/zod-openapi`、互換する `zod`
- DAV: `fast-xml-parser`。adapter外から直接使用しない
- ZIP生成: `fflate` の同期 `Zip`/`ZipPassThrough` だけ。STOREのみ
- Web: React、Vite、Tailwind、shadcn/ui、TanStack Router/Query/Virtual
- PDF: `pdfjs-dist`、browserのみ
- Test: Vitest、`@cloudflare/vitest-pool-workers`、browser E2E runner

Node、pnpm、Wrangler、TypeScript、Vitest と全依存は Phase 0 で互換性を確認した exact version に固定し lockfile をcommitする。採用時点で公開7日未満の版は使わない。未確定のJWT verifier、sanitizer、browser incremental hashは、runtime/保守状況を評価して版を承認してから追加する。自作暗号や巨大な独自sanitizerを暗黙に導入しない。

## 4. ローカル開発構成

- pnpm workspace: worker/web/shared。
- Workerの `fetch/queue/scheduled` と DO をlocal runtimeで動かす。
- private SPA、public-share、readerを別entryとしてbuildし、Workerがmanifestに従ってassetsを配信する。pure表示componentのsource共有は可。
- local D1/R2/KV/DO/Queues stateはstaging/productionと分離する。
- Cookie/CORS試験はapp/contentの別originとHTTPSを使う。
- local auth fixture adapterは開発/test専用entryに限定し、本番bundleへ含めない。
- secretは未追跡設定または環境別secret storeから供給し、Git/frontend/test snapshotへ含めない。
- production相当のAccess、zone body limit、Images codec、Queue concurrency、D1性能はlocal成功で代替しない。

**用意する package scripts：**

```text
pnpm dev
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm verify:contracts
pnpm verify:config
```

`test:e2e` はブラウザ機能実装時に追加する。それ以外は定義済み。`verify:contracts` は toolchain/limit/禁止API と route/operation の設計照合を行う。schema/FK/state の検査は unit/integration tests に含めるが、Phase 1 後半の認可・台帳・permit gate は未完了。

## 5. CI 構成

### A. 通常 PR CI — cloud資格情報なし

1. frozen lockfile install
2. lint/typecheck/build
3. manifest、scope、error、limit、schema/state transitionの整合検査
4. unit tests
5. Workers integration tests
6. D1 migration/FK/FTS external sync/SQL-error rollback/failure injection
7. DO reset/alarm/duplicate delivery/stream backpressure
8. public bundleにprivate/server/auth chunk、secret、開発bypassがないことを検査

### B. 承認付き staging CI

- environment専用resourceへ配備。
- Access policy、Service Auth、Bypass、host/alias、HTTPSを実HTTP検査。
- CONTENT_ORIGIN Cookie/CORS/preflight、KDF、Images、R2、Queueを実検査。
- D1 `changes()` gate、query数、`rows_read`、`duration_ms`、DO負荷/alarmを計測。
- R2 incomplete multipart 7日lifecycle、Queue retention/DLQ、resource inventory driftを検査。
- secret canary、Time Travel/export restore drillを実施。

### C. Release gate

- Finder/Explorer/rclone/cadaverのsupport matrix。
- browser別reader、Cookie、Range、media試験。
- R1〜R5 failure regressionを全件消化。
- Time Travel/export generationの復元証跡、RPO/RTO実測。
- 料金/capacity worksheetと監視閾値。
- production配備は承認付き。PR CIから自動配備しない。

## 6. 迷ったときの判断原則

1. **安全性の矛盾は止めて報告する。** 後の章や過去対応表より v0.6 の明示契約を優先する。
2. **実装可能性が未確認なら機能を閉じる。** 認可/quota/復旧を緩めない。Gallery/Bookshelf/Audio自体はv1から外さない。
3. **commit不明は失敗ではない。** 最大3回/5秒照合後はOperation-Id付き503とし、同一operationを照合する。
4. **SQL/型/テストの役割を混同しない。** 型安全だけで認可やtransactionを保証しない。
5. **元データを優先する。** preview/検索/集計が失敗してもcontent/ref/recoveryを壊さない。
6. **上限未達はalgorithm改善か明示済み縮小で対処する。** platform/security controlを緩和しない。
7. **テスト成功範囲を明記する。** SQLite、Miniflare、staging、実clientを区別する。

## 7. 禁止事項

- 同一content keyの上書き、論理pathをR2 keyにすること。
- D1 commit後のJS例外や `meta.changes` 検査をrollbackとみなすこと。
- operationだけをfailedにして部分更新を補償済みと扱うこと。
- 認可、失効、mutex、厳密quotaをKV/PoP-local rate limitに依存させること。
- long upload/D1 I/Oを `blockConcurrencyWhile()` で囲むこと。
- in-flight/leaseをmemory counter、`finally`、shutdown hookだけで管理すること。
- 大容量bodyの全メモリ化、無制限 `Promise.all`、backpressureのない `tee()`。
- `fflate ZipDeflate/Async*`、通常runtimeのhash-wasm loader、自動WASM image fallback。
- public routeからprivate router/SPA/assetsへのfallthrough。
- bearer secretをURL、operation result、backup、log、traceに保存すること。
- app_adminに他者content readを暗黙付与すること。
- client thumbnail route/resultをv1に追加すること。
- service automationにv1 mutation/uploadを追加すること。
- FK無効化、quota/認可/security policyの一時撤去で試験を通すこと。
- 未承認のproduction migration、purge、GC、restore、資源削除。
- 未合格機能をv1 support matrixへ載せること。

## 8. R6 条件付き Go の確定事項（Phase 0/1 で fixture 化する）

Astra R6（`docs/reviews/round6-astra.md`）の 10 条件に対する確定判断。**v0.6 本文と矛盾する場合は本節を優先**し、Phase 1 で `docs/DESIGN.md` の該当節へ反映する（v0.7）。推測で埋めない。

| # | 条件 | 確定事項 | fixture |
|---|---|---|---|
| 1 | SQL barrier の D1 実証 | Phase 0 で `@cloudflare/vitest-pool-workers` 上の実 D1 で (a) `changes()` が直前 statement を指す、(b) `_assert` CHECK 違反で batch 全 rollback、(c) 応答喪失を `commit-unknown` に分類できる、を検証。(a) が不成立なら **前条件 EXISTS + 後条件 EXISTS**（例: `NOT EXISTS(nodes WHERE id=?1 AND revision=?2+1 AND current_blob_id=?3)`）を必須 step 全部に付ける fallback を採用。G01 三反例 + 全必須 step で副作用ゼロを確認 | `W/test/spike/d1-assert.test.ts`、`W/test/fixtures/g01-*.sql` |
| 2 | permit / 現在認可の commit 述語 | permit 述語は `p.state='open' AND p.epoch=?epoch AND p.space_id=?space AND p.expires_at > (strftime('%s','now')*1000)`（D1 側時刻で期限判定、値一致だけにしない）。同一 batch に principal 有効性 `EXISTS(users WHERE id=? AND disabled_at IS NULL)`、credential 有効性（`app_passwords.revoked_at IS NULL AND expires_at>now` / `sessions.revoked_at IS NULL` / `shares.version=? AND disabled_at IS NULL AND expires_at>now`）、role/scope 述語を `_assert` で入れる | `permit-expired-open.test.ts`、`permit-revoked.test.ts`、`credential-revoked-at-commit.test.ts` |
| 3 | Access session の個体識別 | `sessions(id TEXT PK, user_id, kind CHECK(kind IN('access','app_password','share')), fingerprint TEXT UNIQUE, issued_at, expires_at, revoked_at, last_seen_at)`。Access JWT は `fingerprint = sha256(iss|sub|iat|exp)` で初見時に行を作り、`credential_id = 'as:'+sessions.id`。logout = 該当 session と同 user の派生 content session を `revoked_at` 設定。job は起動時の `credential_id` を保持し、各 chunk の commit batch で `sessions.revoked_at IS NULL` を assert。content session の `issued_by_credential_id` は NOT NULL FK | `session-logout-revokes-content.test.ts`、`job-continues-only-with-live-session.test.ts` |
| 4 | 復旧の安全条件 | (a) ControlDO は epoch bump ごとに R2 `sys/epoch/<epoch>.json`（`{epoch, at, reason}`）を書き、書込み成功後に epoch を公開。ControlDO storage 喪失時は R2 `sys/epoch/` の list 最大値 +1 を下限とし、R2 list が失敗/空で証明できなければ **fail-closed（起動拒否、operator 手動 `EPOCH_FLOOR` 設定が必要）**。時刻ベースの下限は使わない。(b) `blobs.state='deleting'` は不可逆: 通常 restore/disaster restore とも当該 blob を参照する node の復活は 409 `blob_unrecoverable`、待機は不要。disaster restore 後は reconcile job が `deleting` 全件を `head()` で収束（absent→`deleted` + physical 減算、present→再 delete）。(c) logical export は `wrangler d1 export --table=<t>` を通常 table 全部に対して maintenance window（`control.maintenance=1`、mutation は 503 `maintenance`）内で実行。FTS は export せず restore 後に rebuild | `epoch-floor-from-r2.test.ts`、`restore-deleting-blob-409.test.ts`、`export-excludes-fts.test.ts` |
| 5 | 完全 FK graph と purge 順序 | 削除順は手書きしない: `W/test/schema/fk-order.test.ts` が migration の FK graph をトポロジカルソートし、`purgeOrder` 定数と一致することを assert。`trash_members`、`node_props`(dead props)、`node_tags`、`node_media`、`node_audio`、`library_items`、`archive_index`、`user_reading_state`、`user_playback_state`、`shares`→`share_grants`、`node_versions`、`locks`、`uploads`、`fts` 外部内容、最後に `nodes`。別 trash operation に属する既削除子は purge 時に `parent_id=NULL`（deleted node のみ NULL 許容 CHECK）、その子の restore は「親不在→space root へ restore、名前衝突は `(restored N)` 付与」 | `purge-fk-order.test.ts`、`purge-parent-with-foreign-trash-child.test.ts` |
| 6 | single upload 台帳・外部 I/O 状態遷移 | 状態: `created→receiving→completing→completed` / `receiving|created→aborted|expired`、`completing→completed|failed` のみ（`completing` からの abort は 409、一般 `nonterminal→failed` は `completing` を除外）。single PUT 結果不明 (`receiving` のまま応答喪失) は **同一 staging key への再 PUT 禁止**、再試行は新 upload。reservation は `expires_at`（24h）まで維持、Cron が期限後に `head()`: present→`blobs.state='orphan'` + physical 課金維持→GC、absent→`expired` + reservation 解放。期限前の absent は未完了 PUT の不存在と扱わない。台帳記録前に停止した完成物は reservation で会計し、上記 Cron で physical へ移す | `single-put-unknown-no-reput.test.ts`、`single-expired-head-present-orphan.test.ts`、`completing-abort-409.test.ts` |
| 7 | CSRF と operation 照合 | CSRF token は one-time ではなく **session 束縛 HMAC（TTL 1h、再発行自由）**。`POST /api/v1/csrf` は profile `csrf-issue`（auth=access、`Sec-Fetch-Site: same-origin` 必須、token 不要）。public は `POST /api/v1/public/shares/:id/csrf`（profile `public-csrf-issue`、unlock cookie 束縛）。`GET /api/v1/operations/:id` は auth=access|app_password|share で **operation を作成した credential_id と一致**する場合のみ 200（他は 404）。DAV は照合 API を提供せず、protocol 再試行に委ねる | `csrf-issue-no-token.test.ts`、`operation-lookup-same-credential.test.ts` |
| 8 | BudgetDO の単位・精算 | 単位は `budget_id` に統一: user = `u:<user_id>`、共有経由 user = `u:<user_id>:s:<share_id>`、匿名 share = `s:<share_id>:c:<unlock_cookie_id>`。parallel ≤ 8 / budget_id（session 単位ではない）。counter は DO storage（SQLite）に永続、eviction 後も保持。結果不明転送は**全額消費扱い、返金なし**。owner あたり active budget ≤ 64（D1 count、超過 429）。job 全体上限: node 10,000 / blob 10,000 / R2 API 20,000 / invocation 200 回、超過で `failed(budget_exceeded)` | `budget-persist-across-eviction.test.ts`、`budget-unknown-no-refund.test.ts` |
| 9 | DAV protocol contract 残欄 | Basic username = app password id（`ap_<ulid>`）、password = secret（email は不可）。`Timeout`: `Second-N` は `min(N,3600)`、未指定 600、`Infinite` は 3600。method 条件: PUT(既存) は `If-Match` か lock token 必須、なければ 428; MKCOL/DELETE/COPY/MOVE/PROPPATCH は `If` 任意（lock 下は token 必須）。`getetag` は GET/HEAD の `ETag` と同一: file `"b-<blob_id>"`、collection `"c-<node_id>-<revision>"` | `dav-timeout.test.ts`、`dav-put-428.test.ts`、`dav-etag-equals-get.test.ts` |
| 10 | 開始条件・依存順 | Phase 1 の順序は contracts → migrations(+fk-order test) → ControlDO(epoch/R2 history) → auth/sessions → ledger(quota/ref/pin) → permits/LockDO → fsMutation core → 最初の create + outbox。#1〜#9 の fixture 名は各 phase の完了条件に含める | 本表 |
