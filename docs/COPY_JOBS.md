# 所有者をまたぐコピー

更新: 2026-09-28。永続job/manifest/Outboxの内部受付、期限付きclaim、固定source読取り、単一保存に、multipart転送とpart進捗からの再開を追加した。結果不明の修復、HTTP受付、Queue consumer、一括公開、取消し・再試行は後続で、画面から所有者間コピーを使える状態にはまだしていない。最終要件は[DESIGN](DESIGN.md)と[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)を維持する。

## コピー開始時の固定

`services/copyPreparation.ts` の `prepareCrossOwnerCopy` は、現在のAccess利用者について転送元readと転送先createを別々に認可する。両側の選択share ID/versionを複製して固定する。明示的な個人領域はactor本人の所有が必要で、失効した共有を別の広いgrantで補わない。上書き対象には転送先のtrash権限、親・名前の一致を要求する。同じ所有者のコピーは既存COW経路を使い、この準備処理へ切り替えない。

対象にはノード構成、保存名と正規化名、revision、client mtime、hidden、現在のblob、dead propertiesを含める。blobは保存キー・サイズ・保存済みETag・content ETag・hash・MIMEを保持し、記録済みの物理サイズとownerの一致を検査する。コピー元rootの外のparent IDは結果に含めない。Depth 0はcollectionとその属性だけ、Depth infinityは全配下を固定する。上書き対象も別のsnapshotとして固定する。

コピー元と上書き対象を合わせて10,000 node・10,000 property、UTF-8で8 MiBまでのメタデータを扱う。走査には索引付きsuccessor walkと10,001件目の検出を使い、上限超過を切り捨てて成功扱いにしない。大きすぎる属性は値をWorkerへ読み出す前に検出する。深さは絶対depth 64まで。8 MiBを超える対象はまだ受け付けず、この準備の成功をジョブ完了とはしない。

返却するplanと全配下は凍結し、SHA-256 digestを付ける。`copyPreparationAssertions` は生成元のrequest-local proofだけを受け付け、複製・JSON読戻し・偽造したobjectを認可の代わりにできない。開始を確定する同じD1 batchで、両側の資格情報・共有・世代・全メタデータ・現在の名前衝突を再検査する。構成追加、属性の同じ長さでの置換、content変更、共有停止も拒否する。

## 保持と容量予約

`preparedCopyBlobs` はsource blobごとに転送先blob ID、pin ID、reservation IDを割り当てる。コピー元にCOW aliasが複数あっても同じblobの転送・予約・pinは一つ。画面上の合計サイズを表すlogical bytesと、実際に転送・予約するunique bytesを分ける。folder全体を単一uploadのサイズ上限へ押し込まず、各blobについて既存の予約上限を使う。

`reservePreparedCopyStatements` は、上記の再認可と一意なblobごとの予約・pinをまとめたSQLを返す。**`createCopyJob` が、永続job/manifest・idempotency digest・Outboxの記録と、LockDO/common mutation admissionを同じbatchに入れる。このSQLだけを単独で実行するHTTP経路は設けていない。** 256 blobごとにSQLをまとめ、manifest保存と全再検査を含めてD1の1,000 statement上限を維持する。

予約は転送先owner、pinはコピー元blobへ付ける。namespaceや実在R2 bytesはまだ増やさない。quota不足やsource ref上限で最後のchunkが失敗しても、先に入れたpinと予約を含めて全rollbackする。既存のpinを期限だけで消すことはせず、後続のjob終了・取消し・復旧処理が実際の転送終了を確認して精算する。

## 永続受付と再送

`services/createCopyJob.ts` はAccess userだけを受け付ける内部service。内部operation `copy.enqueue` の成功はjob受付だけを表し、namespace公開のoperationとは別に扱う。source spaceのLockDOと共通mutation受付で両側の現行認可を検査し、転送先のcreate/overwrite lockも確定batchで再確認する。同期`node.copy`/`dav.copy`の同一space制限は広げない。

同じbatchで `bulk_jobs`、`copy_job_manifests`、`copy_job_chunks`、`copy_job_blobs`、pin、予約、4個のstep、`copy.requested` Outboxとoperation成功receiptを確定する。`bulk_jobs.op_id`は受付operationを指す。manifest/保持対応が欠ける場合はDB triggerも202 receiptの確定を拒否する。jobの`node_count`/`blob_count`は固定manifestの対象数で、転送の進捗とは分ける。Queueへ送るのは既存OutboxのIDだけ。consumerはまだ転送せず、完了ACKもしない。

job IDは元credentialとidempotency keyに対応するoperation IDから固定する。要求内容には両側の選択share、親、source、保存名、depth、上書き対象、lock token hashを束縛する。再送では現在のcredentialと元/先の権限を検査し、元のjob IDを返す。途中でsourceの内容が変わっても新しいmanifestや追加予約を作らない。異なる要求へのkey再利用は拒否する。応答喪失は既存のoperation照合へ接続し、記録を確認できない間は`commit_unknown`を維持する。

