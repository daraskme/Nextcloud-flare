# OutboxとQueueの更新受付

更新日: 2026-09-25。schema0033、migration・依存追加なし。

Queueの送信・受信処理を共通system受付へ接続しました。送信claim、送信前の確認、送信済み記録、受信claim、処理完了が通常操作と同じ32 active/256 waiting枠を使います。受付対象は元operationの所有spaceで、通知を起こしたactorのspaceと混同しません。

待機後にepoch/maintenance、正確なtokenとlease、受信側の現行credential・認可・元operationの証明を再検査します。DB-onlyの記録はexact receiptで回収しますが、今回のQueue送信には別受付と直接ACKが必要です。送信応答を失った通知はlease後に同じIDで再送でき、確定済みcompleted/failedの再配信は追加受付なしで確認します。Cron・Queue batchは共通の25秒期限を使い、未処理メッセージをretryします。

## 送信

`dispatchOutbox`はimmutableなoutbox/op/spaceから実際のownerを解決する。送信claim・送信前確認・sent保存はそれぞれ共通枠へ入る。claimはSQL時計で30秒leaseを設定し、待機時間で残りleaseを短くしない。送信直前のbatchでtoken、lease、current epoch、maintenance=0、committed operation、所有spaceを再検査し、直接ACKを受けた場合だけ`{outboxId}`をJSON送信する。ACKが遅く25秒期限を過ぎた場合も送信しない。

Queue sendの応答喪失ではleaseを保持する。期限後に新しいclaimで同じ通知IDを再送できる。consumerがsent保存前にcompletedへ進んでも終端を戻さない。別処理のterminalで自分の未確定共通枠を解放しない。Cronは既定50件/最大100件、1 passの25秒期限を共有し、`inspected`は実際に検査を開始した件数を返す。

## 受信

`consumeOutbox`はnode.created/updated/renamed/trashed/restored/purgedについて、元operationのkind、保存済みparent/node/result、node step、committed状態、current credential/権限を検査する。claimとcompletedを別々の共通枠で確定し、どちらも待機後の最終batchで認可とepoch/maintenanceを再確認する。credential失効・親変更・claim置換・lease切れでは完了を保存しない。

同じIDのcompleted/failedは読取りだけで再利用する。`handleOutboxBatch`はdurable terminalだけをackし、malformed・不存在・混雑・結果不明はretryする。ack自体が失われても再配信は同じterminalで収束する。batch全体で25秒期限を共有し、残りメッセージは処理開始せずretryする。実行中のQueue送信やDB I/Oを強制終了する保証ではない。

## 検証と残作業

共有32枠満杯時の5経路の待機・返却・namespace操作への再利用、ControlDO eviction後の失われた送信ACK、全batch rollback、common receipt喪失、遅いACK、権限/epoch/lease変化、先行consumer、自己の未確定枠保持を検証する。最新の全体結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

Windowsの失敗は20msの試験期限が署名中に切れ、本文読取りのキャンセル検査へ届かない競合でした。本文のread開始を確認してからfake timerを20ms進め、fetchとcancel各1回を検査する方式へ修正しました。製品の10秒transport期限は変更していません。

実Queue/Cron/DLQ、追加event kind、旧epoch repair、backup barrier、staging/productionは未完了。今回の接続をこれらの完成証拠にはしない。
