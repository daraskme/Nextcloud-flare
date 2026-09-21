# 機能追加要求: ギャラリーと本棚（v0.4 で設計に追加）

ユーザー要求（原文要旨）: 大量の画像をギャラリーとして見れる機能。電子書籍・同人誌の保存も想定しており、EPUB だけでなく画像ファイルの圧縮アーカイブ (ZIP/CBZ など) をいい感じに閲覧できる「本棚」機能が欲しい。

以下を v1 要件として `docs/DESIGN.md` に章として追加すること（既存の不変条件 — 不変 blob、fsMutation、authorize、制限表、outbox 付き Queue、CONTENT_HOST 分離 — に従う）。

## A. ギャラリー (Gallery)

- 対象: 任意フォルダ（再帰オプション付き）内の画像・動画ノード。
- `node_media(node_id, blob_id, width, height, taken_at, duration_ms, orientation, dominant_color, camera_make/model は任意)` を D1 に持ち、サムネイル生成 job（既存の Queue）で EXIF/ヘッダから抽出。GPS 等の機微 EXIF は保存しない。
- サムネイル variant: `sm`(256px)、`md`(768px)、`lg`(1600px, Lightbox 用)。`lg` は初回要求時に lazy 生成（同一 blob×variant は 1 回のみ、費用冪等ルールに従う）。
- API: `GET /api/v1/nodes/:id/gallery?recursive=1&cursor=&sort=taken_at|name|updated_at` → keyset cursor、1 ページ 200 件、`node_media` を JOIN して幅・高さ・dominant_color を返す（レイアウト先行描画用）。
- UI: justified/masonry レイアウトの仮想スクロール、日付（taken_at）グルーピングとタイムラインスクラバー、Lightbox（前後 2 枚プリフェッチ、ピンチズーム、キーボード、スライドショー、動画インライン再生 Range）、選択→ダウンロード/共有/削除/移動、EXIF 情報パネル。
- 共有: フォルダ共有リンクの共有ページでもギャラリー表示を提供（capability の範囲内、同じ API を `/api/v1/public/shares/:token/gallery` で公開）。
- 上限: 1 ギャラリー要求 ≤ 200 件、再帰は深さ ≤ 64 かつ候補ノード ≤ 50,000（超過時はフォルダ単位に案内）。

## B. 本棚 (Bookshelf / Library)

### 対象フォーマット (v1)

| 形式 | 扱い |
|---|---|
| EPUB (.epub) | ZIP コンテナとしてサーバ側でエントリ索引化。本文はクライアント（sandbox iframe, CONTENT_HOST）でレンダリング。 |
| 画像アーカイブ ZIP / CBZ | サーバ側でエントリ索引化し、ページ単位に配信。stored / deflate のみ対応、他の圧縮方式は `unsupported`。 |
| PDF | pdf.js によるクライアント描画（既存プレビューを利用）。表紙はクライアント生成 thumb。 |
| CBR / RAR / 7z | v1 非対応（`unsupported` 表示、v1.1 でクライアント側 WASM 展開を検討）。 |
| フォルダ（画像の並び） | 「フォルダを本として開く」を許可（索引はフォルダ一覧そのもの）。 |

### データモデル

- `library_items(id, node_id UNIQUE, blob_id, format, title, authors, series, volume, publisher, language, page_count, cover_thumb_key, index_state ∈ {pending, ready, failed, unsupported}, index_key, created_at, updated_at)`。
- メタデータ抽出: EPUB は OPF (`dc:title/dc:creator/...`)、CBZ は `ComicInfo.xml` があれば採用、なければファイル名/親フォルダ名からの推定（`[Author] Title 第01巻` 等のパターン）。ユーザー編集可（`library_items` は編集で `revision` を持つ）。
- `user_reading_state(user_id, node_id, position TEXT, page INTEGER, percent REAL, updated_at)`: 読書位置（EPUB は CFI、画像アーカイブはページ番号）。書き込みは間引き（クライアントが 5 秒デバウンス）。
- タグ: `tags(id, owner_id, name)`, `node_tags(node_id, tag_id)`（本棚に限らず汎用）。本棚ビューは「シリーズ / 著者 / タグ / 未読・読書中・読了」で絞り込み。

