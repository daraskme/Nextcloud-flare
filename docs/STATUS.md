# 実装ステータス

## 到達 Phase

Phase 5（List／search／stats）完了。

Phase 0〜5 の実装を、各 Phase の lint / typecheck / unit・Workers integration test / build が通る状態で確定した。

## 今回のコミット

- `a99c7c6` `feat: implement authenticated Files core`
- `0d75585` `feat: add resumable upload and copy jobs`
- `e84beec` `feat: enforce fenced trash and recovery lifecycle`
- `568672c` `feat: deliver scoped discovery and storage insights`
- `4bdc594` `fix: harden local auth and bulk moves`

## Phase 0〜1 の確定事項

- D1 `changes()` 直後 barrier と `_assert` SQL error による batch rollback を採用し、G01 三反例で副作用ゼロを確認済み。EXISTS fallback は採用していない。
- statement error / 明示的 batch rejection は `rollback-confirmed`、network / timeout は `commit-unknown` に分類する。
- R2 known-length stream、single Range、`crypto.DigestStream`、STORE ZIP dry-run、slow consumer backpressure、cancel propagation、PBKDF2 100,000 回、Images 20,000,000 byte 境界を固定した。
- complete Foundation schema、ControlDO epoch history、LockDO permit、BudgetDO counter、session/credential fence、quota/ref/pin、operation/outbox/repair、folder create を実装済み。

## Phase 2 の実装

- native WebCrypto の Cloudflare Access RS256 verifier を実装した。単一 JWT header、`alg` / `typ` / issuer / audience / `iat` / `exp` / `nbf` / user・service claim、24時間上限、60秒 skew、署名を fail closed で検証する。
- JWKS は issuer 単位 KV cache（fresh 1h / known-key stale 24h）、未知 `kid` single-flight、10 refresh/分、negative 64、5秒 timeout、256KiB、RSA 16鍵上限を実装した。
- `DEV_PRINCIPAL_EMAIL` 等による local principal を追加した。`ENVIRONMENT=development|test` かつ loopback request の場合だけ有効で、production / 非loopbackでは fail closed になる。
- immutable R2 key、staging/physical ledger、create、overwrite/version、rename/MOVE cycle・cross-space fence、same-owner COW、固定 folder COPY manifest/dead props、lock対REST permit を実装した。
- content GET/HEAD、strong content ETag、304、single Range 206/416、multi-range の安全な full response、R2/D1 size・existence整合検査、EffectiveLive を実装した。
- Web UI に dark/light、grid/list、breadcrumb、context menu、複数選択、選択集合の drag-and-drop MOVE、folder create/rename/COPY を実装した。

## Phase 3 の実装

- upload capability digest、24時間 reservation、single PUT 一回制約、known length/declared size、staging/physical 会計、complete の namespace 同一 batch 公開を実装した。
- UploadDO に partごとの durable attempt/result、in-flight、calls/bytes budget、seal、`aborting` internal fence を実装した。D1 は Brief §8 #6 の `created→receiving→completing→completed|failed` を正本にした。
- multipart create/part/status/resume/complete/abort、欠落 part、最大3 attempts・3倍 calls/bytes、complete/abort conflict、期限後 `head()` orphan/expire 収束を実装した。
- cross-owner copy は source pin + destination reservation + Queue claim/lease + immutable transfer + namespace/job/pin terminal 同一 batch を実装した。3 attempts 後は ledger を解放して terminal failed にする。
- Web UI に D&D upload、8MiB 分塊、進捗 panel、IndexedDB capability/part resume、name/size/mtime + head/tail sample fingerprint を実装した。

## Phase 4 の実装

- trash 時点の live subtree membership 固定、独立削除済み child 除外、share disable、root/tree/parent revision fence を実装した。
- restore は ControlDO `gc_paused`、deleting candidate 0、全 blob recoverable を確認し、descendantを処理して最後に root を公開する。親不在 fallback と `(restored N)` 衝突解決を実装した。
- purge は FK graph に従って dependent rows を削除し、別 trash の child を detach する。current/version ref、logical quota、GC candidate/blob state を同一 batch で更新する。
- GC は複数 pin の権威行、ref/pin 再検査、blob/candidate `deleting` 同一 batch、R2 delete response loss の `head()` 収束、物理削除確認後の physical 減算を実装した。
- ControlDO maintenance / GC pause、permit admission停止、recovery run、terminal operation保存、epoch bump、root/ref/quota/R2 検証、Time Travel / logical export の明示確認付き restore drill commandを実装した。
- Web UI に Trash 一覧、restore、確認付き permanent delete を実装した。

## Phase 5 の実装

- HMAC signed keyset cursor を user / parent / tree generation / last key / TTL に束縛し、改変・条件違い・世代 drift を400で拒否する。
- NFKC、小文字化、主要 casefold exception、カタカナ→ひらがな、version固定形式の bigram生成、quote/LIKE escape を実装した。
- external-content FTS の delete/base/insert 同期を create/rename/MOVE/COPY/content revision/trash/restore/purge と同じ D1 batch に組み込んだ。
- scope CTE 10,000、候補10,000、hit 200、pattern 50B の上限で substring/bigram/1文字検索を実装し、stale revision と scope外候補を除外し `truncated` を返す。
- bounded stats、recent、starred、star mutation、tag CRUD を実装した。stats は quota / used / physical / reserved / file・folder・logical bytes を返す。
- Web UI に Cmd/Ctrl+K command palette、検索結果、truncated表示、容量 meterを実装した。

