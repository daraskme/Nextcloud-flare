# 復旧要求に固定したepochの事前予約

更新: 2026-09-28

`reserve-epoch`は検証済みの復旧元と凍結済みD1/BLOBS/BACKUPSに対して、将来のepochをDOとR2履歴へ予約する。D1のepochは変更せず、凍結を維持する。実D1上書きと予約epochの採用は後続工程である。

## コマンドと前提

```sh
pnpm database:restore reserve-epoch --remote --operator-config restore-operator.json \
  --config <対象Workerの設定> [--environment <Wrangler環境名>] \
  --epoch <現在のepoch> --id <凍結した復旧要求UUID>
```

順序はprepare → logicalのverifyまたはverify-bookmark → freeze → reserve-epoch。最初の予約開始時に、同じ要求の未失効SQL検証証言または対象DB/bookmarkの証言を要求する。freezeだけを行った要求には予約しない。証言がない・失効した場合は予約開始前なので、凍結をcancelしてから新しい要求で検証し直せる。

対象設定のD1/BLOBS/BACKUPSを再読取りし、凍結した対象と完全一致することを要求する。CLIはBACKUPSへ直接書かず、既存のprivate `DatabaseRestoreOperator.reserveEpoch`を使う。S3資格情報はこのコマンド自体には不要。通常のBackupOperatorやHTTPからは利用できない。

## 状態と再実行

| 内部状態 | 公開状態 | 保存内容と動作 |
|---|---|---|
| allocating | epoch_reserving | 要求ID・旧epoch・復旧元・対象・凍結token・検証証言を固定。履歴走査前から取消しを拒否 |
| writing | epoch_reserving | 新epoch・履歴時刻・native送信receiptを同期transactionで保存済み。同じ番号のPUTだけを継続 |
| reserved | epoch_reserved | native終了とR2 recordの一致、元D1凍結mirrorを確認済み。新epochを返すがD1には採用しない |

DO SQLiteの`control_database_restore_epoch`に予約を保存し、`control_restore_epoch_write`に[epoch履歴PUTの実終了](EPOCH_HISTORY_WRITES.md)を保存する。通常のepoch発行のreceiptとは分け、通常recoverは現行epochの停止状態を返す。通常bump、backup、受付再開は復旧holdで拒否する。

新epochは履歴全ページの数値最大値+1、現行epoch+1、logical保存元epoch+1、明示EPOCH_FLOORの最大値。時刻を番号に使わない。履歴の上限100ページと、全体25秒・PUT/本文10秒の期限を守る。期限切れ後の遅延した一覧応答から新しいページやPUTを開始しない。

応答喪失では同じ旧epoch・同じ要求ID・同じ設定でinspect/reserve-epochを再実行する。allocatingなら走査を再試行できる。writing以降は新番号を発行せず、native結果不明なら読戻しや再送で解消しない。遅延した元PUT成功は終了記録だけへ反映し、新しい呼出しが予約確認を継続する。

予約開始後の通常cancelは`database_restore_epoch_reserved`で拒否する。予約行だけを削除して凍結を解除する操作は設けていない。R2衝突やunknownでも番号とholdを保持する。実復元前の安全な中止・予約番号を消費する別手順は後続であり、現在の予約コマンドを実環境で試す段階ではない。

結果には旧epoch、`newEpoch`、要求・復旧元・対象、履歴の`reservedAt`、`validator: restore-epoch-v1`を返す。内部tokenを出力しない。inspectにも予約状態と、決定済みならnewEpochを含める。

## 保証の範囲

予約の再送は固定した予約を再照会するもので、期限を過ぎた復旧元証言を更新するものではない。実上書きの直前にはソース有効性・外部I/O全終了・実対象を別途確認する必要がある。

実D1上書き、復元snapshotの照合、backup/restore tokenの解消、新epochのD1採用、全監査・段階再開は未実装。native結果不明・旧実装・DO全喪失時の終了証明も残る。ローカル試験のcontrol行不変性を実Time Travel成功とは扱わない。通常68table・migration0046のままで、remote migration・配備は行っていない。
