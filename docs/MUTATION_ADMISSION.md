# 更新の全体受付

更新日: 2026-09-25。migration `0030` / `0031` / `0032` / `0033` / `0034`。単一deploymentのcanonical ControlDOとD1に対する制御であり、別deploymentや別Cloudflareアカウントの枠とは共有しない。

## バックアップ中の停止

バックアップ専用の書込み停止をControlDOへ接続しました。通常操作・内部復旧・KDFの新規受付を止め、通常67テーブルを凍結して、同じバックアップ要求だけで解除します。

準備開始からsystem/global grantも拒否する。凍結中は通常tableへのINSERT/UPDATE/DELETEをDB guardで拒否し、既存処理の遅い更新も通さない。開始・解除の専用ControlDO intentは通常の32枠を借用せず、元の受付状態を保存して全枠を停止する制御である。[BACKUP_BARRIER](BACKUP_BARRIER.md)参照。

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

serviceと認証helperはDBだけでなくmandatoryなCONTROL bindingを受ける。productionの省略可能な受付やlocal fallbackは設けない。独立試験は明示的なfixture受付を使い、別途実ControlDOのKDF・共有32枠・FIFO待機・返却まで検証する。このapp password接続自体にはmigration追加なし。最新schemaは0034、通常67table、依存変更なし。

## Access session・初回owner・logout

session登録とlogoutも所有spaceの共有枠を取得する。新しいJWTは待機後にiss/sub・同一user・発行/失効時刻・epoch・user有効性を検査し、session/credentialと確定記録・枠の解放を同じbatchに保存する。logoutはsessionと同userの全派生content sessionを一括失効し、既存の冪等性を維持する。内部serviceのdisabled userに対する取消しは許可するが、HTTPでは従来どおりlogin/CSRFを検査する。

既存fingerprintはprimary読取りだけで照合し、正常なGETごとにINSERTや受付を行わない。maintenance・epoch・現在のuser・JWT時刻・失効を毎回検査する。logout済み、期限切れ、credential欠損のfingerprintを再発行・補修しない。新規登録の競合でも、別処理が作ったsessionの欠損credentialを追加しない。

初回ownerはspace作成前なので、専用の内部RPC ControlDO.acquireBootstrapMutationを使う。0032でnullableになったspace_idを明示nullとし、bootstrap接頭辞の内部IDだけに限定する。別の枠や架空spaceは作らず、同じ32/256枠とFIFOを共有する。通常のacquireMutationはnullを拒否し、namespace permitのSQLもspace完全一致を要求する。nullから別spaceへの変更・反対の変更をtriggerで禁止する。

bootstrapのuser・space・root・controlと確定記録・枠解放も同じbatchに保存する。応答喪失はnull scopeを含むexact receiptで照合する。別処理が先に同一iss/subを初期化した場合は、その現行accountへ合流できるが、それを自分のreceiptと扱わず不明な枠は解放しない。JWTやsecretは受付台帳へ保存しない。

新規session/初回ownerを必要とするAPI・private HTML、logout APIの受付不可は503・Retry-After: 1を返す。sessionが既に有効なら、更新枠が混雑しても読取りを続けられる。

## 配信budget・ticket・Cookie交換・取消し

budget確保/更新、ticket発行、Cookie交換、ticket取消しの4経路はmandatoryなCONTROL bindingを使う。現在の認可を先に確認し、共有先ユーザー・app password・匿名共有でもコンテンツ所有者のspaceで同じ32枠へ入る。返された許可の内部ID・space・epochも照合する。待機後の最終batchはexact ticket・所有者の有効性・current authority・SQL時計での期限を再検査し、変更と確定記録・closed化を一括保存する。

budgetは既存のidentity単位を維持し、複数タブやCookie交換ごとに新しい予算を作らない。匿名budgetのunlock sessionも資格情報と一致させる。配信中のBudgetDO reserve/settle・byte/request/並列カウンターは既存制御を維持し、このDB更新受付へ置き換えない。

ticket発行のR2 HEAD、manifestのPUT・読戻し、署名は公開用の更新枠取得前に完了する。budgetの更新は先に独立した受付とbatchで確定し、その枠を返す。manifestの公開は現在の全target認可をもう一度検査する。Cookieはsessionの確定後だけ返し、取消しはticketと全派生content sessionを一括失効する。

batch応答喪失からの成功照合はexact receiptだけを使う。他処理の取消しや、現在のtarget行だけを自分の成功証明と扱わず、自動再実行しない。発行失敗時のmanifest削除には別の取消しbatchを使い、対象target/ticketが存在しないことと、そのexact admissionをclosedにして遅延公開を拒否したことを原子的に確認する。これは成功の確定記録ではない。取消しbatchの応答まで確認できた場合だけ、既にPUTが完了しているmanifestを削除する。対象行がある場合、取消し失敗、またはその応答喪失ではmanifestを保持して結果不明を返す。公開batchが一度も送られていない場合は準備済みmanifestを削除できる。

APIは受付不可を503・Retry-After: 1で返す。Cookie交換はCORSを維持し、失敗時にSet-Cookieを返さない。private HTTPは従来どおりAccess/CSRFを検査する。共有serviceの検証は公開link管理UIの完成を意味しない。

追加70件で4 principal、混雑、停止/失効、待機中の実時計による期限切れ、全rollback、exact receiptとreadback喪失、遅延公開対取消し、HTTP503/CORSを検証する。実ControlDOでも32枠満杯から待機・確定・返却し、namespace操作へ枠を渡す4経路を確認する。migration・依存追加なし。

