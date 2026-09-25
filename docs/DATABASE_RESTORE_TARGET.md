# 復旧先D1の照合

更新: 2026-09-26。`pnpm database:restore verify-d1`は、CLIが指定したD1とControlDOのDB bindingを、新しく発行した停止tokenで照合する。対象と観測結果はControlDO SQLiteに保存する。D1上書きや受付再開の許可ではなく、BLOBS/BACKUPSの対応確認も別工程である。

## コマンドと設定

同じ復旧要求が`preparing`で、停止処理が完了していること。先に[復旧準備CLI](DATABASE_RESTORE_OPERATOR.md)の`prepare`を実行する。SQL検証とD1照合は別の証言であり、片方の成功はもう片方の代わりにならない。

```sh
pnpm database:restore verify-d1 --local --operator-config restore-operator.json \
  --config <対象WorkerのWrangler設定> [--environment <Wrangler環境名>] \
  --epoch <現在のepoch> --id <復旧要求UUID>
```

remoteは`--local`を`--remote`へ変更する。operator descriptorの明示`accountId`と対象設定の`account_id`の一致が必要。両modeとも解決されたWorker名、`vars.ENVIRONMENT`、一つの`DB` bindingを確認する。Wranglerの別設定へのredirectは拒否する。localは設定ファイルと同じディレクトリの`.wrangler/state`を使用し、独自の`--persist-to`で起動した開発サーバーは対象外。

CLIはDBのUUIDとmode、remoteの場合はaccount IDを固定した最小の一時設定を作る。DB以外のbindingや元のWorkerコードをコピーしない。外部D1への操作は固定の`SELECT`一つで、最大30秒・出力1MiB。remoteのaccountは子プロセスにも固定し、localへremoteを自動補完しない。元の設定とoperator descriptorはquery前後でbyte一致を確認する。一時設定は終了時に削除する。

## 検証と永続化

1. 要求の`preparing`状態を確認する。`challengeD1`は対象descriptorをDOに固定し、過去のD1観測を無効にしてからD1停止処理へ進む。以降、同じ要求を別DB・別mode・別accountへ変更できない。
2. 停止済みD1のmirrorが現行ControlDOと一致することを確認し、admission revisionとランダムtokenを更新する。古いsnapshotを現在の停止状態として採用しない。新しいtokenが発行されなければchallengeを返さない。
3. CLIがWranglerから独立にDBを読み、epoch・revision・token・maintenance・GC pause・backup freezeの全項目を照合する。別DBや古いtokenなら証言を送らない。
4. `attestD1`は同じ要求・対象・challenge・停止revision・期限を確認し、Worker側のD1も再読取りする。読取り前後に取消しやrevision変更がないことを確認してから観測時刻を保存する。D1読取りは最大10秒。保存した時刻を後退させない。

`control_database_restore_target`に対象JSON、challenge ID、revision/token、発行時刻、期限、観測時刻を保持する。発行から5分を上限とし、DO再起動後も同じ記録を照合する。取消し後の記録は履歴であり有効な証言ではない。成功出力は`d1_verified`・方式`d1-mirror-v1`と対象・challenge ID・revision・時刻で、停止tokenやquery結果本文を出力しない。D1 migration・通常67tableは変更しない。

このprivate capabilityは信頼された検証者用である。サーバー単独では、CLIが本当に独立queryを実行したか証明できない。`attestD1`へ任意の入力を転送するHTTP窓口を作らない。標準設定では復旧operatorを有効にしない。

## 再実行と残る工程

応答喪失時は同じ復旧要求IDで再実行する。毎回新しいchallengeを発行し、新しい独立queryを実行する。過去の成功結果を再利用しない。停止処理自体が未確定で`closed`になっていない場合は、同じsource・要求IDの`prepare`で既存の停止intentを回復してから再実行する。失敗時に自動で取消し・再開は行わない。対象を誤って固定した場合は、確認後に明示的にcancelし、新しい要求を作る。

照合のための停止更新は既存のsource検証と競合し得るため、`verify`と`verify-d1`は順に実行する。成功したD1観測も、別の停止更新・取消し・期限経過後には使用できない。将来の最終停止と上書き工程は、その時点で対象とauthorityを再確認する必要がある。

R2 bindingの照合、Time Travel bookmarkの検証、R2/KDF/job/repairの終了証明、最終停止、新epoch予約、実D1上書き・採用・全監査・段階再開は未完了。今回のlocal実CLIとservice bindingの成功は、remote認証や実Cloudflare復旧の成功を示さない。検証件数と実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。
