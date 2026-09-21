# 実装ステータス

## 到達 Phase

Phase 8A（Gallery）完了。

Phase 0〜8A の実装を、各 Phase の lint / typecheck / unit・Workers integration test / build が通る状態で確定した。Phase 8B（Bookshelf）以降には未着手。

## 今回のコミット

- `ee2c48f` `feat: deliver secure sharing and bounded content`
- `54a4505` `feat: add fenced WebDAV access`
- `c6941d8` `feat: deliver fenced media gallery`
- `3dcd647` `fix: fence gallery cursor drift`

## Phase 0〜1 の確定事項

- D1 `changes()` 直後 barrier と `_assert` SQL error による batch rollback を採用し、G01 三反例で副作用ゼロを確認済み。EXISTS fallback は採用していない。
- statement error / 明示的 batch rejection は `rollback-confirmed`、network / timeout は `commit-unknown` に分類する。
- R2 known-length stream、single Range、`crypto.DigestStream`、STORE ZIP dry-run、slow consumer backpressure、cancel propagation、PBKDF2 100,000 回、Images 20,000,000 byte 境界を固定した。
- complete Foundation schema、ControlDO epoch history、LockDO permit、BudgetDO counter、session/credential fence、quota/ref/pin、operation/outbox/repair、folder create を実装済み。

## Phase 2〜5 の実装

- Cloudflare Access RS256/JWKS verifier、development loopback principal、immutable R2 content、Files create/overwrite/version/rename/MOVE/COW COPY、strong ETag、HEAD/single Rangeを実装した。
- single/multipart upload、UploadDO attempt/fence、cross-owner Queue copy、reservation/physical accounting、browser IndexedDB resumeを実装した。
- fixed trash membership、restore/purge、複数 pin 対応 GC、ControlDO maintenance/quiesce、recovery drillを実装した。
- HMAC signed keyset cursor、scope-aware bigram/substring search、external-content FTS同期、recent/starred/tag/statsを実装した。
- Web UI は dark/light、grid/list、breadcrumb、context menu、multi-select D&D MOVE、upload、Trash、検索 palette、容量 meterを提供する。

## Phase 6 の実装

- 期限・password・version・actionに束縛した link share、user share、upload-only share、shared-with-me、固定 mount aliasを実装した。
- session-bound HMAC CSRF、share unlock cookie、失効/ancestor trash fence、content ticket/session、BudgetDO request/byte/parallel会計を実装した。
- private/public content と single Range、exact-size STORE ZIP、manifest/pin/cancelを実装した。
- Web UI に共有 dialog、公開共有 page、folder browse/download、upload-only drop、「共有中」「自分と共有」を実装した。

## Phase 7 の実装

- `/dav` と `/dav/*` に app password ID をusernameとする HTTPS-only Basic認証を実装した。credential作成はPBKDF2-SHA256 100,000回 + environment pepper、既定90日・最大365日・20件/user、secret一度表示、label/list/revokeに対応する。
- OPTIONS / PROPFIND / PROPPATCH / MKCOL / GET / HEAD / PUT / DELETE / COPY / MOVE / LOCK / UNLOCKを実装した。
- empty/allprop/propname/prop PROPFIND、Depth 0/1、1,000 child preflight、live/dead property、mixed-content XML、numeric reference、DTD/entity/XInclude拒否、1MiB/depth32/elements/attributes/namespaces/property/value/response上限を実装した。
- tagged/untagged `If`、`Not`、AND-list/OR-list、全token submission収集、single Range、Destination same-origin、Depth/Overwrite、同期1,000 nodes/10GiB gateを実装した。
- Brief §8 #9どおり、Timeout既定600秒・上限3600秒、既存PUTのIf-Matchまたは有効lock token必須（欠落428）、file `"b-<blob>"` / collection `"c-<node>-<revision>"` ETagを実装した。
- LockDOでgrant/refresh/unlockとpermitを直列化し、creator user、credential/epoch、ancestor/depth/subtree token、lock-null empty resourceを検査する。COPY/MOVE Overwrite:Tはdestination trashとmutationを同じD1 batchに置く。
- `/dav/Shared/<mount>` の固定aliasをread-onlyで解決する。現行internal share action modelに`edit`がないためshared DAV mutationはfail closedとした。
- Web UI設定にapp password作成・label・期限・一度だけのsecret表示/copy・失効を実装した。

