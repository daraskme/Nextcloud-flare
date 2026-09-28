# 所有者をまたぐコピー

更新: 2026-09-28。永続job/manifest/Outboxの内部受付、期限付きclaim、固定sourceのRange読取りに、8 MiB以下のblobをコピー先へ保存する内部処理を追加した。分割転送、HTTP受付、Queue consumer、一括公開、取消し・再試行は後続で、画面から所有者間コピーを使える状態にはまだしていない。最終要件は[DESIGN](DESIGN.md)と[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)を維持する。

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

`jobs/copyRead.ts` は1回最大8 MiBをRangeで読み出す。D1認可・後続書込みの余裕を確保するため、読取りは1 invocation最大16回に制限する。R2送信前にjobとleaseのcall数を同じbatchで増やし、直接の成功応答を得た場合だけGETする。claim取得はDB receiptから応答喪失を照合できるが、送信前batchの応答喪失はGETの許可にしない。失敗したcall数も戻さない。

blobごとにmanifest上の最初のnodeを固定した権限確認対象にする。元のrootとそのnode、転送先親、必要なoverwrite対象を現在の資格情報・選択shareで認可し、読取り前後でDB条件を再確認する。元fileが新しいblobへ更新されてもpinした旧blobを読むが、そのnodeが選択shareの外へ移動した場合は拒否する。別のaliasや広いgrantへの切替はしない。物理ETagの条件付きGETでkey・全体size・返却Range・実body長も照合する。空blobはRangeを指定せず読む。

返却bytesは上限内だけ保持し、読取り後の再認可に成功してから後続処理へ渡す。期限切れ、claim解放、短い/長いbody、遅れて返るR2応答ではbodyをcancelする。実行claimの解放はpinや予約を返さず、再取得回数も保持する。この読取りだけでcheckpointを進めたりjob/Outboxを完了にしたりしない。

## 小さいblobの保存と進捗

`jobs/copyPut.ts` の `copyNextSmallBlob` はmanifest順に8 MiB以下のblobを一つ保存する。source全体のSHA-256を計算し、既知のsource hashがあれば照合する。共通受付の同じbatchで転送attempt/hash/claimとコピー先staging blobを記録する。このbatchの直接ACKを失った場合はPUTせず、照合待ちを維持する。

新しいnative種別`copy.put`は、ControlDO内でmanifestのidentity、両側の現行認可、source pin、コピー先予約、現在のjob lease、staging blob、既存write不在を再確認する。固定source nodeを転送recordへ束縛し、ControlDOでは小さいidentity行だけを読み、8 MiBのmanifest本文をnative呼出しごとに再読込しない。R2 API予算とnative pending receiptを同じbatchに記録し、1回だけ送信する。PUTには未存在条件とSHA-256を付け、既存objectを上書きしない。書込み結果が不明ならlease期限だけで再送・容量返却をしない。

実際のPUT結果からkey/size/SHA-256/ETagを照合し、blob_storage、検証済みhash、転送stored状態を同じsystem batchに記録する。現在の共有権限が失効した場合やlease解放後に遅れて成功が届いた場合でも、実在bytesの記録は行う。native完了台帳の確定は独立して行い、事実のD1記録が失敗しただけでnativeを再送しない。

現行認可・claim・stored/physical記録・native succeeded・pending不在が揃った後、同じbatchで次のblobへのcheckpointを進め、無進捗retry回数をリセットする。保存済みrecordがあればPUTを繰り返さずこの進捗確定から再開する。再取得時にはcheckpointまでの全blobがstoredであることも照合する。全blobの保存が終わってもnamespace公開やjob/Outbox完了ではない。source pinと容量予約、staging blobは保持する。

8 MiB超のmultipart、送信前ACK喪失後の未送信照合、native結果不明や観測記録欠落の修復、失敗/取消しの精算は未接続。現在はreadとPUTを合わせたcall数で次のreadを制限するため、正常な単一保存は最大8 blob/invocationになる。最大10,000件の受付を完走させるには、大量blobのbatch化とD1/200 invocation/20,000 R2 callの全体予算検証も必要。現段階ではこれらを推測で解放せず、HTTP/Queue consumerを有効化しない。

## 移行と復旧

migration0052で通常72tableとなり、0053は既存job_leasesへinvocationのR2 call数を追加する。0054は全native receiptと既存のcopy保持情報を維持し、copy.putと転送状態・attempt・hashを追加する（72tableのまま）。既存のtoken・epoch・期限・試行回数は保持する。0052の追加3tableはSTRICT/FK/index、backup/restore freeze、export/purge順序の契約へ含める。旧catalogueに未解決の`node.copy` bulk jobが残る場合は0052移行を拒否し、元処理の個別照合を要求する。

copy用reservationは汎用の旧epoch回収から除外する。保持対応の存在中はreservationの変更とpinの変更/削除を拒否する。pending/running jobまたは保持対応が残る間は復旧後の再開を許可しない。Outbox監査は保存済みmanifestのhashと受付receiptを検査するが、成功しても実転送の終了証明にはならない。24時間の受付期限やepoch変更だけで保持を解放しない。

取消しと転送後の精算はまだ未実装で、現時点のschemaはmanifest/保持対応の削除を拒否する。R2-awareな精算を実装する際にはforward migrationで対応する。guardだけを外して容量を返す運用は行わない。この段階の内部serviceはHTTP経路へ公開しない。

## 次に接続する処理

1. 8 MiB超のblobをmultipartへ接続し、partごとのcheckpointとnative完了receiptを実装する。大量blobのbatch化・完走予算も検証する。
2. ACK喪失/未送信/結果不明/観測欠落の照合と取消し時の精算を接続し、Queue consumerへ進める。chunkごとに現行権限とclaim fenceを検査し、native R2の送信・結果不明・実終了の記録を残す。
3. 全blobを検証してから、固定manifest・衝突方針・dead propertiesをnamespaceの原子的な公開へ接続する。フォルダーの一部だけを公開しない。
4. job read/cancel/retry、停止・recovery・Outbox、pin/予約/physicalの精算、Shared画面の宛先選択と進捗を接続する。

同期DAVは引き続き同一owner・1,000 node・10 GiBまでで、cross-owner要求をREST jobへ自動fallbackしない。[DAV Shared](DAV_SHARED.md)を参照。検証結果と残る全体要件は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とする。
