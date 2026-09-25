# バックアップの実行監視と通知

更新: 2026-09-25。`maintain --monitor-directory PATH`がローカルの実行開始・終了を記録し、独立した`pnpm backup:monitor`が失敗、長時間実行、成功の欠落を検知する。HTTPS受信先へ状態変化と復旧を通知できる。実通知先の設定、hostへの設置・起動、remote運用は未実施。

## 実行記録

```sh
pnpm backup maintain --local \
  --operator-config scripts/backup/operator.local.example.json \
  --config wrangler.jsonc --database DB --epoch <現在のepoch> \
  --directory <世代保存先> --prune-expired --monitor-directory <監視保存先>

pnpm backup:monitor check --directory <監視保存先>
```

監視保存先は環境ごとに分け、信頼された運用利用者だけが書けるdirectoryを指定する。`monitor.sqlite`に実行UUID・epoch・開始/終了時刻・終了コード・直前の終了結果・最後の成功時刻を保存する。SQL本文、ファイル名、接続設定、資格情報は保存しない。新しいDBは0600で作成し、SQLiteのWALとFULL synchronousを使う。これはhost内の運用記録であり、D1の完了receiptや復旧世代の権威ではない。

maintainの引数構文とmonitor保存先を受け付けた後、運用bindingへの接続前に開始を記録する。epoch等の設定不備も失敗として残せる。epochが無効な場合、監視記録のepochはnullになる。引数の解析自体の失敗、保存先の権限・破損・disk fullでは記録できないため、serviceの非0終了も別途監視する。

終了記録は、取得・補充・health・明示的な回収・接続の終了処理が終わった後に保存する。終了コード0だけが最後の成功時刻を更新する。再送された同じ終了記録は時刻を更新しない。記録失敗はCLIを終了コード1にする。新しい実行の開始だけで以前の失敗や成功時刻を消さない。

## 判定

| 問題コード | 意味 |
|---|---|
| `backup_monitor_uninitialized` | 実行記録がまだない |
| `backup_monitor_no_success` | まだ正常終了を記録していない |
| `backup_monitor_run_failed` | 最後に終了したmaintainがコード1 |
| `backup_monitor_run_unhealthy` | 最後に終了したmaintainがコード2。世代不足・破損・回収未完了等を元のJSONで確認する |
| `backup_monitor_run_overdue` | 実行中のまま6時間を厳密に超えた |
| `backup_monitor_success_overdue` | 最後の正常終了から24時間を厳密に超えた |
| `backup_monitor_clock_conflict` | 記録時刻がhostの現在時刻より未来にある |

`--max-run-ms N`で長時間実行の基準を1ms〜24時間の範囲で指定できる。これは警告閾値であり、実行取消しやbackup barrier解除の期限ではない。24時間の成功欠落基準は変えない。時刻は監視hostの時計であり、バックアップ世代の35日判定には使わない。

実行UUIDが進行中の間、同じ保存先への新しいmaintainを拒否する。プロセス停止・強制終了・host再起動でも、成功を推測して記録を消さない。古いrunnerが終了したことを確認し、必要な世代のreceipt・ローカルcapture lockを確認してから、次で**ローカルの実行記録だけ**を失敗へ確定する。

```sh
pnpm backup:monitor abandon --directory <監視保存先> --run-id <checkで得た実行UUID>
```

別UUID、既に正常終了した記録には適用できない。バックアップのcancel/thaw、R2削除、capture lockの除去は行わない。同じバックアップ世代からの再実行手順は[BACKUP_OPERATOR](BACKUP_OPERATOR.md)を参照。

## 状態変化の通知

```sh
pnpm backup:monitor notify --directory <監視保存先> --source <環境の固定ラベル>
```

