# 更新の全体受付

更新日: 2026-09-25。migration `0030` / `0031` / `0032` / `0033`。単一deploymentのcanonical ControlDOとD1に対する制御であり、別deploymentや別Cloudflareアカウントの枠とは共有しない。

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

serviceと認証helperはDBだけでなくmandatoryなCONTROL bindingを受ける。productionの省略可能な受付やlocal fallbackは設けない。独立試験は明示的なfixture受付を使い、別途実ControlDOのKDF・共有32枠・FIFO待機・返却まで検証する。このapp password接続自体にはmigration追加なし。最新schemaは0033、通常67table、依存変更なし。

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

HTTPは混雑503・Retry-After: 1。実ControlDOで32枠満杯からの待機・無課金、既存receipt読取り、枠返却後のnamespace許可を検証する。単一/分割・新規/上書き、待機後の失効/停止/epoch/祖先/revision/quota、実時計での期限切れ、rollback、ACK/照合喪失、遅延SQL、別owner grantも検証する。migration・依存追加なし。送信claimの接続は後述。自動回収/GCなどの更新受付は後続。

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

待機後のcredential失効/maintenance/epoch/対象変更/owner無効化、実時計期限、rollback、ACK/全照合喪失、別要求の成功、HTTP503、送信claimと中止の競合、検証混雑後の二重complete防止を検証する。実ControlDOの32枠待機/返却も3経路へ追加した。物理観測・既知R2 ID・初期化停止は後述のsystem受付へ接続。自動回収の受付は後続。

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
| GC・残るinventory更新 | 既存制御を維持。共通受付は未接続 |
| DAV LOCK/refresh/UNLOCK | 接続済み。同一batchの確定記録と解放 |
| Queue consumer・Cron・repairの非namespace更新 | 未接続 |
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

物理観測のsource epoch検査は維持する。既知R2 IDは遅延応答でも自分のinit attemptに限り、現在epochのsystem枠で記録できる。system受付は再送や容量返却を許可する証明ではない。Cron/Queue・GC/全bucket repair・backup barrierの接続は未完了。

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

停止アラームはcredential/owner無効化や旧source epochでも制限方向の記録を続ける。ただしControlDOが示す現在epochとD1が一致する必要があり、mirror不整合ではアラーム/予約を保持して再試行する。全台帳喪失・応答喪失で予算をリセットせず、同じpart attemptを再送しない。GC・残るinventory/Queue・backupの受付接続は後続。

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

unknown-ID inventoryは共有する停止claimだけがこの段階の接続対象。残るscan/cursor/page・全bucket/GC・Queue・backupは後続。migration0033/67tableを維持し、global scopeや偽のowner-spaceを追加しない。
