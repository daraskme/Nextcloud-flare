# epoch履歴の送信・終了記録

更新: 2026-09-28

`ControlDO.recover()`と`bumpEpoch()`は、BACKUPSの`sys/epoch/<epoch>.json`への条件付きPUTをDO SQLiteで追跡する。実装は`do/controlEpochHistory.ts`。D1のmigrationは追加せず、schema0046・通常68tableを維持する。

## 予約から公開まで

1. `control_state`のpending intentと、`control_epoch_write`のreserved行を同じ同期transactionで保存する。epoch・at・reason・pending tokenを束縛し、前回の未終了行があれば次の予約を拒否する。
2. reservedからpendingへ同期更新してから、`etagDoesNotMatch: "*"`のnative PUTを一度だけ呼ぶ。別のrecover、eviction、期限満了は同じPUTの再送を許可しない。
3. PUTの実成功、または条件不成立のnull応答だけでendedを保存する。例外や応答喪失ではpendingを残す。GETで完全一致しても終了の証明にはしない。
4. endedの場合だけGETでepoch・at・reasonの3項目を照合する。1024byte上限、実本文長、UTF-8、余分な項目も検査する。R2のPUTと読取り全体は10秒で打ち切る。
5. 元のpending tupleと現在の停止状態を再検査してからD1のepoch/permit/operationを原子的に更新する。D1応答後にも元のtupleを確認し、同期transactionでDOをreadyへ移す。受付とGCは停止したままで、再開には全監査が必要。

ended行は同じpending intentのD1再試行に使う。次のepoch予約時に前回のended行だけを置き換えるため、記録は1行に限定される。reserved/pendingの削除、tupleの変更、不正な状態遷移はSQLite triggerも拒否する。

## 応答喪失と遅延

| 状況 | 動作 |
|---|---|
| PUT前に中断、reservedが残る | 同じ予約の最初のPUTを実行可能 |
| PUTの応答喪失・例外 | pendingを保持し、読戻し・再送・epoch公開を拒否 |
| PUT timeout後に元のnative成功が到着 | endedだけ記録する。古い呼出しはGETやD1更新へ進まない |
| ended後のGET失敗、本文停止、内容不一致 | epoch公開を保留。後のrecoverはGETだけを再試行 |
| 実PUT成功後のD1失敗・応答喪失 | endedとpending intentを保持し、同じD1採用を再試行可能 |
| 別のrecoverやbumpが先に完了 | 古いD1読取り・R2読取り・D1応答の継続は元のpending tupleに一致せず拒否 |
| ready/uninitialized状態に未終了receiptが残る | ControlDOの状態照会・新規受付・epoch予約を拒否 |

timeout、取消し、isolate終了はnative PUTが終了した証拠ではない。元の継続が失われて実終了を記録できなければ停止を保持する。強制解除のRPCは設けていない。

## 移行と残る境界

旧実装のpending intentにreceiptがない場合は`epoch_history_receipt_missing`で止める。既存objectや空tableから過去のnative終了を推定しない。実配備時には旧実装からの送信終了確認が必要。

この記録は通常のepoch更新を保護する。復旧用には別tableの`control_restore_epoch_write`で同じnative終了規則を使い、[要求に固定した事前予約](DATABASE_RESTORE_EPOCH.md)を実装した。予約時にはD1を更新せず、実上書き後の採用は後続。[D1書込み凍結](DATABASE_RESTORE_FREEZE.md)や予約の成功だけで実上書きを開始しない。

DO全storage喪失後の履歴数値最大値・D1下限・明示EPOCH_FLOORによる復旧は従来どおりだが、消えたreceiptや旧native処理の終了を証明するものではない。native結果不明の運用証明、全storage喪失を含む実復旧、実環境の停止・監査・段階再開は後続。[外部I/O終了記録](R2_WRITE_SETTLEMENT.md)も参照する。
