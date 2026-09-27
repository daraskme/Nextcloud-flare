# Time Travelの一度限りの実行と結果記録

更新: 2026-09-28

`apply-time-travel`をprivate operatorとCLIへ接続した。復旧要求に固定したDB/bookmarkへ1回だけPOSTし、実際の成功応答をD1の巻戻し対象外にあるControlDOへ記録する。これは復元内容の検証や新epochの採用を完了するコマンドではない。成功後も旧epochとmaintenance/GC停止を保持する。後続の[verify-restored](DATABASE_RESTORE_SNAPSHOT.md)は全通常tableの隔離検証と観測保存まで接続済み。

既定では`RESTORE_WRITE_ENABLED`を設定せず、送信を拒否する。今回の接続はローカルfixtureで検証する開発段階である。[snapshot照合](DATABASE_RESTORE_SNAPSHOT.md)と[停止中epoch採用](DATABASE_RESTORE_ADOPTION.md)は接続済み。native結果不明・旧実装・DO全storage喪失時を含む外部I/O全終了の運用証明、未終了処理の全ケースの修復、実Cloudflareドリルは未完了。[全監査・hold解除・段階再開](DATABASE_RESTORE_RECOVERY.md)はローカル検証用に接続済み。これらのrelease gateを閉じるまで実環境で有効化しない。フラグの設定自体はI/O終了証明にならない。

## 呼出しと前提

```sh
pnpm database:restore apply-time-travel --remote --operator-config restore-operator.json \
  --config <対象Workerの設定> [--environment <Wrangler環境名>] \
  --epoch <旧epoch> --id <復旧要求UUID> \
  --timestamp <verify-bookmarkで固定した明示UTC時刻>
```

prepare → verify-bookmark → freeze → [reserve-epoch](DATABASE_RESTORE_EPOCH.md)が先行する。同じ要求IDと同じ時刻を使う。対象Workerの`RESTORE_OPERATOR_ENABLED=true`、private `database-restore-v1`権限に加え、送信時は`RESTORE_WRITE_ENABLED=true`を必要とする。CLIの実POSTには`CLOUDFLARE_API_TOKEN`が必要。OAuth、別URL、任意SQL、ローカルモードへの切替えは受け付けない。通常のBackupOperatorと公開HTTPからは利用できない。

CLIはD1/BLOBS/BACKUPSの設定とoperator設定を固定し、変更を各境界で拒否する。WranglerのTime Travel infoを元の時刻で再実行し、選択bookmarkとの一致を確認する。DOはこの観測を30秒以内に限り受け付け、epoch予約に保存された元の時刻とも照合する。

DOは同じ予約のnative履歴PUT終了とR2 record、D1凍結mirror、DO内のKDF/R2/maintenance/backup hold、D1の最終停止条件を再確認する。preflight全体は25秒以内で、非同期処理の後に要求と予約を再検査する。これらは現行の記録済み実行に対する検査であり、失われた旧実行の終了を推測しない。

## 永続状態

`control_database_restore_execution`はDO SQLiteに置く。要求ID、旧epoch、新epoch、対象3binding、bookmark、元の時刻、送信token、発行/失効時刻を固定したgrantを、呼出し元へ返す前に`pending`として保存する。grantの送信期限は5秒。HTTPへの送信直前に期限を検査する。

| 公開状態 | 意味 | 再実行 |
|---|---|---|
| epoch_reserved | まだ実行grantを発行していない | preflightを再試行できる |
| restore_pending | grantを発行済み。送信の有無やprovider結果が不明な場合も含む | 新しいgrant・POSTを拒否する |
| restore_written | 元の実POSTから得た成功応答を保存済み | 保存済み結果だけを返す |

grantの応答喪失、発行後の設定変更、期限切れ、ネットワーク切断、異常応答ではpendingと復旧holdを残す。再起動や時間経過、DBの読戻しを使って「未送信」「終了済み」と扱わない。取消し・予約番号の変更・自動再送は行わない。安全な中止や結果不明の運用解消は別途未実装。

## Providerとの境界

送信先は固定の`https://api.cloudflare.com/client/v4/accounts/<account>/d1/database/<database>/time_travel/restore?bookmark=<selected>`。ネイティブfetchを1回だけ呼び出し、redirectは追従せず、自動retryを行わない。全体の待機は60秒、応答本文は16KiB/10秒に制限する。timeout時のabortは結果不明を解消しない。

HTTP 200、`success: true`、妥当な`result.bookmark`と`result.previous_bookmark`をすべて受け取った場合だけ、専用`finishTimeTravel`でDOに記録する。Cloudflareの[公式API仕様](https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/methods/restore/)では、前者は復元後、後者は復元直前のbookmarkである。そのため、復元後bookmarkと選択した過去bookmarkの文字列一致は要求しない。[Time Travelの説明](https://developers.cloudflare.com/d1/reference/time-travel/)にあるとおり、実復元はDBを置き換える破壊的操作である。

finishは全grantを保存済みの値と比較し、同じ成功応答の再記録だけを許す。D1にアクセスしないため、復元後のschemaが異なる場合でも結果を記録できる。送信フラグを無効化した後や期限経過後も、元grantの実応答を記録できる。遅延応答の記録はプロセス/RPCが利用可能な場合に限られ、終了したCLIからの記録を保証しない。保存ACKを失った場合は同じIDをinspectし、providerへ再送しない。

CLI出力にはtoken、認証情報、providerの自由形式message/bodyを含めない。inspectは旧epoch、新epoch、復旧元、状態と保存済みbookmark2個だけを公開する。

## 検証の範囲

ローカル試験は実workerdのD1/R2/DOと、合成provider応答を使う。実private service bindingの運用ドリルではD1 control行の巻戻しを模擬し、旧DO epoch・停止維持・結果記録・再送拒否を確認する。これは実CloudflareのTime Travelでも、全snapshotの復元でもない。remote resource、migration、deploy、実POSTは行っていない。

復元後snapshotの読取り照合は接続済みだが、その結果は継続した書込み障壁ではない。元snapshotのbackup/restore token処理、予約epochの採用、全監査と再開は後続。検証件数と実行結果の正本は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。
