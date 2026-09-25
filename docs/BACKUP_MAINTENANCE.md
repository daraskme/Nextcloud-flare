# 日次バックアップと世代補充

更新: 2026-09-25。`pnpm backup maintain`は日次世代の再開・取得、保持判定、不足分の追加取得、最終検査を1回のコマンドで実行する。初回の正常なDBでは1世代を取得し、4世代を補充して5世代にする。すべて現在のsnapshotであり、取り逃した過去日の状態を作ったことにはしない。

```sh
pnpm backup maintain --local \
  --operator-config scripts/backup/operator.local.example.json \
  --config wrangler.jsonc --database DB \
  --epoch <現在のepoch> --directory <世代の保存先>
```

remoteは[run/dailyと同じ権限・設定](BACKUP_OPERATOR.md)を使う。`--id`は受け取らない。世代IDはControlDOが永続化してから返す。追加取得では、直前の完了世代IDがまだ現在の計画と一致するときだけ次へ進める。同じ要求を再送すると現在の後継世代を返し、未開始・凍結中の世代を置換しない。通常の翌日の日次作成も維持する。

開始・保存・完了の応答を失った場合は同じ引数を再実行する。手動で開始した別世代を引き継いだり、自動cancel/thawを行ったりしない。別runnerが既に後継世代を完成させていた場合は、古い不足数による追加を打ち切って再検査する。競合時の再実行で改めて必要数を決める。

## 不足と破損の扱い

[health](BACKUP_RETENTION.md)で検査完了した場合に限り、実際の不足分を最大5世代まで追加する。5世代があっても最新取得が24時間を超えていれば、新しく1世代を取得する。検査上限で未完了なら追加取得を始めない。同日の完成済み世代が破損していても、それを健全と数えずに新しい世代を補充できる。既存の破損はレポートに残り、5世代を確保できても破損警告を消さない。世代数と鮮度が足りていれば、破損警告だけを理由に追加取得を繰り返さない。

終了コードは最終検査が正常なら0、不足・破損・検査未完了なら2、処理失敗なら1。途中の`maintenance_health`イベントは補充前後の不足数と警告を示し、最後の`command:maintain`のJSONには`completed`、`initial`、`health`、`cleanup`がある。外部監視は非0終了を失敗と扱い、長時間実行や24時間超の未実行も検知する必要がある。`--prune-expired`を指定すると、最終healthが完了・正常・active backupなしの場合だけ[期限切れ世代の自動走査](BACKUP_SWEEP.md)を行う。省略時は削除せず、`cleanup:null`を返す。指定時は走査未完了・破損保留も終了コード2とし、健全性検査の結果は`health`に維持する。回収の接続失敗等は終了コード1となる。特定UUIDの回収には[prune](BACKUP_PRUNING.md)を使う。

## Linuxでの定期起動例

[service](../ops/backup/nextcloud-flare-backup.service)、[timer](../ops/backup/nextcloud-flare-backup.timer)、[環境変数例](../ops/backup/backup.env.example)を用意した。service例は`--prune-expired`で健全性確認後の回収を有効にする。走査が1回の上限を超えた場合は次の定期実行で継続する。repositoryやCIからinstall/enableは行わない。

例はUTC 00:30に起動し、最大5分の分散待機を入れる。`Persistent=true`は停止中に逃した起動を後から1回実行するための設定であり、過去日のsnapshotを生成しない。同じserviceが実行中ならtimerは別instanceを開始しない。仕様は[systemd公式timer文書](https://raw.githubusercontent.com/systemd/systemd/v261/man/systemd.timer.xml)を参照。

導入時は承認済みの環境inventoryを使い、専用利用者`ncf-backup`、書込み可能な状態保存先とhome、固定したNode版・依存導入済みの`/opt/nextcloud-flare`、D1/Worker descriptor、R2資格情報、現在のepochを準備する。例のpathを実環境に合わせる。`backup.env`はhost側で制限した権限のファイルとして配置し、実secretをrepositoryへ保存しない。環境変数例のepochは空欄であり、設定前は開始できない。

`TimeoutStartSec=infinity`は大きな抽出をsystemdの起動期限だけで強制終了しないために明示する（[公式service文書](https://raw.githubusercontent.com/systemd/systemd/v261/man/systemd.service.xml)）。長時間実行は外部監視で検知する。終了コード2を`SuccessExitStatus`で正常へ変更しない。通知先は別途接続する。現時点でtimerは未設置で、remoteの実行も未検証である。

設定の構文確認には`systemd-analyze verify ops/backup/nextcloud-flare-backup.service ops/backup/nextcloud-flare-backup.timer`を使う。これは起動試験や認証確認ではない。hostへの設置・起動前に、実設定で単発実行して正常終了、失敗通知、再実行、日付変更を確認する。

強制終了でローカルの`<UUID>.lock`が残った場合は、同じ世代の実行者が終了したと確認してから運用者が除去する。単なるタイムアウトではlockを回収しない。既存のローカル世代は残し、R2公開済みなら同じmanifestから再開する。詳細は[中断・再実行](BACKUP_OPERATOR.md#中断再実行)。