通知先は保護された環境変数`NCF_BACKUP_NOTIFY_URL`と`NCF_BACKUP_NOTIFY_TOKEN`で指定する。HTTPSのみ、URL内のuserinfo・fragmentなし、Bearer tokenは16〜4096文字の空白を含まないASCIIを受け付ける。redirectは追跡しない。受信先はversion 1のJSONを受け付ける運用用endpointであり、特定のチャットサービスの固有payloadを直接生成するものではない。

JSONには`version/id/source/type/healthy/observedAt/issues/run`がある。`type`は`backup.alert`か`backup.recovered`。HTTPの`Idempotency-Key`にも同じ`id`を送る。受信先はIDで重複排除し、通知を永続的に受理してから2xxを返す。HTTP 2xxだけをACKとし、応答bodyは読み込まずログにも出さない。待機は10秒、同じ呼出し内での自動再送はしない。URL・token・providerのエラー本文をエラーログへ含めない。

初期状態が正常なら通知せず、問題コードの集合が変わった場合だけ新しい通知を作る。実行UUIDや観測時刻が変わっただけでは再通知しない。異常から正常へ戻ったときは復旧を通知する。`source`は最初のnotify時に保存先へ固定し、別環境のラベルへの変更は拒否する。

送信前に通知IDと本文をSQLiteへ保存する。通信失敗・応答喪失・送信後のプロセス停止では、次回も同じID・本文を使う。30秒の送信claimを同じDBのtransactionで確保し、通常の並行送信を抑える。期限後の遅い送信が重複する可能性はあるため、exactly-onceではなくat-least-onceである。古いACKは別の新しい通知をACKしない。

最初の未通知の実行失敗を別行に保持するため、監視周期の間に失敗・復旧してもその失敗を見逃さない。未ACKの異常がある間に復旧しても、その異常を破棄しない。まず同じ通知を再送し、次の監視回で復旧通知へ進む。1回最大1通知であり、`pending:true`なら次回の処理が必要。既に通知した同じ問題集合の失敗は重複通知せず、未通知の失敗は最初の1件へまとめる。全実行履歴を保存するものではないため、監査にはjournald等のログも保持する。

| 終了コード | 意味 |
|---|---|
| 0 | 正常。通知要求時は、この観測で必要な通知も処理済み |
| 2 | 異常を検知。通知要求時は送信済み、または同じ異常を通知済み |
| 1 | 引数・保存・接続失敗、または未完了の通知あり |

## 定期監視と検証範囲

[backup service](../ops/backup/nextcloud-flare-backup.service)はmonitor保存を指定する。[monitor service](../ops/backup/nextcloud-flare-backup-monitor.service)と[monitor timer](../ops/backup/nextcloud-flare-backup-monitor.timer)はbackup serviceから独立し、boot後2分・以後5分周期、精度枠30秒で起動する。[systemdのtimer仕様](https://raw.githubusercontent.com/systemd/systemd/v261/man/systemd.timer.xml)に従う。終了コード2を正常へ読み替えない。通知資格情報は別の[環境変数ファイル](../ops/backup/backup-monitor.env.example)へ置く。

host停止、timer停止、監視DBの破損、通知先不通は同じhostからの通知だけでは完結しない。hostと監視serviceの非0終了・未実行を外部監視へ接続し、受信先の稼働確認も行う必要がある。最新runの成功はR2がその後も無傷であることの証明ではない。保存済みSQLの実検証は[health/maintain](BACKUP_RETENTION.md)で行う。

Node試験では再起動、並行開始、期限・時刻逆行、同じ完了記録の再送、未ACK通知の継続、遅いACK、正常時の無通知、復旧、HTTP拒否・timeout・秘密情報の非出力を検証する。ローカルHTTP受信fixtureでは通知と復旧を実際に受け、実CLIドリルでは5世代の健全性検査・自動回収後の成功記録を確認する。受信fixtureのtransport adapterだけをloopbackへ向け、製品のHTTPS制限を緩めない。実通知先のTLS・認証・配信先、serviceのinstall/enableと運用演習は別途検証する。
