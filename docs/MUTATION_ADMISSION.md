# Namespace更新の全体受付

更新日: 2026-09-24。migration `0030`。単一deploymentのcanonical ControlDOとD1に対する制御であり、別deploymentや別Cloudflareアカウントの枠とは共有しない。

## 接続した範囲

LockDOのcreate・rename・move・copy・node write・trash・restore・purgeの8許可経路で、`ControlDO.acquireMutation`が必須になった。REST/WebDAVのファイル更新と、upload completeのnamespace公開がこの経路を通る。

| 上限 | 実装 |
|---|---|
| active 32件 | D1の全epoch・全space共通。INSERT/UPDATE triggerと原子的な昇格処理で制限 |
| waiting 256件 | D1にFIFO順序と元の受付期限を保存。ControlDO内でも処理中RPCを256件に制限 |
| 待機5秒 | 呼出元の元deadline、DO timer、D1の期限検査。再送で既存受付の期限を延長しない |
| 許可30秒以下 | grant時点のSQL時計から30秒。個別permitの期限をこの期限以下に制限 |

accountのユーザーごとに32枠を作る実装ではない。同じControlDO/D1へ接続する利用者とspaceが32枠を共有する。これはnamespace更新の同時許可数であり、R2送信数・実CPU同時数の証明ではない。

## 許可と確定

1. LockDOが従来どおり現在の認可、DAV lock、永続intentを確認する。
2. ControlDOがD1へ受付を保存する。永続sequenceの先頭から空き枠へ昇格する。同じpermit intentへの並行再送は同じlive ticketへ合流する。
3. 待機中はインスタンス内の単一pollを共有する。1回最大288件を読み、100ms間隔で先頭を処理する。再起動後もD1の順序・枠数が正本となる。
4. LockDOのpermit batchがticket ID・space・epoch・期限に加え、認可とlockを再検査する。任意SQLをControlDO RPCへ渡すことはしない。
5. 各mutationの最終batchは既存のpermit/operation/revision条件と、まだactiveな受付を確認する。

D1の[batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)は失敗時に一括rollbackする。FIFOの候補集合はSQLiteの[MATERIALIZED CTE](https://www.sqlite.org/lang_with.html#materialization_hints)で固定し、同じtransaction中の更新で候補数が変わらないようにする。これらの仕様から設計した制約を、native SQLiteとworkerd D1でも検証する。

## 応答喪失・失効・復旧

- active ticketのRPC応答が失われても枠を解放しない。同じintentの再送で再照合できる。DOのevictionやローカルの受付期限超過も解放根拠にしない。
- 許可取得後の認可失効やspace競合でpermitを発行できなかった場合も、共有ticketを推測で取り消さない。未使用枠は最大30秒の期限処理、または停止で閉じる。
- 期限切れ枠を再利用する前に、D1でticketを不可逆にclosedへ変える。同じtransaction内で対応permitをrevokedへ、claimed操作だけをfailedへ変える。committed/failedの結果は保持する。時計が巻き戻っても閉じた許可は復活しない。
- permitのrelease/revokeもticketを閉じる。maintenanceまたはepoch変更ではwaiting/activeをすべて閉じる。復旧監査・最終再開batchは未解決ticketがないことを要求する。
- 待機期限切れでpermitが作られなかったintentは、新しいticket IDで再試行できる。古いticketを持つ遅延handlerは拒否される。permitが一度作られたintentは、その終端permitを再発行しない。
- active/waitingは削除禁止。closed receiptは元待機期限後に索引を使って最大256件ずつ掃除する。終端permitは保持するため、受付receiptの掃除後も同じpermit intentを再発行できない。通常の枠確認はactive/waitingの最大288件を対象とし、全終端履歴を走査しない。
- DB namespaceの失効は、R2 I/Oが終了した証拠にはならない。upload・blob・物理容量の保留をこの受付処理から解放しない。
- REST/WebDAV/upload HTTPは受付失敗を503と`Retry-After: 1`で返す。operation IDを変えずに再照会・再送する既存契約を維持する。

## migrationと残作業

`0030`はmaintenance中、open permitなし、claimed operationなしでのみ適用できる。先に旧実装のquiesceを完了させる。適用済みmigrationは変更しない。旧binaryと新binaryを混在させて受付を開く運用は未検証。remote migration・deployは未実施。

| 更新経路 | この受付への接続 |
|---|---|
| 上記8種類のnamespace permit / upload公開 | 接続済み |
| session/bootstrap/logout、CSRF、app password、content ticket/budget | 未接続。KDFの別制限は実装済み |
| upload予約・R2 create/part/completeの外部I/O・abort/cleanup | 既存upload制御を維持。namespace公開以外は未接続 |
| DAV LOCK/refresh/UNLOCK | 未接続 |
| Queue consumer・Cron・repairの非namespace更新 | 未接続 |
| backup専用barrier・全更新経路の統合 | 未実装 |

全account mutation制御の完成ではない。追加経路への接続とbackup barrier、実Cloudflareの負荷・時計・通信断・複数region・restore drillが残る。製品全体のPhase 0〜9の完了条件は変更しない。

検証記録: Node追加4件・workerd追加17件を含む全check1,308件（Node400/workerd908）が成功。browser/CI結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と次回checkpointで照合する。
