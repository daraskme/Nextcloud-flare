# 開発進捗

更新日: 2026-09-24。製品全体は開発中。remote migration・deployは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、フォルダー集計を接続済み。
- multipart走査・中止receipt・part容量保留、KDF全体制限と終了記録repairを接続済み。未知処理の全体閉鎖・精算は残る。
- namespace8許可経路の共通受付は接続済み。直前commit `89cc9b7`はpush済み。[CI](https://github.com/daraskme/Nextcloud-flare/actions/runs/36005018219)全job成功。Node400 + workerd908 + browser19 = **1,327件**。

## 今回の変更

DAV LOCK・refresh・UNLOCKを同じ同時32件・待機256件の受付へ接続した。lock変更と確定記録、枠の解放を同じDB batchで行う。応答喪失時は自分の確定記録を照合し、別処理によるlock削除や期限一致を成功の根拠にしない。migration0031、通常67table、依存変更なし。

追加Node4件・workerd22件。対象Node8件と関連workerd72件が成功。共有枠の実ControlDO待機/解放、3操作のHTTP503、認可失効、停止/epoch、期限、応答/照合喪失、DB rollback、旧DB移行と記録保持を検証。全check成功: Node404 + workerd930 = **1,334件**。lint・型・契約・設定・Web build・Wrangler dry-runも成功。browser/CIはpush後に確認する。[MUTATION_ADMISSION](MUTATION_ADMISSION.md)に契約と未接続経路を記載。

## 後続の主要項目

- account mutationの認証情報・upload準備・Queue等への接続、backup barrier、終了証明のないKDFの運用収束。
- multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。
