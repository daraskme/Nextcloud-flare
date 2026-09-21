あなたは Web アプリケーションセキュリティと Cloudflare Zero Trust (Access) に精通したセキュリティアーキテクトです。

対象: `docs/DESIGN.md` (v0.3 — ラウンド1・2 反映済み)。参考: `docs/reviews/round2-astra.md`（敵対的レビュー）、`docs/reviews/round2-resolution.md`。ファイルは編集しないでください（レビュー結果のみ出力）。

## 依頼: ラウンド3 — セキュリティ / 認証・認可レビュー

1. **脅威モデル**: 攻撃者を (a) 未認証の外部者、(b) 共有リンク保持者、(c) 認証済みの一般メンバー、(d) app password を盗んだ者、(e) Cloudflare アカウント管理者、(f) 悪意ある/侵害された WebDAV クライアント に分け、各攻撃者が到達できる資産と、設計上の防御を表にする。防御が設計書に明記されていない箇所を列挙。
2. **Cloudflare Access 統合**: JWT 検証（`Cf-Access-Jwt-Assertion` ヘッダと `CF_Authorization` Cookie の扱い、aud/iss/kid/alg、JWKS ローテーション、clock skew、`nbf`）、Bypass ポリシーの範囲、Service Token の扱い、ログアウト・セッション失効の伝播、複数 Access アプリ/複数 aud の扱い、`workers.dev`/preview URL の遮断。設計の記述で不正確・危険なものを指摘。
3. **認可モデルの形式検証**: `authorize(principal, node, action)` の入力と判定表を読み、(i) 全 endpoint が通るか、(ii) ancestor 判定（capability root の子孫チェック）の実装方法が D1 で安全に実現できるか、(iii) MOVE/COPY で src と dst の両方を判定しているか、(iv) 削除済み・trash 内・別 space のノードの扱い、を確認。
4. **セッション/トークン**: 共有 unlock Cookie、download ticket、app password、CSRF token、upload session ID の生成・保存・失効・ローテーションを確認。エントロピー、比較、保存形式、鍵ローテーション、ログへの漏えい。
5. **コンテンツセキュリティ**: 別ホスト配信 (`CONTENT_HOST`) と単一ホストフォールバックの各構成で、XSS / clickjacking / MIME sniffing / SVG・HTML・PDF プレビュー / Markdown レンダリング / ZIP 内パス / ファイル名インジェクション（Content-Disposition, CSV, XML PROPFIND）の防御を確認。
6. **入力検証**: 名前正規化順序、パス、XML (WebDAV)、JSON、Range ヘッダ、Content-Length、`If`/`If-Match`、Destination、Depth、Timeout の各ヘッダのパース・上限。
7. **秘密情報・設定**: vars/secrets の分類、`OWNER_EMAILS`、`DEV_BYPASS_ACCESS`、鍵素材の生成・保管・ローテーション手順。
8. **判定**: 各指摘に `致命 / 重大 / 中 / 低` と該当章番号、修正案。最後に「セキュリティ観点で実装に渡せるか（Yes / 条件付き / No）」と必須修正リスト。

出力は日本語の Markdown。Cloudflare の仕様で確信がないものは「要確認」と明記してください。
