# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

前回の自動走査`c664c85`は[CI36122071388](https://github.com/daraskme/Nextcloud-flare/actions/runs/36122071388)の全5ジョブ（Ubuntu、Windows両分割、backup、browser）が成功しました。

「maintain --monitor-directory」と「pnpm backup:monitor」を追加しました。host内SQLiteへ開始・終了と最後の成功を保存し、失敗・6時間超の実行・24時間超の成功欠落を独立したwatchdogで検知します。最初の未通知失敗を保持するため、監視周期の間に再実行が成功しても見逃しません。

HTTPS通知は状態変化と復旧だけを送り、未ACKの通知ID・本文を保存して同じIDで再送します。30秒の送信claim・10秒の待機上限・古いACKの照合を設け、秘密情報やproviderの本文をログへ出しません。中断したrunは正確なUUIDでローカル記録だけを失敗へ確定でき、バックアップのcancel/thawには接続しません。backup/monitorのserviceと別timerの例を用意しました。詳細は[BACKUP_MONITORING](BACKUP_MONITORING.md)。

監視32件が成功（4.04s）。Node全728件（41file、43.29s）が成功しました。監視付き実CLIドリルも成功し、SQL9,079bytesの世代から4世代を補充、全5世代の検証と期限切れ回収を終えてから成功記録を保存することを確認しました。lint369file・型・契約/設定検査と4つのsystemd unitの構文検査も成功しています。今回Worker本体・migration・依存は変更せず、schema0039・通常67tableを維持しています。実行記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

次はTime Travelとlogical exportからの稼働系復旧を、停止・新epoch・全監査・段階再開へ接続します。通知先・timerの実設置とhost自体の外部監視、破損・未完了世代の回収、D1/全storage喪失後の信頼できる世代選択、旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。remote migration・deployは未実施です。
