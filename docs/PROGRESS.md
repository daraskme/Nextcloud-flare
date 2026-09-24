# 開発進捗

更新日: 2026-09-24。製品全体は開発中。remote migration・deployは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、フォルダー集計を接続済み。
- multipart走査・中止receipt・part容量保留、KDF全体制限と終了記録repairを接続済み。未知処理の全体閉鎖・精算は残る。
- 直前commit `6b65a47`はpush済み。[CI](https://github.com/daraskme/Nextcloud-flare/actions/runs/36001142967)全job成功。Node396 + workerd891 + browser19 = **1,306件**。

## 今回の変更

namespace更新の全体受付を追加。ControlDO/D1共通で同時32件、待機256件・5秒とし、LockDOの8許可経路に接続した。待機後に認可・lockを再検査する。期限切れ・停止・epoch変更では古い許可をDB上で無効にしてから枠を再利用し、R2容量保留は維持する。migration0030、通常67table、依存変更なし。

上限・FIFO・再送・応答喪失・期限・再起動・認可失効・HTTP 503の追加21件を含め、全check成功: Node400 + workerd908 = **1,308件**。lint・型・契約・設定・Web build・Wrangler dry-runも成功。今回のbrowser/CIはpush後に確認する。[MUTATION_ADMISSION](MUTATION_ADMISSION.md)に契約と未接続経路を記載。

## 後続の主要項目

- account mutationの認証情報・upload準備・DAV lock・Queue等への接続、backup barrier、終了証明のないKDFの運用収束。
- multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。
