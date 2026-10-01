# DAV PUTの保存・公開・回収

更新: 2026-10-01。

WebDAV PUTは本文保存後に公開用の30秒permitを取得する方式へ変更しました。31秒を超える実転送でも公開でき、本文受信中にnamespace permitや共通更新枠を保持しません。

migration0036で、開始時のupload/reservationを操作ID未結合のまま保持できます。実ownerのdav.put-start受付で現在の認可・lock・予約・不変attemptを一括確定し、直接ACK後だけ条件付きPUTを送ります。保存事実を記録した後に新しい短期permitを取得し、元のrevision/parent/tree/blob/credential/lockを検査して、operationへの結合とcreate10/overwrite8 stepの公開を原子的に行います。HTTPで解決した対象revisionも渡します。再送・ACK喪失・停止で本文を再送せず、未知結果の容量を保持します。

## 本文を受け取る前

現在のapp_password認可・対象revision・parent/tree/blobのsnapshotとlock tokenを確認する。操作IDは元のrequest intentから安定して導出するが、namespace permitとoperations行はまだ作らない。実ownerのdav.put-start受付を取得し、待機後の現在認可・lock・同ID不在を再検査して、24h予約・staging blob・receiving台帳・不変attempt/15分write leaseを原子的に保存する。同じbatchで自分の共通受付枠を閉じる。quota不足は507で本文とoperation claimより前に拒否する。

migration0035で固定したsource=davを維持する。0036はcompletion_op_idと予約op_idの両方NULLを許すが、real app_password/owner/space/parent、derived blob/reservation、hex64 digest、size/epoch/expiryを検査する。既存のbound DAVとprivate行はそのまま保持する。private capabilityは発行しない。

## 保存と公開

開始batchの直接ACKだけで1回のconditional PUTを送る。metadataはupload/attempt/blob/epoch。consumeKnownLengthでproducer/consumer/digestの終了を待つ。同じIDの再送は現在認可と元digestを検査し、未結合でも本文を再送しない。HTTP再試行は別request IDになる。

実PUT応答のsize/metadata/etagとhashを照合し、system:dav.put-storedで物理計上・completing・自己receiptを一括保存する。その後に初めてfresh30秒のLockDO permitを取得し、元intentでclaimする。転送前の認可snapshotとlockを公開batchでも検査し、変更済みtargetへ新しいrevisionで置き換えて上書きしない。HTTPで最初に解決したrevisionの不一致も保存前に拒否する。

公開batchはready body/physical/hash、unexpired upload、cleanup不在、exact operationを検査する。予約op_id→completion_op_idを結び付け、node/version/blob/予約消費/台帳完了/outbox/全stepを同時確定する。create10/overwrite8 stepを維持する。0036の結合triggerと従来の不変identityが別操作IDへの付替えを拒否する。permitの期限延長・immutable claimの更新は行わない。

## 編集可能な内部共有DAV

`/dav/Shared/<mount>`は`read`を前提に、現在の共有actionとapp password scopeの両方から能力を導出する。`create` + `node:create`はMKCOL、新規PUT、COPY先、lock-null作成を許可する。`edit` + `node:write`は既存PUT、PROPPATCH、MOVE元、LOCK/UNLOCKを許可し、`edit` + `node:delete`はDELETEと置換対象のtrashを許可する。MOVEは同じ共有能力内のcreate/edit/deleteをすべて要求する。read-only共有のAllowと405動作は従来どおりである。

mount解決時に共有ID/versionと受取人証明をprincipalへ固定する。direct grantはgrant version、group grantはgroup ID/versionとmembership versionを固定する。以後のnode認可、DAV path assertion、LockDO permit intent、operation claim、PUT upload台帳、公開batch、operation再照会は同じ固定contextを比較し、各境界で現在の共有action、grant/membership、owner/root ancestry、epoch、maintenance、app password scopeを再検査する。COPY/MOVEのsourceとdestinationは同じ固定contextでなければ403にするため、別共有・個人領域・別ownerへの権限持ち出しはできない。

migration0049はoperationsとuploadsへ不変のauthorization contextを追加する。shared PUTでもreservationは実ownerのquotaへ属し`share_id IS NULL`を維持する一方、upload source/completion triggerが共有ID/version、direct grantまたはgroup membership version、create/edit action、operationとのcontext一致を検査する。R2 key、blob owner、refs/pins、Outbox、GC、terminal receiptとcommit-unknown再照会はprivate DAVと同じ経路を使う。

## 失敗と回収

保存・許可・claim・namespaceの応答が不明なら、例外だけでR2を削除せず容量も返さない。operation未claimの段階で権限失効・停止・lock競合になった完成bodyも、予約と物理計上を保持し24h後の回収へ渡す。known failed operationと完成bodyの証明が揃う場合はsystem:dav.put-failedでlogical予約だけを解放し、physicalを維持してorphan/GC candidateへ原子的に渡す。GC後の厳密な終端再照会は新規受付不要。他のcleanup tokenや未確定receiptへ割り込まない。

cleanupは未claimのDAV台帳と、claim後・結合前のderived operationも扱う。source/owner/credential/space/epoch/parent/target/digest/予約を検査し、committedまたはstepのある操作を回収しない。upload終端化と該当claimed操作の失敗化が一つのbatchなので、その後の遅い公開は拒否される。期限後HEADのpresentはphysicalを保持してGC、absentは容量解放、metadata不一致は計上・隔離する。期限前のabsentはwrite終了証明にしない。

旧DAVのupload台帳がない予約は汎用復旧で解放しない。新しいNULL結合記録と旧記録を混同せず、証拠付きの専用回収は後続。

## 検証と残作業

Node3件・workerd25件を追加。全体checkが成功し、Node427件（26file、6.34s）・workerd1,970件（93file、1,051.32s）、計2,397件を検証しました。31秒転送、元の認可・revision・lock維持、実ControlDOの共有枠・停止・eviction、未結合台帳の回収競合、前方移行を含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。schema0036/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。

試験は31秒を超える実本文、転送中のpermit/operation/active枠不在、本文後の正確な30秒grant、停止/eviction、共有32枠、grant待機中と本文中の認可/lock/revision変更、native/permit/namespace ACK喪失、再送、NULL結合とcleanupの競合、旧schemaの前方移行を対象にする。

旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。
