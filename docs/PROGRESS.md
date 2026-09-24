# 開発進捗

更新日: 2026-09-25。製品全体は開発中。remote migration・deployは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、フォルダー集計を接続済み。
- multipart走査・中止receipt・part容量保留、KDF全体制限と終了記録repairを接続済み。未知処理の全体閉鎖・精算は残る。
- namespace8許可経路・DAVロック・app password・session登録/初回owner/logoutの共通受付は接続済み。直前commit `8e7243e`はpush済み。[CI36016276272](https://github.com/daraskme/Nextcloud-flare/actions/runs/36016276272)全job成功。Node408 + workerd984 + browser19 = **1,411件**。

## 今回の変更

配信budgetの確保/更新、ticketの発行・Cookie交換・取消しを同時32件/待機256件の受付へ接続。共有先ユーザーや匿名共有もコンテンツ所有者のspaceを使う。待機後に現在の認可とSQL時計で期限を再検査し、変更・確定記録・枠解放を一括保存する。

R2 manifestの準備・読戻しは公開用の更新枠取得前に完了する。発行結果が不明なら、DB公開を原子的に取り消せた証明がある場合だけmanifestを削除する。取消し確認の応答も失った場合は保持する。他処理の成功を自分の確定記録と混同しない。受付混雑はHTTP503とRetry-Afterを返し、Cookie交換のCORSを維持する。

workerd70件追加。対象101件と全checkが成功。Node408/25files + workerd1054/64files = 1,462件、lint/typecheck/contracts/config・Web build・Worker dry-runも成功。今回のbrowserと両OSのCIはpush後に確認する。最新schema0032・通常67table、migration追加・依存変更なし。確定した検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、契約は[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

- account mutationのupload準備・Queue等への接続、backup barrier、終了証明のないKDFの運用収束。
- multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。
