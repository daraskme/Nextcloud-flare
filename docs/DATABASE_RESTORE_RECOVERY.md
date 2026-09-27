# 復元後の監査と段階再開

更新: 2026-09-28

[予約epoch採用](DATABASE_RESTORE_ADOPTION.md)の後、同じ復旧要求を使ってFTS再構築・全監査・hold解除・受付再開・GC再開を進める。ControlDOの既存の監査とadmissionの原子的遷移を使用し、D1のflagsを直接変更しない。

## CLI

すべて元のDO epochと復旧要求IDを使う。対象は既に採用済みの要求に固定されるため、追加のD1設定やbookmarkは受け取らない。private `database-restore-v1`権限と`RESTORE_OPERATOR_ENABLED=true`が必要。最初のhold解除には`RESTORE_WRITE_ENABLED=true`も必要であり、既定では無効。

```sh
pnpm database:restore audit-restored --remote --operator-config restore-operator.json \
  --epoch <元epoch> --id <同じUUID> --max-pages 100 --page-size 10

pnpm database:restore resume-restored --remote --operator-config restore-operator.json \
  --epoch <元epoch> --id <同じUUID>

pnpm database:restore resume-restored-gc --remote --operator-config restore-operator.json \
  --epoch <元epoch> --id <同じUUID>
```

`audit-restored`は開始時または修復で監査が無効になった時に遠隔D1のFTSを再構築し、その後、永続cursorを進める。page sizeは1〜20、1回のCLIのpage数は1〜100。`audit.completed=false`なら終了code 2で、同じコマンドを再実行して続ける。pageの失敗を成功扱いにしたり、自動再送・自動再開したりしない。

復元でpendingへ戻ったKDF/R2は[終了証拠に基づく修復CLI](DATABASE_RESTORE_NATIVE.md)で照合する。続いて[upload・multipart・予約・outbox・GC・孤立走査の修復CLI](DATABASE_RESTORE_DOMAINS.md)を必要な種類ごとに実行する。修復後は監査が無効になり、FTS再構築からやり直す。明示的にやり直す場合は`rebuild-restored-fts`に同じ引数を渡す。これはholdを解除しない。

`resume-restored`は全監査が完了した停止状態からholdを解除して受付を開く。GCは停止したまま。`resume-restored-gc`は受付再開後の別工程であり、最後にGCを再開する。CLIはtokenや監査の内部nonceを出力しない。

## 証明と永続記録

1. 元の復旧要求、採用済みD1/DO epoch、他の復旧要求・backupとの排他を確認する。
2. FTS再構築後のaudit tokenを要求IDへ記録する。users・quota/ref/physical・blob/R2実体・outbox・shares・credentials・FTS・最終停止条件を既存の監査で検査する。監査のやり直しやrepairでtokenが変われば、以前のFTS/監査証明を使わない。
3. hold解除前にDOのKDF/R2未終了、maintenance taskが無いこと、同じ監査がcompleteであること、同じ停止epoch/revision/tokenであることを確認する。予約済みR2履歴のnative終了と内容も再確認する。
4. 同じD1 batchで`RECOVERY_FINAL_QUERY`と正確な停止mirrorをassertする。未終了KDF/R2、旧epoch outbox、permit/claim、予約、upload/GC/inventory等の未解決状態があれば解除しない。復元freeze/backup tokenも空でなければならない。
5. 25秒の期限内でDOの証明を再確認し、単一local transactionでrelease receiptと元要求の`released_at`を保存する。受付・GCのD1 flagsはまだ変えない。元のsource・実行・採用記録を保存し、取消しに書き換えない。
6. 受付再開はrelease時のaudit tokenと停止revision/tokenに限定する。既存admissionのD1 CASと最終fenceを使い、commit応答喪失は同じtransitionを読戻して収束する。新しい停止や監査が先に進んだ場合、古い復旧要求で再開しない。
7. GC再開も最初の呼出し時のrevision/tokenを別途固定する。遅れた再送で新しいGC pauseを上書きしない。完了済みのGC再開を再実行した場合は、追加の変更をせず現在の制御状態を返す。

DOの既存要求tableへnullable `released_at`を追加し、activeの一意制約を未解除の要求に限定する。既存のpreparing/cancelled行は保存する。FTS証明とrelease receiptは別のDO tableに記録する。D1 schemaは0046・通常68tableのままである。

| 公開状態 | 意味 |
|---|---|
| epoch_adopted | 復旧holdを保持。監査・停止中repairが可能 |
| recovery_ready | 全監査と最終fenceに基づいてholdを解除済み。受付はまだ停止 |
| service_resumed | この要求による受付再開を確認済み |
| gc_resumed | この要求による最後のGC再開を確認済み |

後の2状態は履歴であり、後日operatorが停止・GC pauseを行っても書き換えない。再開RPCの`control`は現在の状態を返す。新しい復旧要求が始まれば、古い要求の再開操作は拒否する。

## 残る制約

この経路は既存の全監査で検証可能な復元状態を対象とする。古いschemaは先のsnapshot検証・epoch採用には対応するが、この監査は現行schemaを必要とし、自動migrationはしない。未終了のKDF/R2や未知multipartを期限・HEADだけで終了扱いにしない。multipart inventory・旧backup修復のprivate operator接続、未知処理の全ケースの収束、旧実装/全DO喪失時の外部I/O終了証明、logical import、安全な中止、大規模DBのRTOは引き続き未完了。

実Cloudflareでの復元・再開は未実施。ローカルの合成providerとD1 control巻戻しによる通し試験は、実Time Travelや本番運用証明の代わりにはしない。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。
