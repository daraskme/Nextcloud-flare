# 復元後のmultipart inventory

更新: 2026-09-28

[epoch採用](DATABASE_RESTORE_ADOPTION.md)後、同じ復旧要求からmultipartの接続照合、upload単位の未知handle修復、bucket全体の走査、部品容量の観測、中止試行を実行する。通常の受付とGCは停止したままにする。

## 実行

```sh
pnpm database:restore inventory-restored --remote \
  --operator-config restore-operator.json --epoch <元epoch> --id <同じUUID> \
  --action bucket --limit 20
```

private `database-restore-v1`権限、`RESTORE_OPERATOR_ENABLED=true`、`RESTORE_WRITE_ENABLED=true`が必要。DOのlive KDF/R2とD1のclaimed/pendingが空であることを先に確認する。残存nativeは[終了記録の修復](DATABASE_RESTORE_NATIVE.md)で解決し、時間経過・空一覧・HEAD不在から終了を推測しない。

| action | 引数 | 処理 |
|---|---|---|
| verify | 追加なし | 新しいnonceをBLOBSに条件付きPUTし、S3から読戻して接続を照合する |
| uploads | `--limit 1..20`、既定20 | 元のlease/期限/operation条件で停止可能なuploadを選び、各uploadの一覧1ページを保存する。全ページ終了後、最大10handle/uploadを実BLOBS bindingで中止する |
| bucket | `--limit 1..20`、既定20 | u/の未完了multipartを1ページ走査し、tracked/quarantinedとoperator用handle IDを返す |
| parts | `--handle-id UUID --limit 1..20` | quarantined handleの部品を1ページ観測する。部品ごとの最大観測bytesを保持し、physicalを保守的に計上する |
| abort | `--handle-id UUID --attempt-id UUID` | 完了したbucket/parts走査と元handleの条件を照合し、同じattempt IDに対して一度だけ中止を送る |

各呼出しは1回の操作だけを行い、自動反復・自動再送はしない。`verify`と`abort`へ`--limit`は渡せない。`parts`と`abort`にはbucket結果のoperator用IDを使い、R2 key・R2 upload ID・endpoint・credentialを引数で受け取らない。中止前にattempt UUIDを保存する。同じIDを再実行した場合は元receiptを返し、abortを再送しない。新しいattemptには既存の生涯回数制限も適用する。

接続設定はWorkerの`R2_INVENTORY_*`から取得し、account/bucket/jurisdictionが採用済み復旧要求のBLOBS対象と一致することを要求する。その後、各操作で新しいbinding probeを行う。`verify`の成功結果を後続操作の権限として使わない。

## 停止・結果不明・容量

1つのmaintenance taskで実行し、前後で全監査を無効にする。task開始後のepoch/revision/tokenを固定し、system/global受付、BLOBSのGET/HEAD、S3送信・応答、native送信直前と対象間で再確認する。probeのD1 mutationと送信証拠にも同じ停止と25秒期限を渡す。呼出し全体が25秒を過ぎれば終了し、遅れて届いた読み取りから新たなPUTやabortを送らない。

停止が変わる前に実際に送ったPUT/abortの完了は、遅れて届いても終了記録へ保存する。停止変更後の古いdomain更新は拒否する。grant取得後・送信前に停止が変われば未送信を記録する。unknownなnativeが残れば次の操作はfresh probeの前に拒否し、probeの新しい成功で以前のunknownを消さない。

bucketとpartsのcursorは既存のD1台帳で管理する。source/epochが変われば元cursorを流用せず、新しいroundで再走査する。部品の一覧が縮小・消失しても保留bytesを減らさない。中止開始batchの応答が不明なら、その呼出しからabortを送らず、同じattemptを再実行しても新たに送らない。実abort後にdomain receiptだけが保存できなかった場合は、中止の共通native証拠と未確定のdomain receiptを両方保持する。

出力の`inventory`はaction/pendingと、verification/uploads/bucket/parts/abortのいずれかを含む。CLIは内部token、R2 key、R2 upload ID、source、cursorを除き、件数・状態・保留bytes・後続操作に必要なoperator handle/attempt IDだけを返す。`r2Calls`はupload修復内のI/O予算回数であり、共通probeの回数やnative成功回数ではない。

`pending=true`なら終了code 2。未完了ページ、upload inventory台帳、未識別のmultipart、quarantined handle、不整合なbucket走査、未終了R2を含めて保留を判定する。partsの完了やabortのconfirmedでも、quarantined handleの容量は残る。`pending=false`もこの処理範囲だけの結果であり、[全監査と段階再開](DATABASE_RESTORE_RECOVERY.md)の代わりにはならない。

## 残る工程

この入口で調査・中止を実行できるが、未知multipart全体の閉鎖証明と予約/physicalの最終精算は未完了。空のS3一覧、NoSuchUpload、個別abort成功だけを全体閉鎖とせず、既存scan/handleのdelete guardや容量holdを維持する。古いsnapshotに欠けたnative tuple、旧実装、全DO storage喪失の収束、旧backup修復、logical import、安全な中止、大規模RTOと実Cloudflareでの復旧も残る。

D1 schema0046・通常68table・依存追加なし。ローカル試験のS3応答は合成providerで、実S3・Time Travelの検証ではない。結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。
