# 旧epochの予約・通知・検索索引の修復

更新: 2026-09-25。停止中の内部ControlDO RPCを共通受付へ接続した。HTTP/operator UI、backup exportそのもの、remote migration/deployは未実装・未実施。

## 呼出しと範囲

`rebuildRecoveryFts(epoch)`、`releaseStaleReservations(epoch, limit=20)`、`failStaleOutbox(epoch, limit=20)`を使用する。更新の前後に復旧監査を再初期化し、既存の監査結果を再開証明として流用しない。

旧epochの予約解放・Outbox通知の停止・検索索引の再構築を共通受付へ接続しました。予約と通知は実際の所有space、索引再構築は明示null scopeで、通常操作と同じ32 active/256 waiting枠を使います。

| 経路 | 受付scope | 確定する事実 |
|---|---|---|
| reservation-release | reservations.owner_idの実space | 旧epoch・reserved・upload参照なしの予約をreleasedにする |
| outbox-fail | 元operation.space_idのowner | 旧epochの対象node通知をfailedにし、dispatch/consumer claimを消す |
| fts-rebuild | 明示null | 外部内容表search_indexからsearch_ftsを再構築する |

actorのspaceを所有者の代わりに使わない。所有者がdisabledでも保守修復は可能だが、実spaceがなければ拒否する。FTSはuser/spaceがまだない空DBでも整合したbootstrap状態なら実行できる。

## 原子的な停止条件

修復の前後の診断は全ての未終了共通受付を拒否する。更新batchでは共通assertが自分の受付ID・permit ID・scope・epoch・system/mode・期限を確認したうえで、停止条件からそのIDだけを除外する。他のwaiting/active、open permit、claimed operation/KDF、live job lease、通知のlive consumer claim、deleting GC、receiving/completing uploadを拒否する。epoch一致・maintenance=1・gc_paused=1も必須。

bootstrapが未完ならissuer/subとuser/spaceが全て空であること、完了済みなら同じissuer/subの有効なapp_adminが存在することを同じbatchで確認する。受付待ち後に条件が変われば全体rollbackする。32枠のうち1枠が空いただけでは修復可能にならない。

## domainの条件と応答喪失

予約は元のID・owner・epoch・bytes・期限・shareを束縛し、待機中にuploadが結び付けば解放しない。同じIDで別の予約が作られた場合も元の操作として扱わない。通知はID・operation・kind・payload・epoch・所有spaceを束縛し、既存のoperation種別とnode stepの由来、dispatch形状、consumer claim満了を更新時にも検査する。現在epochの行や未知upload予約は対象外。

更新と自分の共通確定記録・枠解放を一つのD1 batchで保存する。DB応答喪失は自分の確定記録を照合し、既存の厳密な終端/FTS integrity-check照合も維持する。両方の証拠が読めなければエラーになる。他の処理が同じdomainを完了していても、自分の未確定な枠を明示的に返さない。処理後の停止条件にその枠が残れば成功を返さない。ControlDOのfinallyで行うquiesceは別の停止処理であり、修復batchの成功証明ではない。

予約・通知の完了済み行は選択対象から外れるため、再起動後の再照会も枠を増やさない。FTS rebuildは明示した再構築操作であり、呼出しごとに受付を取って事後の整合を検査する。read-onlyの復旧診断/FTS整合検査はDB-onlyのままにし、coordinatorが自分の枠待ちへ再帰しない。

1回の予約・通知修復は最大20件。開始前の時刻から25秒の固定期限を持ち、次の行を始める前と受付後に検査する。期限後に新しい更新を開始せず、完了件数だけを報告する。既に開始したD1命令を途中取消しした証明には使わない。

## 検証と残作業

workerd67件を追加（境界59件・実ControlDO8件）。追加67件（14.72s）・既存復旧23件（12.96s）と全体checkが成功。Node422件（25file、5.81s）・workerd1,847件（85file、983.56s）、計2,269件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 全体check後にCI試験を調整し、KDF統合20件（7.15s）・待機列Node8件（104ms）・lint・型検査を再確認しました。

境界試験は受付不能、rollback、ACK/照合喪失、他のwaiting/active、epoch/mode/pause/bootstrap変更、固定期限、実owner/disabled owner/space未復元、uploadへの結合、行の置換、通知の由来とclaim、他処理の終端を検査する。実ControlDO試験は全32枠との共有、1枠だけ空いても拒否、全終了後だけ確定、応答喪失後のevictionとread-only再照会を検査する。

backupは停止modeだけでは凍結されない。これらの修復は停止中にも更新できる。upload公開失敗後の精算は[共通受付へ接続済み](UPLOAD_FAILED_COMPLETION.md)。`services/putFile.ts`にはDAV PUT失敗後の共通受付外の予約解放が残り、不明なR2保存・削除結果の保留条件も整備する必要がある。次はその経路を整備してから、明示的なbackup barrierとlogical export/restore drillへ進む。未知KDF/multipartの閉鎖証明や容量精算はこの修復の対象に含めない。