## 単一・分割uploadの新規予約

createSingleUploadとreserveMultipartUploadはmandatoryなCONTROL bindingを受け、既存receiptがない場合に所有spaceの共有枠を取得する。署名/hash計算と現在の認可の事前確認を終えてから入る。最終batchでexact admission・所有者・credential・node/祖先・revision/tree generation・epoch・SQL時計を検査し、quota triggerを含むreservation、staging blob、upload、確定記録と枠解放を一括保存する。許可待機中や受付不可では予約もR2初期化も行わない。

同じrequest ID/bodyの保存済みreceiptは従来のcurrent authority検査で返し、新しい枠を取らない。32枠が満杯でも、上書き対象のrevisionが変わった既存予約を確認できる。これは転送許可の再発行ではなく、新規予約・R2初期化・本文・確定のrevision検査は維持する。異なるbody、失効したcredential、移動などの拒否条件も維持する。

自分のbatch応答喪失はexact receiptで照合する。別要求が同じkeyの予約を作った場合や自分のreceipt読取りを失った場合も、current authorityと一致する保存済みuploadを読めれば、その共有HTTP receiptへ合流できる。ただしそれは自分の確定証明ではなく、自分の未確定ticketを閉じない。予約・blob・容量を消さず、自動で予約SQLやR2を再実行しない。全照合応答を失ったときはエラーを返し、同じkeyで次に照会する。capabilityやhashを受付台帳に入れない。

HTTPは混雑503・Retry-After: 1。実ControlDOで32枠満杯からの待機・無課金、既存receipt読取り、枠返却後のnamespace許可を検証する。単一/分割・新規/上書き、待機後の失効/停止/epoch/祖先/revision/quota、実時計での期限切れ、rollback、ACK/照合喪失、遅延SQL、別owner grantも検証する。migration・依存追加なし。送信claimの接続は後述。自動回収・所有blob GCの受付は後述。

## 応答喪失・失効・復旧

- active ticketのRPC応答が失われても枠を解放しない。同じintentの再送で再照合できる。DOのevictionやローカルの受付期限超過も解放根拠にしない。
- 許可取得後の認可失効やspace競合でpermitを発行できなかった場合も、共有ticketを推測で取り消さない。未使用枠は最大30秒の期限処理、または停止で閉じる。
- 期限切れ枠を再利用する前に、D1でticketを不可逆にclosedへ変える。同じtransaction内で対応permitをrevokedへ、claimed操作だけをfailedへ変える。committed/failedの結果は保持する。時計が巻き戻っても閉じた許可は復活しない。
- permitのrelease/revokeもticketを閉じる。maintenanceまたはepoch変更ではwaiting/activeをすべて閉じる。復旧監査・最終再開batchは未解決ticketがないことを要求する。
- 待機期限切れでpermitが作られなかったintentは、新しいticket IDで再試行できる。古いticketを持つ遅延handlerは拒否される。permitが一度作られたintentは、その終端permitを再発行しない。
- active/waitingは削除禁止。closed receiptは元待機期限後、確定記録付きならさらにcommit後60秒を過ぎてから、索引を使って最大256件ずつ掃除する。終端permitは保持するため、受付receiptの掃除後も同じpermit intentを再発行できない。通常の枠確認はactive/waitingの最大288件を対象とし、全終端履歴を走査しない。
- DB namespaceの失効は、R2 I/Oが終了した証拠にはならない。upload・blob・物理容量の保留をこの受付処理から解放しない。
- REST/WebDAV/upload HTTPは受付失敗を503と`Retry-After: 1`で返す。namespace operationはIDを変えずに再照会・再送する既存契約を維持する。DAVロックの別HTTP要求は上記の再生対象ではない。

## upload転送claimと検証済み情報

単一uploadの送信開始・読戻し・検証済み情報の保存、multipartの初期化・complete送信claimの5経路を共通32枠へ接続。現在の権限/対象/期限と変更・確定記録・枠返却を同一batchで検査する。外部送信はclaim batchの直接ACKを受けた場合だけ許可し、確定記録の読戻しでは再送しない。検証済みDB情報はexact receiptから復旧する。multipartの検証は後述。

| admission種別 | 同一batchの主な変更 | 応答喪失後の扱い |
|---|---|---|
| upload.single-start | created→receiving、write attempt/lease、data counter | receiptからPUTしない。別の読戻しclaimへ進む |
| upload.single-recover | receivingのcontrol_calls加算・上限検査 | このclaimではGETしない。次回も独立した受付とcounterが必要 |
| upload.single-verify | blob SHA-256/ETag、receiving→completing | exact receiptでDB確定を回収可能。PUTなし |
| upload.multipart-start | 初回write attempt/lease、control counter | R2 createなし。自分の未送信attemptを既存処理で停止 |
| upload.multipart-complete | 一度限りのcomplete attempt/lease | R2 completeなし。既存のHEAD照合へ収束 |

受付はpreflight後、最終batch前。4つの外部送信claimはaccountMutationStatementsの共通fence/receiptを使うが、commitAccountMutationのACK回収ではdispatchしない。R2 PUT/create/completeの再送禁止とGET回数上限を維持する。待機後の失効・maintenance・revision・SQL時計を再検査し、rollbackした未確定枠は推測で閉じない。

単一PUT後に検証済み情報の受付が満杯でも、観測済みphysicalとreservationを保持する。次回はGETで同じobjectを検査し、PUTを再送しない。受付失敗のHTTPは503/Retry-After: 1。physical観測や既知R2 IDの記録は後述のsystem受付へ接続した。自動回収/GCは後続。利用者の中止は次節。DB枠の返却は外部I/Oの終了証明ではない。

