# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit1993f9cはmainへプッシュ済み。[CI36040104582](https://github.com/daraskme/Nextcloud-flare/actions/runs/36040104582)はUbuntu・Windows・browser全成功。Node416/workerd1402/browser19、計1,837件。

## 今回の変更

既存upload行に紐づく未知multipart IDの調査・回収を共通system受付へ接続しました。走査の再初期化、外部呼出し予算、物理観測、遅れて判明したID、ページ保存、中止確認、lease返却、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。

待機後にfreshなR2/S3対応証明、epoch/pause、cleanup token/lease、scan round・cursor、pin/refを同じbatchで再検査します。HEAD・S3一覧・abortはそれぞれ予算batchの直接ACKが必要で、受付待ちと遅いACKの後も実行期限を確認します。DB-onlyのexact receipt回収と既存の厳密なscan/中止照合を維持し、全ページ取得やhandle中止だけでは予約容量を返しません。

workerd66件追加（境界59件・実ControlDO7件）。全体check成功、Node416件（25file、5.90秒）・workerd1,468件（75file、755.11秒）、計1,884件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

global probe・orphan/全bucket inventory・Queueの更新受付とbackup barrier、未知KDF/multipartの収束、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
