あなたは Next-cloud-flare（Cloudflare 完結型セルフホストストレージ）の設計担当です。
`docs/DESIGN.md` (v0.1) に対して、レビュアー (GPT-6 Astra) から `docs/reviews/round1-astra.md` のレビューが届きました。

## 依頼: レビューを反映して `docs/DESIGN.md` を v0.2 に改訂する

- `docs/DESIGN.md` を**直接編集**してください（全面書き直し可。ただし日本語・Markdown・既存の章立ての流れは維持し、章番号は 0〜18 で振り直す。§18 を「未決事項 / 次ラウンドで検証する点」にする）。
- レビューの **全 Blocker (B-01〜B-15)・全 Major (M-01〜M-17)・全 Minor (m-01〜m-16)・「不足している機能」表・§17 回答・制限値表** を反映すること。反映漏れがないよう、最後に `docs/reviews/round1-resolution.md` を作成し、各指摘 ID ごとに「反映箇所（章番号）/ 採用・不採用・後段 / 一言」の表を書いてください。
- 設計判断は以下の **確定方針** に従ってください（レビューの修正案に沿ったもの）。これ以外で判断が必要な箇所はレビューの推奨に従い、迷う場合は「安全側・v1 では制限」を選び、§18 に列挙してください。

### 確定方針

