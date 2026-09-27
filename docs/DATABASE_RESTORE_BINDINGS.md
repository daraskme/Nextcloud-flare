# 復旧先D1・BLOBS・BACKUPSの一括照合

更新: 2026-09-27。`verify-backups`はBACKUPS bindingと運用側S3接続の対応を確認し、`verify-bindings`はD1・BLOBS・BACKUPSを一つの新しい停止challengeへ結び付ける。固定された対象、今回の試行、期限内の観測が一致した場合だけ結果を返す。実D1の上書きや受付再開はまだ行わない。

## 操作と設定

[復旧準備CLI](DATABASE_RESTORE_OPERATOR.md)で同じ要求IDを`prepare`した後、次を実行する。

```sh
pnpm database:restore verify-bindings --remote --operator-config restore-operator.json \
  --config <対象WorkerのWrangler設定> [--environment <Wrangler環境名>] \
  --epoch <現在のepoch> --id <復旧要求UUID>
```

BACKUPSだけを検査する場合は`verify-bindings`を`verify-backups`へ変更する。いずれも明示的な`--remote`と対象設定を要求する。logical世代とTime Travel候補の両方を受け付けるが、SQLやbookmarkの検証を代替しない。

- 専用の`database-restore-v1` service binding権限と、対象Workerの`RESTORE_OPERATOR_ENABLED=true`が必要。
- 対象設定のaccount・Worker名・環境・一つの`DB` bindingを[D1照合](DATABASE_RESTORE_TARGET.md)と同じ条件で固定する。
- `BACKUPS` bindingのbucket名とjurisdiction（省略時`default`）を固定し、CLIの`R2_BACKUP_ACCOUNT_ID`・`R2_BACKUP_BUCKET`・`R2_BACKUP_JURISDICTION`と照合する。D1と同じaccountが必要。
- CLIは既存の`R2_BACKUP_ACCESS_KEY_ID`・`R2_BACKUP_SECRET_ACCESS_KEY`でS3 GETに署名する。BACKUPS照合のためにWorkerへS3秘密値をコピーする必要はない。この検査ではCLIのS3書込みは使わない。
- 一括照合には一つの`BLOBS` bindingも必要で、BLOBSとBACKUPSの対象は異なるbucketを要求する。BLOBS側は[既存のWorker用R2_INVENTORY設定](DATABASE_RESTORE_BLOBS.md)を使う。

CLIはaccount・対象・S3設定の不一致を復旧RPCの前に拒否する。設定ファイルとoperator descriptorが途中で変わった場合も拒否する。D1独立queryの一時設定にはR2 bindingsや秘密値を含めない。

## BACKUPSの照合プロトコル

1. CLIは毎回新しいD1停止challengeを独立queryで照合する。
2. `challengeBackups`は復旧要求・epoch・D1対象・BACKUPS対象をDOへ固定し、以前の観測を無効にする。Workerだけが生成した256-bit nonceを64文字の本文として使い、期待値は返り値に含めない。
3. WorkerはBACKUPSの固定key `sys/restore/binding-probe-v1`を読む。既存objectはsize・専用metadata・本文を検査し、取得したETagを条件に一度だけPUTする。新規作成は`If-None-Match: *`を使う。
4. CLIが同じ固定keyをS3 GETで読み、64-byteのhex値を`attestBackups`へ渡す。S3読取りは10秒・64 bytesまで。任意keyの読取り・PUT許可を広げず、既存backup storeへ専用の固定key GETだけを追加している。
5. Workerは保存した秘密のnonceと照合し、BACKUPSからobjectを再読取りする。本文だけでなくPUT時のETag/versionとの一致、現在のD1停止状態を確認して、観測保存とlease解放を一つのDO transactionで行う。

対象と試行はDO SQLiteの`control_database_restore_backups`、共有leaseと呼出し予算は`control_restore_backups_probe`へ保存する。probeは最大1個・64 bytesのsystem枠として`allocated_bytes=64`を保持し、利用者のquotaへ混ぜない。BACKUPSの世代容量・epoch履歴と同様、運用上のbucket容量に含める。現schemaは0045、通常68table。

