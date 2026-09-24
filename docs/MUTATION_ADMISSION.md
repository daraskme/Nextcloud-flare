# 更新の全体受付

更新日: 2026-09-24。migration `0030` / `0031`。単一deploymentのcanonical ControlDOとD1に対する制御であり、別deploymentや別Cloudflareアカウントの枠とは共有しない。

## 接続した範囲

LockDOのcreate・rename・move・copy・node write・trash・restore・purgeの8許可経路で、`ControlDO.acquireMutation`が必須になった。REST/WebDAVのファイル更新と、upload completeのnamespace公開がこの経路を通る。

既存resourceのDAV LOCK・refresh・UNLOCKも同じ32枠へ接続した。未存在pathへのLOCKは従来のlocked empty file作成とnamespace permitを通る。

app passwordの発行・失効・認証時pepper更新も同じ枠へ接続済み。既に現行kidの資格情報による認証と一覧読取りにはmutation枠を使わない。

| 上限 | 実装 |
|---|---|
| active 32件 | D1の全epoch・全space共通。INSERT/UPDATE triggerと原子的な昇格処理で制限 |
| waiting 256件 | D1にFIFO順序と元の受付期限を保存。ControlDO内でも処理中RPCを256件に制限 |
| 待機5秒 | 呼出元の元deadline、DO timer、D1の期限検査。再送で既存受付の期限を延長しない |
| 許可30秒以下 | grant時点のSQL時計から30秒。個別permitの期限をこの期限以下に制限 |

accountのユーザーごとに32枠を作る実装ではない。同じControlDO/D1へ接続する利用者とspaceが32枠を共有する。これは接続済みDB更新の同時許可数であり、R2送信数・実CPU同時数の証明ではない。

## 許可と確定

1. LockDOが従来どおり現在の認可、DAV lock、永続intentを確認する。
2. ControlDOがD1へ受付を保存する。永続sequenceの先頭から空き枠へ昇格する。同じpermit intentへの並行再送は同じlive ticketへ合流する。
3. 待機中はインスタンス内の単一pollを共有する。1回最大288件を読み、100ms間隔で先頭を処理する。再起動後もD1の順序・枠数が正本となる。
4. LockDOのpermit batchがticket ID・space・epoch・期限に加え、認可とlockを再検査する。任意SQLをControlDO RPCへ渡すことはしない。
5. 各mutationの最終batchは既存のpermit/operation/revision条件と、まだactiveな受付を確認する。

