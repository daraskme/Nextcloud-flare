# Sol 実装 run 4: E2E 指摘の修正 + Phase 8B (Bookshelf) + Phase 8C (Audio)

あなたは Next-cloud-flare の実装担当（Sol）の続きです。リポジトリは `C:\Users\Administrator\repos\Next-cloud-flare`、ブランチ `devin/1789973800-implementation`。前回 run で Phase 7（WebDAV, `54a4505`）と Phase 8A（Gallery, `c6941d8`/`3dcd647`）がコミット済みです。

契約は `docs/DESIGN.md`（v0.6）と `docs/IMPLEMENTATION_BRIEF.md`（§8 含む）。進捗と既知の設計差分は `docs/STATUS.md`。

## 作業順序

### A. ブラウザ E2E で見つかった不具合の修正（最優先）

`docs/reviews/e2e-findings-1.md` の 9 項目を全て修正すること。要点:

1. **Unicode ファイル名**: ASCII 限定の "Foundation-safe subset" ゲートを撤廃し、DESIGN の名前正規化（NFC、制御文字 / `/` / `\` 禁止、先頭末尾の空白とドット禁止、Windows 予約名禁止、UTF-8 255 bytes 以内）に置き換える。`旅行メモ.txt`、`同人誌 vol.1.cbz`、絵文字名のテストを追加。WebDAV の PUT/MKCOL/MOVE も同じ validator を通すこと。
2. **同名アップロードの衝突**: `POST /api/v1/uploads` / complete で同名 file が存在する場合、API は `409 name_conflict` に `existingNodeId`, `revision` を含めて返し、Web UI は「新しいバージョンとして上書き」「両方残す（自動リネーム）」「スキップ」を選べるダイアログを出す。上書きは `mode=overwrite&expectedRevision=` で新 blob を `node_versions` に積む既存 overwrite path を使う。ファイル詳細にバージョン一覧（復元）を追加。
3. **再ゴミ箱→完全削除の 409**: restore → 再 trash → purge で `mutation_rejected` になる原因（trash_members / permit / revision fence の不整合）を特定し修正。`trash-retrash-purge.test.ts` を追加。
4. **ライトテーマのコントラスト**: 色をセマンティック CSS 変数（`--fg`, `--fg-muted`, `--bg`, `--surface`, `--border`, `--accent`）に統一し、light/dark 両方で WCAG AA 相当を満たす。ハードコードの白系文字色を排除。
5. **公開共有ルーティング（ローカル）**: Vite dev server は `/s/*`, `/api/*`, `/dav/*` を Worker (8787) にプロキシする。Worker の `/s/:id` は public share shell（private app を含まない別エントリ）を返す。dev principal は public route（`/s/*`, `/api/v1/public/*`）には適用しない。匿名で public route を叩く integration test を追加（password 必須 share は unlock 前に 401/403、期限切れ・無効化 share は 404/410）。
6. **不正名のエラー**: `..` や `../escape` は `invalid_name` を返す（duplicate-name エラーで誤魔化さない）。
7. **ストレージ表示**: 単位を自動（B/KB/MB/GB）にし、使用率バーを表示。
8. **無効化済み共有のバッジ**と **UI 文言の日本語統一**（既存の英語ラベルを日本語に。i18n 辞書 1 ファイルに集約）。
9. **compatibility_date** をインストール済み Wrangler/workerd が対応する日付に固定（起動時の警告が出ないこと）。

修正ごとに回帰テストを追加し、`pnpm lint && pnpm typecheck && pnpm test && pnpm build` を通してコミット（例: `fix: accept Unicode names and surface conflict resolution`）。

### B. Phase 8B: Bookshelf

DESIGN の本棚仕様に従う:
- `library_roots`, `library_items`, `archive_index`, `user_reading_state`（migration 追加）
- ZIP/CBZ（stored / deflate のみ、RAR/7z は v1 非対応で `unsupported_format`）: Range GET で central directory を読み、ページ単位配信 `GET /api/v1/library/items/:id/pages/:n`、zip bomb 制限（entry 数、圧縮率、展開サイズ）
- EPUB: sanitized 派生 XHTML、trusted reader shell、sandbox iframe、CSP
- 表紙サムネイル、読書位置保存、シリーズ/タグ表示
- Web UI: 本棚グリッド（表紙）、リーダー（単ページ/見開き、RTL 対応、キーボード・スワイプ）、続きから読む

### C. Phase 8C: Audio

- `node_audio` に title / artist / album / track_no / disc_no / duration_ms / codec / bitrate / cover を抽出（MP3 ID3v2, FLAC Vorbis comment, OGG/Opus, M4A/MP4 atoms, WAV）— Queue consumer で実行、上限サイズ内のヘッダのみ Range で読む
- `GET /api/v1/nodes/:id/tracks`（フォルダ＝アルバム）
- Web UI: アルバムビュー（トラックタイトル・番号・長さ）、キュー、ミニプレイヤー（MediaSession、Range 再生、再生位置保存）

### 共通ルール

- 各 Phase 完了ごとに全チェックを通してから、明示ファイル指定でコミット（`git add .` 禁止。`docs/reviews/*.out|*.err` はコミットしない）。
- 認可・quota・CSRF・permit fence を弱めてテストを通さない。
- 契約と実装が矛盾する場合は実装側で安全側に倒し、`docs/STATUS.md` の差分表に追記。
- `C:\Users\Administrator\repos\ncf-test` は触らない。
- 最後に `docs/STATUS.md` を更新して commit し、実施した Phase・テスト件数・未完了項目を日本語で要約して終了。