各PUTを`backups.probe.put`としてDO/D1へ送信前から記録する。元の復旧要求・試行・nonce・bucket・期待ETagと停止challengeを再検査し、nativeが成功して終了記録を反映してからchallengeを返す。grant応答の喪失では送信せず保留を保持する。送信直前の取消しはnot_started、送信後の取消し・timeoutでは遅れた実終了だけを反映する。条件不成立のnullもnativeの終了事実として扱う。詳細は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)。

このkeyは成功・失敗・取消しで削除しない。条件付きPUTと恒久objectにより、遅れた初回createや旧ETagによる更新が、後から成功した新しい検証値を上書きすることを防ぐ。バックアップ世代と`sys/epoch/`は変更しない。R2の[条件付きPUTと整合性の契約](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)に依存する。

## 同じ停止状態での一括照合

`verify-bindings`はD1 challengeを一度だけ発行し、同じchallengeでBLOBS、BACKUPSを順に照合する。最後に`verifyBindings`が現在のD1 mirrorを再読取りし、DOに保存された両方の成功記録と、CLIが受け取った正確な試行IDを同期的に照合する。古い試行、別のchallenge、未確定の片方、期限切れは拒否する。

結果は`state:bindings_verified`、`validator:restore-bindings-v1`、D1対象、challenge ID/revision、両bucketの対象・試行ID・観測時刻、短い方の期限。停止token・nonce・credentialsを成功出力へ含めない。BACKUPS単独は`state:backups_verified`を返す。

この結果は、同じ停止状態で行った接続先の観測である。終了証明を失ったR2/KDF/job/repairの不存在や、復元元SQL/bookmarkの最終確認は別工程。`verify-d1`・`verify-bookmark`などで新しい停止challengeを作った後は、過去の一括照合を再利用しない。

## 期限と失敗時の扱い

BACKUPSの観測・leaseは発行から60秒とD1 challenge期限の短い方に固定し、RPC一回の処理は最大25秒。GET/PUT/確認GETは通常操作と同じ32 active/256 waitingの共通受付を使い、各D1予算batchの直接ACK後だけ開始する。応答喪失後のreceipt読戻しから外部操作を許可しない。

取消し・epoch/停止変更・時計逆行・対象/試行変更・timeoutがあれば、await後の再検査で後続処理を止める。保存が拒否または無視された場合も成功を返さない。結果不明ではleaseと64-byte枠に加え、各native PUTのpendingを保持する。leaseが残る間の再試行は拒否し、期限後に同じ復旧要求IDで新しいchallenge/nonceを使って検査し直す。新しい接続確認が成功しても古いpendingは解消せず、復旧凍結・受付再開を拒否する。停止やGC pauseは自動解除しない。

## 検証範囲と次の工程

Node試験はS3署名・固定key・body/時間上限、対象設定、CLI境界、返り値検査と一つのchallengeでの実行順を確認する。workerdは実D1/DO/R2でeviction、対象固定、取消し、budget ACK喪失、停止変更、保存/lease解放の原子的rollback、遅延PUTのCAS、現在の試行の組合せを検証する。named service bindingドリルは全12復旧操作の権限拒否と一括照合・再起動後再検証を確認する。実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。

S3とTime Travelのprovider応答はローカルfixtureで模擬し、実Cloudflareへの接続・復元・配備は未実施。後続の[D1書込み凍結](DATABASE_RESTORE_FREEZE.md)を追加し、修復の新規受付拒否・全通常table guard・応答喪失後の再照会と取消しを接続した。現在のドリルはfreezeを含む13操作を検証する。R2/KDF/job/repairの全終了証明、新epoch予約、実D1上書き・採用・全監査・段階再開は未完了。BLOBS本体の独立バックアップ、ControlDO全storage喪失からの復旧も未完了。