## Phase 8A の実装

- `GET /api/v1/nodes/:nodeId/gallery` とpublic share Gallery APIを実装した。folder/recursive、最大200件、署名keyset cursor、scope root/user/recursive/tree generation/view revision束縛、recursive 50,000 candidate gateを持つ。
- image/videoを現在blobとEffectiveLiveで列挙し、Queue consumerがcurrent blob・epoch・claim tokenを再検査して`node_media`へ幅/高さ/EXIF撮影日時・orientation・bounded camera情報だけを公開する。GPS/任意EXIF/埋込み原画像は保存しない。
- `media_jobs`をmutation同一batchのdurable outboxとして作り、最大3 attempt、claim expiry、saved principal、epoch、current blob、user有効性をfenceする。Queue duplicateと完了後再実行は冪等に収束する。
- Cloudflare Images bindingでsm256/md768を生成し、lg1600はlazy jobにした。transform前にvariant claimを取り、WebP・metadata除去・20MB/12,000px/40MP上限・immutable attempt key・stale publish拒否を実装した。
- development/testのHTTP thumbnailは元画像や別transformへfallbackせず、明示placeholderだけを返す。productionで未生成の場合だけQueueへenqueueする。
- public thumbnailはshare subtree/action/sessionとBudgetDOを通す。動画は既存content single Range経路でprivate/publicとも206再生する。
- Web UIに日付group、justified virtual layout、recursive切替、lazy page、Lightboxの前後移動/Escape/矢印/ズーム/wheel/スライドショー、video controls/Range URLを実装した。

## 検証結果

最終実行（local Workers runtime / Miniflare。実stagingではない）:

- `pnpm lint`: pass
- `pnpm typecheck`: pass（shared / web / worker）
- `pnpm test`: pass
  - unit: 21 files / 40 tests
  - Workers integration・schema・spike: 34 files / 68 tests
- `pnpm build`: pass
  - shared TypeScript build
  - web Vite production build
  - worker Wrangler dry-run build
- WebDAV integration: Basic credential、全Class 1/2 method、428/ETag/Timeout、PROPFIND/PROPPATCH rollback、LOCK/UNLOCK/lock-null、atomic Overwrite、Range、失効をMiniflareで確認した。
- Gallery integration: signed keyset/view drift、candidate gate縮小fixture、Queue claim/duplicate、fake Images binding metadata/derivative、local placeholder、public share BudgetDO、video RangeをMiniflareで確認した。
- 実Cloudflare Images codec/metadata除去、実D1 rows_read/duration、実DAV clientはstaging/release gateに残る。

## 未実装

- Phase 8B: Bookshelf、archive index、CBZ/PDF/EPUB sanitize、reader shell、reading state。
- Phase 8C: Audio metadata、track API、player、playback state。
- Phase 9: release gate、README/support matrix、監視・resource inventory、a11y/touch/低性能端末、staging/production運用演習。
- Access service principal HTTP automation adapter。Access user、app password、share credential HTTP adapterは実装済み。
- cross-owner copyのpublic/share HTTP admission。job coreは実装済みだがgrantのcommit時再検査経路は未提供。
- 実Cloudflare Access、D1/R2/KV/Queues/Cron/DO placement、Images、R2 incomplete multipart 7日 lifecycle、Time Travel / logical export restoreのstaging smoke。
- litmus/rclone/Finder/Explorer実client互換試験。local integrationはprotocol fixtureとHTTP requestのみ。
- 大規模trash/restore/purgeの複数 invocation chunk pipeline。現在は1 operation 1,000 nodesを上限にfail closedとする。
- exhaustiveなversion固定Unicode casefold table。portable file nameはFoundation-safe printable ASCIIに限定する。
- media metadataを含む検索document、Recent / Starred専用Web画面、public share bundle専用Gallery layout。

## 既知の欠陥・制約