manifest本文は最大8 MiB、64 KiBずつ最大128個のBLOB行へ保存する。`jobs/copyManifest.ts` は8行ずつ読み、サイズ・連番・SHA-256・operation/owner/credential/選択・保持対応を照合する。D1のBLOBがnumber配列として返ることを考慮し、全chunkを同時に配列化しない。読戻したobjectは凍結するが、request-local authorization proofは与えない。次の実行段階では現行権限を改めて検査する。

## 実行claimと固定sourceの読取り

`jobs/copyClaim.ts` は送信済み（または送信中）のOutbox IDから保存済みmanifestを照合し、両側の現行権限と共通system admissionを経て実行leaseを取得する。同じtransactionでjobをrunningへ進め、token・epoch・期限・初期checkpointを保存する。並行配信は一つだけが取得でき、転送先ownerあたり同時2claim、実行25秒、job全体200 invocation/20,000 R2 callを上限にする。進捗が未確定の再取得は最大10回。lease期限を過ぎても、転送先keyに結果不明のnative writeがあれば再取得しない。

`jobs/copyRead.ts` はbufferとして返す場合は1回最大8 MiB、multipartへのstream転送では最大90 MiBをRangeで読み出す。D1認可・後続書込みの余裕を確保するため、読取り開始時にinvocationの合計R2 call数が16未満であることを要求する。R2送信前にjobとleaseのcall数を同じbatchで増やし、直接の成功応答を得た場合だけGETする。claim取得はDB receiptから応答喪失を照合できるが、送信前batchの応答喪失はGETの許可にしない。失敗したcall数も戻さない。

blobごとにmanifest上の最初のnodeを固定した権限確認対象にする。元のrootとそのnode、転送先親、必要なoverwrite対象を現在の資格情報・選択shareで認可し、読取り前後でDB条件を再確認する。元fileが新しいblobへ更新されてもpinした旧blobを読むが、そのnodeが選択shareの外へ移動した場合は拒否する。別のaliasや広いgrantへの切替はしない。物理ETagの条件付きGETでkey・全体size・返却Range・実body長も照合する。空blobはRangeを指定せず読む。

bufferを返す場合は読取り後の再認可まで待つ。streamではbackpressureを維持して送信し、終端で長さと現行認可を検査してから成功を返す。期限切れ、claim解放、短い/長いbody、遅れて返るR2応答ではbodyをcancelする。実行claimの解放はpinや予約を返さず、再取得回数も保持する。この読取りだけでcheckpointを進めたりjob/Outboxを完了にしたりしない。

## 小さいblobの保存と進捗

`jobs/copyPut.ts` の `copyNextSmallBlob` はmanifest順に8 MiB以下のblobを一つ保存する。source全体のSHA-256を計算し、既知のsource hashがあれば照合する。共通受付の同じbatchで転送attempt/hash/claimとコピー先staging blobを記録する。このbatchの直接ACKを失った場合はPUTせず、照合待ちを維持する。

新しいnative種別`copy.put`は、ControlDO内でmanifestのidentity、両側の現行認可、source pin、コピー先予約、現在のjob lease、staging blob、既存write不在を再確認する。固定source nodeを転送recordへ束縛し、ControlDOでは小さいidentity行だけを読み、8 MiBのmanifest本文をnative呼出しごとに再読込しない。R2 API予算とnative pending receiptを同じbatchに記録し、1回だけ送信する。PUTには未存在条件とSHA-256を付け、既存objectを上書きしない。書込み結果が不明ならlease期限だけで再送・容量返却をしない。

実際のPUT結果からkey/size/SHA-256/ETagを照合し、blob_storage、検証済みhash、転送stored状態を同じsystem batchに記録する。現在の共有権限が失効した場合やlease解放後に遅れて成功が届いた場合でも、実在bytesの記録は行う。native完了台帳の確定は独立して行い、事実のD1記録が失敗しただけでnativeを再送しない。

現行認可・claim・stored/physical記録・native succeeded・pending不在が揃った後、同じbatchで次のblobへのcheckpointを進め、無進捗retry回数をリセットする。保存済みrecordがあればPUTを繰り返さずこの進捗確定から再開する。再取得時にはcheckpointまでの全blobがstoredであることも照合する。全blobの保存が終わってもnamespace公開やjob/Outbox完了ではない。source pinと容量予約、staging blobは保持する。

## 分割保存とpart進捗

