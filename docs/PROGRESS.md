# 開発進捗

更新日: 2026-09-25。製品全体は開発中。remote migration・deployは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、フォルダー集計を接続済み。
- multipart走査・中止receipt・part容量保留、KDF全体制限と終了記録repairを接続済み。未知処理の全体閉鎖・精算は残る。
- namespace・DAVロック・app password・session/bootstrap/logout・配信budget/ticket・upload新規予約の共通受付は接続済み。直前commit 47160c4の[CI36027205940](https://github.com/daraskme/Nextcloud-flare/actions/runs/36027205940)は全成功。Node408/workerd1141/browser19、計1,568件。

## 今回の変更

単一/分割uploadの利用者による中止と、multipart完成物の検証済み情報保存を共通32枠へ接続。待機後の現行認可・期限・状態を再検査し、変更・確定記録・枠返却を同一batchで保存する。

未送信の単一uploadだけ予約を返し、待機中に送信claimが入った場合も予約を保持する。multipart中止は送信を停止するだけで、回収前に予約を返さない。multipart検証の受付混雑時は物理容量/予約を保持し、再試行でR2 completeを再送しない。 応答喪失はexact receiptで照合する。別要求の終端結果を自分の確定証明にせず、自分の未確定枠は閉じない。

workerd45件追加。新規境界42件（27.01秒）、既存upload/転送/実ControlDO103件（58.79秒）成功。全check1,594件（Node408/workerd1186）・静的検査・契約・設定・build成功。今回のbrowser/CIはpush後に確認する。 schema0032/通常67table・migration/依存追加なし。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

- uploadの物理観測・UploadDO台帳反映・内部停止/cleanup・Queue等の更新受付、backup barrier、終了証明のないKDFの運用収束。
- multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。
