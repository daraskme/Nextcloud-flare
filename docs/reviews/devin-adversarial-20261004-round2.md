# Devin 敵対的レビュー・検証 ラウンド2（2026-10-04）

対象: `main` `143f4ec`（PR #41 ラウンド1修正込み）。方法: 12 領域の並列敵対的レビュー（ワークフロー `wfr-29e3060750514bf09286c135ce4338dd`）→ 各候補をコード/一時テストで検証 → 実在した指摘を修正 + 回帰テスト。ラウンド1（H1-H4/M1-M6/L1-L2、`devin-adversarial-20261004.md` 参照）の指摘は再掲しない。

## PR #46 原版の検証結果

以下は原版の記録。PR #43〜#46を統合した候補の検証は末尾に区別して記録する。

- 対象実行: `adversarial-hardening.test.ts` 15 件・`audio-indexing.test.ts` 11 件・`dav-xml.test.ts`・`zip-download.test.ts` すべて緑。
- `pnpm check` 全緑: lint / tsc (worker+web+fault) / verify:contracts / verify:config / unit 1033 合格(8 skip) / integration 2425 合格（129 ファイル、expected disconnects=0、unhandled rejections=0）/ vite build+wrangler deploy --dry-run OK。

## 修正した指摘（検証済み）

### HIGH

**R2-H1. リシェア伝達（share_delegations）を持つゴミ箱サブツリーの purge が恒久的に失敗する**
`share_delegation_ancestry.node_id`/`parent_id` と `share_delegations.source_root_parent_id`/`delegated_root_parent_id` はいずれも `nodes(id)` への NOT NULL FK で、delegation 行は UPDATE 不可トリガ（0048）のため無効化で逃げられない。被共有者がリシェアしたフォルダをオーナーがゴミ箱に入れて purge すると、`nodes` 削除が FK で拒否され atomicBatch ごとロールバック — サブツリーは purge 不能のまま quota を占有し続ける。
修正: ancestry 経由でしか辿れない delegation 集合を先に新規スクラッチ表 `purge_share_ids`（migration 0064）へ実体化し、status→ancestry→delegations の FK 順で削除（同期 `purgeTrash.ts`・非同期 `treeJobWorker.ts` の両経路）。ancestry 削除後に `share_delegations` の検索条件を評価すると空振りするため、ID 集合の事前実体化が必須だった（初版はこの順序バグで `share_delegations` に残行）。

**R2-H2. user_audio_chapter_sets を持つノードの purge も同じく恒久的に失敗**
`user_audio_chapter_sets.node_id` は `nodes(id)` NOT NULL FK、`user_audio_chapters.set_id` は sets への CASCADE FK。チャプター付き音声ファイルを purge すると同様に FK で wedge。同じ変更で chapters→sets の順に削除。

### MEDIUM

**R2-M3. メンバー 1,001〜10,000 の trash op で listTrash が全体 404**
読み側は `memberCount > 1_000` で `trash_unavailable`（一覧全体が 404）だが、書き側の非同期 worker は `ASYNC_TREE_MAX_NODES`=10,000 までの op を実際に作る。1,001 件超のゴミ箱操作があると以後の一覧が恒久的に見えない。読み側 bound を `ASYNC_TREE_MAX_NODES` に揃えた。

**R2-M4. 暗号化上書きの share 祖先検査が parent 起点で target を見落とし**
`uploads/create.ts`/`uploads/complete.ts` の `privateAncestry`（link share root への暗号化ファイル混入を拒否する CTE）が `parent_id` 起点で祖先を辿るため、`targetId` 上書き時は対象ノード自身の祖先が調べられず、link share 直下のファイルへ暗号化上書きが素通りして公開 share が ciphertext を配信し続ける。バインドを `targetId ?? parentId` に修正（create/complete 双方）。

**R2-M5. 失効済み ZIP セッションが課金なしでフルパイプラインを実行**
`prepareZipSessionContent` の session SELECT に liveness 条件（`cs.revoked_at`/`cs.expires_at`/`t.cancelled_at`/`t.expires_at`）がなく、死んだセッションでも manifest GET + 各 entry の authorizeNode/HEAD/D1 write まで全部走ってから最終 assert で 404。WHERE に liveness 条件を追加し、計画段階で落とす（テストは R2 spy で R2 アクセス 0 を確認）。

**R2-M6. ZIP Range が DD/CD を跨ぐと対象 entry を全件フル取得するのに range.length しか課金されない**
`zipRangeSpans` が `needsCrc` の entry を非 ranged `bucket.get` で全読みする一方、reserve は `range.length` のみ（ラウンド1 M3 の残件）。`bytes=<cdStart>-` で ~76KB 課金で全 entry（最大 4GiB）の R2 fetch + CRC を踏める。PR #43 と統合し、lease は応答 byte と配信されない全量取得 byte の合計を reserve する。成功時の settle も同じ加算方式。HEAD・304・416 は blob を取得せず byte 課金は0。