### アーカイブ索引とページ配信

- 索引化 job（Queue、`{jobId, nodeId, blobId, generatorVersion}`）: R2 Range GET で ZIP 末尾（EOCD / ZIP64 EOCD、最大 1 MiB + central directory）だけを読み、central directory を解析して `archive_index` JSON を R2 `u/<ownerId>/x/<blobId>/index-g<gen>.json` に保存（D1 には件数と状態のみ）。エントリ: `path(正規化済み), method, compressed_size, uncompressed_size, local_header_offset, crc32, is_image, is_dir`。ページ順は自然順ソート（数字を数値比較）、画像 MIME ホワイトリスト（jpeg/png/webp/gif/avif）のみをページとして採用。
- 上限（zip bomb / コスト対策）: エントリ数 ≤ 10,000、単一エントリ uncompressed ≤ 64 MiB、合計 uncompressed ≤ 8 GiB、central directory ≤ 8 MiB。超過は `unsupported`。パスは `..`/絶対パス/制御文字を拒否・正規化。
- ページ配信 `GET /api/v1/library/:nodeId/pages/:n` (および `/entries/*path` は EPUB 用): 索引から local header を Range GET（30 byte + name/extra）→ データ本体を Range GET → stored はそのまま、deflate は `DecompressionStream('deflate-raw')` で展開してストリーミング応答。`Content-Type` は索引時に判定した画像 MIME、`X-Content-Type-Options: nosniff`、`Content-Disposition: inline`（CONTENT_HOST 経由）。EPUB の XHTML/CSS は CONTENT_HOST の sandbox iframe 内のみで表示し、スクリプトは CSP で禁止。
- ページサムネイル: `GET /api/v1/library/:nodeId/pages/:n/thumb` は展開後の画像を Images binding で 256px に変換して R2 `u/<ownerId>/x/<blobId>/p/<n>-sm-g<gen>.webp` に lazy 保存（1 本あたり並行生成 ≤ 4、1 ページ 1 回のみ）。表紙 = 最初の画像ページ（ComicInfo の cover 指定があれば優先）。
- 認可: `library_items` は node の read 権限に従う（authorize(principal, node, 'read')）。共有リンク経由でも同じ API を `public/shares/:token/library/...` で提供（capability 範囲内）。読書位置は認証ユーザーのみ保存。
- 費用: 1 ページ表示 = R2 Class B ×2（header + data）。索引 JSON はブラウザにキャッシュ（`private, max-age=3600`, ETag = index_key）。

### リーダー UI

- 画像リーダー: 単ページ / 見開き（右開き・左開き切替、日本語コミック既定は右開き）/ 縦スクロール、ページ送りキーボード・スワイプ、前後 3 ページプリフェッチ、フィット（幅/高さ/原寸）、ページサムネイル一覧、読書位置の自動保存・復帰、フルスクリーン。
- EPUB リーダー: 目次、ページネーション/スクロール、フォントサイズ・行間・テーマ（ダーク/セピア）、縦書き (`writing-mode: vertical-rl`) の尊重、CFI ベースの位置保存。
- 本棚ビュー: 表紙グリッド（`dominant_color` プレースホルダ）、シリーズをまとめて表示、続き（読書中）棚、未読棚、並び替え（追加日/タイトル/著者/最終読書）、フォルダを「本棚として登録」する操作（`library_roots(user_id, node_id)`）。登録フォルダ配下に追加された対応形式のファイルは自動的に `library_items` 候補（索引 job を outbox 経由で投入）。

### 非目標 (v1)

- OCR、本文全文検索、DRM 付き EPUB、RAR/7z、サーバ側での EPUB→画像変換、外部メタデータ DB との照合。

## C. オーディオライブラリ (ASMR / 音声作品)

ユーザー要求: ASMR 音声作品も保存するので、トラックのタイトル等が表示されること。

### データモデル