D1の[batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)は失敗時に一括rollbackする。FIFOの候補集合はSQLiteの[MATERIALIZED CTE](https://www.sqlite.org/lang_with.html#materialization_hints)で固定し、同じtransaction中の更新で候補数が変わらないようにする。これらの仕様から設計した制約を、native SQLiteとworkerd D1でも検証する。

## DAVロックと確定記録

既存resourceの3操作は呼出しごとにfreshな内部IDで受付を取得し、namespace permitを作らずにDB更新する。待機後の最終batchでticket・現在の認可・token/creator・lock期限を再検査し、lock変更と`committed_at`の保存、ticketのclosed化を一括確定する。失敗時は全部rollbackし、未確定の枠を推測で解放しない。

batch応答を失った場合は、正確なticket ID・内部ID・space・epoch・期限と`committed_at`をprimaryから照合する。lockが存在しないことや期限が一致することだけでは成功扱いにしない。他処理のUNLOCK、停止、期限切れが自分の成功に見える誤判定を防ぐ。照合応答も失った場合はエラーを返し、更新を自動再実行しない。

`0031`はactive→closedの同一更新だけにSQL時計での確定記録を許可する。namespace permitに結び付くticketをこの方法で閉じることは禁止。確定記録は60秒保持し、索引付きの最大256件cleanup後は失われる。保持期間後の照合は成功を証明できずエラーとなる。cleanup条件と[expression index](https://www.sqlite.org/expridx.html)の式を一致させ、最近の履歴を全走査しないことをquery planで検証する。

生のlock tokenはDBに保存しない。この記録は同じRPCのbatch応答喪失を照合するためのもの。LOCKのHTTP応答ごと失われた場合にtokenを再取得する機能や、別RPCの自動再送・結果再生は追加していない。

## App passwordの更新

`accountMutation`は所有spaceをprimaryで解決し、ControlDOへ操作種別付きのfresh ID・space・epoch・元deadlineだけを送る。secret・digest・SQLをRPCへ渡さない。発行前のhash生成、鍵更新前の検証と新hash生成を終えてからDB更新枠を取るため、KDFの待機中にmutation枠を占有しない。KDF自体のrate/実行枠は[KDF_ADMISSION](KDF_ADMISSION.md)を維持する。

- 最終batchでexact ticket、space所有者とuser有効性、各操作のcurrent authorityを確認し、資格情報の変更と`0031`の確定記録・解放を一括保存する。
- 発行はAccess session、必要なroot認可、20件上限を待機後に再確認。secretの別HTTP要求への再表示や保存は追加しない。
- 失効は他owner/不存在を受付前に拒否。待機後も所有権とAccess sessionを検査し、app passwordと派生content sessionを一括失効する。既に失効済みの再送は204を維持する。
- pepper更新は旧digest/salt/kidのCAS、current credential/user・期限・epochを最終batchで確認する。自分のbatchが失敗しても他のloginが鍵更新した場合は、現在のrecordとsecretを再検証して認証できる。ただし、それを自分のcommit証明と扱わず、自分の未確定枠は保持する。
- 発行・失効のAPIと鍵更新が必要なDAV認証は、受付不可を503・`Retry-After: 1`で返す。DAVの受付混雑ではBasic再認証を要求しない。

serviceと認証helperはDBだけでなくmandatoryなCONTROL bindingを受ける。productionの省略可能な受付やlocal fallbackは設けない。独立試験は明示的なfixture受付を使い、別途実ControlDOのKDF・共有32枠・FIFO待機・返却まで検証する。migration追加なし（0031、通常67table）、依存変更なし。

## 応答喪失・失効・復旧

- active ticketのRPC応答が失われても枠を解放しない。同じintentの再送で再照合できる。DOのevictionやローカルの受付期限超過も解放根拠にしない。
- 許可取得後の認可失効やspace競合でpermitを発行できなかった場合も、共有ticketを推測で取り消さない。未使用枠は最大30秒の期限処理、または停止で閉じる。
- 期限切れ枠を再利用する前に、D1でticketを不可逆にclosedへ変える。同じtransaction内で対応permitをrevokedへ、claimed操作だけをfailedへ変える。committed/failedの結果は保持する。時計が巻き戻っても閉じた許可は復活しない。
- permitのrelease/revokeもticketを閉じる。maintenanceまたはepoch変更ではwaiting/activeをすべて閉じる。復旧監査・最終再開batchは未解決ticketがないことを要求する。
- 待機期限切れでpermitが作られなかったintentは、新しいticket IDで再試行できる。古いticketを持つ遅延handlerは拒否される。permitが一度作られたintentは、その終端permitを再発行しない。
- active/waitingは削除禁止。closed receiptは元待機期限後、確定記録付きならさらにcommit後60秒を過ぎてから、索引を使って最大256件ずつ掃除する。終端permitは保持するため、受付receiptの掃除後も同じpermit intentを再発行できない。通常の枠確認はactive/waitingの最大288件を対象とし、全終端履歴を走査しない。
- DB namespaceの失効は、R2 I/Oが終了した証拠にはならない。upload・blob・物理容量の保留をこの受付処理から解放しない。
- REST/WebDAV/upload HTTPは受付失敗を503と`Retry-After: 1`で返す。namespace operationはIDを変えずに再照会・再送する既存契約を維持する。DAVロックの別HTTP要求は上記の再生対象ではない。

## migrationと残作業

`0030`はmaintenance中、open permitなし、claimed operationなしでのみ適用できる。`0031`ではさらにwaiting/active ticketなしが必要。先に旧実装のquiesceを完了させる。適用済みmigrationは変更しない。通常table数67、依存変更なし。旧binaryと新binaryを混在させて受付を開く運用は未検証。remote migration・deployは未実施。

| 更新経路 | この受付への接続 |
|---|---|
| 上記8種類のnamespace permit / upload公開 | 接続済み |
| app password発行・失効・pepper更新 | 接続済み。KDF後に取得、current authorityと変更/確定記録/解放を同一batch |
| session/bootstrap/logout、content ticket/budget | 未接続 |
| CSRF helperの発行/検証 | DBはcurrent credentialの読取りのみ、tokenは署名。入口のsession登録は上記の未接続経路 |
| upload予約・R2 create/part/completeの外部I/O・abort/cleanup | 既存upload制御を維持。namespace公開以外は未接続 |
| DAV LOCK/refresh/UNLOCK | 接続済み。同一batchの確定記録と解放 |
| Queue consumer・Cron・repairの非namespace更新 | 未接続 |
| backup専用barrier・全更新経路の統合 | 未実装 |

全account mutation制御の完成ではない。追加経路への接続とbackup barrier、実Cloudflareの負荷・時計・通信断・複数region・restore drillが残る。製品全体のPhase 0〜9の完了条件は変更しない。

検証記録: 直前のDAV受付commit64ed237はCI全成功（Node404/workerd930/browser19）。今回のapp password接続はworkerd32件追加。全検証項目（Node404/workerd962）は成功。初回の旧fixture失敗と再検証、今回のbrowser/CI結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)で照合する。
