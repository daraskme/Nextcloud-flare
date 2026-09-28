# 配信失敗の記録

更新: 2026-09-28。migration `0063`、通常76table、147 route。

## 接続済みの範囲

ローカルQueue設定のDLQ consumerから、`queue_dead_letters`へ配信失敗の観測を保存する。`GET /api/v1/admin/dlq`と管理者のアカウントメニュー「配信失敗の記録」から確認できる。元処理が現在は完了している場合も記録を残す。管理者の明示操作で、再投入可能な元Outboxを同じIDの再配信待ちへ戻せる。

DLQはdelivery単位の失敗であり、copy jobの停止・終了、外部nativeの終了、容量解放を証明しない。通常のOutbox再送と停止済みcopyの独立した精算巡回は継続する。観測保存自体は既存copyを再開せず、上限・checkpoint・reservation・pin・leaseを変更しない。停止済みcopyの新規retryは[COPY_JOBS](COPY_JOBS.md)の全精算条件を引き続き要求する。

## 保存と受領確認

Worker entryは`MessageBatch.queue`を`JOBS_QUEUE_NAME` / `JOBS_DLQ_NAME`と照合する。設定欠落・同名設定・未知queueは全件retry。message bodyで経路を選択しない。ControlDO/D1の通常admissionを通ったDLQだけを保存処理へ渡す。

25秒のinvocation期限内で、`global:queue.dead-letter`の共通受付を取り、現在epoch・maintenance・backup/restore freezeをD1で再確認して観測と受付receiptを同時保存する。message IDを主キーとし、再配信では同じoutbox参照と送信時刻を確認してACKする。保存応答喪失は確定済み受付receiptで照合できる。確定不明・envelope矛盾・受付不能・期限超過はretryし、保存前のACKを行わない。Queue ACKの喪失後も同じ観測を再利用する。

観測時に保存するのはmessage ID、検証済みのoutbox IDまたはNULL、Queue送信時刻、D1記録時刻、記録epochだけ。本文・ファイル名・元operand・R2 key・認証tokenを保存・出力しない。IDだけの既存payload形式から外れるbodyはNULLの観測として保存する。D1復旧等で元outboxが存在しない正規形式の参照も保存するため、outbox IDにはFKを付けない。これを元処理の完了とは判断しない。

元の観測列は更新不可。0063では一度だけ再投入の受付情報を追加でき、確定後はその情報と参照先activityも更新不可。migrationはmaintenance、稼働permit/operation/admission不在、backup/restore停止不在を要求する。新tableはbackup/restoreの全3種freeze、schema contract、全table export/importへ含める。

## 管理者一覧

Accessの`app_admin`のみ。署名済みカーソルを検査し、ページを読む同じD1 statementでuser/credential/session・role・無効化/失効/期限・current epoch・maintenanceを検査する。呼び出し元が保持する古いrole値だけでは許可しない。

50件を新しい順に返し、51件目がある場合だけ次カーソルを発行する。カーソルは10分有効で、用途`admin-dlq`、scope、actor、credential、epochへ固定する。列挙順は記録時刻とmessage IDで安定させ、専用索引を使う。返すのは観測情報と、参照先が現在存在する場合のevent種別/状態/epoch・copy job ID/状態、再投入受付ID/時刻。他userのファイル内容、名前、operandやmanifestを読む権限は与えない。

UIは管理者メニューから開き、手動ページ追加と更新に対応する。再取得中と認可失敗時は古い情報を隠す。API応答は`private, no-store`。コピーの停止表示から精算済みとは判断しない。

## 管理者からの再投入

`POST /api/v1/admin/dlq/:jobId/requeue`のjobIdは永続Outbox ID。bodyは`{messageId}`だけを受け、`Idempotency-Key`とAccess/CSRFを要求する。bodyからoperand、別の資格情報、native key、checkpointを指定できない。配信記録と一致するOutboxだけを対象にする。

新規受付はcurrent adminに加え、元operationのactor/credential、元のsource/destination share選択、operand/result/stepを検査する。通常eventのconsumerと同じ`outboxAuthority.ts`を使い、copyでは検証済みmanifestと`copyAuthorityStatements`で再認可する。別の広いgrantへ差し替えない。通常admissionは操作した管理者のspaceへ課金し、元actorの内容を管理者へ返さない。

完了/失敗Outbox、旧epoch、送信/consumer/コピーの実行中lease、期限/残予算による停止対象は再投入しない。copyのpending nativeや未記録prepare、未観測create/partも保留する。成功が記録済みのPUT/completeでobject観測だけが欠ける場合、既知multipartのpartが保存済みの場合は、既存executorの照合・途中再開へ渡せる。再投入はR2/nativeを呼ばず、jobのcheckpoint、実行回数、R2予算、reservation、pin、保持、停止状態を変更しない。

共通受付後に同じ条件と両側の元認可・current adminをD1で再検査し、Outboxをpendingへ戻す更新、activityの`admin.dlq`監査行、観測への受付情報を同じtransactionで確定する。202は再配信の受付を意味し、実送信やcopyの完了ではない。通常Cronが既存producerから同じIDを送信し、consumerは再度現在の元認可を検査する。

1観測につき受付1件。キーはactor/credentialと操作種別に結び付け、同じキー・別観測は409。同じキーの再送は元受付を返し、別キーや別credentialから同じ観測を再投入しない。同時要求・D1応答喪失は保存済み受付を照合し、未確定は503。確定済み受付の再読はcurrent adminと同一actor/credentialを要求するが、元jobの再実行を伴わないため、その後の完了や元actor失効でも受付履歴を返せる。

一覧は再配信受付時刻を返す。UIは`dlq:<messageId>`を同じ要求キーとして使い、応答喪失やreload後も同じ受付を照合する。自動POSTは行わず、reload時の一覧で受付済みを確認した場合はボタンを隠す。候補表示後の競合・権限変化はserverで拒否する。受付と監査の関連はFK/一意索引/確定triggerで固定し、backup/restoreへ含める。

## 運用上の残り

解決/保管/保持期限の管理、外部通知、実Cloudflare配信試験は未実装・未検証。D1観測行の自動削除はまだない。未知nativeの修復・コピーの最大規模検証も残る。

[Cloudflare公式DLQ説明](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)によるとDLQにも独立したconsumer設定が必要で、consumerなしの既定保持は4日。[Queue設定](https://developers.cloudflare.com/queues/configuration/configure-queues/)には保持期間とretry設定がある。ローカル設定はDLQ consumerを追加し、最大100retry、retry delay 3600秒、最大10件/batch、concurrency 1。これはD1障害時の無期限保持を保証しない。実環境はQueue保持期間・監視・停止中の扱いをinventoryと合わせて検証する必要がある。remote Queue作成・migration・deployは行っていない。

検証結果の正本は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。
