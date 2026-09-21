# 実装ステータス

## 到達 Phase

Phase 8C（Audio）完了。

Phase 0〜8C の実装を、各 Phase の lint / typecheck / unit・Workers integration test / build が通る状態で確定した。今回の run では E2E 指摘9項目を閉じ、Phase 8B（Bookshelf）と Phase 8C（Audio）を追加した。

## 今回のコミット

- `ee2c48f` `feat: deliver secure sharing and bounded content`
- `54a4505` `feat: add fenced WebDAV access`
- `c6941d8` `feat: deliver fenced media gallery`
- `3dcd647` `fix: fence gallery cursor drift`
- `d5f54e5` `fix: close E2E upload and public UI gaps`
- `b6959c2` `feat: deliver fenced Bookshelf readers`
- `ee15beb` `feat: add bounded audio library playback`

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

## E2E 指摘の修正

- portable nameをNFC・制御文字/区切り/colon/先頭末尾space・dot/Windows予約名/UTF-8 255 bytesで検証し、日本語・空白・絵文字をFiles/upload/WebDAVで受理する。`..`/path traversalは`invalid_name`を返す。
- upload completeの`name_conflict`に`existingNodeId/revision`を返し、UIで新version上書き・自動rename・skipを選択できる。version一覧とCAS付き復元API/UIを追加した。
- restore後の旧`trash_members` FKが再trash→purgeを妨げる原因を修正し、current operation fenceを維持した回帰testを追加した。
- Web UIを`--fg/--fg-muted/--bg/--surface/--border/--accent`中心のsemantic themeへ移行し、日本語既定・英語fallback辞書、adaptive容量表示、使用率bar、無効化済み共有badgeを実装した。
- Viteは`/s`・`/api`・`/dav`をWorkerへproxyする。public shellはprivate appと別entryで、development principalをpublic routeに適用しない。password/期限切れ/無効化/匿名shell integrationを追加した。
- Wrangler 4.71.0同梱workerdに合わせ`compatibility_date=2026-03-01`へ固定し、dry-run warningがないことを確認した。

## Phase 8B の実装

- `0008_bookshelf.sql`で`library_roots/library_items/archive_index/user_reading_state/library_jobs`を拡張し、upload mutation同一batchのdurable job、saved principal、epoch/current blob/claim fenceを実装した。
- ZIP/CBZはR2 RangeでEOCD最大1MiB・central directory最大8MiB・local headerを読み、stored/deflate、offset overflow、暗号化/data descriptor/unsupported method、危険path、entry/圧縮率/展開量、CRCを検査する。CBR/RAR/7zは`unsupported_format`で閉じる。
- archive indexはD1 page rowとimmutable R2 manifestへ保存し、`GET /api/v1/library/items/:itemId/pages/:page`でpage単位配信する。public share pageもsubtree/session/BudgetDOを通す。
- EPUBはQueueでXHTMLをtext-onlyの安全な派生XHTMLへ変換し、immutable keyへ保存する。trusted reader shellとpublication sandboxを分離し、inner CSP、TOC、coarse CFI、theme/font-sizeを提供する。
- coverをImagesでmetadata除去WebPへ変換し、reading stateを`(user,node,blob)`へ束縛した。本棚grid、series/tag、続きから読む、単ページ/見開き、RTL、keyboard/swipe readerを実装した。PDFはoriginal contentをbrowser readerで表示する。

## Phase 8C の実装

- `0009_audio.sql`で`node_audio`のtrack/disc/bitrate/coverと`audio_jobs`を追加し、upload mutation同一batchのdurable job、最大3 attempt、saved principal、epoch/current blob/claim fenceを実装した。
- head最大2MiB、通常tail 128B、MP4 moov window最大4MiBのR2 RangeだけからMP3 ID3v2、FLAC STREAMINFO/Vorbis/Picture、OGG Vorbis/Opus、M4A/MP4 atoms、WAV fmt/INFOを抽出する。fieldとcoverをboundedにし、coverはImagesでWebP化する。
- `GET /api/v1/nodes/:nodeId/tracks`をfolder=album、最大2,000 tracksとして実装し、disc/track順、title/artist/album/duration/codec/bitrate/cover/再生位置を返す。public tracks/cover/content Rangeもshare capabilityとBudgetDOを通す。
- Web UIにalbum/folder view、basic queue、前後/再生停止/volume、SPA遷移中も常駐するmini-player、MediaSession、Range URL再生、10秒間隔とpause/end時のblob-bound位置保存を実装した。

## 検証結果

最終実行（local Workers runtime / Miniflare。実stagingではない）:

