# 開発進捗

更新日: 2026-09-24。製品全体は開発中。remote migration・deployは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、フォルダー集計を接続済み。
- multipart走査・中止receipt・part容量保留、KDF全体制限と終了記録repairを接続済み。未知処理の全体閉鎖・精算は残る。
- namespace8許可経路とDAVロックの共通受付は接続済み。直前commit `64ed237`はpush済み。[CI](https://github.com/daraskme/Nextcloud-flare/actions/runs/36008397681)全job成功。Node404 + workerd930 + browser19 = **1,353件**。

## 今回の変更

app passwordの発行・失効・認証時pepper更新を同時32件・待機256件の受付へ接続。KDF後に枠を取り、待機後の権限・owner・root・件数上限・CASを再検査し、変更/確定記録/枠解放を一括保存する。混雑はHTTP503・Retry-After、DAVの再認証要求なし。migration0031・通常67table・依存を維持。

workerd32件追加。既存認証55件・最終境界60件が成功。全体試験で旧content-ticket fixtureが1件失敗したため、fixtureだけを修正し同file11件を再検証した。合計Node404 + workerd962 = **1,366件**を確認。lint・型・契約・設定・Web build・Wrangler dry-runも成功。CIで全checkとbrowserを確認する。[MUTATION_ADMISSION](MUTATION_ADMISSION.md)に契約と残る経路を記載。

## 後続の主要項目

- account mutationのsession/bootstrap/logout・content ticket・upload準備・Queue等への接続、backup barrier、終了証明のないKDFの運用収束。
- multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。