## 検証結果

最終実行（local Workers runtime / Miniflare。実 staging ではない）:

- `pnpm lint`: pass
- `pnpm typecheck`: pass（shared / web / worker）
- `pnpm test`: pass
  - unit: 17 files / 32 tests
  - Workers integration・schema・spike: 31 files / 57 tests
- `pnpm build`: pass
  - shared TypeScript build
  - web Vite production build
  - worker Wrangler dry-run build
- `pnpm dev`: migration 0001〜0004をlocal D1へ適用し、Vite `:5173` + Worker `:8787` を起動確認
- local HTTP smoke: dev principal `/me`、CSRF、folder create、single upload create/PUT/complete、trash/list/restore、search、stats、childrenを確認

## 未実装

- Phase 6 以降: Share／content-session／BudgetDO route接続／ZIP、WebDAV、Gallery、Bookshelf、Audio、release gate。
- Access service principal の HTTP automation adapter、app password/share credential の発行・検証 HTTP adapter。Access user HTTP adapterは実装済み。
- cross-owner copy の public/share HTTP admission。job coreは実装済みだが、公開経路はPhase 6のgrant検査後に開く。
- 実 Cloudflare Access、D1/R2/KV/Queues/Cron/DO placement、R2 incomplete multipart 7日 lifecycle、Time Travel / logical export restoreのstaging smoke。
- 大規模 trash/restore/purge の複数 invocation chunk pipeline。現在は1 operation 1,000 nodesを上限に fail closed とする。
- exhaustiveなversion固定Unicode casefold table。現在のportable file nameはFoundation-safe printable ASCIIに限定し、検索側はNFKC・主要casefold・かな統一を行う。
- media metadataを含む検索document。name indexとtag CRUDは実装済みで、media title/author/audio metadataはPhase 8のextractor公開時に同期する。
- Recent / Starred 専用 Web 画面（APIは実装済み）。
- README とrelease support matrix。

## 既知の欠陥・制約

- portable nameは安全なversion固定Unicode casefold実装が未承認のため printable ASCII subsetに限定している。
- JWKS refresh rate / single-flight は isolate 内で強制し、KVをcacheに使う。production相当のPoP横断 refresh stormはstaging gateで検証が必要。
- migration rollbackはdestructive down migrationではなく、maintenance下のD1 snapshot/Time Travel restoreを前提とする。
- local integration runtimeのcompatibility dateは同梱runtime上限に合わせた `2026-08-13`。deploy dry-runは `2026-09-21` だが、同日runtimeの実検証はstaging gateに残る。
- recovery drill scriptは明示的 `--confirm-staging` がない限りdry-runであり、このrunでは実restoreを実行していない。
- Gallery 50,000 candidate とPROPFIND 1,000×20 propertyの実D1予算は、それぞれPhase 8A / Phase 7 transportとstagingで未検証。

## 次に着手すべき点

Phase 6 の share model / unlock / session-bound CSRF / content-session / BudgetDO route接続 / ticket / ZIP STOREを、private bundleとpublic-share bundleの分離から実装する。cross-owner copy HTTP admissionはshare operandとcurrent grantをcommit batchで再検査できるようになってから開く。

## 設計へのフィードバック

- `docs/DESIGN.md` v0.6 の `nodes` CHECK は non-root の `parent_id IS NULL` を常に禁止する一方、Brief §8 #5 は別 trash operation の既削除子をpurge時に `parent_id=NULL` とするよう要求する。§8を優先し、migrationはdeleted non-rootに限ってNULLを許可した。
- DESIGNのCSRF profileはone-time tokenと記載するが、Brief §8 #7のsession-bound HMAC・TTL 1h・再発行自由を優先した。
- DESIGN §6.2 はD1 upload stateに `uploading|aborting` を挙げる一方、Brief §8 #6は `created→receiving→completing` を正本とする。D1はBriefに従い、`aborting` はUploadDO internal stateだけに置いた。
- DESIGN §11.3 のControlDO喪失時下限は現在時刻を使う記述が残るが、Brief §8 #4は時刻下限を禁止しR2 epoch history最大値+1またはoperator `EPOCH_FLOOR`を要求する。実装はBriefに従った。
- Brief Phase 5完了条件のGallery 50,000 / PROPFIND 1,000×20は、phase表ではtransport本体がPhase 8A / 7にある。Phase 5では共通scope/search/statsのbounded SQLを実装し、実transport予算fixtureは各到達Phaseへ残した。
- 現行Workers runtimeでは`DigestStream`の実体は `crypto.DigestStream` にあり、型packageのglobal宣言とは配置が異なる。実装はruntimeの実体を明示的に使用する。