- portable nameは安全なversion固定Unicode casefold実装が未承認のため printable ASCII subsetに限定している。
- JWKS refresh rate / single-flightはisolate内で強制しKVをcacheに使う。PoP横断refresh stormはstaging gateで検証が必要。
- migration rollbackはdestructive down migrationではなく、maintenance下のD1 snapshot/Time Travel restoreを前提とする。
- local integration runtimeのcompatibility dateは同梱runtime上限に合わせた`2026-08-13`。deploy dry-runは`2026-09-21`だが同日runtimeの実検証はstaging gateに残る。
- recovery drill scriptは明示的`--confirm-staging`がない限りdry-runであり、このrunでは実restoreを実行していない。
- Gallery 50,000 candidate、PROPFIND 1,000×20 propertyの実D1予算はlocal correctnessのみ。rows_read/duration gateはstaging未検証。
- app password production利用前に`APP_PASSWORD_PEPPER`を32文字以上のsecretとして設定する必要がある。development/testだけはlocal専用値を使う。
- upload時の`mime_sniffed`列は現行経路ではrequest Content-Type由来であり、独立magic-byte sniff pipelineは未実装。不正画像はImages jobがfail closedになるがGallery種別表示の精度は今後改善が必要。
- local Galleryは要件どおりImages fallbackを閉じてplaceholderを返すため、実thumbnail表示はstagingまたはproduction Images bindingでのみ確認できる。

## 次に着手すべき点

Phase 8Bのarchive indexから着手する。EOCD/central directory/local header/CRC/size/pathをbounded Rangeで検証し、CBZ page streamを確定してからPDF、EPUB sanitize、reader shell、reading stateの順に進める。

## 設計へのフィードバック

- `docs/DESIGN.md` v0.6 の`nodes` CHECKはnon-rootの`parent_id IS NULL`を常に禁止する一方、Brief §8 #5は別trash operationの既削除子をpurge時に`parent_id=NULL`とするよう要求する。§8を優先し、migrationはdeleted non-rootに限ってNULLを許可した。
- DESIGNのCSRF profileはone-time tokenと記載するが、Brief §8 #7のsession-bound HMAC・TTL 1h・再発行自由を優先した。
- DESIGN §6.2はD1 upload stateに`uploading|aborting`を挙げる一方、Brief §8 #6は`created→receiving→completing`を正本とする。D1はBriefに従い、`aborting`はUploadDO internal stateだけに置いた。
- DESIGN §11.3のControlDO喪失時下限は現在時刻を使う記述が残るが、Brief §8 #4は時刻下限を禁止しR2 epoch history最大値+1またはoperator`EPOCH_FLOOR`を要求する。実装はBriefに従った。
- Brief Phase 5完了条件のGallery 50,000 / PROPFIND 1,000×20は、phase表ではtransport本体がPhase 8A / 7にある。各到達Phaseでtransport fixtureを追加したが、実D1性能値はstaging gateに残る。
- 現行Workers runtimeでは`DigestStream`の実体は`crypto.DigestStream`にあり、型packageのglobal宣言とは配置が異なる。実装はruntimeの実体を明示的に使用する。
- DESIGN §7.3はlock recordをDO SQLiteへ保存すると記載する一方、Foundation schemaとLockDO permit判定はD1 `locks`を権威行として要求する。実装はgrant/refresh/unlock/permit直列化をLockDOへ集約し、永続行はD1に置いた。v0.7では権威storageを一方に統一する必要がある。
- DESIGN §7.3の「token hashだけ保存」と、PROPFIND `lockdiscovery`でcreatorへraw tokenを再表示する期待は両立しない。実装はraw tokenを初回LOCK responseとclient提出時だけ返し、後続PROPFINDではactive lock情報だけを返す。
- DESIGN route表の`/dav/*path`はHonoではcatch-allにならない。実装manifestは実framework表記の`/dav/*`を使う。設計上のtemplate表記とruntime router表記を分離して明記すべきである。
- DESIGN §9A.1は高度layoutをv1.1とする一方、今回の実装指示はvirtual justified/masonryをPhase 8A必須とした。今回指示を優先してjustified virtual layoutを実装した。
