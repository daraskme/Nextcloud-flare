# 復元後の予約epoch採用

更新: 2026-09-28

`adopt-epoch`は[隔離snapshot検証](DATABASE_RESTORE_SNAPSHOT.md)に続いて、予約済みepochをD1へ書き込み、指定先から新しい停止tokenを独立に読み返してからControlDOへ採用する。採用後も復旧hold・maintenance・GC停止を保持する。通常の`bumpEpoch`を使用せず、番号を再予約しない。

```sh
pnpm database:restore adopt-epoch --remote --operator-config restore-operator.json \
  --config <対象Workerの設定> [--environment <Wrangler環境名>] \
  --epoch <元のDO epoch> --id <同じ復旧要求UUID>
```

private `database-restore-v1`権限と`RESTORE_OPERATOR_ENABLED=true`が必要。最初のD1書込みには`RESTORE_WRITE_ENABLED=true`も必要で、既定は無効。既に開始した要求の読戻し・採用はフラグを無効化しても可能。CLIは`beginAdoption`と`attestAdoption`を使用し、tokenを通常出力へ含めない。採用後のinspectにも元のepochと同じ要求IDを使用し、`newEpoch`で採用した番号を確認する。

## D1停止とDO採用

1. 未失効のsnapshot証言、元の実行結果・対象3binding、DOの旧epoch、KDF/R2/maintenance/backup hold、予約したR2履歴のnative終了と内容一致を確認する。control全列・schema・catalogueを再読取りし、証言の観測と一致させる。
2. 同じ要求に対する不変の採用intentをDOへ保存する。新しいUUID token、予約epoch、対象3binding、期待するcontrolのhash、KDF待機期限の下限を固定する。以後、新しいsnapshot challengeや通常cancelを拒否する。
3. controlの全列を`IS ?`で比較する単一D1 batchを送る。復元されたrestore freezeをその列だけ、backup freezeをそのflagだけ解除し、backup tokenを外す。各変更は同じtransaction内で完了し、後続失敗時は凍結解除もrollbackする。
4. 同じbatchで予約epoch・新admission token・revision 0・maintenance/GC停止・operator GC停止を設定し、GC holdを外す。古いmutation admissionを閉じ、open permitを失効し、claimed operationだけをstaleとして失敗させる。committed/failed operation、backupの履歴・terminal receipt、KDF/R2の実行証拠は変更しない。古いbackup行の後処理は別の復旧作業となる。
5. epoch変更の既存トリガーがKDF待機期限をD1実行時刻に基づいて延長するため、この列は固定下限以上を要求する。他のcontrol列は期待hashと完全一致させる。待機期限の短縮は拒否する。
6. CLIが固定済みWrangler設定からcontrolを独立に読み、新tokenを含むhashとKDF下限を照合する。設定変更や30秒の読戻し期限超過は採用証言を送らない。DOもR2履歴とD1 controlを再照合する。各DO RPCは25秒で打ち切る。
7. DOの単一local transactionで新epochを公開し、admissionをclosed・revision 0・同tokenへ設定し直す。監査記録をリセットし、採用記録を確定する。凍結中のmaintenance制限を解除して既存の停止中repair/監査へ進めるが、復旧hold自体は残す。通常受付、GC再開、次epoch発行、新しい復旧要求は許可しない。

schema 0037以降の信頼済みprefixを扱う。0040より前のsnapshotにはrestore freeze列を要求せず、自動migrationを行わない。古いschemaへ現行repairを適用する前のmigration計画は別途必要。

## 応答喪失と再実行

| 公開状態 | 意味 |
|---|---|
| adoption_pending | intent保存済み。D1 batchの結果が未確定または失敗。再送せず停止を維持 |
| adoption_written | 実batch成功、または同transactionの停止markerを読戻しで確認済み。DOはまだ旧epoch |
| epoch_adopted | 独立読戻しの証言とDO側の再確認後、DOにも予約epochを採用済み |

同じ要求の再実行は、保存したmarkerを読むだけでD1 batchを再送しない。markerは全D1変更と同じ原子transactionに入るため、その一致は当該SQL transactionのcommitを示す。R2 PUTの終了をGETから推測する仕組みとは別である。遅れた実成功はD1成功receiptだけを保存し、期限切れの呼出しからDO epochを公開しない。採用完了後の再送は保存済み状態を返す。

intent保存直後の停止、SQL拒否、markerの不一致ではpendingを自動的に消さない。安全な中止・再試行権の発行は未実装。独立読戻し前やDO公開前に止まった場合も、同じIDで再実行する。

## 残る工程

この処理は停止状態でのepoch採用であり、検証後の全行不変性や全外部I/O終了を新たに証明するものではない。旧epochのSQLをfenceするが、過去に開始したR2/暗号処理の終了を捏造しない。保留中のKDF/R2記録を残したまま監査・修復へ進め、全監査と運用証明がそろうまでサービスを再開しない。

復旧holdの最終解除、全監査・R2実体/会計照合・段階再開へのoperator接続、native不明/旧実装/全DO喪失時の終了証明、安全な中止、logical import、大規模DBの再開cursor/RTO、実Cloudflare復旧ドリルは未完了。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照する。