`jobs/copyMultipart.ts` の `copyNextBlob` は8 MiB以下を単一PUTに委譲し、それより大きいblobでは、初期化・一つのpart送信・進捗照合・completeのいずれか一段階を実行する。partは既定64 MiB、8〜90 MiB、最大10,000個で、既存uploadのgeometry検査を使う。全ファイルやpart全体をbuffer化せず、条件付きRange GETからFixedLengthStreamとDigestStreamへ順次流す。

`copy_multipart_uploads`には固定geometry・初期化attempt/claim・実R2 upload ID・complete attempt/claimを保存する。`copy_multipart_parts`には連番・予定bytes・送信attempt/claim・検証したSHA-256/ETagを保存する。初期化と各part、completeにはそれぞれ一度限りのnative記録を作り、ControlDO内で現在の権限・lease・保持・正確なupload ID/part/attemptを再検査する。前のpartがstoredかつnative succeededになるまで次のpartを作らず、全partの件数・geometry・bytes・native成功を確認してからcompleteする。完了照合には(kind,source_ref)の一意索引を使い、各partの送信記録を直接検索する。

part進捗は`{v:1,blob,offset}`として確定し、leaseを取り直しても保存済みpartを再送しない。part/objectの観測記録とnative終了が揃い、現行認可も有効な場合だけcheckpointを進める。nativeの実応答や検証済みpart情報が遅れて届いた場合は、元lease解放後も事実を保存する。応答を取りこぼしたDB更新はその確定receiptで照合する。実completeの結果からphysical bytesとobject ETagを記録し、multipartの全体SHA-256を計算済みとは扱わない（`sha256_verified`はNULL）。

全bucket走査では既知のcopy upload IDをtrackedとして扱う。未知IDを含め、copy保持が残るkeyは全bucket用abortから除外する。copy専用の取消し・終了照合が必要で、lease満了や一覧からの消失を閉鎖証明にしない。

送信前ACK喪失後の未送信照合、native結果不明や観測記録欠落の修復、失敗/取消しの精算は未接続。現在はreadとwriteを合わせたcall数で次のreadを制限する。最大10,000件・500 GiBの受付を完走させるには、batch化とD1/200 invocation/20,000 R2 callの全体予算検証も必要。現段階ではこれらを推測で解放せず、HTTP/Queue consumerを有効化しない。

## 移行と復旧

migration0052で通常72tableとなり、0053は既存job_leasesへinvocationのR2 call数を追加する。0054は全native receiptと既存のcopy保持情報を維持し、copy.putと転送状態・attempt・hashを追加する（72tableのまま）。既存のtoken・epoch・期限・試行回数は保持する。0052の追加3tableはSTRICT/FK/index、backup/restore freeze、export/purge順序の契約へ含める。旧catalogueに未解決の`node.copy` bulk jobが残る場合は0052移行を拒否し、元処理の個別照合を要求する。

0055はmultipart用の2tableを追加して74通常tableとし、既存15種のnative記録を全field維持してcreate/part/completeの3種を追加する。旧copy保持行はsingle modeを保つ。新tableもSTRICT/FK/index・backup/restore freeze・export/purge順序へ含め、保存済みpartと途中checkpointをSQL backup/restoreで保持する。移行はmaintenance中・未凍結・open permit/claimed operation/未閉鎖admissionなしで実施する。

copy用reservationは汎用の旧epoch回収から除外する。保持対応の存在中はreservationの変更とpinの変更/削除を拒否する。pending/running jobまたは保持対応が残る間は復旧後の再開を許可しない。Outbox監査は保存済みmanifestのhashと受付receiptを検査するが、成功しても実転送の終了証明にはならない。24時間の受付期限やepoch変更だけで保持を解放しない。

取消しと転送後の精算はまだ未実装で、現時点のschemaはmanifest/保持対応の削除を拒否する。R2-awareな精算を実装する際にはforward migrationで対応する。guardだけを外して容量を返す運用は行わない。この段階の内部serviceはHTTP経路へ公開しない。

## 次に接続する処理

1. 大量blob・大容量multipartのbatch化と、最大規模の完走予算を検証する。
2. ACK喪失/未送信/結果不明/観測欠落の照合と取消し時の精算を接続し、Queue consumerへ進める。chunkごとに現行権限とclaim fenceを検査し、native R2の送信・結果不明・実終了の記録を残す。
3. 全blobを検証してから、固定manifest・衝突方針・dead propertiesをnamespaceの原子的な公開へ接続する。フォルダーの一部だけを公開しない。
4. job read/cancel/retry、停止・recovery・Outbox、pin/予約/physicalの精算、Shared画面の宛先選択と進捗を接続する。

同期DAVは引き続き同一owner・1,000 node・10 GiBまでで、cross-owner要求をREST jobへ自動fallbackしない。[DAV Shared](DAV_SHARED.md)を参照。検証結果と残る全体要件は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とする。