境界試験は5経路の混雑/待機後失効/停止/対象変更/rollback、直接ACK喪失時の送信拒否、実時計期限、検証済み情報のACK/読戻し喪失と容量保持、HTTP503を検証する。実ControlDOで各経路を32枠満杯から待機させ、commit後の枠をnamespace permitへ渡す。

## 利用者による中止とmultipart検証

単一/分割uploadの利用者による中止と、multipart完成物の検証済み情報保存を共通32枠へ接続。待機後の現行認可・期限・状態を再検査し、変更・確定記録・枠返却を同一batchで保存する。未送信の単一uploadだけ予約を返し、待機中に送信claimが入った場合も予約を保持する。multipart中止は送信を停止するだけで、回収前に予約を返さない。multipart検証の受付混雑時は物理容量/予約を保持し、再試行でR2 completeを再送しない。

| admission種別 | 同一batchの変更 | 保持する条件 |
|---|---|---|
| upload.single-abort | aborted・orphan・未送信予約の返却 | write_attempt_idをbatch内で再検査。進行中/結果不明のPUTは予約保持 |
| upload.multipart-abort | aborting・accept_parts=0・cleanup intent・control counter | reservationは保持。completing/completedは409 |
| upload.multipart-verify | blob ETag・multipart_object_etag | physical観測済みかつmetadata/size/part証明一致。whole SHA-256はNULL |

単一中止は既存のtransfer期限を維持する。multipartはreceipt profileなのでupload期限/idle切れ後も有効なcredential・現在node権限で停止できる。どちらも上書き対象の古いrevisionだけを理由に中止を妨げず、待機後の現在の認可snapshotは同じbatchで再検査する。保存済みの中止結果は追加の枠を取らず、現在の認可で読み返す。

DB-onlyの確定はexact receiptでACK喪失を回収できる。別要求の中止結果/完成物proofへ合流しても、それを自分のbatchの成功証明とせず、自分の未確定枠は閉じない。ACKと全照合応答を失った場合も次回の状態照会・同じ要求で回収する。物理容量はこのreceiptの有無だけで戻さない。

待機後のcredential失効/maintenance/epoch/対象変更/owner無効化、実時計期限、rollback、ACK/全照合喪失、別要求の成功、HTTP503、送信claimと中止の競合、検証混雑後の二重complete防止を検証する。実ControlDOの32枠待機/返却も3経路へ追加した。物理観測・既知R2 ID・初期化停止は後述のsystem受付へ接続。自動回収の受付も後述の共通system枠へ接続済み。

## migrationと残作業