**R2-M7. depth-infinity LOCK を作成者以外が外せず、受領者ロックがオーナーを飢餓させる**
`LockDO.#changeDavLock` の token 検査が `ap.user_id=creator` のみで、node/space オーナーの UNLOCK が `dav_lock_token_mismatch` で失敗する。share 受領者が mount ルートを Depth: infinity LOCK すると、オーナーは access 剥奪以外に回復手段がない。UNLOCK のみ space owner に `EXISTS(spaces.owner_id=?)` 経路を追加（refresh は作成者専用のまま、DO 経路のみで HTTP 権限面は不変）。

**R2-M8. `readNode` の `parentId` が share root の親を漏らす**
`readNodePath` は祖先を share root で打ち切るが、`readNode` は `parentId: proof.node.parent_id` を素で返すため、file-rooted share の受領者は共有範囲外の親フォルダ node id を取得できる。share 境界プリンシパルには親への `node.read` を再検査し、失格なら `parentId: null`。

**R2-M9. EPUB 配信が応答 byte だけ課金し、実コスト（index 再読+全 inflate）は無料**
`streamBudgetedEpubSelection` は `bytes=responseBytes(range)` で reserve するが、毎リクエスト index 全体を再 fetch し GET は entry を全 inflate してから range を切る。lease は `max(responseBytes, fetchBytes)` で reserve するよう変更: byte 応答（GET/Range）は `entry.compressedSize`（全 inflate コスト）、HEAD は `row.indexBytes`（index 再読コスト）を下回らない。zip と同じく settle にも同じ下駄を掛ける。

2026-10-05の追加ソース確認で、この時点ではindexを予約前に読んでおり、無効entryや上限到達後の要求にREQUEST_LIMIT=1024が効かないことを確認した。現在はindexBytesを先に予約・精算し、有効entryでは追加byteが0でも本文leaseを取得する。合計は`max(indexBytes,responseBytes,compressedEntryBytes)`、成功2 request・無効entry1 request。最初の期限を引き継ぐ。索引と本文の加算課金は行わず、認可用target manifestの予約前読出は残る。境界と検証は[CONTENT_LEASES](../CONTENT_LEASES.md)を参照。

**R2-M10. `node.copy`/`dav.copy` 由来の `node.created` が音声 indexing をスキップ**
`consumeOutbox.isAudioEvent` の `node.created` 許可 op が `dav.put`/`upload.complete` のみで、コピーされた音声ファイルは `node_audio` に載らずチャプター/書誌抽出が起きない。`node.copy`/`dav.copy` を追加（video/image projection は op フィルタなしで既に動作）。共有 blob を再利用するコピーの indexing は同一 R2 オブジェクトを参照して動く（回帰テスト追加）。フォルダ配下のコピーは `node.created` がルート 1 件のみで配下を網羅しない既知の制限として記録。

**R2-M11. XML 1.0 非合法文字を PROPPATCH/LOCK が受理し 207 multistatus に生埋め込み**
`decodeEntities` が 0x01-0x08/0x0B/0x0C/0x0E-0x1F/U+FFFE/U+FFFF 等を受理し、`escapeXml` を素通りして `node_props.value_xml`・`locks.owner_text` に保存、`deadProperty`/`activeLockValue` が生バイトで emit → 当該ノードへの PROPFIND が strict parser でパース不能（共有 edit 受領者がオーナーの DAV listing を破壊できる）。`decodeEntities` で XML 1.0 合法範囲（0x9,0xA,0xD,0x20-0xD7FF,0xE000-0xFFFD,0x10000-0x10FFFF）外を `invalid_dav_xml` で拒否。

### 設計上の指摘（記録のみ・今回は非修正）

**tree job DoS（jobs-dos A1）**: 任意の通常書き込み admission が進行中の非同期 tree job の lease を確定的に殺す。busy space では実質 livelock 化しうるが、tree job の retry/再 claim 設計上の振る舞いで、安全性違反ではない。恒久対策には admission と job lease の調停設計が要るため今回は修正対象外。

## LOW（確認済み・今回は非修正）

