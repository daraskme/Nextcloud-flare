# 復旧準備とSQL検証の運用コマンド

更新: 2026-09-26。`pnpm database:restore`を[復旧準備](DATABASE_RESTORE.md)と[復旧元照合](DATABASE_RESTORE_SOURCE.md)へ接続した。logical世代を固定し、全SQLを隔離SQLiteへ復元して検証し、その結果をControlDOに保存する。稼働系D1の上書き、最終停止、新epoch発行・採用、受付再開は次の工程である。

## 専用の権限

main Workerのnamed entrypoint `DatabaseRestoreOperator`に、`prepare/inspect/verify/attest/challengeD1/attestD1/cancel`を追加した。HTTPのfetchは404で、任意SQLや外部restore、ControlDOのrecover/resumeは受け付けない。

targetの`RESTORE_OPERATOR_ENABLED=true`と、呼出し元service bindingの`props.purpose=database-restore-v1`、`props.environment=targetのENVIRONMENT`の一致が必要。既存の`BACKUP_OPERATOR_ENABLED`や`logical-backup-v1`だけでは復旧準備を操作できない。標準wrangler.jsoncでは復旧権限を有効にしない。

SQL検証の証言をするため、このcapabilityは信頼された検証者にだけ渡す。`attest`は受け取ったhashからSQL検証の実行を独立に証明するAPIではない。利用者が渡したhashをそのまま転送するHTTP窓口を作らない。CLIは固定のentrypoint/purposeを持つ一時設定を生成し、`RESTORE_CONTROL`一つだけを接続する。

## コマンド

対象ControlDOは初期化済みで、現行epochと保存済み完了世代のid・epoch・manifest hashが既知であること。復旧要求用UUIDは世代IDとは別に一度生成し、応答喪失後も同じ値で再送する。

descriptorは`{"service":"next-cloud-flare-local","environment":"development"}`形式。localでは同じ端末のWrangler dev登録を使い、remote bindingは無効。remote descriptorには明示的な`accountId`も必要で、Wrangler認証を使う。

```sh
pnpm database:restore prepare --local --operator-config restore-operator.json \
  --epoch <現在のepoch> --id <復旧要求UUID> \
  --source-id <完了世代UUID> --source-epoch <保存時epoch> \
  --manifest-sha256 <完了記録のhash>

pnpm database:restore verify --local --operator-config restore-operator.json \
  --config <対象Workerの設定> --epoch <現在のepoch> --id <同じ復旧要求UUID>

pnpm database:restore inspect --local --operator-config restore-operator.json \
  --epoch <現在のepoch> --id <同じ復旧要求UUID>

pnpm database:restore cancel --local --operator-config restore-operator.json \
  --epoch <現在のepoch> --id <同じ復旧要求UUID>
```

`prepare`は通常書込みとGCを止める。`inspect`は保存された要求を読む。`cancel`は準備だけを取り消し、受付とGCは停止を維持する。失敗時に自動でcancelや再開はしない。

`verify-d1 --config <対象設定>`を追加した。新しい停止tokenを発行して、CLIから独立に読んだDBがWorkerのDB bindingと一致することを照合する。毎回再検証し、対象と5分以内の観測をControlDOへ保存する。SQL検証とは別工程で、`verify`と順に実行する。詳細は[DATABASE_RESTORE_TARGET](DATABASE_RESTORE_TARGET.md)。

remoteの`verify`は`--remote`を指定し、`--config/--environment`を受け取らない。BACKUPSの読取りには既存の`R2_BACKUP_*`設定を使う。CLIはR2へ書き込まない。remote認証・実resourceでの検証と配備は未実施。

## SQL検証と保存する証言

`verify`は保存済みのlogical要求だけを使い、次の順に実行する。

1. ControlDOに最大100回問い合わせ、サーバーに保存された位置からR2部品を検証する。未完了なら`complete:false`と終了コード2を返す。同じコマンドを再実行して続きを処理する。
2. 全部品が一致したら、選択したmanifest hashを必須にしてR2から一時ディレクトリへ全SQLを取得する。`downloadGeneration`の既存検証を再利用し、信頼済みmigration列、保存時schema、SQL全体hash、全tableの内容、FK、FTS再構築、保存時の凍結状態を隔離SQLiteで検証する。外部SQLをそのまま実行せず、許されたINSERT値だけを取り込む。
3. generation epoch・part数・作成時刻由来の期限もサーバー結果と照合する。
4. 同じ復旧要求とhashで`attest`を送る。サーバーは全R2部品の完了を要求し、完了receipt・manifest・停止mirror・35日期限を再確認する。取消し、停止revision変更、期限超過、古いepochなら保存しない。

ControlDO SQLiteの`control_database_restore_sql`に、要求ID・epoch・manifest hash・サーバー検証時刻・世代の期限・検証方式`logical-sql-v1`を保存する。D1を巻き戻してもこの記録は巻き戻らない。同じ要求への再証言は時刻を後退させず、別世代へ置き換えない。INSERTの成否はRETURNING行で判断し、索引更新を含むrowsWrittenを変更件数と取り違えない。

成功結果は`state:sql_verified`と`complete:true`。これはSQL検証工程の完了であり、復旧全体の完了ではない。停止中repairの終了、BLOBSとの対応確認、新epoch予約、実D1上書き・採用・全監査が必要。manifest/SQLの一致は同じbucket/accountであることの証明にもならない。

1 RPCの待機は最大60秒。応答喪失では結果不明として同じ要求を照会・再実行する。再実行時も全SQL検証を通してから同じhashを証言する。過去の成功結果だけで検証を省略しない。Time Travel要求は照会・取消しできるが、CLIからの新規準備とbookmark検証・復元は未接続。

## ローカル検証

Node試験は実SQLの復元と改変・不正SQL・schema/table不一致、100 step継続、誤った応答、応答喪失、設定の取り違えと秘密非出力を確認する。workerd試験は不完全な部品・誤hash・期限・取消し・停止revision競合・保存失敗・再起動と内部RPCを確認する。

`backup:operator-drill`は実named service bindingで全7操作の拒否境界と、実SQL世代の検証・記録・D1の新しい停止token照合・eviction後再実行を確認する。`backup:run-drill`は実CLIとWrangler dev/getPlatformProxyをつなぎ、prepareの再送、verify、verify-d1の再送、inspect、cancel、元epochと停止維持を確認する。実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。Cloudflare上の実D1復旧ドリルとは区別する。
