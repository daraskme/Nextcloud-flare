あなたは Next-cloud-flare の実装担当（Sol）の続きです。前回までの run で Phase 0〜5 が完了し、`docs/STATUS.md` に到達状況が記録されています。

## まず読む
- `docs/STATUS.md`
- `docs/IMPLEMENTATION_BRIEF.md`（§2 の Phase 表と §8）
- `docs/DESIGN.md` の Share / content / ZIP / WebDAV 節
- 既存コード: `packages/worker/src`, `packages/shared/src`, `packages/web/src`

## 今回の目標
`docs/reviews/sol-impl-prompt.md` と同じ規約・禁止事項のもとで、**Phase 6（Share / content-session / ZIP download）→ Phase 7（WebDAV Class 1/2）** を順に実装する。各 Phase 完了ごとに lint/typecheck/test/build を通して、明示ファイル指定でコミットする（`git add .`/`-A`/amend 禁止）。

- Phase 6: 期限付き・パスワード付きリンク共有（閲覧/ダウンロード/アップロード専用）、ユーザー間共有（shared-with-me）、public route（`/s/*`, `/api/v1/public/*`）、content session、フォルダ ZIP download（STORE、fflate 同期 API）。Web UI: 共有ダイアログ（期限・パスワード・権限・リンクコピー）、公開共有ページ（モダンなデザイン、フォルダ閲覧、ダウンロード、アップロード専用ドロップ）、「共有中」「自分と共有」ビュー。
- Phase 7: `/dav/*` Basic 認証（app password id をユーザー名）、OPTIONS/PROPFIND/PROPPATCH/MKCOL/GET/HEAD/PUT/DELETE/COPY/MOVE/LOCK/UNLOCK、Brief §8 #9 の Timeout/ETag/428 契約、DESIGN の DAV protocol profile（If header、lock token、mount alias、XML 制約）。Web UI: 設定画面の app password 管理（作成・ラベル・失効、secret は一度だけ表示）。
- 到達できなかった Phase は着手しない。到達分を `docs/STATUS.md` に更新してコミット。
- 設計との矛盾は `docs/DESIGN.md` を編集せず `docs/STATUS.md` の「設計へのフィードバック」に追記。

## 出力
最後に標準出力へ: 到達 Phase、コミット一覧、lint/typecheck/test/build の結果、未実装項目、設計へのフィードバックを日本語で要約する。