- `node_audio(node_id, blob_id, title, artist, album, album_artist, track_no, disc_no, duration_ms, codec, bitrate, sample_rate, has_cover, cover_thumb_key, lyrics_present, tag_state ∈ {pending, ready, failed, unsupported}, generator_version)`。
- タグ抽出 job（Queue、`{jobId, nodeId, blobId, generatorVersion}`、outbox 経由）: R2 Range GET で **ファイル先頭 (ID3v2 ヘッダ + フレーム、最大 2 MiB) と末尾 (ID3v1 128 byte / MP4 の moov が末尾の場合)** のみ読む。対応: MP3 (ID3v2.3/2.4, ID3v1)、FLAC (Vorbis comment + PICTURE)、OGG/Opus (Vorbis comment)、M4A/MP4 (ilst atoms、moov ≤ 4 MiB)、WAV (INFO chunk、duration はヘッダから)。タグは UTF-8 に正規化、長さ上限 1 KB/フィールド。全体を読まない（duration は ヘッダ / Xing / stream info から推定し、不明なら `null`）。
- 埋め込みジャケット (APIC / PICTURE / covr) は ≤ 20 MB を Images binding で `sm/md` に変換して `u/<ownerId>/t/<blobId>/cover-<variant>-g<gen>.webp` に保存。無ければ同フォルダの `cover.jpg|folder.jpg|*.jpg（1 枚のみ）` を「アルバムアート候補」として UI 側で利用（`node_media` 経由）。
- 作品（アルバム）単位: 明示テーブルは持たず、**フォルダ = 作品** をアルバムビューの単位とする（DLsite 等の音声作品はフォルダ配下にトラックが並ぶ構成が一般的）。フォルダ内の `node_audio` を `disc_no, track_no, name(自然順)` でソート。タグの `album` が揃っていればアルバム名として表示、無ければフォルダ名。
- `user_playback_state(user_id, node_id, position_ms, updated_at)`: 再生位置（5 秒デバウンス）。`user_node_state.last_opened_at` も更新。

### API

- `GET /api/v1/nodes/:id/tracks` → フォルダ配下の音声ノードをソート済みで返す（`node_audio` JOIN、ページング不要な上限 2,000 件、超過は分割）。
- `GET /api/v1/nodes/:id/content` の Range 配信をそのまま利用（`Accept-Ranges: bytes`、206、`Content-Type` は sniff 済み audio MIME、CONTENT_HOST 経由）。
- `PATCH /api/v1/nodes/:id/audio` でタグの手動修正（`node_audio` に `user_override` JSON を持ち、抽出結果を上書き表示。ファイル自体は書き換えない = 不変 blob）。
- 共有リンク経由: `public/shares/:token/tracks` を capability 範囲で提供。

### UI

- 音声ファイルの一覧/ギャラリー表示ではファイル名ではなく **タグの `title`（無ければファイル名）、`artist`、`duration`** を表示。フォルダを開くと「アルバムビュー」（ジャケット、作品名、トラックリスト、合計時間）に切り替え可能。
- プレイヤー: 画面下部に固定のミニプレイヤー（アプリ内ページ遷移をまたいで再生継続 — SPA で `<audio>` をルート直下に保持）、キュー/連続再生、シャッフル、リピート、再生速度、スリープタイマー、キーボードショートカット、`MediaSession API` でロック画面・ヘッドホン操作にタイトル/アーティスト/ジャケットを表示、`Range` によるシーク、再生位置の復帰（「続きから再生」）。
- 本棚と同様に「音声ライブラリ」ビュー: 作品（フォルダ）の表紙グリッド、最近再生、未再生、アーティスト/タグ絞り込み、検索は `node_audio.title/artist/album` も `node_search` の正規化・bigram 対象に含める。
- 波形表示・歌詞同期表示は v1.1。

### 上限・セキュリティ

- タグ抽出の読み取りは先頭 2 MiB + 末尾 128 byte（MP4 は moov 探索で最大 4 MiB）。それ以上必要な場合は `unsupported`。
- 埋め込み画像は Images で再エンコードしたものだけ配信し、元バイトはそのまま出さない。
- タグ文字列は表示時にエスケープ、`Content-Disposition` のファイル名には使わない。