- `readShareSession` が `ss.user_id` の disabled チェックを持たない（同種経路は持つ）。現在 user_id は書き込み経路なしの dead column のため実害は将来条件付き。
- `ensureContentBudget` が複数 share_group 所属時に recipientVersion を非決定的に選択 → 予算 id が複数並立し得る。
- link share の ticket 発行レート bucket が全 visitor 共有 → 1 人の荒らしで他者 429。
- in-flight blob stream は権限の再検査なし（zip は 1 秒ポーリングあり）。
- >1,000 子要素フォルダが WebDAV PROPFIND で閲覧不能（書き込み側の cap なし）。
- 非完了 backup run が prune されず R2 エクスポート残骸が残る。
- delegated share が invalidate されるとオーナーの一覧・管理対象から落ちる。
- dead-prop 書き込み上限（~1MB/ノード）が PROPFIND 応答上限（32MiB）と非対称 — ~32 兄弟ノードで Depth:1 listing が 503。ドキュメントの per-user 100k cap 未実装。
- If-header セマンティクス条件が PUT/MKCOL/PROPPATCH/LOCK で commit 時再評価されない（DELETE/MOVE/COPY は atomic）。他リソースタグ前提条件の TOCTOU。
- PROPPATCH `DAV:displayname` が黙って no-op（live property に shadow）— rename 成功の誤解。
- read-only share からの COPY が不可能（source share 側 gate が canCreate を要求、destination 解析前）。
- DAV 経路で `%`+2hex 桁を含む名前・raw `,` の Destination が拒否される UI 非対称。
- UNLOCK/LOCK のエラーマッピングが missing-node と authz 拒否を 503 に潰す。
- audio projection で `authorization_denied` が swallow されて有効ファイルでも無音スキップ。
- rename/move は search_index の name のみ更新し ID3 メタが FTS から落ちる。
- `multipart complete()` の一度限りの dispatch が一時的 R2 失敗で ~24h 'completing' wedge + reservation 保持（保守的設計と思われる）。
- resumable upload の fingerprint は先頭+末尾 64KiB のみ → 中間改変が同一 fingerprint で splice commit（FILES_UI.md は既に免責）。

## 棄却した候補（誤検知）

- purge の `delegationBinds` 個数疑義: `members` は `IN (SELECT ... purge_op_id=?)` のサブクエリで 1 bind/箇所 — 正しかった。実際のバグは削除順序（上記 R2-H1 修正で発見・同時修正）。
- LockDO の `lock_recovery_required` は回復ハンドシェーク仕様で意図通り（テスト側の fixture 不備だった）。
- video/image の copy 未索引: 当該投影は op フィルタなしで動作済み — audio のみのギャップに限定。
- `share_delegation_status` に残行が残るとの見立て: status/ancestry は削除済みで、残ったのは `share_delegations`（削除側述語が ancestry 削除後に空振りする設計ミス — 修正済み）。

## PR 統合時の追加修正（2026-10-05）

- PR #43 の ZIP 加算課金と、PR #44 の DAV 条件・音声チャプター削除、PR #45 の利用者別 admission 上限を統合。章データの削除は二重登録せず、同期処理の step 数も一致させる。
- PR #45 が `0063_admission_principal_fairness.sql` を追加するため、purge の migration は未配備の段階で `0064_purge_share_ids.sql` へ採番し直した。
- 再共有されたノードを元のフォルダー外へ移動してから元のフォルダーを purge すると、delegation の削除によって失効した share が通常の share として再び有効になる不具合を追加発見。削除対象の delegation とその子孫の share を先に同じ transaction で無効化する。移動先のファイル自体は保持する。
- この再共有の回帰テストは同期と 1,001 件以上の非同期処理の両方を実行し、原版では失敗、修正版では成功することを確認した。
- ZIP の Range 付き HEAD は本文・R2 の元 blob 読み出し・バイト課金がすべて0であることを回帰テストに追加した。
- Cloudflare staging とローカル週次バックアップ runtime はこの PR 対応では更新していない。配備状態は [ENVIRONMENT_STATUS](../ENVIRONMENT_STATUS.md) を参照。
- PR #45 の Windows run `37218158062` で KDF settlement 応答喪失のテストが5秒の開始期限に達して失敗した。同一 head の別 run は成功していた。専用 DO と durable storage の初期化を期限の生成前に行うようテストを調整し、実 PBKDF2・応答喪失注入・実行1回の検査を維持した。アプリの5秒制限は変更していない。
- ローカルの schema / backup-generation は116件成功。追加の purge 回帰は2件、KDF の対象ケースは1件成功。lint・Worker / Web / fault の型検査・contracts・configも成功。統合後の全件結果は対象commitのCIで確認する。
- 統合候補 `c23eef9` のCIは、push/PR両方でUbuntu・Windows第2系統・browser・backupが成功。Ubuntuは単体1,034成功・8 skip、通常結合131 files / 2,452件と別実行のR2試験1件が成功し、未処理Promiseは0件。Windows第1系統は成功したsuiteを処理し続けたまま、両run（`37220099398` / `37220102707`）で30分のjob上限に達して中断した。Windowsのjob上限を40分へ変更し、個別テストとアプリの期限を維持して再検証する。
