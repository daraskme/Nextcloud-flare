# バックアップ運用コマンド

更新: 2026-09-25。`pnpm backup daily`がサーバーで管理する日次世代、`pnpm backup run`が明示した世代の開始→抽出→SQL検証→R2保存→完了記録を実行する。`receipt`は履歴照会、`cancel`は明示的な中止である。`health`は[保持判定と健全性検査](BACKUP_RETENTION.md)を実行する。元BLOBSの削除猶予は[GC保護](BACKUP_GC_PROTECTION.md)を参照。期限切れ世代の自動回収は[sweep](BACKUP_SWEEP.md)に接続済み。定時起動の設置・live restoreは別工程。

## 呼出し権限

`BackupOperator`はmain Workerのnamed entrypointで、`daily/begin/complete/cancel/receipt/inventory/replenish/prune/sweep`を公開する。inventoryは読取り専用、pruneは[期限切れの指定世代を回収](BACKUP_PRUNING.md)し、sweepは永続cursorを使って全世代を走査する。通常のHTTP handlerにはrouteを追加せず、entrypoint自身のfetchは404を返す。任意SQLやControlDOのrecover/resume/repairは提供しない。一般のAccess service principalやapp passwordの権限は変更しない。

呼出し元が持つ専用service bindingをcapabilityとして扱う。[Cloudflare RPCの権限モデル](https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/)と[named entrypoint](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/#named-entrypoints)に従い、bindingの付与を運用者に限定する。target側は`BACKUP_OPERATOR_ENABLED=true`を明示した場合だけ受け付け、bindingの`ctx.props.purpose=logical-backup-v1`と`ctx.props.environment=ENVIRONMENT`を全操作で検査する。propsは秘密鍵ではなく、環境inventoryに含むbinding設定である。このcapabilityを未信頼Workerへ渡したり、利用者入力をそのまま転送するHTTP窓口を作ったりしてはならない。

CLIは[Wrangler getPlatformProxy](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy)で専用bindingへ接続する。小さなJSON descriptorから一時的なWrangler設定を作り、`BACKUP_CONTROL`一つだけを設定する。追加resourceや任意entrypointは受け付けない。localはremote bindingsを明示的に無効にし、同じ端末で稼働中のWrangler dev登録を使う。remoteは明示したaccountとWranglerのCloudflare認証を使う。remote認証・権限・実resourceの検証と配備はまだ行っていない。

## 実行

対象ControlDOは既に初期化済みで、epochが既知であること。バックアップコマンドはepochを新規発行しない。targetの`BACKUP_OPERATOR_ENABLED`は既定で未設定・無効であり、運用環境の設定で有効にする。

localのdescriptor例は`scripts/backup/operator.local.example.json`。対象Workerの`ENVIRONMENT`と一致させ、同じWorkerをWrangler devで起動しておく。

```sh
pnpm backup run --local \
  --operator-config scripts/backup/operator.local.example.json \
  --config wrangler.jsonc --database DB \
  --id <新しいUUID> --epoch <現在のepoch> --directory <世代の保存先>

pnpm backup receipt --local \
  --operator-config scripts/backup/operator.local.example.json \
  --id <同じUUID> --epoch <同じepoch>
```

remote descriptorは`{"service":"<対象Worker名>","environment":"production","accountId":"<32文字のaccount ID>"}`。`--remote`、対象D1を持つ`--config/--database`と必要に応じた`--environment`、[R2保存用環境変数](BACKUP_GENERATIONS.md)を明示する。descriptorのenvironmentは対象WorkerのENVIRONMENTであり、Wranglerの`--environment`とは別の照合値である。target D1とBACKUPSの組合せが違えば凍結token・世代・実object照合で完了を拒否する。

## 中断・再実行

- 実行前にUUIDとepochを保存し、応答喪失後も同じ引数を使う。自動で別UUIDへ切り替えない。
- 完成したローカル世代があれば全SQL検証を通して再利用し、既存R2 part/manifestを照合する。ControlDOがcompleting中でもbeginをやり直さず、同じhashで完了を再照合する。
- ローカル世代を失っても、未完了のD1 receiptとR2の公開済みmanifestがあれば、全part・SQLを検証して同じ世代を復元する。beginや再抽出をせず、そのmanifestのhashで完了を再照合する。R2が欠落・改変されていれば停止する。
- D1にcompletedがあってもControlDOへの同じcomplete呼出しを行い、未処理の完了intentと受付状態を収束させてから成功する。次の世代を開始済みなら古いrunは競合しうる。古い世代の参照にはreceiptを使う。
- 1 RPCは最大60秒で呼出し元が待機を打ち切る。これは処理取消ではなく結果不明である。自動cancelや自動thawは行わない。SQL検証/保存/完了が失敗したら原因を直して同じ世代を再実行する。
- 中止が必要なら`pnpm backup cancel --local|--remote --operator-config ... --id ... --epoch ...`を明示して実行する。completing intent中は中止できず、completeの再照合で収束させる。中止済み世代はfailedとなり、後から完成へ昇格しない。
- captureの排他lockは通常終了/例外時に削除される。プロセスの強制終了で残った`<UUID>.lock`は、同じ世代の実行者が終了したと確認してから運用者が除去する。タイムアウトだけでlockを自動回収しない。

manifest hashの証言とControlDOの完了判定は[BACKUP_COMPLETION](BACKUP_COMPLETION.md)を参照。保存完了はBLOBS本体の保護やlive復旧の完了を意味しない。

## 日次実行

定時運用には、日次処理と検査・補充を一連に行う[maintainコマンド](BACKUP_MAINTENANCE.md)も利用できる。

```sh
pnpm backup daily --local \
  --operator-config scripts/backup/operator.local.example.json \
  --config wrangler.jsonc --database DB \
  --epoch <現在のepoch> --directory <世代の保存先>
```

`daily`は`--id`を受け取らない。ControlDOがUUID・epoch・計画時刻をSQLiteの1行に保存してから返す。開始前の応答喪失や日付変更、別runnerからの再実行でも、未完了の同じ世代を使う。D1 receiptがまだないpreparing intentも引き継ぐ。手動で開始した別世代は引き継がず、競合として停止する。

日の境界はサーバーのUTC時刻で判断する。同じUTC日に取得した完了世代があれば、D1の完了記録とhashを照合し、R2から全データを取得してSQL・schema・FK・FTS検査を通したときだけ`skipped:true`で成功する。ローカル時計やファイルの有無で省略しない。日をまたいで完了した世代は元の取得日に属し、次の呼出しで当日の新しい世代を作る。取り逃した過去日のsnapshotを作ったことにはしない。

明示的にcancelしてfailed/releasedが確定した場合は新しいIDで再試行できる。単独releaseによる未完了行や、D1に未完了行があるのにDOの権威がない場合は自動的に置換しない。epoch変更後は開始前の古い計画を置換できるが、旧epochの開始要求は拒否する。

コマンドは1回の実行で終了する。定時起動のschedulerはまだ設置していない。運用時は同じ設定で定期起動し、失敗を通知して原因解消後に再実行する必要がある。最大35日・最少5世代・最新24時間の判定は[health](BACKUP_RETENTION.md)で行う。不足はJSONと終了コード2で報告する。不足と鮮度の自動補充は[maintain](BACKUP_MAINTENANCE.md)へ接続した。期限切れ世代の自動走査は[sweep](BACKUP_SWEEP.md)と`maintain --prune-expired`へ接続済みである。外部通知先は未接続である。指定UUIDの回収は[prune](BACKUP_PRUNING.md)へ接続済みである。schema0039・通常67tableは変わらない。

## 検証

Node試験は日次再実行・保存済みデータの欠落/改変・ローカル喪失からの復元、保存/開始/完了の失敗、ACK喪失後の再照合、不正receipt、複数part、設定の取り違えと期限を検査する。workerd試験はUTC日付変更、eviction、開始前の障害、同時要求、手動世代との競合、epoch変更を検査する。`backup:operator-drill`はdailyを含む実named service bindingの権限/環境/無効化、実ControlDO/D1/R2によるrun、eviction再送、取消・履歴、隔離復元のFTS/会計を検査する。`backup:run-drill`は実Wrangler dev登録とgetPlatformProxy、実CLI daily/run/receipt/download/restore-offlineをつなぐ。従来の`backup:drill`は独立したcapture/publish/downloadコマンドも維持する。

最新の実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。全ドリルは隔離したlocal fixtureであり、remote Cloudflareの認証・配備・全storage喪失・Time Travelの証明ではない。
