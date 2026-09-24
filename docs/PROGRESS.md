# 開発進捗

更新日: 2026-09-25。製品全体は開発中。remote migration・deployは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、フォルダー集計を接続済み。
- multipart走査・中止receipt・part容量保留、KDF全体制限と終了記録repairを接続済み。未知処理の全体閉鎖・精算は残る。
- namespace・DAVロック・app password・session/bootstrap/logout・配信budget/ticketの共通受付は接続済み。直前commit522f616はpush済み。[CI36020805225](https://github.com/daraskme/Nextcloud-flare/actions/runs/36020805225)全成功。Node408 + workerd1054 + browser19 = **1,481件**。

## 今回の変更

単一/分割uploadの新規予約を同時32件・待機256件の共通受付へ接続。署名/hashと事前認可を終えてから所有spaceの枠を取得し、待機後のcurrent authority・上書きrevision・epoch・期限・quotaを再検査する。reservation・staging blob・upload・確定記録・枠解放を同じbatchで保存する。混雑時は容量を予約せずR2初期化を始めず、HTTP503とRetry-Afterを返す。

同key/bodyの保存済み予約は追加受付なしで読取り、混雑中も確認できる。並行する別要求のreceiptへの合流は、自分の確定証明や未確定枠の解放根拠としない。全照合応答を失っても容量を保持し、同keyで再取得する。

workerd42件追加。既存55件、新規境界40件、実ControlDO37件が成功。全check1,504件（Node408/workerd1096）・静的検査・契約・設定・build成功。今回のbrowser/CIはpush後に確認する。最新schema0032・通常67table、migration・依存追加なし。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、契約は[MUTATION_ADMISSION](MUTATION_ADMISSION.md)と[UPLOAD_HTTP](UPLOAD_HTTP.md)。

## 後続の主要項目

- uploadの転送開始/終了記録・abort/cleanup・Queue等の更新受付、backup barrier、終了証明のないKDFの運用収束。
- multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。
