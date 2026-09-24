# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit0f1cb82はmainへプッシュ済み。[CI36042342676](https://github.com/daraskme/Nextcloud-flare/actions/runs/36042342676)はUbuntu・browser成功、Windowsは既存S3本文タイムアウト試験1件で失敗しました。UbuntuはNode416/workerd1468、browser19。WindowsはNode415件成功・1件失敗で停止し、workerdは未実行です。

## 今回の変更

Queueの送信・受信処理を共通system受付へ接続しました。送信claim、送信前の確認、送信済み記録、受信claim、処理完了が通常操作と同じ32 active/256 waiting枠を使います。受付対象は元operationの所有spaceで、通知を起こしたactorのspaceと混同しません。

待機後にepoch/maintenance、正確なtokenとlease、受信側の現行credential・認可・元operationの証明を再検査します。DB-onlyの記録はexact receiptで回収しますが、今回のQueue送信には別受付と直接ACKが必要です。送信応答を失った通知はlease後に同じIDで再送でき、確定済みcompleted/failedの再配信は追加受付なしで確認します。Cron・Queue batchは共通の25秒期限を使い、未処理メッセージをretryします。

Windowsの失敗は20msの試験期限が署名中に切れ、本文読取りのキャンセル検査へ届かない競合でした。本文のread開始を確認してからfake timerを20ms進め、fetchとcancel各1回を検査する方式へ修正しました。製品の10秒transport期限は変更していません。

workerd57件追加（境界51件・実ControlDO6件）。全体check成功、Node416件（25file、5.55秒）・workerd1,525件（77file、778.32秒）、計1,941件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。S3タイムアウト試験の修正後88件（261ms）も成功。schema0033/通常67table、migration・依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[OUTBOX](OUTBOX.md)。

## 後続の主要項目

global probe・orphan/全bucket inventory・旧epoch repairの更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