1. **不変 blob と論理 node の分離**: `blobs(id, owner_id, r2_key, size, sha256_verified, content_etag, mime_sniffed, ref_count, created_at, state)`、R2 キーは `u/<ownerId>/b/<blobId>`。`nodes.current_blob_id`, `nodes.revision`（metadata revision、更新ごとに +1）。書き込みは「新 blob を新キーに書く → 実サイズ検証 → D1 で `UPDATE nodes SET current_blob_id=?, revision=revision+1 ... WHERE id=? AND revision=?`（期待 revision 条件）→ 影響行 0 なら 412/409 で失敗し新 blob は GC 候補」。旧 blob は `node_versions(node_id, blob_id, revision, created_at, created_by)` に残し、**内部世代保持**（既定: 直近 N=10 世代 or 30 日）。UI のバージョン履歴は後段（v1.1）だが内部保持は v1 で実装。
2. **Copy は copy-on-write**: 同一 owner space 内の COPY は新 node が同じ blob を参照し `ref_count+1`。owner をまたぐ copy も blob 参照でよい（blob は `owner_id` を保存側スペースにするため、跨ぎ copy は get→put で新 blob。v1 では跨ぎ copy=ストリームコピー）。GC は `ref_count=0` かつ猶予期間経過後。
3. **D1 が名前空間・参照・権限・状態の正本**、R2 は不変内容の正本。「D1 を失っても R2 から再構築できる」という記述は削除。代わりに: 日次 D1 エクスポート（`wrangler d1 export` 相当の JSON/SQL を R2 `_meta/backups/` に保存する Cron ジョブ）、Time Travel 復旧手順、**復旧モード中は GC 停止**（`settings.gc_paused`）。GC は「候補記録 → 猶予 7 日 → 再検証 → 削除」の台帳方式（`gc_candidates` テーブル）。全 R2 走査は週次の修復処理のみ。
4. **ルートノード**: ユーザーごとに実体の root node（`kind='root'`）。一般ノードは `parent_id NOT NULL`。UNIQUE は `(parent_id, name_ci) WHERE deleted_at IS NULL`（`name_ci` = 大文字小文字を畳んだ照合用列。名前は保存時 NFC、比較は case-insensitive = macOS 相当）。制約: 親は同 owner の folder/root かつ未削除、自身/子孫への MOVE 禁止、深さ ≤ 64、owner 跨ぎ MOVE は v1 禁止（copy+delete）。actor と owner を区別し、内部共有先への作成は「保存先スペースの owner」のクォータに計上。
5. **クォータ予約**: `users.reserved_bytes`、`uploads.reserved_bytes`。開始時 `used+reserved+new <= quota` を D1 の条件付き UPDATE（影響行 0 なら 507）で原子的に確保。各パート実サイズ検証、complete 時に宣言サイズと照合、予約の確定/解放は一度だけ（`uploads.state` で冪等化）。upload-only 共有には size/件数/合計/同時セッション上限。
6. **回収箱**: `trash_ops(id, actor_id, root_node_id, created_at, purge_after, state)`、`nodes.deleted_op_id`。削除時は同 op で未削除の子孫のみ `deleted_at/deleted_op_id` を付与（既に削除済みは触らない）。復元はその op に属するノードのみ、復元先が削除済/回収箱内/別 owner なら root 直下 or ユーザー選択。大きなツリーは root を先に不可視化し子孫処理は再開可能ジョブ。パージは manifest 方式で `shares`/`node_props`/`node_versions`/thumbs/blob 参照を順に処理し、`shares.node_id` は `ON DELETE CASCADE`。復元で共有は自動復活しない（`shares.disabled_reason='trashed'` を残し、明示操作で再有効化）。
7. **ロック**: `LockDO` の単位は **space（保存先 owner の user id）**。全書き込みは共通 `fsMutation` サービス経由（REST/WebDAV/upload complete/Queue consumer 全て）でロック検査 → 操作予約 → 期待 revision 付き確定。ロックは DO SQLite に永続化、期限は各リクエストで検査。ロックは URI（path）意味論で扱い、MOVE 元のロックは移動先へ引き継がない（RFC 4918）。read-only principal の write LOCK は拒否。`Depth: infinity`、未存在 URL への LOCK（lock-null → 空リソース作成）、Destination 側ロック、If: ヘッダの tagged/untagged/Not を仕様化。
8. **UploadDO 状態機械**: `initiating → active → completing → committed` / `active → aborting → aborted`、DO SQLite に session/parts/etag/size を永続化、同一 part の並行/再送制御、complete は操作 ID で冪等（完了済みなら同じ node/revision を返す）。R2 側の未完了 multipart は 24h 期限 + Cron abort を安全網に。期限は「最終進捗から 24h」（最大 7 日）。
9. **principal と権限表**: `user / app_password(scope) / link_share(capability) / service_token` を型分け。操作 × principal の許可表を章に追加。共有 token は capability（対象 root とその有効な子孫のみ、操作・期限限定）。upload-only は「新規受け取り」のみ（一覧・読み取り・上書き禁止）。content/thumb/preview/zip/children/upload complete の全経路で同一判定関数 `authorize(principal, node, action)` を通す。Access JWT が Bypass 経路に付いていても自動昇格しない。共有 Cookie は `share_id, share_version, exp, kid` を含め、パスワード/権限変更で `share_version` を進めて失効。
10. **公開 API パスと Bypass**: 公開 API は `/api/v1/public/*`、共有ページは `/s/*`、WebDAV は `/dav` と `/dav/*`。Access の Bypass はこの 3 prefix と `/.well-known/` の必要パスのみ。Hono・Access・Static Assets・CSRF・CORS で単一のルート表（`routes.ts`）を共有し、公開 prefix 配下の未知ルートは 404 で拒否（SPA/private にフォールスルーしない）。SPA シェルも `run_worker_first` で Worker 経由にし Access 必須（公開シェルは置かない）。`workers.dev` / preview URL は無効化、R2 public access / r2.dev 無効。デプロイ後の未認証スモークテストを CI に。
11. **CSRF / CSP**: Cookie ベース REST mutation = Origin 検証 + `X-Requested-With`。WebDAV = Cookie 認証なし（Basic のみ）、CORS 非公開、ブラウザ由来 Origin 付き要求は拒否。共有ページの SSR フォーム = CSRF token + Origin。CSP は surface 別（アプリ / 共有ランディング / 未信頼プレビュー iframe = sandbox + 別 origin）。生コンテンツは別ホスト `CONTENT_HOST`（例 `files.example.com`）から配信することを推奨構成とし、単一ホスト構成では attachment + nosniff + 厳格 CSP のフォールバックモードとする。
12. **サイズ制限**: `MAX_REQUEST_BYTES`（既定 95 MB = Free/Pro の 100 MB より余裕）、`MAX_PART_BYTES`（既定 64 MiB、設定 8〜90 MiB）、`MAX_FILE_BYTES`（既定 = partSize × 10,000 未満に丸め、v1 公称上限 500 GiB）。パート数は開始前に計算し 10,000 超は拒否。長さ不明ボディは v1 では 411 で拒否（REST/WebDAV 共通、`Content-Length` 必須）。MB/MiB を統一表記（HTTP 上限は MB、内部は MiB）。「Workers Paid で上限が上がる」記述は削除し、ゾーンプラン依存と明記。
13. **サムネイル**: Images binding 入力 ≤ 20 MB。WASM フォールバックは「≤ 8 MB かつ ≤ 12 MP（ヘッダから事前判定）」の画像のみ。超過/未対応/不正は `thumb.status='unsupported'|'failed'` で終了（無条件フォールバックしない）。Queue メッセージ `{jobId, nodeId, blobId, variant, generatorVersion}`、派生物キー `u/<ownerId>/t/<blobId>/<variant>-g<generatorVersion>.webp`、結果反映時に現在の `current_blob_id` を検証。D1 確定と同一 batch で `outbox` に記録し、dispatcher が Queue へ送信、pending 修復ジョブと DLQ 閲覧/再投入 API を用意。`thumb_status` は `status` と `source(server|client)` に分離、`dominant_color` 列追加。クライアント生成 thumb の POST は対象 node/blob の write 権限と世代を検証し、サーバで形式・寸法・サイズ検証（可能なら Images で再エンコード）。EXIF は派生物から除去。
14. **ZIP**: v1 は通常 ZIP の安全範囲（合計 < 4 GiB、単体 < 4 GiB、件数 ≤ 65,000）を開始前に検査し、超過は 413 + 分割案内。ZIP64 は §18 の後段課題。backpressure を尊重し、ZIP 内パスを正規化。
15. **Cron / ジョブ**: 曜日は `SUN` 表記、UTC 明記。KV mutex 廃止。`job_leases(job, holder, fence, expires_at)` を D1 条件付き UPDATE で取得、fencing token で旧実行を排除。全ジョブは cursor/checkpoint 付きで再開可能・冪等。予算（ノード数・blob 数・API 呼出数・時間）を分けて持ち、backlog/最古未処理/回収バイト数をメトリクス化。
16. **owner bootstrap**: `OWNER_EMAILS`（必須 vars）に一致する identity のみ初回に owner。未設定なら fail closed（全リクエスト 503）。`allow_signup` 既定 false（Access で許可されたドメインでも owner が招待/許可するまで 403）。owner 移譲、最後の owner 削除禁止。
17. **identity**: `users.access_sub`（iss+sub）を主キー相当、email は属性。別 sub の既存 email への自動紐づけ禁止。`users.disabled_at`。JWT は alg/iss/aud(配列可)/exp/nbf 検証、未知 kid で JWKS 再取得、失敗は fail closed。Service Token は `service_principals` テーブルで明示的にユーザー/スペース/scope に対応付け（v1 は任意機能）。
18. **KV パスキャッシュ**: mutation の権威にしない。パス解決は再帰 CTE 1 クエリ、キャッシュは読み取り専用かつ `space_generation` をキーに含める。認可とパス解決のキャッシュを分離。
19. **ETag**: ノード API の ETag = `revision`、content の ETag = blob の `content_etag`。WebDAV collection の getetag は `revision`。`If-Match`/`If-None-Match: *` 失敗は 412。
20. **アプリパスワード**: 32 byte CSPRNG、保存は `HMAC-SHA256(server_key, secret)`、timing-safe 比較、有効期限・端末名・scope(ro/rw, 任意でフォルダ限定)・最終使用（間引き記録）・全失効。共有パスワードは salt + バージョン付き KDF（PBKDF2-SHA256 反復は実測で決定、既定 300k）。安価なレート制限を先に、per-IP + per-share/per-credential、Rate Limiting binding は近似であると明記し、重要上限は DO で補完。
21. **検索**: `node_search(node_id, name_norm, name_bigram)` を別テーブルで持ち、FTS5 は `node_search` を external content とする。bigram で候補抽出 → `name_norm` で最終照合（順序検証）。1 文字は scope 限定 LIKE fallback。正規化: NFKC + casefold + かな統一（カタカナ→ひらがな）は検索用のみ。利用者入力を FTS クエリ言語として解釈しない（エスケープ）。共有スコープ検索は許可木に限定。
22. **名前**: `portable_names=true` 既定（Windows 予約名・末尾 `.`/空白・制御文字は拒否）。`.DS_Store`/`._*` は保存を許可（hidden フラグ、UI では非表示）。仮想 `Shared` は `/dav/Shared/` を予約 prefix とし、実フォルダ名 `Shared` は root 直下では作成禁止。内部共有のマウント名は `<share_id 短縮>-<name>` のように安定 ID 付き。
23. **共有仕様**: パスワード保護共有の未認証 OG/ランディングは汎用情報のみ。認証依存 JSON/HTML は `no-store`。共有 content/thumb は `private, max-age=300` 程度に短縮。download_count は「ダウンロードチケット発行数」と定義（ticket: share_id, share_version, blob_id/zip manifest, exp。Range/再試行は追加計上しない）。UI 表記も「最大ダウンロードセッション数」。
24. **クライアント再開/ハッシュ**: IndexedDB に session/fingerprint/parts、再読込後は File System Access API または再選択（同一性確認）。ハッシュは Web Worker 内の incremental WASM (hash-wasm)。`sha256_declared` と `sha256_verified` を分離し、未検証ハッシュを dedupe の根拠にしない。
25. **D1 バッチ**: バッチ境界は行数ではなく bind parameter ≤ 100/statement, SQL 長, 実行時間で決定。keyset cursor と索引一覧（`shares(grantee_user_id,node_id)`, `uploads(state,expires_at)`, `activity(node_id,ts)`, `nodes(parent_id,deleted_at,name_ci)`, `nodes(owner_id,deleted_at,updated_at)` など）を明記。D1 Sessions API は「書き込み直後/認可判定は primary」。
26. **監査/運用**: activity の脅威モデル明記（アカウント管理者は信頼境界内）、保持期間と R2 アーカイブ、ログマスキング対象一覧、CSV formula injection 対策、監視項目一覧、費用試算表（R2/D1/Images/DO/Queues の単価 × 想定量）。
27. **UI**: `starred`/`last_opened_at` は `user_node_state(user_id, node_id, starred, last_opened_at)` に移す。PWA はシェルのみキャッシュ。フォント/アバターの外部 CDN 取得禁止。名前衝突の置換/スキップ/別名 UX、bulk 操作の job ID/進捗/キャンセル、Idempotency-Key。
28. **Rate Limiting**: 正式な `ratelimits` 設定を使う（`unsafe.bindings` 不使用）。vars と secrets を分類（`ACCESS_AUD`/team domain は vars）。Images binding 有無で wrangler 環境を分ける。`DEV_BYPASS_ACCESS` が本番ビルドに混入したら CI/起動失敗。
29. **サポート表**: Web UI = multipart 大容量、通常 WebDAV = 1 リクエスト上限（95 MB）まで、CLI 大容量 = 専用 API クライアント（後段）、Nextcloud クライアント互換は非目標と明記。同期衝突: ETag 競合は 412、conflicted copy は作らない（クライアント責務）。mtime は `client_mtime` を別列で保持（`X-OC-Mtime` 互換ヘッダ受理）。
30. **不足機能表**: レビュー §4 の各項目に「v1 / v1.1 / 非目標」を割り当てて章に追加（チームフォルダ・グループ共有 = v1.1、通知 = v1.1（アプリ内のみ）、マルウェア検査 = 非目標（サイズ/形式上限のみ）、インポート/エクスポート = v1.1、フォルダ集計 = v1（非同期集計）、保存済み検索 = v1.1、データ所在地 = R2 jurisdiction 設定で対応、バックアップ = v1 の RPO 24h/RTO 手動）。
31. **テスト計画**: レビュー M-17 の障害境界テスト一覧をそのまま受け入れ試験に追加。実クラウド検証環境（staging）での実測項目を明記。
32. **実装フェーズ**: Foundation で認可表・操作状態機械・blob 世代・予約クォータを確定してから Files core。

## 出力

- `docs/DESIGN.md` を上書き（先頭を `# Next-cloud-flare — 設計・実装方針 (v0.2)` とし、ステータス行に「Astra ラウンド1 反映済み」と記載）。
- `docs/reviews/round1-resolution.md` を作成。
- 標準出力には、変更の要約（10 行以内）だけを出してください。