- `pnpm lint`: pass
- `pnpm typecheck`: pass（shared / web / worker）
- `pnpm test`: pass
  - unit: 25 files / 74 tests
  - Workers integration・schema・spike: 38 files / 82 tests
- `pnpm build`: pass
  - shared TypeScript build
  - web Vite production build
  - worker Wrangler dry-run build
- WebDAV integration: Basic credential、全Class 1/2 method、428/ETag/Timeout、PROPFIND/PROPPATCH rollback、LOCK/UNLOCK/lock-null、atomic Overwrite、Range、失効をMiniflareで確認した。
- Gallery integration: signed keyset/view drift、candidate gate縮小fixture、Queue claim/duplicate、fake Images binding metadata/derivative、local placeholder、public share BudgetDO、video RangeをMiniflareで確認した。
- Bookshelf integration: upload同一batch job、stored/deflate、natural page順、Range index/local header/CRC、cover、reading state、public share budget、EPUB sanitize/CSP、PDF、path traversal/zip bomb/RAR拒否をMiniflareで確認した。
- Audio unit/integration: MP3/FLAC/OGG・Opus/M4A・MP4/WAV parser、upload同一batch job、cover、album tracks、blob-bound位置、private/public Rangeを確認した。
- 実Cloudflare Images codec/metadata除去、実D1 rows_read/duration、実DAV client、browser別EPUB/PDF/audio MediaSessionはstaging/release gateに残る。

## ブラウザ E2E 第2ラウンドの修正（Phase 9 準備）

ローカル（Vite 5173 + Worker 8787、dev principal）で実施した2回目のブラウザ E2E の指摘に対する修正:

- `1c5afa8` Vite dev proxy を `^/s(?:/|$)` 等に固定し `/src` が `/s` に吸われる問題を修正。`cc27aea` で `/c` `/public-assets` `/reader` `/reader-assets` も Worker へ proxy。
- `cf3cd88` handler の無い `library/:nodeId` 系 route が `/library/roots` を遮蔽していた問題を manifest から除去し、contract test で「handled literal route を deferred param route が遮蔽しない」ことを固定。
- `ddead8f` blob commit 時に先頭 64B から MIME を sniff（PNG/JPEG/GIF/WebP/PDF/FLAC/MP3/OGG/MP4/ZIP/EPUB/RAR/7z 等）。ブラウザ宣言 MIME は passive 型のみ fallback として採用。file create/overwrite 後に library/audio job を Queue へ dispatch（development では Images binding が無いため media-extract は dispatch しない。test では dispatch しない）。DAV XML parser が標準 `<?xml ...?>` 宣言を受理（DTD/ENTITY/XInclude は引き続き 400）。`GET /` と `/assets/:asset` を Worker の明示 handler にし、Wrangler assets の SPA fallback (`not_found_handling`) を無効化。
- `2d4de3f` 画像/PDF/テキスト/音声/動画のアプリ内 PreviewDialog（ダブルクリックで開く、Esc/overlay で閉じる、新規タブ/ダウンロード）。狭幅（<lg）向けの top bar + drawer（Upload/検索/セクション nav）。同一不正名の再送で operations の request digest が衝突し `name_conflict` と誤表示される問題を、明示 idempotency key が無い場合は operation 毎 nonce、未開始 claim の revoke 時削除、`duplicate_request` への map で修正。
- `cc27aea` Gallery を Files で最後に開いたフォルダにスコープ（header にパス表示）。
- `0abec6c` public-share / reader を single-entry の自己完結 bundle として別 build（`vite build --mode public-share|reader`）。以前は i18n chunk が `/assets/*`（auth: access）に共有され、public landing が本番でも Access 越しに壊れる構成だった。
- share session / content session cookie の `__Host-` prefix を `ENVIRONMENT=development` かつ `APP_ORIGIN` が `http://` のときだけ外す（`auth/cookies.ts`）。Chrome は plain http（localhost 含む）で `__Host-` cookie を `InvalidPrefix` として破棄するため、local dev では正しいパスワードで unlock 200 の直後に GET が 401 になっていた。`Secure`/`HttpOnly`/`SameSite` 属性と production の名前は変更していない。

## 未実装

