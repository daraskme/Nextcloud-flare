# 配信失敗の記録

更新: 2026-09-28。migration `0062`、通常76table、147 route。

## 接続済みの範囲

ローカルQueue設定のDLQ consumerから、`queue_dead_letters`へ配信失敗の観測を保存する。`GET /api/v1/admin/dlq`と管理者のアカウントメニュー「配信失敗の記録」から確認できる。元処理が現在は完了している場合も記録を残す。

DLQはdelivery単位の失敗であり、copy jobの停止・終了、外部nativeの終了、容量解放を証明しない。通常のOutbox再送と停止済みcopyの独立した精算巡回は継続する。既存copyを再開せず、上限・checkpoint・reservation・pin・leaseを変更しない。停止済みcopyの新規retryは[COPY_JOBS](COPY_JOBS.md)の全精算条件を引き続き要求する。

## 保存と受領確認

Worker entryは`MessageBatch.queue`を`JOBS_QUEUE_NAME` / `JOBS_DLQ_NAME`と照合する。設定欠落・同名設定・未知queueは全件retry。message bodyで経路を選択しない。ControlDO/D1の通常admissionを通ったDLQだけを保存処理へ渡す。

25秒のinvocation期限内で、`global:queue.dead-letter`の共通受付を取り、現在epoch・maintenance・backup/restore freezeをD1で再確認して観測と受付receiptを同時保存する。message IDを主キーとし、再配信では同じoutbox参照と送信時刻を確認してACKする。保存応答喪失は確定済み受付receiptで照合できる。確定不明・envelope矛盾・受付不能・期限超過はretryし、保存前のACKを行わない。Queue ACKの喪失後も同じ観測を再利用する。

保存するのはmessage ID、検証済みのoutbox IDまたはNULL、Queue送信時刻、D1記録時刻、記録epochだけ。本文・ファイル名・元operand・R2 key・資格情報を保存・出力しない。IDだけの既存payload形式から外れるbodyはNULLの観測として保存する。D1復旧等で元outboxが存在しない正規形式の参照も保存するため、outbox IDにはFKを付けない。これを元処理の完了とは判断しない。

観測行は更新不可。migrationはmaintenance、稼働permit/operation/admission不在、backup/restore停止不在を要求する。新tableはbackup/restoreの全3種freeze、schema contract、全table export/importへ含める。

## 管理者一覧

Accessの`app_admin`のみ。署名済みカーソルを検査し、ページを読む同じD1 statementでuser/credential/session・role・無効化/失効/期限・current epoch・maintenanceを検査する。呼び出し元が保持する古いrole値だけでは許可しない。

50件を新しい順に返し、51件目がある場合だけ次カーソルを発行する。カーソルは10分有効で、用途`admin-dlq`、scope、actor、credential、epochへ固定する。列挙順は記録時刻とmessage IDで安定させ、専用索引を使う。返すのは観測情報と、参照先が現在存在する場合のevent種別/状態/epoch・copy job ID/状態のみ。他userのファイル内容、名前、operandやmanifestを読む権限は与えない。

UIは管理者メニューから開き、手動ページ追加と更新に対応する。再取得中と認可失敗時は古い情報を隠す。API応答は`private, no-store`。コピーの停止表示から精算済みとは判断しない。

## 運用上の残り

`POST /api/v1/admin/dlq/:jobId/requeue`、解決/保管/保持期限の管理、外部通知、実Cloudflare配信試験は未実装・未検証。本文を使った任意再投入は行わない。今後の再投入も保存済みoriginal operand/current authority・epoch・native保持・既存予算を検査する必要がある。D1観測行の自動削除はまだない。

[Cloudflare公式DLQ説明](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)によるとDLQにも独立したconsumer設定が必要で、consumerなしの既定保持は4日。[Queue設定](https://developers.cloudflare.com/queues/configuration/configure-queues/)には保持期間とretry設定がある。ローカル設定はDLQ consumerを追加し、最大100retry、retry delay 3600秒、最大10件/batch、concurrency 1。これはD1障害時の無期限保持を保証しない。実環境はQueue保持期間・監視・停止中の扱いをinventoryと合わせて検証する必要がある。remote Queue作成・migration・deployは行っていない。

検証結果の正本は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。
