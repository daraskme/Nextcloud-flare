# 開発進捗

更新日: 2026-09-25。製品全体は開発中。remote migration・deployは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、フォルダー集計を接続済み。
- multipart走査・中止receipt・part容量保留、KDF全体制限と終了記録repairを接続済み。未知処理の全体閉鎖・精算は残る。
- namespace・DAVロック・app password・session/bootstrap/logout・配信budget/ticket・upload新規予約の共通受付は接続済み。直前commit e90ee88の[CI36024332349](https://github.com/daraskme/Nextcloud-flare/actions/runs/36024332349)は全成功。Node408/workerd1096/browser19、計1,523件。

## 今回の変更

単一uploadの送信開始・読戻し・検証済み情報の保存、multipartの初期化・complete送信claimの5経路を共通32枠へ接続。現在の権限/対象/期限と変更・確定記録・枠返却を同一batchで検査する。外部送信はclaim batchの直接ACKを受けた場合だけ許可し、確定記録の読戻しでは再送しない。単一の検証済みDB情報だけはexact receiptから復旧する。

単一PUT後に受付が混雑してもphysicalとreservationを保持し、再試行はGET照合のみ。DB受付枠の返却と外部I/O終了を区別する。

workerd45件追加。既存upload55件・境界40件・実ControlDO5件成功。全check1,549件（Node408/workerd1141）・静的検査・契約・設定・build成功。今回のbrowser/CIはpush後に確認する。 最新schema0032・通常67table、migration・依存追加なし。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

- uploadの物理観測・UploadDO台帳反映・abort/cleanup・Queue等の更新受付、backup barrier、終了証明のないKDFの運用収束。
- multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。
