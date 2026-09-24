# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit90c4593はmainへプッシュ済み。[CI36037522754](https://github.com/daraskme/Nextcloud-flare/actions/runs/36037522754)はUbuntu・Windows・browser全成功。Node416/workerd1322/browser19、計1,757件。

## 今回の変更

台帳に登録済みのファイルを対象に、GC（不要ファイルの物理回収）の通常実行・停止中の回収・ゴミ箱復元中の回収を共通system受付へ接続しました。claim、delete/HEAD予算、完了精算、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。

deleteとHEADはそれぞれ予算batchの直接ACKが必要です。受付待ちと遅いACKの後も実行期限を確認し、pin・参照・未精算upload・lease・epoch/mode・復元token/operation/期限を再検査します。待機後のSQL時計で60秒leaseを設定し、失敗したclaimも処理上限に数えます。DB-onlyのexact receipt回収と完全な終端照合を維持し、他の回収処理の成功で自分の未確定枠を返しません。

workerd80件追加（GC境界73件・実ControlDO7件）。全体check成功、Node416件（25file、5.66秒）・workerd1,402件（73file、705.27秒）、計1,818件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

残るorphan/multipart inventory・Queueの更新受付とbackup barrier、未知KDF/multipartの収束、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
