# 復旧要求に結び付けたD1書込み凍結

更新: 2026-09-27。`freeze`は現在のD1/BLOBS/BACKUPS照合を受けて、D1全通常tableへの書込みと新規repair受付を停止する。外部R2処理の全終了、新epochの予約、D1上書き許可は別工程で、まだ接続していない。

## コマンド

[復旧準備](DATABASE_RESTORE_OPERATOR.md)で作った同じ要求IDを使う。

```sh
pnpm database:restore freeze --remote --operator-config restore-operator.json \
  --config <対象WorkerのWrangler設定> [--environment <Wrangler環境名>] \
  --epoch <現在のepoch> --id <復旧要求UUID>
```

初回は[一括照合](DATABASE_RESTORE_BINDINGS.md)と同じ設定・S3資格情報を使い、一つの新しい停止challengeで3 bindingを照合する。既存の`freezing`/`frozen`要求を再送するときは新しいchallengeやprobeを作らず、元のD1対象・両bucket・要求IDを照合して、保存済みの凍結を再確認する。途中の設定変更は失敗にする。

成功出力は`state:frozen`、`validator:d1-write-freeze-v1`、要求・選択値・対象・開始/凍結確認時刻だけで、停止token・凍結token・nonceを出力しない。現在のソースSQL/bookmarkの検証を、このコマンド単独で行ったとは扱わない。

## 永続化とDB側の拒否

| 状態 | 意味・再送 |
|---|---|
| `preparing` | 通常書込み停止。保留を精算するrepairは継続可能 |
| `freezing` | DOに要求・元challenge・両bucketの正確な試行・凍結tokenを保存済み。通常更新とrepairの新規受付を拒否。D1確定は未確認 |
| `frozen` | 同じepoch/revision/停止tokenと凍結tokenをD1で確認済み。凍結を維持し、再送は読取りで確認 |
| `cancelling` | 元の凍結を解消するintentを保存済み。受付の拒否を維持して取消しを再送できる |
| `cancelled` | 当該要求の凍結だけを解消し、D1とDOの停止revision/tokenを更新済み。maintenance/GC pauseは維持 |

DOの`control_database_restore_freeze`はD1復元で巻き戻らない。既存の準備要求も保持し、同時に別の復旧要求・通常epoch発行・backup・受付再開を始められない。凍結intent保存前にはKDF終了記録・R2書込みreceipt・maintenance taskの保留がないことを確認する。

初回のD1事前照会では`RECOVERY_FINAL_QUERY`の予約・upload・GC・job・outbox・inventory/probe・multipart・bootstrap条件と、現行停止状態、backup解除を確認する。保留があれば`preparing`のまま拒否し、repairを続けられる。DOのintent保存後、**同じD1条件を凍結batch内で再評価**する。事前照会の成功だけで凍結しない。

migration `0040_restore_freeze.sql`は`control.restore_freeze_token`と当時の全67通常tableへのguardを追加する。0041の`r2_write_attempts`にもguardを追加し、現在は全68通常tableのINSERT/UPDATE/DELETEを拒否する。controlへの例外は、他の列を変えずに凍結tokenだけをNULLにする操作。公開APIからこの例外を呼び出す窓口はない。FTSは通常tableではないが、アプリの更新は共通mutationのbatchへ接続されており、凍結中の確定は拒否される。

閉じた状態の共通system/global受付も、DO側で待機前後に凍結intentを検査する。DOの検査前に送信済みのD1更新にはDB triggerが効く。凍結のD1更新は専用制御操作であり、閉鎖する通常mutation受付へ自己待機しない。

## 応答喪失と取消し

1 RPCは25秒まで。時間切れ・応答喪失でintentを自動削除しない。D1の正確な凍結tokenを読み戻せれば`frozen`へ収束できる。未確定の再送による書込みは、元のbinding証言の短い方の期限内に限る。SQLの秒時計には1秒の余裕を取る。期限を超えた未確定要求は、新しい証言へ差し替えず取消しへ進む。

```sh
pnpm database:restore cancel --remote --operator-config restore-operator.json \
  --epoch <同じepoch> --id <同じ復旧要求UUID>
```

取消しは元のepoch/revision/停止tokenと、NULLまたは当該凍結tokenだけを受け付ける。凍結token解除と停止revisionの増加・新tokenへの切替えを一つのD1 batchで確定する。古い凍結batchはこの新tokenに一致せず、取消し後に再凍結できない。

その後、一つのDO transactionで停止mirrorの採用、古い監査の無効化、凍結と要求の取消しを保存する。D1/DOの保存が拒否・無視された場合は成功にせず、正確な取消しtokenで再送する。D1のepochや停止状態が別のものへ変わっていれば、凍結だけを消さず拒否する。取消し後の再開には既存の全監査→受付再開→GC再開が必要。

確認済みの`frozen` markerがD1から消えた場合、再送で勝手に作り直さない。D1の巻戻し・別対象・外部操作を区別できない状態で採用へ進まない。

## 適用・検証・残る作業

migrationはmaintenance中かつbackupなし、open permit/claimed operation/nonclosed admissionなしで適用する。旧schemaのlogical世代は引き続き保存時migration列で検証する。旧Workerへ戻す場合は対応する新Workerの`cancel`で凍結を解消し、maintenance/GC pauseを維持する。凍結中の列・trigger削除をrollback手順にしない。

Node試験は全通常tableのtrigger、実INSERT拒否、control変更拒否、取消しrollback、移行前提、CLI再送・設定変更・秘密非出力を検証する。workerdは実DO/D1/R2で凍結、eviction、受付の待機競合、事前照会後のD1競合、ACK喪失、期限切れ、遅延batch、timeout、DO transaction失敗を確認する。専用bindingドリルは13操作の権限拒否と、既知の試験用予約を解放する前の拒否、凍結・再起動・取消しを確認する。実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

空ファイルPUT、target manifest staging、未公開manifest削除の送信・終了記録はmigration0041で接続し、0042でblob/orphan GC、0043で単一/DAV PUTとmultipart作成/part/完了/全中止、0044でBLOBS接続probe、0045でBACKUPS接続probeへ拡張済み。table再構築でも全pending・終端行と凍結guardを保持する。[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)が正本。DOの未精算receiptと全epochのD1 pendingを検査し、応答不明・期限切れ・DO storage喪失だけで凍結を確定しない。停止中に既知の実終了をD1へ反映するrepairはあるが、native結果不明の解除は未実装。

**全R2操作の最終終了証明は未完了。** BACKUPS保存/削除、epoch履歴などの送信点も個別に確認し、全ての終了条件を集約する必要がある。共通mutation枠の期限、HEAD不在、D1のterminalだけを外部処理終了へ読み替えない。

外部I/Oの全終了、新epochの事前予約、復元元の最終確認、実D1上書き後の採用、全監査・段階再開、ControlDO全storage喪失からの復旧、実Cloudflare検証は未完了。現在の`frozen`をD1の手動上書き許可として使わない。