0032は新tableへのcopy・旧tableのdrop・renameでnullable scopeを追加し、関連trigger/indexを再作成する。既存closed receiptの全列と、削除済み行を含むAUTOINCREMENT最大sequenceを保持する。FKを無効化しない。現schemaでこのtableを参照するFKはない。SQLiteの[table再構築手順](https://www.sqlite.org/lang_altertable.html#otheralter)と[sqlite_sequence](https://www.sqlite.org/autoinc.html)を根拠に実装し、SQLiteの空/既存tableとworkerd D1の既存receipt移行で検証する。

`0030`はmaintenance中、open permitなし、claimed operationなしでのみ適用できる。`0031`〜`0033`ではさらにwaiting/active ticketなしが必要。先に旧実装のquiesceを完了させる。適用済みmigrationは変更しない。通常table数67、依存変更なし。旧binaryと新binaryを混在させて受付を開く運用は未検証。remote migration・deployは未実施。

| 更新経路 | この受付への接続 |
|---|---|
| 上記8種類のnamespace permit / upload公開 | 接続済み |
| app password発行・失効・pepper更新 | 接続済み。KDF後に取得、current authorityと変更/確定記録/解放を同一batch |
| session/bootstrap/logout | 接続済み。既存sessionはcurrent primary読取りのみ |
| content budget / ticket発行・交換・取消し | 接続済み。コンテンツ所有spaceで受付し、current authorityと変更/確定記録/解放を同一batch |
| CSRF helperの発行/検証 | DBはcurrent credentialの読取りのみ、tokenは署名。入口のsession登録も上記の共有受付へ接続済み |
| 単一/分割upload新規予約 | 接続済み。reservation/blob/uploadと確定記録/解放を同一batch。同keyの既存receiptは追加受付なし |
| 単一送信開始/読戻し/検証済み情報、multipart初期化/complete claim | 接続済み。外部送信には直接ACK必須。検証済みDB情報のみexact receiptで回収 |
| 利用者によるsingle/multipart中止、multipart検証済み情報 | 接続済み。DB-onlyのexact receipt回収。容量返却は既存の安全条件を維持 |
| 物理観測・既知R2 ID記録・初期化停止/緊急abort予算 | 接続済み。後述のsystem受付、通常と同じ枠 |
| UploadDO台帳初期化/反映/喪失時停止 | 接続済み。初期化と通常反映はaccount、停止/喪失はsystem。直接ACK契約は後述 |
| 単一/分割upload自動回収 | 接続済み。停止claim・外部予算・観測・閉鎖・精算・エラーが共通system受付 |
| blob GC（通常/停止中/復元中） | 接続済み。claim・delete/HEAD予算・完了精算・エラーが共通system受付 |
| 既存uploadの未知multipart ID調査・回収 | 接続済み。claimに加えて走査・予算・観測・中止receipt・lease返却・エラーが共通system受付 |
| global R2接続確認 | 専用global scopeで接続済み。後述の同一32/256枠 |
| orphanの台帳更新 | scan/GCを明示null scopeへ接続済み。全bucket multipartも後述の受付へ接続済み |
| DAV LOCK/refresh/UNLOCK | 接続済み。同一batchの確定記録と解放 |
| 通常Outbox送信・node event consumer | 接続済み。送信claim/send/sent・受信claim/complete、所有space、同じ32/256枠 |
| global inventory・旧epoch repair更新 | 未接続 |
| backup専用barrier・全更新経路の統合 | 未実装 |

全account mutation制御の完成ではない。追加経路への接続とbackup barrier、実Cloudflareの負荷・時計・通信断・複数region・restore drillが残る。製品全体のPhase 0〜9の完了条件は変更しない。

検証記録: 直前commit f62dad8の[CI36029086734](https://github.com/daraskme/Nextcloud-flare/actions/runs/36029086734)はUbuntu・Windows・browser全成功。Node408/workerd1186/browser19、計1,613件。今回の復旧用受付の全check・CIの確定結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。

## 復旧用の物理観測・multipart初期化後処理

物理容量の観測、multipartのHEAD予算・既知R2 ID・初期化停止・緊急abort予算を共通受付へ接続しました。復旧用の内部RPCも通常操作・bootstrapと同じ32 active/256 waiting・5秒期限を使います。安定したopen/closed状態のD1 mirrorを確認し、失効・owner無効化・maintenance後の必要な事実を記録できます。

migration0033でsystem/modeを不変にし、通常操作・namespace permitへの流用を拒否します。停止・再開・epoch更新で古い枠を閉じます。DB-onlyの応答喪失はexact receiptで回収し、外部HEAD/abortはclaim batchの直接ACKだけで許可します。結果不明や混雑でも予約容量を推測で返しません。

| 内部kind | 同一batchに含む記録 | 応答喪失後の扱い |
|---|---|---|
| upload.observe | 単一objectのblob_storageとphysical加算 | DB receiptで照合。size不一致でも実bytesは保持 |
| upload.multipart-head | 完成物をHEADするcontrol_calls予算 | 直接ACKがなければHEADしない |
| upload.multipart-observe | multipart完成物のphysical加算 | DB receiptで照合。後の公開は現行認可が必要 |
| upload.multipart-record | 自分のinit attemptに対応する既知R2 ID | DB receipt、または同じ保存済みIDの照合。別処理の記録で自分の枠を返さない |
| upload.multipart-stop | 自分の初期化attemptの停止・cleanup intent | DB receiptで照合。予約は保持 |
| upload.multipart-abort | 既知ID保存失敗後の緊急abort予算 | 直接ACKがなければabortしない |

通常/初回owner RPCは余分なsystem/mode入力を捨て、system接頭辞を拒否する。内部RPCは固定kindと具体的owner-spaceを要求し、modeはControlDOの安定した永続状態から取得する。D1 mirror読取りも共有256件の処理中制限の内側で行う。system ticketはopen時でも通常のassert/commit/receiptやnamespace permitに使用できない。

systemとmaintenanceの2列は0033で既存台帳へ追加する。旧rowは0/0、receiptとAUTOINCREMENT high-water markは保持する。適用前にmaintenance・全ticket/permit/claimed operationのdrainを必須とする。閉鎖状態のsystem mirror照合は稼働中system ticketを許すが、復旧監査と再開の全体fenceは維持する。

物理観測のsource epoch検査は維持する。既知R2 IDは遅延応答でも自分のinit attemptに限り、現在epochのsystem枠で記録できる。system受付は再送や容量返却を許可する証明ではない。Cron/Queue・GC・orphanの受付は後述の経路へ接続済み。全bucket multipartは後述。旧epoch repairは後述。backup barrierの接続は後続。

## UploadDO台帳の初期化・反映・喪失

UploadDOの台帳初期化・通常の台帳反映・停止時の反映・台帳喪失時の停止を共通受付へ接続しました。初期化と通常反映は現在の利用者認可、停止反映と喪失処理は復旧用system受付を使い、すべて同じ32 active/256 waiting枠を共有します。

初期化markerや部品送信につながる台帳反映は、D1 batchの直接ACKがなければローカル台帳を確定せず、送信許可も返しません。混雑・rollback・応答喪失でもdirty行、アラーム、予約容量を保持します。台帳全喪失では停止記録を回収できても再初期化しません。

| kind | 同一batchの処理 | ACK喪失後 |
|---|---|---|
| upload.multipart-journal-init | 現在の認可・upload fence・一度限りledger marker・確定記録/返却 | ローカル台帳を開始しない。再送は喪失処理へ収束 |
| upload.multipart-journal-mirror | 現在の認可・予約/期限・binding/revision・uploadとdirty parts・確定記録/返却 | markMirroredせず部品送信許可を返さない |
| system:upload.multipart-journal-stop | 停止snapshotのbinding/source epoch・upload/parts・確定記録/返却 | dirty/alarmを残し、次回の直接ACKまで保持 |
| system:upload.multipart-journal-lost | multipartのfailed/cleanup intent・in-flight partsをunknown・確定記録/返却 | exact DB receiptで記録だけ回収し、必ずrecovery_requiredを返す |

同じUploadDO内の既存直列化を維持し、R2やstreamをDOへ渡さない。待機後もSQL時計・現行認可・予約・正確なjournal binding/revisionを検査する。dirty partsは最大200、追加envelopeを含めてもD1の1,000 statement上限内。終端公開証明の読取りとローカルのcompleted照合は新たなD1 mutation受付を増やさない。

停止アラームはcredential/owner無効化や旧source epochでも制限方向の記録を続ける。ただしControlDOが示す現在epochとD1が一致する必要があり、mirror不整合ではアラーム/予約を保持して再試行する。全台帳喪失・応答喪失で予算をリセットせず、同じpart attemptを再送しない。GC・所有upload inventory・Queue・orphanの受付は後述。全bucket multipartは後述。旧epoch repairは後述。backup barrierは後続。

## 単一・分割アップロードの自動回収

単一・分割アップロードの自動回収を共通の復旧用受付へ接続しました。停止claim、HEAD/abort予算、物理観測、既知handleの閉鎖、容量精算・GC引渡し、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。

停止claimは正確なcleanup tokenで回収できますが、外部HEAD/abortは予算batchの直接ACKが必要です。確定済みDB記録はexact receiptで照合し、他の回収処理の終端記録で自分の未確定枠を返しません。待機・遅いACKで実行時間を超えた場合は外部送信を止め、予約・leaseを保持します。ControlDO内の復旧は同じinstanceの受付を直接使い、自己RPCや別枠を作りません。

| system kind | 同一batchの処理 | ACK喪失後 |
|---|---|---|
| upload.cleanup-claim | 停止・cleanup lease・孤立化、共有inventoryのscan作成 | exact receiptと自分のcleanup tokenを照合。外部送信は別の予算受付が必要 |
| upload.cleanup-call | cleanup_calls加算・control/source/lease fence | 直接ACK必須。待機前のrun期限を取得後とACK後に検査 |
| upload.cleanup-observe | metadata不一致も含む実physical bytes | exact DB receiptで回収。予約は別の閉鎖証明まで保持 |
| upload.cleanup-close | 既知handleのabort成功、または既知complete attemptのobject確認 | exact DB receiptで回収。NoSuchUpload/不在だけでは閉鎖しない |
| upload.cleanup-settle | 閉鎖条件・予約解放・physical/GC引渡し・cleanup token解放 | exact DB receipt、または完全な終端tuple。別処理のtupleで自分の枠は返さない |
| upload.cleanup-error | 現在epoch/modeと自分のcleanup tokenに対するエラー | best effort。混雑・記録失敗でも保留・再試行時刻を保持 |

CronはCONTROL binding、ControlDO内のmaintenanceは同一instanceのstatus/acquireSystemMutationを必須引数で供給する。DBだけのfallbackはない。回収前後の復旧監査・quiesceは維持する。disabled owner/失効credential/旧source epochでも現在のsystem受付で回収できるが、元のcontrol epoch/mode、cleanup lease、未公開・pin・GC・閉鎖条件はbatchで再検査する。

unknown-ID inventoryの停止claimに加え、既存upload行の走査・観測・中止は後述の受付へ接続済み。Queue・global probe・orphanは後述の共通受付へ接続済み。全bucket multipartは後述。旧epoch repairは後述。backupは後続。この所有uploadの更新は既存owner-spaceのsystem受付を維持する。

## 所有blobのGC

台帳に登録済みのファイルを対象に、GC（不要ファイルの物理回収）の通常実行・停止中の回収・ゴミ箱復元中の回収を共通system受付へ接続しました。claim、delete/HEAD予算、完了精算、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。

deleteとHEADはそれぞれ予算batchの直接ACKが必要です。受付待ちと遅いACKの後も実行期限を確認し、pin・参照・未精算upload・lease・epoch/mode・復元token/operation/期限を再検査します。待機後のSQL時計で60秒leaseを設定し、失敗したclaimも処理上限に数えます。DB-onlyのexact receipt回収と完全な終端照合を維持し、他の回収処理の成功で自分の未確定枠を返しません。

| system kind | 同一batchの処理 | ACK喪失後 |
|---|---|---|
| gc.claim | candidateの不可逆deleting化、または既存deletingのclaim更新。owner/key・ref/pin・未精算upload・quarantine・modeの再検査 | exact receiptと自分のclaim tokenを照合。外部送信には別受付が必要 |
| gc.call | deleteまたはHEADのr2_calls加算、dispatch fence | 直接ACK必須。混雑/失敗/期限超過では送信しない |
| gc.finalize | blob/candidateのdeleted化、physical解除、upload cleanup終了 | exact receiptまたは完全な終端tuple。別処理のtupleで自分の枠は返さない |
| gc.error | 現在epoch/mode・自分のclaim token/epochに対するエラー | best effort。記録失敗でもdeleting・physical保留を維持 |

通常実行はmaintenance=0/gc_paused=0。停止中は1/1で既存deletingだけ。復元中は0/1に加え、同じrestore operation/token/固定期限を必須とする。ControlDOはacquireRestorePauseの永続化・mirror反映後に同一instanceのsystem受付を使い、alarmとmaintenance RPCも同じqueueへ接続する。復旧監査/quiesceや復元windowの管理は自分の受付枠に依存させない。

claimの60秒leaseとremoved_atは待機後のSQL時計を使う。removed_atはobserved_atを下回らない。1回のmaxBlobsは失敗したclaimも含む候補検査数の上限とし、同じ失敗を無制限に再試行しない。既定50件（停止/復元20件）、25秒の外部dispatch開始期限を維持する。進行中R2呼出しの強制終了は保証しない。

owner未復元のorphan・そのcursor/leaseは後述のglobal受付、Queueは所有spaceの受付へ接続済み。全bucket multipart inventoryは後述。旧epoch repairは後述。backup barrierは後続。既知blobのGC完了を未知multipartの閉鎖証明に流用しない。

## 所有uploadの未知multipart調査・回収

既存upload行に紐づく未知multipart IDの調査・回収を共通system受付へ接続しました。走査の再初期化、外部呼出し予算、物理観測、遅れて判明したID、ページ保存、中止確認、lease返却、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。

待機後にfreshなR2/S3対応証明、epoch/pause、cleanup token/lease、scan round・cursor、pin/refを同じbatchで再検査します。HEAD・S3一覧・abortはそれぞれ予算batchの直接ACKが必要で、受付待ちと遅いACKの後も実行期限を確認します。DB-onlyのexact receipt回収と既存の厳密なscan/中止照合を維持し、全ページ取得やhandle中止だけでは予約容量を返しません。

| system kind | 同一batchの処理 | ACK喪失後 |
|---|---|---|
| upload.inventory-reset | source/epoch変更または再走査期限によるround初期化 | exact receipt、または自分のround/source/epoch/tokenを照合 |
| upload.inventory-call | cleanup_calls、abort時のhandle attempts/時刻 | 直接ACKのみ。保存済みreceiptから外部dispatchしない |
| upload.inventory-observe | HEADで確認した完成objectのphysical計上 | exact receipt回収。予約は保持 |
| upload.inventory-handle | 遅れて判明した元のR2 IDを台帳へ保存 | exact receipt回収。新しい初期化/送信許可にしない |
| upload.inventory-page | exact-key handlesとcursor/pages/完了時刻を一括保存 | exact receiptまたは完全一致するpage tuple |
| upload.inventory-abort | 実R2 abortの成功receipt | exact receiptまたはupload/handle/abortedの完全一致 |
| upload.inventory-release | cleanup leaseの返却と次回時刻だけ | exact receipt回収。予約とclosure-requiredは維持 |
| upload.inventory-error | handle失敗または自分のcleanup tokenの診断 | 保存不能でも未解決lease・容量を保持 |

受付はmandatoryなSystemMutationSourceを使い、ControlDO内部は同じinstanceへ直接接続する。待機時間は1回最大5秒、外部操作開始はfresh検証後から既定20秒/最大25秒。R2/S3対応証明の60秒leaseを延長しない。既存のmaxUploads20/maxHandles20、1 uploadにつき1ページ20件、全ページ完了後だけabortする制限を維持する。

別の処理が残した機能上のreceiptは、自分の未確定共通枠を返す証拠にはしない。probeそのものの更新は後述の明示null global scopeへ接続済みで、所有spaceへ流用しない。全bucket走査や未知ID全体の閉鎖・予約精算の完成を意味しない。

## Queueの送信・受信

Queueの送信・受信処理を共通system受付へ接続しました。送信claim、送信前の確認、送信済み記録、受信claim、処理完了が通常操作と同じ32 active/256 waiting枠を使います。受付対象は元operationの所有spaceで、通知を起こしたactorのspaceと混同しません。

待機後にepoch/maintenance、正確なtokenとlease、受信側の現行credential・認可・元operationの証明を再検査します。DB-onlyの記録はexact receiptで回収しますが、今回のQueue送信には別受付と直接ACKが必要です。送信応答を失った通知はlease後に同じIDで再送でき、確定済みcompleted/failedの再配信は追加受付なしで確認します。Cron・Queue batchは共通の25秒期限を使い、未処理メッセージをretryします。

| system kind | 同一batchの処理 | 応答喪失後 |
|---|---|---|
| outbox.dispatch-claim | pending/期限切れからdispatching、SQL時計による30秒lease | exact receiptまたは自分のdispatch tokenを照合。送信前に別受付と現行条件が必要 |
| outbox.send | 正確なdispatch token/lease、committed operation、current epoch/maintenanceの再確認と自分のreceipt確定 | 直接ACKなしでは今回のsendを実行しない。期限後の同一ID再送は可能 |
| outbox.sent | 自分のdispatchingをsentへ変更 | exact receiptまたは正確なsent tokenを照合。速いconsumerのcompletedは戻さない |
| outbox.consume-claim | 現在の認可と保存済みoperand/result/node stepを検査し30秒claim | exact receipt回収。後続の完了も別受付と現行認可が必要 |
| outbox.complete | 自分のclaim/leaseと現行認可を検査してcompleted | exact receiptまたはdurable terminalだけをackの根拠にする |

completed/failedの照会は枠を取らない。他のconsumerが完成させたterminalはQueue応答の判断に使えるが、自分の未確定枠を返す証拠にはならない。既存のID-only/at-least-onceを維持し、R2初期化や転送の一回限定dispatchとは区別する。公開Workerのqueue/scheduledからmandatory SystemMutationSourceを渡す。全bucket multipart inventoryは後述。旧epoch repairは後述。backup barrierは後続。詳しい制限と試験は[OUTBOX](OUTBOX.md)。


## 所有者を持たない内部更新とR2接続確認

所有者を持たないR2接続確認を共通受付へ接続しました。専用global RPCは通常操作・初回登録・所有者付きsystem更新と同じ32 active/256 waiting枠を使い、架空のownerや別枠を作りません。

migration0034で既存の全確定記録、受付sequence、外部キー、索引と60秒保持を維持します。globalのscopeは明示nullで、owner/system・bootstrap・namespace許可への流用を拒否します。R2確認のclaim・各GET/条件付きPUT/S3読取り予算は直接ACKと固定25秒の開始期限が必要です。段階記録・終了はDB-onlyのexact receiptで回収し、待機後のnonce/source/token・元の60秒lease・epoch/pauseを再確認します。エラー記録も同じ確定記録方式を使い、現epoch/pauseと自己nonce/source/tokenで制限します。期限切れ後のエラー記録でも容量を返しません。ControlDO内は同一instanceの受付を使います。

| class | scope / 接頭辞 | authority |
|---|---|---|
| 通常 | 所有space / 通常ID（system:/global:禁止） | 現行認可を別途検査しnamespace permitへ接続可能 |
| 初回登録 | null / bootstrap: | 初回owner登録のみ。system=0/mode=0 |
| 所有者付きsystem | 所有space / system: | 内部の事実記録。namespace不可 |
| global | null / global: | allowlistにある所有者なし内部処理。namespace不可 |

新migration0034は既存台帳のCHECKをtable再構築で拡張する。maintenance=1・active/waiting枠なし・open permitなし・claimed operationなしを適用条件とする。全列、停止だけのreceipt、commit receipt、削除済み行を含むAUTOINCREMENT high-water、FK/index/trigger、commit後60秒保持を維持し、既存migrationを編集しない。

ControlDO.acquireGlobalMutationはscopeを明示nullに固定し、呼出し側のsystem/modeを採用しない。安定したmodeを同期取得して同じControlMutationsへ入り、D1 mirror読取りの前に256 pendingの制限を適用する。待機期限は5秒、grantは30秒。owner/globalのassert・commit・readbackもruntimeでclassとscopeを検査し、型castや通常/初回登録RPCでの流用を拒否する。停止・再開・epoch変更はすべてのclassを閉じる。

| global kind | 同一batch | 応答喪失後 |
|---|---|---|
| r2.probe-claim | nonce/source/generation・SQL時計60秒lease | 直接ACK必須、外部読取りを開始しない |
| r2.probe-call | phase/token/lease/epoch/pause検査・呼出しcounter | GET/条件付きPUT/S3ごとに直接ACK必須。receiptで送信を推測しない |
| r2.probe-phase | prepared/written/verifiedの段階記録 | exact receiptで回収可能。次のI/Oは別受付が必要 |
| r2.probe-release | verified→idle・lease返却 | exact receiptのみ。idle状態だけでは自己の未確定枠を返さない |
| r2.probe-error | 現在epoch/pause・自己nonce/source/tokenのエラー記録 | best effort。別generationやidleを上書きしない |

外部確認の開始は1回の25秒期限を共有し、受付後と直接ACK後も期限を確認する。既に実行中のI/Oを強制停止する保証ではない。最終DB記録は別途5秒の受付を使うが、元の60秒proofを延長しない。固定64-byte probeは削除せず、遅れた初回PUTの再生成を防ぐ。callback終了後はscoped fenceを無効化し、返却したbindingVerified booleanを後続の削除・精算権限にしない。

GlobalMutationSourceは必須で、ControlDO内の確認・bucket走査・部品観測・中止は同じinstanceのproviderを渡す。owner側のmultipart修復は両scopeを要求する。DBだけのfallbackはない。probeの受付に加え、orphan・全bucket multipartの台帳更新は後述の共通受付へ接続済み。保留容量精算・backup barrierは後続。


## 未追跡objectの調査・回収

未追跡の完成済みR2 objectの調査・回収を共通global受付へ接続しました。scanのclaim・外部予算・観測・ページ保存・lease返却と、GCのclaim・外部予算・置換観測・削除確定・エラー記録が通常操作と同じ32 active/256 waiting枠を使います。

owner不在でもscopeは明示nullで、架空のspaceを作りません。待機後にepoch/mode/pause、元のtoken・60秒lease、object世代・全catalogueからの独立を再検査します。LIST・HEAD・deleteは各回の直接ACKが必要で、既定20秒/最大25秒の開始期限を受付後とACK後に確認します。DB-onlyの確定記録と既存の厳密なtoken/終端照合を維持し、他の処理の完了で自分の未確定枠を返しません。35日猶予・後日owner復元・不在確認後だけのphysical精算を維持し、ControlDO内部は同じinstanceの受付を使います。 全10kindと応答喪失後の条件は[ORPHAN_INVENTORY](ORPHAN_INVENTORY.md#共通global受付)を参照。rawの結果付き観測batchには共通assertを前置し、changesのindexを調整する。終了時のlease返却と失敗注記も共通受付を経由し、受付不能時は自然失効まで保留する。

## 全bucket multipartの調査・中止

全bucketの未完了multipart調査・中止を共通global受付へ接続しました。scanとpartの開始・外部予算・ページ保存、中止の開始・結果保存の8経路が、通常操作と同じ32 active/256 waiting枠を使います。

所有者が未復元でもscopeは明示nullです。受付待ち後にfresh proof・epoch/mode/pauseとscan/partの元のround・cursorを再検査します。S3一覧とR2 abortは直接ACK後だけ送信し、probe開始から固定25秒の開始期限を受付後・ACK後にも検査します。初期化と中止結果のDB-only更新は自分の確定記録だけを照合し、一覧の結果付きbatchは応答喪失時に推測で成功を返しません。同じ中止attemptは再送せず、64回の生涯上限と容量保留を維持します。ControlDO内部は同じinstanceの受付を使います。

8kindはbucket.scan-init/scan-call/scan-page、bucket.parts-init/parts-call/parts-page、bucket.abort-start/abort-finish。DB-onlyのinit/finishはcommitGlobalMutationで確定記録を照合する。call/abort-startは外部I/Oの許可なのでraw batchの直接ACKが必須。結果付きpage batchもrawで保存し、共通assert/receiptを返却値から除外する。受付不能や確定不明でcapacity・probe・保留容量を手動返却しない。

新しい中止は待機後に完了した一覧と競合upload/leaseをtriggerで検査する。既存attemptの照会は新しい中止枠を取らず、fresh proof後に保存結果を返すだけである。詳しい試験と制約は[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md)。

## 旧epochの予約・通知・索引修復

旧epochの予約解放・Outbox通知の停止・検索索引の再構築を共通受付へ接続しました。予約と通知は実際の所有space、索引再構築は明示null scopeで、通常操作と同じ32 active/256 waiting枠を使います。

修復の前後は従来どおり全更新の停止を要求します。更新batch内だけは自分の有効な受付IDを除外し、他のactive/waiting、permit・claim・job・GC・uploadとbootstrap管理者の条件を待機後に原子的に再検査します。自分の枠が空いても他の更新が残れば修復しません。DB-onlyの確定記録と厳密な終端・索引照合で応答喪失を扱い、他の処理の完了では自分の未確定枠を返しません。uploadへ結び付いた予約は保持し、元の行・所有者・通知のoperation由来を再検査します。予約・通知は1回最大20件、次の更新開始には固定25秒の期限を使い、ControlDO内部は同じinstanceで受け付けます。

kindはsystem:recovery.reservation-release、system:recovery.outbox-fail、global:recovery.fts-rebuild。所有者のspaceが未復元なら修復を拒否し、globalへ代替しない。既存の終端/FTS整合照合で結果を報告できても、自分のactiveで未確定な共通枠は解放しない。厳密な処理後の停止確認もその枠を拒否する。ControlDOのfinallyによる停止は別のcoordinator操作である。詳細は[RECOVERY_REPAIR](RECOVERY_REPAIR.md)。

## upload公開失敗後の精算受付

単一・分割uploadで公開operationの失敗が確定した後の精算を共通system受付へ接続しました。実際の所有spaceで通常操作と同じ32 active/256 waiting枠を取得し、upload・blob・予約解放・確定記録を一つのbatchで保存します。

待機後に元のupload/owner/space/credential/epoch/予約と失敗operationのoperand・step不在を再検査します。最初の予約解放には一致するblob_storageの物理計上を必須とし、singleは検証済みhash、multipartは独立した完成object proofを要求します。公開結果不明・転送中・参照済みblob・証拠不足では解放しません。精算済み結果は追加受付なしで読み、GC後も再照会できます。応答喪失は自分の確定記録または厳密な終端を照合し、他の精算で自分の未確定枠を返しません。混雑はHTTP503/Retry-Afterで予約とphysicalを保留し、再試行でR2送信・削除を繰り返しません。

kindはsystem:upload.complete-failed。CONTROLまたは同一coordinator providerは必須で、DB-only fallbackはない。精算自体はR2を呼ばず、physicalを減算しない。詳細は[UPLOAD_FAILED_COMPLETION](UPLOAD_FAILED_COMPLETION.md)。

## DAV PUTの保存台帳と精算受付

WebDAV PUTの保存前に予約・staging blob・転送台帳を原子的に保存し、保存結果が不明でも容量を保持する処理を実装しました。保存事実と公開失敗後の精算は、実ownerの共通32 active/256 waiting枠を通ります。

migration0035でprivate/DAVの台帳種別を固定しました。開始batchの直接ACK後だけ、attempt metadata付きの条件付きPUTを1回送信します。同じoperationへの再送は追加PUTを発行せず、ストリーム障害時もnative処理の終了を待ちます。成功時は物理計上・hashを保存してからファイルと転送完了を同時確定します。既知の公開失敗はphysicalを保持してGCへ渡し、未知の保存結果は予約を24時間保持してHEAD確認・既存回収へ引き継ぎます。旧DAVの追跡不能な予約も汎用復旧では解放しません。

kindはsystem:dav.put-storedとsystem:dav.put-failed。migration0035時点の転送開始はnamespace permit内だったが、0036以後は以下のdav.put-start受付へ分離した。外部送信は開始batchの直接ACKを必須とする。DB-onlyの確定記録を再送許可にしない。private capability認可をapp_passwordへ拡張しない。現行の転送・公開契約は[DAV_UPLOAD](DAV_UPLOAD.md)。

## DAVの転送と公開の分離

WebDAV PUTは本文保存後に公開用の30秒permitを取得する方式へ変更しました。31秒を超える実転送でも公開でき、本文受信中にnamespace permitや共通更新枠を保持しません。

migration0036で、開始時のupload/reservationを操作ID未結合のまま保持できます。実ownerのdav.put-start受付で現在の認可・lock・予約・不変attemptを一括確定し、直接ACK後だけ条件付きPUTを送ります。保存事実を記録した後に新しい短期permitを取得し、元のrevision/parent/tree/blob/credential/lockを検査して、operationへの結合とcreate10/overwrite8 stepの公開を原子的に行います。HTTPで解決した対象revisionも渡します。再送・ACK喪失・停止で本文を再送せず、未知結果の容量を保持します。

開始は通常owner受付dav.put-start、保存事実と既知公開失敗の精算は既存system受付を使う。原子的な自己receipt確定後は本文に共通枠を持ち越さない。未結合の台帳も旧epoch汎用予約回収の対象外で、24h後のR2-aware cleanupが担当する。Node3件・workerd25件を追加。全体checkが成功し、Node427件（26file、6.34s）・workerd1,970件（93file、1,051.32s）、計2,397件を検証しました。31秒転送、元の認可・revision・lock維持、実ControlDOの共有枠・停止・eviction、未結合台帳の回収競合、前方移行を含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。schema0036/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。
