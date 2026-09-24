# 開発進捗

更新日: 2026-09-24。製品全体は開発中。remote migration・deployは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、フォルダー集計を接続済み。
- multipart走査・中止receipt・part容量保留、KDF全体制限と終了記録repairを接続済み。未知処理の全体閉鎖・精算は残る。
- namespace8許可経路・DAVロック・app passwordの共通受付は接続済み。直前commit `a9ab676`はpush済み。[CI36012173188](https://github.com/daraskme/Nextcloud-flare/actions/runs/36012173188)全job成功。Node404 + workerd962 + browser19 = **1,385件**。

## 今回の変更

session登録・初回owner作成・logoutを同時32件/待機256件の受付へ接続。初回作成はspaceがない専用scopeで同じFIFOへ入り、namespace permitには利用できない。更新・確定記録・解放を一括保存する。既存JWTのloginはcurrent primary読取りだけで照合し、失効済み・credential欠損のsessionを再作成しない。

migration0032は既存receiptと削除済み行を含むsequence最大値を保持する。通常67table、依存変更なし。Node4/workerd22件追加。Node408/workerd984の計1,392件と全検証項目を確認済み。初回fixture失敗を修正し、関連57件を再検証。CIで全check/browserを確認する。詳細は[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

- account mutationのcontent ticket・upload準備・Queue等への接続、backup barrier、終了証明のないKDFの運用収束。
- multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。