- Phase 9: release gate、README/support matrix、監視・resource inventory、a11y/touch/低性能端末、staging/production運用演習。
- Bookshelfのfolder-images corpus、pdf.js固定asset/pagination、EPUBの完全なOPF spine/NCX/nav/標準CFI round-trip。現行はCBZ/EPUBの明示要件、browser PDF表示、entry単位coarse CFIを提供する。
- Access service principal HTTP automation adapter。Access user、app password、share credential HTTP adapterは実装済み。
- cross-owner copyのpublic/share HTTP admission。job coreは実装済みだがgrantのcommit時再検査経路は未提供。
- 実Cloudflare Access、D1/R2/KV/Queues/Cron/DO placement、Images、R2 incomplete multipart 7日 lifecycle、Time Travel / logical export restoreのstaging smoke。
- litmus/rclone/Finder/Explorer実client互換試験。local integrationはprotocol fixtureとHTTP requestのみ。
- 大規模trash/restore/purgeの複数 invocation chunk pipeline。現在は1 operation 1,000 nodesを上限にfail closedとする。
- exhaustiveなversion固定Unicode casefold table。現行はruntime Unicodeの`toLowerCase()+NFC`をportable uniqueness keyに使う。
- media metadataを含む検索document、Recent / Starred専用Web画面、public share bundle専用Gallery layout。

## 既知の欠陥・制約

- portable nameはUnicode NFCを受理するが、casefoldはruntime Unicodeの`toLowerCase()`に依存する。version固定full casefold tableは未実装である。
- JWKS refresh rate / single-flightはisolate内で強制しKVをcacheに使う。PoP横断refresh stormはstaging gateで検証が必要。
- migration rollbackはdestructive down migrationではなく、maintenance下のD1 snapshot/Time Travel restoreを前提とする。
- local integrationとdeploy dry-runの`compatibility_date`はWrangler 4.71.0同梱workerdに合わせ`2026-03-01`へ統一した。新しいruntime dateへの更新はdependency更新時に別途検証する。
- recovery drill scriptは明示的`--confirm-staging`がない限りdry-runであり、このrunでは実restoreを実行していない。
- Gallery 50,000 candidate、PROPFIND 1,000×20 propertyの実D1予算はlocal correctnessのみ。rows_read/duration gateはstaging未検証。
- app password production利用前に`APP_PASSWORD_PEPPER`を32文字以上のsecretとして設定する必要がある。development/testだけはlocal専用値を使う。
- `mime_sniffed`は先頭64Bのmagic-byte判定で、判定不能時のみpassiveなブラウザ宣言MIMEにfallbackする。EPUB判定は`mimetype`が先頭entryで無圧縮という標準layoutを前提とし、それ以外のEPUBは`application/zip`になる（Bookshelfはentry走査で別途判定する）。
- Starred / Tags のUI操作（context menu・Details）は未提供。
- WebDAV: 削除直後の同名collection再作成はtrash中のnodeと衝突し409を返す。別名か回収箱からの完全削除後は成功する。
- Audio: 前トラック終了後のqueue遷移でUIがPause表示のまま再生位置0で停止するケースがある。ネストしたフォルダ内のalbumがalbum pickerに現れない。MP3 durationのbounded推定はffprobeと数秒ずれる。
- local devでは`/s/*`のpublic shellから同一originの`/api/v1/me`を叩くとdev principalで200になる。これはloopback限定のdev bypassの副作用で、productionではAccessが`/api/v1/me`をgateする。
- local Galleryは要件どおりImages fallbackを閉じてplaceholderを返すため、実thumbnail表示はstagingまたはproduction Images bindingでのみ確認できる。
- EPUB sanitizerは安全側のtext-only XHTMLを生成するため、publication由来の複雑なlayout/CSS/画像埋込みは保持しない。完全なOPF spine/nav/CFIはPhase 9以降のbrowser gateに残る。
- MP3 durationは先頭MPEG frameのbitrateからのbounded推定で、VBR精密durationは未提供。OGG durationはtail 128B内に最終page headerがない場合nullになる。

## 次に着手すべき点

Phase 9のrelease gateへ進む。実Cloudflare bindingsでQueue/Images/Range/Cookie/CORS、browser別reader/audio、large archive/D1 budget、WebDAV実client、backup/restore、a11y/touch/低性能端末を検証し、support matrixと運用手順を確定する。

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
- DESIGN §3.3は`.DS_Store`/`._*`をhiddenで保存可とする一方、今回の明示指示は先頭dotを禁止する。今回指示を優先して先頭dotを`invalid_name`にしたため、v0.7でhidden例外の扱いを再確定する必要がある。
- Foundationのmedia placeholder tableはPhase 8B/8Cで必要なstatus/job/offset/order/cover列を持たなかったため、破壊的再作成ではなく`0008_bookshelf.sql`/`0009_audio.sql`の追加migrationで拡張した。
- DESIGN §9A.2の標準CFI round-trip/PDF pdf.js/folder-images全対応は今回の明示bulletを超える。現行実装はentry単位coarse CFI、browser PDF、CBZ/EPUBを安全側の提供範囲とし、未合格部分をsupport matrixへ載せない。
