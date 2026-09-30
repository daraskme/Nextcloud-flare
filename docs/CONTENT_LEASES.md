# 配信leaseの期限と終了処理

更新: 2026-09-24。ローカル実装・検証の記録。リモート配備は未実施。

## 会計期間と配信期限

BudgetDOは、新しいleaseの期限を10分・content session・D1 budget・DOに保存した現在のbyte期間の各期限以内にする。ticketの再発行でD1側の期限が延びても、進行中のbyte期間を延長せず、期限を超えるleaseを新しく作らない。同じ対象の再発行による枠の増加や、10分request数のリセットも行わない。

修正前は、D1の期限だけを延長して新しいleaseを発行すると、そのleaseの有効期間中に古いbyte期間が終わり、次の要求が配信記録を削除していた。実`ensureContentBudget`による更新と現実の時間経過で、精算時の`budget_lease_missing`を再現した。

以前の実装が残した、その期間を超える有効なleaseも破棄しない。同じrequestの再照会は元の期限を返し、現在の認可を確認する。新規要求は429で停止し、既存leaseの精算または期限切れを待ってから期間を更新する。正規の旧leaseでは最長10分以内に解消する。epochが変わった場合の旧lease拒否は維持する。

## R2読み込みと応答の期限

`/c`配信はBudgetDOが返した期限を、R2 HEAD/GETから応答bodyの終了まで引き継ぐ。応答が読まれない場合や、読み込み・最終精算の応答が止まった場合にもtimerが終了させる。各awaitの前後とR2 HEAD/GETの直後でも時計を照合するため、timerのcallbackがまだ実行されていない境界でも期限後のデータを返さない。

- 期限切れのHEADが遅れて戻っても、GETを追加で呼ばない。
- GETが遅れて戻った場合、そのbodyを取り消す。
- 応答のラッパーは先読みをせず、1 chunkずつ渡す。予約したbyte数との不足・超過は停止する。
- 期限切れ、明示的なrequest abort、consumer cancelではsourceを取り消し、以後の配信を止める。未読のqueueも破棄する。すでに受信されたbyteは回収できない。
- R2側の取消し応答を待って停止を遅らせない。consumer cancelで精算応答を待つ時間は最大5秒とする。
- 完了・取消し・失敗後はtimerとabort listenerを解除する。

headerを返す前の期限切れは503 `not_ready`とし、許可されたAPP_ORIGINのCORSを保つ。headerを返した後はbodyをerrorで終了する。新しいticketとRange要求による大容量download再開UIは残る。今回の変更だけで500 GiBの長時間downloadを検証済みとはしない。

## 精算

1つの配信からの精算要求は1回だけにまとめる。本文をまだ渡していないsetup失敗、HEAD/304/416のbodyなし応答は既知の0 byteを精算する。通常完了では実際に渡した長さを確認する。本文の途中の失敗・取消し・期限切れは結果不明として予約全額を保持する。

取消しと完了が競合しても、後から未使用量を推定して返金しない。DOへの応答が失われた場合や、期限切れで記録が既に回収された場合も、失敗を理由に使用量を減らさない。残るleaseは既存のalarmで回収する。

## 検証と残る範囲

Node試験は、正常/空/bodyなし配信、期限切れ/事前abort、遅延setup、停止したbody、未読応答、取消しの応答喪失、5秒待機上限、長さ不一致、最終精算待ち、10分上限、HEAD/GET後のtimerとの順序競合を確認する。

workerdでは実D1/R2/BudgetDOと実ticketの5秒→120秒の更新を使い、期限後のchunk拒否、古い会計期間内へのlease制限、R2 HEAD/GETの遅延、503のCORS、部分受信後のabortと全額保持、事前abortによる予約/読み込みの抑止を検証する。修正前の配信関数を使う比較試験では、期限後の3 byteが届く失敗を確認した。全体結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。

実CloudflareからのHTTP切断通知、各browser/OSの長時間download、全media/public配信経路、全routeの会計、負荷・費用とrestore drillは未検証または未接続。明示的なAbortSignalのローカル試験を、実HTTP切断の証明に置き換えない。D1 migration・依存追加はない。
