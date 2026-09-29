# 現在の実装状態

[Galleryの画像一覧と閲覧](GALLERY.md)を所有者・内部共有・公開リンクへ接続しました。撮影日時順の200件ページ、グリッド／リスト、再帰切替、原本ライトボックスと前後移動に対応します。現在の原本・生成version・認可を固定し、サムネイル取得は画面付近の同時4件に制限します。50,000候補の読み取り行数gateが未達のため、設計に従い通常10,000候補へ縮小します。schema0071・通常79table・147 routeを維持します。lg要求時生成、動画情報・player、Bookshelf/Audioと運用の残件は継続します。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

## 先行実装の記録

[サムネイル配信](THUMBNAIL_DELIVERY.md)を所有者・内部共有・公開リンクへ接続しました。生成済みWebPの世代とサイズをチケットに固定し、現在の閲覧権限・原本・共有状態を配信直前にも確認します。同じ生成物の別名や再発行では配信容量を加算しません。schema0071・通常79table・147 routeを維持します。次はGallery API/UIとlgの要求時生成です。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[アップロード後のサムネイル生成](IMAGE_QUEUE.md)をQueueへ接続しました。通常・匿名uploadとWebDAV PUTからsm256/md768のWebPを生成・保存し、成功済みの再配信では変換とPUTを重複させません。invocation全体で有料試行2回・25秒を共有し、非対応・既知の失敗は原本を残して記録します。未知結果は保留します。schema0071・通常79table・147 routeを維持します。次はthumb配信・Gallery API/UI・lgの要求時生成です。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[サムネイルの公開再開](IMAGE_DERIVATIVES.md)を追加しました。元の処理期限が切れても、同じ通知の新しいclaimと現在の認可で、成功済みの保存結果を公開できます。D1と独立した終了履歴・書込み停止記録も照合し、費用・保存を重複させません。schema0071・通常79table・147 routeを維持します。Queue自動生成・配信・Gallery UIは次の接続対象です。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[復元後の画像回収](DATABASE_RESTORE_DOMAINS.md)を `repair-restored --kind images` へ接続しました。未保存の生成物や保存済みの未公開出力を、同じ停止証拠と容量計算で回収します。停止変更・独立履歴欠落では予約を保持します。schema・公開API・依存の追加はありません。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[サムネイル生成物の回収](IMAGE_DERIVATIVE_CLEANUP.md)を接続しました。D1と独立したControlDOの記録で新しい書込みを止め、未終了PUTがない場合だけ実容量へ計上して予約・pinを精算します。公開中の画像は原本が削除段階へ進むまで保持し、回収後も35日のGC猶予を守ります。専用Cronは最大8件・25秒、HEADは生成物ごとに累計64回までです。schema0071・通常79table・147 route。復元CLIの画像回収にも接続済みです。Queue自動生成・thumb配信・Gallery UI、未知nativeの運用修復は未完了です。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[サムネイルの保存処理](IMAGE_DERIVATIVES.md)を追加しました。成功済みのWebPを不変のR2 keyへ一度だけ保存し、元の認可・現在の原本・claim・epochと実際の保存証拠を確認して公開記録を確定します。画像の予約容量は通常ファイルの論理容量と分離し、実bytesは物理容量へ計上します。schema0070・通常78table・147 route。生成物の回収は後続の0071で接続済みです。未確定nativeの運用修復、Queue自動生成、thumb配信、Gallery UIは未完了です。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[画像変換の失敗記録](IMAGE_COSTS.md)を接続しました。Imagesの明示的な拒否と、EOFまで取得した生成物の検査失敗を終了として記録します。timeout後の遅い拒否、応答喪失、D1復元後も同じ記録を修復します。失敗の費用キーを保持し、再実行を許可しません。schema0069・通常77table・147 route。R2保存は後続の0070で接続済みです。回収・修復、配信、Queue、Gallery UIが次の接続対象です。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[画像変換の費用・終了記録](IMAGE_COSTS.md)を追加しました。同じblob・サイズ・生成versionの重複変換を防ぎ、実際の終了証拠をD1とは独立したControlDOに保存します。応答喪失やD1復元後も変換を再実行せず記録を修復し、未確定ならbackup・復旧完了・受付再開を止めます。schema0068・通常77table・147 route、依存追加なし。既知のImages失敗の終了証明は後続の0069で接続済みです。R2保存は後続の0070で接続済みです。Queue・配信・Gallery UIは後続です。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[サムネイル変換の実行部](IMAGE_TRANSFORMS.md)を追加しました。固定原本のサイズ・静止画・寸法を確認し、条件付きR2ストリームからsm256/md768/lg1600のWebPを生成します。生成物の寸法・metadata非保持・SHA-256を検査し、期限後の応答と途中中断も処理します。費用claim・native終了記録は後続のIMAGE_COSTSで接続済みです。R2保存は後続の0070で接続済みです。Queue・配信、Gallery UIは次の接続です。この実行部を追加した時点はschema0067・76table・147 route、依存追加なし。

[画像メタデータ](IMAGE_METADATA.md)を通常upload・WebDAV PUTの完了Outboxへ接続しました。JPEG/PNG/WebP/AVIFの寸法と許可したEXIFだけをbounded Rangeで抽出し、元blob・parent・actor・claimを確認してMIMEと同じbatchで保存します。新しいDAV PUTは利用者申告だけでinline mediaにしません。サムネイル生成・Gallery画面・既存データ再抽出と動画/音声は後続です。

先行472e682の[CI36473189569](https://github.com/daraskme/Nextcloud-flare/actions/runs/36473189569)は公開編集再開後の全10job成功。今回の画像処理は後続の変更です。

[公開編集の再開](PUBLIC_EDIT_RECOVERY.md)を実装しました。フォルダー作成・改名・削除の元intentを送信前に保存し、再読み込み後は同じsession/keyで明示確認します。別タブの同時実行、記録の差替え、ログアウト後の遅い応答による再保存を拒否します。サーバーAPI・schema・依存の追加はありません。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[ZIPダウンロード](ZIP_DOWNLOADS.md)を所有者・内部共有・公開リンクのAPIと画面へ接続しました。固定snapshot、日本語名・空フォルダー、正確なサイズ会計、期限付きblob保持に対応し、共有停止・内容変更・元credentialを各取得時に検査します。schema0067・通常76table・147 routeを維持し、今回のmigration/依存追加はありません。thumb/page/track・media、復旧側の残件、実環境検証は未完了です。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

先行ebcc9faの[CI36469054574](https://github.com/daraskme/Nextcloud-flare/actions/runs/36469054574)は、ZIP配信接続後のUbuntu/Windows Node・全native shard・通常/単一host browser・backup bindings/cliの全10jobが成功しました。今回の公開編集再開は後続の変更です。

先行c886e85の[CI36465246546](https://github.com/daraskme/Nextcloud-flare/actions/runs/36465246546)は、Ubuntu/Windows Node・全native shard・通常/単一host browser・backup bindings/cliの全10job成功。D1の結果列上限に対応した分割projectionと、Nodeの同時実行制限後の結果です。過去のWindows native失敗の根本原因特定とは区別します。

先行f2c6c33の[CI36460457472](https://github.com/daraskme/Nextcloud-flare/actions/runs/36460457472)はWindows全Node/4分割・通常/単一host browserの7job成功、backup bindings/cliとUbuntu Nodeの3job失敗で終了しました。バックアップはローカル実D1でも再現し、uploadsが51列になったことで型と値の102列SELECTがD1の結果列上限100を超えると特定しました。今回、同じ凍結keyset pageを100列以内のprojectionへ分割し、各pageのkey/順序/件数を照合するよう修正しています。Ubuntuはbackup-operator試験の5秒timeoutで、Nodeの同時実行を全OSで2に制限しました。製品の期限やUbuntuの試験timeoutは変更していません。CLI jobの保存ログはbackup_run_drill_command_failedのみで、詳細artifactは取得できなかったため、その失敗の同一原因までは確定せず修正後CIで確認します。修正後の検証は上記実装記録を参照してください。

更新: 2026-09-29。直近の到達点は[PROGRESS](PROGRESS.md)。

[所有者間コピー](COPY_JOBS.md)の明示的な再試行をRESTと画面へ接続しました。元jobの停止と全blobの精算が証明された後、現在の内容から新しいjobを1件だけ受け付けます。異なるkeyの競合・応答喪失・reloadでも同じ後継を追跡し、元jobの容量保持やnative記録を解除しません。DLQの保持期限管理と通知、未知native/part/handleの全修復、最大規模の実環境検証、タブ終了後や別端末の追跡復元は未完了です。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

前回の再試行はmigration0061で後継受付の一意索引と確定時検査を追加し、通常75table・147 routeを維持しています。依存追加はありません。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はlg要求時生成、動画情報/playerとpage/track・media配信、copyのDLQ運用・未解決attemptの修復を進めます。ZIPの実環境・最大規模検証も残っています。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

先行dad1f95の[CI36455427980](https://github.com/daraskme/Nextcloud-flare/actions/runs/36455427980)は、Ubuntu・Windows全Node/4分割・通常/単一host browser・backup bindings/cliの全10jobが成功して終了しました。過去のWindows native失敗の根本原因が特定されたことを意味しません。

先行937b434の[CI36450383559](https://github.com/daraskme/Nextcloud-flare/actions/runs/36450383559)は8job成功、Windows4/4失敗で終了しました。multipart-uploadの64 MiB + 3 bytes試験で完了直後のHEADが不在となりupload_complete_pending、867/868件成功です。R2 complete直前の受付・native結果・観測のどの段階が原因かは保存ログだけで確定できず、未解決として追跡します。/tmp/ncf-public-delete-ci-windows4.log。

先行837cfedの[CI36444362854](https://github.com/daraskme/Nextcloud-flare/actions/runs/36444362854)は、Ubuntu・Windows2/4〜4/4・backup bindings/cliの6job成功、browser失敗、Windows1/4が30分上限でcancelledでした。browserの4件は仮想スクロールの表示範囲外を直接操作していたため、検索してから操作する形へ修正しました。Windows全Node（1,573件成功、約9分）を独立jobへ分け、全4integration shardの検査と30分上限を維持します。今回のCIはpush後に確認します。

先行2d34118の[CI36440037128](https://github.com/daraskme/Nextcloud-flare/actions/runs/36440037128)は、Ubuntu・Windows4分割・browser・backup bindings/cliの全8job成功で終了しました。下記の先行Windows失敗の根本原因が特定されたことを意味しません。

先行4cf6153の[CI36435508999](https://github.com/daraskme/Nextcloud-flare/actions/runs/36435508999)は、Ubuntu・Windows1/4/2/4/4/4・browser・backup bindings/cliの7job成功、Windows3/4失敗で終了しました。3/4はmultipart-bucket-control-admissionのscan-page試験でr2_binding_verification_failedとなり、773/774件成功でした。保存ログでは根本原因を特定できず、解決済みとは扱いません。

先行1cee05dの[CI36430025491](https://github.com/daraskme/Nextcloud-flare/actions/runs/36430025491)は、Ubuntu・Windows4分割・browser・backup bindings/cliの全8job成功で終了しました。Windows全Nodeを1/4に集約後の全shard完走を確認しています。

先行67be478の[CI36425378826](https://github.com/daraskme/Nextcloud-flare/actions/runs/36425378826)は、Ubuntu・Windows1/4〜3/4・browser・backup bindings/cliの7job成功、Windows4/4は30分のjob上限でcancelledとなりました（GitHub annotation確認）。4/4の全Nodeは成功し、integration中に打ち切られています。先行backupのEBADF修正はUbuntuの全checkでも成功しました。Windowsの未完走を成功扱いにはしません。Windows全Nodeを1/4で一度実行し、残るshardでの重複を取り除きます。全integration shardと検証範囲は維持し、次のCIで完走を確認します。

先行c0ed70aの[CI36421891215](https://github.com/daraskme/Nextcloud-flare/actions/runs/36421891215)は、Windows4分割・browser・backup bindings/cliの7job成功、Ubuntu失敗で終了しました。backup-generationの不正SQL拒否試験で、期待したbackup_invalid_data_sqlがEBADFに置き換わりました。借用fdのReadStreamがparser中断時にfdを閉じ、FileHandleのfinally closeと競合する経路を一時ファイル100回中1回で再現しました。今回は64KiBのFileHandle.readに統一し、handleをfinallyだけで閉じます。修正後のローカル全Node1,528件が成功し、CIでの再確認はpush後に行います。

先行57d54dcの[CI36419462128](https://github.com/daraskme/Nextcloud-flare/actions/runs/36419462128)は、Ubuntu・Windows4分割・browser・backup bindings/cliの全8job成功で終了しました。

先行19622b8の[CI36415056432](https://github.com/daraskme/Nextcloud-flare/actions/runs/36415056432)は、Ubuntu・Windows1/4と2/4・browser・backup bindings/cliの6job成功、Windows3/4と4/4失敗で終了しました。3/4はbudget.test.tsの準備中にR2 grantのD1 triggerがr2_write_unavailableで拒否し、729/730件成功。4/4はcontrol-restore-inventoryのsame_round試験でdatabase_restore_inventory_unconfirmedとなり、839/840件成功。保存ログでは詳細原因を特定できず、解決済みとは扱いません。DLQ再投入変更57d54dcのCIは上記を参照してください。

先行f2e4788の[CI36411992220](https://github.com/daraskme/Nextcloud-flare/actions/runs/36411992220)は、Ubuntu・Windows4分割・browser・backup bindings/cliの全8jobが成功して終了しました。

先行45a72d2の[CI36405509625](https://github.com/daraskme/Nextcloud-flare/actions/runs/36405509625)は、Ubuntu・Windows分割2/4と3/4・browser・backup bindings/cliの6job成功、Windows1/4失敗、4/4はcancelledで終了しました。Windows1/4はNode1,464/1,466件成功で、backup-operatorとdatabase-restoreのbeforeEachが60秒でタイムアウトしました。準備処理のボトルネックは未確定です。先行810ea19の[CI36402990343](https://github.com/daraskme/Nextcloud-flare/actions/runs/36402990343)はWindows4分割を含む7job成功、browserのみ27/28件成功で終了しました。上書き応答喪失試験の待機順序は45a72d2で修正し、同コミットのbrowser CI成功を確認済みです。

先行0b85355の[CI36400478502](https://github.com/daraskme/Nextcloud-flare/actions/runs/36400478502)は終了しました。Ubuntu・Windows分割1/4〜3/4・browser・backup bindings/cliの7job成功、Windows4/4はcopy-executorの2件で書込み許可取得に失敗しました（workerd813/815件成功）。以前の固定件数assertionとは異なります。残り3秒で次転送へ進む経路をローカルで再現し、6秒の事前余裕を追加しましたが、CIの元例外が隠れていたため、2件の根本原因を確定したとは扱いません。内部causeを保持して次回CIで確認します。

先行8dd74ecの[CI36394122457](https://github.com/daraskme/Nextcloud-flare/actions/runs/36394122457)は終了し、Ubuntu・Windows4分割・browser・backup bindings/cliの全8jobが成功しました。UbuntuのNode1,436件と全workerd137file/3,093件の成功もログで確認済みです。直前81e9f01の[CI36396573483](https://github.com/daraskme/Nextcloud-flare/actions/runs/36396573483)は終了し、Ubuntu・Windows分割1/4と3/4・browser・backup bindings/cliが成功しました。Windows2/4はQueue再開1件（796/797件成功）、4/4はexecutor3件（811/814件成功）が失敗しました。25秒で正常にyieldしても固定件数を要求していたため、0b85355で時間による中断後の再開と重複PUT防止を検証する形へ修正し、D1/R2予算境界は少量の実転送で独立に再現しています。製品の期限・上限は維持しています。今回の変更のCIはpush後に確認します。

CI分割変更ae79ecaの[CI36387497530](https://github.com/daraskme/Nextcloud-flare/actions/runs/36387497530)は終了しました。Ubuntu・Windows分割2/4・4/4・browser・backupのbindings/cliは成功、Windows分割1/4は30分のjob上限でcancelled（annotation確認）、3/4はcopy-executionのepoch変更試験の準備中にfixture_copy_failedで失敗しました（Node1,431件成功、integration717/718件成功）。SQLエラーと受付outcomeの診断はef5ee58へ追加済みですが、原因解消とは扱いません。コピー実行処理b7a32abの[CI36387145263](https://github.com/daraskme/Nextcloud-flare/actions/runs/36387145263)はUbuntu・Windows3分割・browser・backupの全6job成功です。ef5ee58の[CI36389252207](https://github.com/daraskme/Nextcloud-flare/actions/runs/36389252207)は終了し、Windows4分割・browser・backupのbindings/cliが成功しました。Ubuntuは全Node1,431件成功、integration3,046/3,047件成功で、control-restore-domainのfixtureがdispatch_before<=started_at+5000制約に違反しました。開始と期限でDate.now()を別々に取得していたため、8dd74ecで同じ開始値へ統一しました。製品の期限・assertionは維持しています。fdc7abaの[CI36390929822](https://github.com/daraskme/Nextcloud-flare/actions/runs/36390929822)は終了し、Windows4分割・browser・backupのbindings/cli成功、Ubuntu失敗です。UbuntuはNode1,431件成功、integration3,066/3,067件成功で、control-restore-gcの同じ時刻fixture問題でした。8dd74ecでこちらも同じ開始値へ統一しました。

先行5787368の[CI36385410210](https://github.com/daraskme/Nextcloud-flare/actions/runs/36385410210)はUbuntu・Windows分割2/3・3/3・browser・backup成功、Windows分割1/3は30分のjob上限でcancelledです（GitHub annotationで確認）。上記4分割化後のCIで完走を確認します。

先行de13fc6の[CI36384106965](https://github.com/daraskme/Nextcloud-flare/actions/runs/36384106965)はUbuntu・Windows分割1/3・3/3・browser成功、Windows分割2/3とbackupは30分のjob上限でcancelledとなりました（GitHub annotationで確認）。backup:run-drillは上限直前に全assertion成功とSQL 9,233bytesのPASSを出していますが、jobの正常終了は確認できません。Windows分割2/3も打切り直前まで試験が進行しており、上記のCI実行単位へ分割します。以前のbackup_wrangler_failedや検索個別timeoutの原因が解決したことは意味しません。

先行2f9b8bdの[CI36381492636](https://github.com/daraskme/Nextcloud-flare/actions/runs/36381492636)はbrowser・Windows分割1/2が成功、Ubuntu・Windows分割3は復旧snapshot試験の旧table数74という期待値で失敗しました。通常75tableとexport対象名の完全一致へ今回修正し、対象46件は成功しています。backupは通常drill・operator drill成功後、run-drill中に30分のjob上限で打ち切られました（GitHub annotationで確認）。保存ログだけでは遅延箇所を確定できず、調査を継続します。

送信先は承認済み専用`codex/database-restore`です。先行b1fedc7の[CI36377836985](https://github.com/daraskme/Nextcloud-flare/actions/runs/36377836985)はUbuntu・Windows2分割・browser・backupが成功、Windows分割1はsearch.test.tsの1万件検索が90秒timeoutで失敗しました（965/966件成功）。検索試験の遅延原因は未解決で、上限や検査を緩めていません。先行33a8a80の[CI36365491865](https://github.com/daraskme/Nextcloud-flare/actions/runs/36365491865)はUbuntu・Windows3分割・browser・backupの全6job成功です。前回の時刻依存テスト修正はWindows3分割でも成功しました。以前のorphan-admission回数不一致と21cd396のR2保存先照合失敗の原因は未確定です。先行af30646の[CI36367826306](https://github.com/daraskme/Nextcloud-flare/actions/runs/36367826306)は全6job成功です。先行7e933b1の[CI36369537337](https://github.com/daraskme/Nextcloud-flare/actions/runs/36369537337)は全6job成功です。先行a52b815の[CI36371093589](https://github.com/daraskme/Nextcloud-flare/actions/runs/36371093589)はUbuntu・Windows3分割・browser成功、backup:run-drillのsource fingerprints中にbackup_wrangler_failedで失敗しました。保存されたログだけでは子プロセスの失敗原因を特定できません。最新CI状態はgh run listで確認します。

## 状態の意味

| 状態 | 意味 |
|---|---|
| 実装済み | repository内に本体と接続経路がある。ただしリモート公開済みとは限らない |
| 検証済み（local） | Node/SQLiteまたはworkerdのD1/R2/DO/Imagesで自動試験済み |
| 検証済み（CI） | GitHub ActionsのUbuntu/Windowsでrepository全checkが成功済み |
| 未検証（staging） | 実Cloudflare resource、Access、Queue、ネットワーク、browser等の試験が残る |
| 未実装 | 必要なサービス、UI、運用処理、または接続経路がまだない |

ローカル成功はstagingやproductionの成功を意味しない。現在productionへのmigration・deployは行っていない。

## 実装済みでローカル検証済み

| 分野 | 実装済みの範囲 | 検証済みの範囲 | 残る境界 |
|---|---|---|---|
| サムネイル変換の内部実行部 | 固定原本の入力計画、条件付きR2 stream、静止画sm/md/lg WebP、出力metadata非保持・寸法・hash・中断 | Nodeの上限/破損/失効/遅延、ローカルImagesのJPEG/PNG/WebP/AVIF/10-bit・3サイズ・alpha・EXIF除去 | 費用claim/native記録、Queue/R2保存・physical会計・配信、Gallery、実EXIF回転・品質・plan検証。[詳細](IMAGE_TRANSFORMS.md) |
| 画像メタデータと原本MIME | 新しい通常/匿名upload・DAV PUTのOutbox、JPEG/PNG/WebP/AVIF header、EXIF whitelist、current blob/parent/claim、元uploadを確認した受け取り専用認可 | Nodeの破損/上限、実D1/R2の原子確定/応答喪失/失効、Chromeの6形式と匿名AVIF実decode | Images/サムネイル・Gallery API/UI、既存データ/copy/move、動画/音声、他browser・実環境。[詳細](IMAGE_METADATA.md) |
| 公開リンクの所有者管理API/画面 | CRUD、閲覧/編集切替、期限、専用鍵によるpassword保存、秘密値更新、現行所有者の認可と共通受付、旧session/ticket失効、URLコピー | 実D1の権限変更・競合・rollback/応答喪失・cursor分離、実PBKDF2・Unicode・鍵切替、mobile browser操作 | 実環境。[詳細](PUBLIC_SHARES.md) |
| 受け取り専用共有 | 所有者管理、password/期限/容量上限、匿名receipt/単一・分割送信、衝突時自動改名、owner/share原子予約、reload再開 | 実D1/R2、既存移行、失敗/中止精算、型・関連Node、390px browser・96 MiB再開・ACK喪失 | 実環境・最大規模。[詳細](UPLOAD_ONLY_SHARES.md) |
| 公開閲覧・フォルダー作成・名前変更・削除・upload | 独立public build/SRI、root/children、ticket配信、現行edit権限でのcreate/rename、元session/key固定の再送とoperation照会、単一/分割upload・上書きAPI/画面、IndexedDB再開・中止、確認付きtrashと所有者の復元 | 匿名複数tab、共有境界、保存直前の失効、DAV lock、ACK喪失、権限切替、mobile browser | thumb/page/track・media、staging。[詳細](PUBLIC_SHARES.md) |
| 公開リンクの匿名認証 | challenge/Cookie、秘密値/password照合、共有sessionの発行/再利用、public CSRF/logout、ControlDOの共有10/IP30回のrolling制限 | JWT用途/鍵切替、D1の失効競合・応答喪失、DO並行制限/eviction/喪失・停止。結果はIMPLEMENTATION_STATUS | 未接続の公開API、staging。[詳細](PUBLIC_SHARES.md) |
| DLQ記録・管理者再投入 | 配信単位の観測、50件ページ、同じOutboxへの再配信予約、監査と一度限りの受付、現行管理者と元actorの認可 | 同時要求、応答喪失、失効/停止、copy途中再開、成功済みPUT/completeの再送防止、未知native保留。詳細はIMPLEMENTATION_STATUS | 保持期限・通知・実Queue/DLQ運用。[詳細](DEAD_LETTERS.md) |
| 受信共有の閲覧・編集 | Shared一覧・配下/単体file閲覧、選択share固定、共有rootでのparent/breadcrumb遮蔽、content download、folder作成/改名、単一/分割upload・上書き、共有内move/copy/trashと所有者のごみ箱 | 実D1で認可/失効競合/再送/Outbox/UploadDO/R2、実browserで独立受信者のmobile表示・応答喪失・reload再開・親情報の遮蔽 | 公開link、copyのDLQ・最大規模検証は後続。[詳細](SHARED_WORKSPACE.md) |
| 所有者間copyの受付・転送・一括公開 | 固定manifest、job/Outbox、pin/予約、実行lease、固定blob Range、単一/分割保存・part進捗・physical/native照合、一括公開・成功時の保持精算、停止/照会・未着手/未送信証明/保存済み/既知multipart中止後の失敗精算、実成功後のobject観測修復 | 実D1/R2/DOで認可・応答喪失・並行取得・遅延成功・重複送信拒否を検証。回帰結果はIMPLEMENTATION_STATUS | Queue実行/再開と限定精算は接続済み。停止後巡回は接続済み。上限内の規模検証・未知/未送信修復・中止attemptの再試行管理・DLQ運用は後続。REST受付/read/cancel/retryと画面は接続済み。[詳細](COPY_JOBS.md) |
| 内部共有DAV | 固定mount一覧/解決、read/edit操作、同一ownerの別mount間COPY/MOVE、両側の選択とロック・Outbox・復旧 | 実D1の権限停止競合、再送・応答喪失・照会・上書き、schema移行と破損復旧記録の拒否。関連回帰はIMPLEMENTATION_STATUS | cross-owner copy、実OS/staging。[詳細](DAV_SHARED.md) |
| 内部共有の管理 | 所有者CRUD/期限設定、受信一覧API、固定mount名、version/相手/現行認証の再検査、旧session/ticket失効、Files管理画面 | 実D1の認可/競合/rollback/応答喪失、実ブラウザーのmobile CRUD/非再送/古い編集拒否 | 公開link・受け取り専用共有は接続済み。ZIPも接続済み。[詳細](INTERNAL_SHARES.md) |
| 復元後snapshotの隔離検証 | DO/CLI観測照合・信頼済みmigration prefix・全通常table hash・隔離SQL/FK/FTS・DO証言保存 | 新規Node17/workerd16、関連CLI150/workerd138、18操作の権限拒否と68tableの実bindingドリル成功 | 採用用停止障壁・新epoch採用・全監査/再開は後続。[詳細](DATABASE_RESTORE_SNAPSHOT.md) |
| Time Travel送信と実応答記録 | 永続pending・5秒の1回grant・固定APIへのPOST・実応答のDO保存・unknownの再送拒否・旧epoch停止維持 | Node34/workerd22追加、関連CLI94/workerd155、16操作の権限拒否と模擬巻戻しを含むbindingドリル成功 | 既定で無効。全I/O運用証明・snapshot照合・epoch採用・live復旧は未完了。[詳細](DATABASE_RESTORE_TIME_TRAVEL.md) |
| probe・upload・multipart・空ファイル・manifest・GCのR2終了記録 | migration0041〜0046・DO/D1送信記録・元attemptの一意制約・実成功/未送信だけの終了記録・凍結/再開/GC/予約解放拒否・既知終了のrepair | 期限切れpendingの移行保持、結果不明・遅延終了・元claim/認可の変更・15分転送leaseを試験。68tableの運用ドリル成功。全体結果はIMPLEMENTATION_STATUS | CLI保存とepoch履歴は専用DO記録へ接続済み。native不明の運用証明と実復元後epoch採用は後続。[詳細](R2_WRITE_SETTLEMENT.md) |
| epoch履歴のnative終了記録 | DO pending intentとreserved receiptの原子的保存、1回だけの条件付きPUT、実応答のみの終了記録、古い継続の拒否 | 新規24件と停止・監査・凍結・backupの関連workerd177件、Node11件が成功 | 旧実装/全喪失の終了証明、live復元後採用。[詳細](EPOCH_HISTORY_WRITES.md) |
| 復旧用epoch事前予約 | 復旧元証言・凍結対象・要求IDの固定、DO/R2予約、private RPCとCLI、通常cancel拒否、D1旧epoch維持 | 新規workerd15件を含む関連162件、Node126件、14操作の権限拒否を含む実bindingドリル成功 | 実D1上書き・予約epoch採用、予約後の安全な中止、全I/O終了証明。[詳細](DATABASE_RESTORE_EPOCH.md) |
| 復旧中D1書込み凍結 | migration0040と0041で全68通常table guard・修復受付拒否・永続intent・再照会・停止token更新による取消し | 保留R2試行の拒否とprivate bindingドリル成功 | 全外部I/Oの終了証明・実上書き/採用は後続。[詳細](DATABASE_RESTORE_FREEZE.md) |
| 復旧先の一括照合 | BACKUPS fresh probe/S3読戻し、同一D1 challengeでのBLOBS/BACKUPSの試行・期限照合 | Node42/workerd28追加、全check3,206件、実private bindingドリル成功 | 最終停止、実上書き・採用、実S3は後続。[詳細](DATABASE_RESTORE_BINDINGS.md) |
| 復旧先BLOBSの照合 | fresh D1照合・bucket固定・probe条件付き更新/S3読戻し・DO観測保存 | Node40/workerd26追加、全check3,136件と実private bindingドリル成功 | 最終停止、実上書き・採用、実S3は後続。[詳細](DATABASE_RESTORE_BLOBS.md) |
| Time Travel候補の照合 | remote候補準備・固定D1のfresh照合・時刻検索bookmark一致・DO証言 | Node42件/workerd24件追加、全Node843/関連workerd144、実private bindingと合成providerのドリル成功 | 実remote検索、保持期限保証、最終停止・D1上書き・採用は未接続。[詳細](DATABASE_RESTORE_BOOKMARK.md) |
| 復旧先D1の照合 | 対象のDO固定・fresh停止token・独立Wrangler query・5分の観測・再実行 | Node39件/workerd23件追加。全Node801件・関連workerd120件と実binding/CLI成功 | 最終停止・実上書きは後続。[DATABASE_RESTORE_TARGET](DATABASE_RESTORE_TARGET.md) |
| 復旧準備の運用CLI | 専用service binding、prepare/verify/inspect/cancel、隔離SQL検証とDOへの証言保存 | Node34件追加・DO10件追加。全check2,942件・実binding/CLI両ドリル成功 | 対象binding・最終停止・実D1上書き・新epoch採用は後続。[DATABASE_RESTORE_OPERATOR](DATABASE_RESTORE_OPERATOR.md) |
| logical復旧元の照合 | 完了receipt・R2 manifest/部品hash・35日・永続cursor・ControlDO RPC | 新規42件、関連115件。再起動・取消し・古い結果・期限・時計逆行・完了後の競合・遅い応答 | 対象binding・最終停止・実復旧は後続。SQL/schema再検証は専用CLIへ追加。[DATABASE_RESTORE_SOURCE](DATABASE_RESTORE_SOURCE.md) |
| D1復旧準備 | DO内の要求・世代選択固定、停止保持、照会/取消し、通常操作との排他 | primary/ACK喪失、eviction、巻き戻り、遅延処理、未知KDF、同epoch巻き戻りと未確定停止の28件が成功。全体結果は検証記録 | 最終停止・新epoch採用・実D1復元は後続。[DATABASE_RESTORE](DATABASE_RESTORE.md) |
| バックアップ実行監視・通知 | host SQLite・失敗/長時間/成功欠落・HTTPS状態変化通知・永続未ACK・別timer例 | 監視32件、実CLI設定失敗、loopback受信fixture、ACK喪失・並行送信・復旧 | 実通知先・host監視・設置は後続。[BACKUP_MONITORING](BACKUP_MONITORING.md) |
| 期限切れ世代の自動走査 | sweep・永続round/cursor・既知破損の保留・maintainの明示option | Node22/workerd13追加、eviction・100件超の不在receipt・固定期限・競合、9操作のbindingドリル | timer/通知先の実設置・remote運用は後続。[BACKUP_SWEEP](BACKUP_SWEEP.md) |
| 期限切れSQL世代の明示回収 | 専用prune・実receipt/hash/年齢照合・20部品/100RPC・manifest最終削除 | Node12/workerd26追加、境界・応答喪失・eviction・遅延DELETE、専用bindingドリル | 未完了/破損世代の回収、remote運用は後続。[BACKUP_PRUNING](BACKUP_PRUNING.md) |
| 日次運用と世代補充 | maintain・完了ID照合・不足/鮮度補充・定時起動例 | Node18/workerd8追加、Node662件と関連87件、実5世代ドリル成功 | timer/通知先の実設置・remote/live復旧は未完了。[BACKUP_MAINTENANCE](BACKUP_MAINTENANCE.md) |
| バックアップ保持判定 | inventory/health、実R2/SQL検証・35日/最少5世代/最新24時間・終了コード通知 | Node27/workerd23追加、全Node644件・関連79件成功 | 通知先の実設定・live復旧は未接続。[BACKUP_RETENTION](BACKUP_RETENTION.md) |
| 日次バックアップ | サーバー所有ID・同日実データ検証・R2からの再開 | Node17/workerd17追加、関連56件・全Node617件成功 | 定時起動・通知先の実設置・live復旧は未完了。[BACKUP_OPERATOR](BACKUP_OPERATOR.md) |
| 値を保持するデータ出力 | 型情報・BLOB hex・NUL TEXT・bounded SQL writer | Node16件追加、統合600件と実D1/CLIの3ドリルが成功 | remote・大規模運用は未検証。[BACKUP_EXPORT](BACKUP_EXPORT.md) |
| 過去schemaと全table照合 | 信頼済みprefix、保存時schema、未知tableの拒否 | Node19件追加、統合584件と実D1の3ドリルが成功 | 全データ形式・live復旧は後続。[BACKUP_HISTORY](BACKUP_HISTORY.md) |
| バックアップ用GC保護 | migration0039・35日猶予・最後の参照による延長・WebDAV空ファイルの直接削除除去 | Node565件（34file、18.55s）が成功しました。workerd全体は2,013件中2,012件が成功し、失敗した1件は旧仕様の即時削除を期待するDAV試験でした。35日以内の削除拒否・容量保持と期間経過後の回収へ更新し、そのfileの17件（7.06s）が成功。再実行を含めworkerd全2,013件を確認しています。lint345file・型・契約/設定検査、Web build・Worker dry-runも成功しました。schema0039の実D1試験5件と、従来CLI（67table・SQL9,599bytes）、専用binding（9,613bytes）、実CLI run→receipt→download→restore-offline（9,110bytes）の3ドリルも成功しました。この変更のCIはプッシュ後に確認します。 | 35日保護は元BLOBS bucket内の削除猶予です。移行前に削除済みのobjectを復元せず、bucket/account喪失への別保管も提供しません。過去schemaは0037以降の信頼済みmigration列だけを受け付けます。追加データ形式、定時起動、Time Travel・live復旧・全storage喪失からの運用復旧とremote検証は未完了です。 |
| バックアップ運用コマンド | 専用capability、run/receipt/cancel、再実行と失敗時の停止維持 | Node25件を追加し、全552件（33file、19.71s）が成功しました。専用bindingの実ControlDO/D1/R2ドリルは67table・SQL9,613bytesで成功し、全4操作の権限/環境/無効化、eviction後の再実行、取消・履歴、復元先のFTS/会計を確認しました。R2保存先修正後の実CLI run→receipt→download→restore-offlineもSQL9,110bytesで成功し、同じ引数の再実行と元policyへの復帰を確認しています。従来CLIのcapture/publish/download/restore-offlineも修正後に67table・SQL9,599bytesで成功しました。全体checkも成功し、Node552件＋workerd2,009件（95file）の計2,561件、lint・型・契約・設定検査、Web buildとWorker dry-runを確認しました。 | 専用service bindingを持つ運用者だけがSQL検証済みhashを証言します。remote Cloudflareの認証・権限・実resourceによる運用検証は未実施です。定時起動、元BLOBSの独立保管、live復旧、全storage喪失からの運用復旧は未完了です。 |
| バックアップ完了記録 | 内部completeBackup、R2実体/cursor照合、D1 receiptと元policyへの原子的復帰、migration0038 | Node22件・workerd18件を追加し、全体checkが成功しました。Node527件（32file、14.22s）・workerd2,009件（95file、1,085.53s）、計2,536件を検証しています。lint335file・型・契約/設定検査・Web build・Worker dry-runも成功。schema0038で実CLIのcapture→verify→local R2 publish→download→restore-offlineが67table・SQL9,599bytesで成功しました。今回commitのCI/browserはプッシュ後に確認します。 | completeBackupは内部RPCです。SQL/source/schema/FK/FTSの全検証は信頼された生成コマンドが担い、ControlDOはそのhashでR2実体を再検査します。利用者が指定したhashを転送する公開APIは追加していません。remote運用の認証・権限検証、元BLOBSの独立保管、live復旧、全storage喪失からの運用復旧は未完了です。 |
| バックアップR2保存・取得 | 条件付きpart保存、manifest最終確定、native終了記録、unknown保持、download後の全検証 | 実CLI/local R2の保存・取得・隔離復元。8MiB超の複数part、再開、ACK喪失、同時公開、改変/欠落、期限・本文上限・署名を試験 | 保存対象はD1の論理SQL。remoteの運用接続検証、BLOBS本体の独立保管、定時起動・live復旧は後続。remote S3は実装済み・実環境未検証。 |
| バックアップ世代・オフライン復元 | 実Wrangler抽出、全行/hash/schema/FK/FTS照合、ローカル世代保存、新規DB復元 | schema0038・全67tableの実CLIドリルで元DBの凍結保持、容量、FTS検索を確認。欠落/内容変化、不正SQL、checksum不一致、既存出力保護、UTF-8/文上限を試験 | 旧version/全データ形式の互換性、Time Travel・live restoreの新epoch/全監査、backup中の全storage喪失からの運用復旧は後続。 |
| バックアップ書込み停止 | 専用永続intent、全通常table凍結、watermark、元policyへの原子的復帰 | 全table guard、旧schema移行、確定順序、ACK/primary喪失、遅延開始/解除、全storage喪失、rollback。実ControlDOの完了記録は上記の通り検証 | 内部RPCとCLIを認証付き運用処理で接続する一連のドリル、停止中の全ControlDO喪失からの運用復旧は後続。 |
| DAVの転送と公開の分離 | 本文後のfresh30秒permit、開始受付、未結合記録の回収 | Node3件・workerd25件を追加。全体checkが成功し、Node427件（26file、6.34s）・workerd1,970件（93file、1,051.32s）、計2,397件を検証しました。31秒転送、元の認可・revision・lock維持、実ControlDOの共有枠・停止・eviction、未結合台帳の回収競合、前方移行を含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。schema0036/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。 | 旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。 |
| DAV PUTの保存台帳 | 送信前の永続記録・共通受付・未知結果の容量保留・回収/GC | Node2件・workerd47件を追加。全体実行はNode424件（25file、6.25s）・workerd1,944/1,945件（91file、1,010.68s）成功。唯一の失敗は移行数の旧期待値34で、35へ修正後に実D1のschema5件（2.71s）が全成功しました。ローカル計2,369件を検証済みです。最終lint・型・契約/設定・Web build・Worker dry-runも成功。Windows分割は実Vitestの91fileを46/45fileへ重複・欠落なしと確認し、CIでの実行結果は別途確認します。schema0035/通常67table、依存追加なし。 | 旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。 |
| upload公開失敗後の精算受付 | 実ownerの共通枠・物理計上証明・GC後の再照会 | workerd51件を追加（境界46件・実ControlDO4件・HTTP1件）。関連109件（66.06s）と実ControlDO4件に加え、全体checkが成功。Node422件（25file、6.20s）・workerd1,898件（87file、990.88s）、計2,320件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 | 旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。 |
| 旧epoch修復の全体受付 | 予約・通知・FTS、厳密な停止条件と自分の枠だけの例外 | workerd67件を追加（境界59件・実ControlDO8件）。追加67件（14.72s）・既存復旧23件（12.96s）と全体checkが成功。Node422件（25file、5.81s）・workerd1,847件（85file、983.56s）、計2,269件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 全体check後にCI試験を調整し、KDF統合20件（7.15s）・待機列Node8件（104ms）・lint・型検査を再確認しました。 | 旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。 |
| 全bucket multipartの全体受付 | scan/parts/abortの8経路、null scope、直接ACK、同一ControlDO | workerd82件を追加（境界73件・実ControlDO9件）。関連109件（97.66s）と全体checkが成功。Node422件（25file、5.68s）・workerd1,780件（83file、971.26s）、計2,202件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 | 旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| 未追跡object調査・回収の全体受付 | scan/GCの10経路、null scope、直接ACK、同一ControlDO | workerd105件追加（境界93件・実ControlDO12件）。全体check成功、Node422件（25file、6.01s）・workerd1,698件（81file、888.73s）、計2,120件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 | 全bucket multipart inventory・旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| 所有者なし更新の全体受付 | migration0034・global RPC・R2 probe、通常と同じ枠 | Node6件・workerd68件追加（probe境界58件・実ControlDO等9件・移行1件）。全体check成功、Node422件（25file、6.04秒）・workerd1,593件（79file、851.58秒）、計2,015件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。診断表示の追加後も関連59件（44.02秒）と型検査が成功。schema0034/通常67table、依存追加なし。 | orphan/全bucket inventory・旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| 既存uploadの未知multipart調査受付 | round・予算・観測・ID/page・中止receipt・lease返却・エラー、同一ControlDO受付 | workerd66件追加（境界59件・実ControlDO7件）。全体check成功、Node416件（25file、5.90秒）・workerd1,468件（75file、755.11秒）、計1,884件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 | orphan/全bucket inventory・旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| blob GCの全体受付 | 通常/停止中/復元中、claim・外部予算・精算・エラー、同一ControlDO受付 | workerd80件追加（GC境界73件・実ControlDO7件）。全体check成功、Node416件（25file、5.66秒）・workerd1,402件（73file、705.27秒）、計1,818件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 | 残るorphan/multipart inventory・Queueの更新受付とbackup barrier、未知KDF/multipartの収束、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| upload自動回収の全体受付 | claim・外部予算・観測・閉鎖・精算・エラー、ControlDO直接受付 | workerd62件追加。90c4593のローカル全check成功、Node416/workerd1322、計1,738件。CIは冒頭参照。 | 残るinventory/Queueの更新受付とbackup barrier、未知KDF/multipartの収束、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| UploadDO台帳の全体受付 | 初期化・通常反映・停止反映・喪失時停止、共有枠と直接ACK | workerd33件追加。8892b4fのローカル全check成功、Node416/workerd1260、計1,676件。CIは冒頭参照。 | 残るinventory・Queue/backupと実環境は後続 |
| 復旧用更新の全体受付 | migration0033、通常と同じ枠、物理観測・既知ID・初期化停止・外部claim | Node8件/workerd41件追加。f9dffcbのCI全成功、Node416/workerd1227/browser19、計1,662件。 | 残るinventory・Queue等の残る更新受付、backup barrier、未知KDF/multipartの収束、共有/メディア/実環境検証は後続です。 |
| upload中止/検証の全体受付 | single/multipart利用者中止、multipart検証済み情報、exact receiptと返却 | workerd45件追加。f62dad8のCI全成功、Node408/workerd1186/browser19、計1,613件。 | 残るinventory/Queue/backupは後続 |
| upload転送の全体受付 | 単一start/recover/verify、multipart start/completeの5経路、直接ACKによる外部送信とDB-only receipt回収を分離 | workerd45件追加。47160c4のCI全成功、Node408/workerd1141/browser19、計1,568件。 | 残るinventory/Queue/backupは後続 |
| upload予約の全体受付 | 単一/分割の新規予約、署名後取得、quota/blob/uploadと確定記録/解放を同一batch、既存receiptは読取りのみ | workerd42件追加、停止/失効/期限/quota/revision、全rollback、応答喪失、実ControlDO満杯での読取り・待機・返却 | 残るinventory/Queue/backupと実環境は後続 |
| 配信更新の全体受付 | budget・ticket発行/交換/取消し、共有もコンテンツ所有spaceで受付、変更/確定記録/解放を同一batch、取消し証明後のmanifest削除 | workerd70件追加、4 principal・実時計・停止/失効・応答喪失・遅延公開・実ControlDO32枠・HTTP503/CORS | upload転送/Queue/backup統合、実環境未検証 |
| Access sessionの更新受付 | migration0032、登録・初回owner・logout共有枠、既存JWTのread-only照合 | Node4/workerd22件追加、scope・移行・失効・応答喪失・実ControlDO待機、8e7243eのCI全成功 | 残る更新と実環境は未接続 |
| schema・契約 | migration `0001`〜`0051`、69通常table、FTS、147 route契約、FK graph、会計・状態遷移trigger | SQLiteとD1 migration、FK/CHECK/trigger、生成契約一致 | 全147 routeの機能実装は未完了 |
| 認証 | Access JWT/JWKS、user/service分離、bootstrap、session、logout、CSRF、app password | JWT失敗境界、鍵cache、bootstrap競合、session失効、PBKDF2 | 実Access/MFA policy、remote issuer/AUD/secret |
| KDF終了記録repair | DO SQLite最大20件の送信前/終端記録、DB精算再照合、停止中内部RPC、ローカル記録の復旧fence | 新規14件、既存認証・受付再開・GC停止の回帰、全check成功 | 証明喪失した未知試行の運用収束、実環境のrepair/restore drill |
| KDF実行制限 | Worker/ControlDO各1件・待機256件・5秒、D1の600回/65秒予算と未精算20枠、epoch cooldown、発行/認証/鍵更新と503応答。公開linkは事前の共有/IP制限にも接続 | 新規Node7件・workerd20件、既存認証34件、実ControlDO RPC/eviction/全喪失。詳細は[KDF_ADMISSION](KDF_ADMISSION.md)と[PUBLIC_SHARES](PUBLIC_SHARES.md) | 証明喪失試行の収束、実CPU・処理量・切断 |
| 認可 | private/app-password/internal-share/anonymous-shareのnode authority、祖先検査 | 4 principal、失効対commit、別owner・削除祖先拒否 | 全operation・全routeのoperand tuple |
| namespace更新の全体受付 | migration0030、D1 active32/waiting256、ControlDO FIFO、LockDO全8許可経路、失効と最終commit fence | 新規Node4・workerd17件と全check成功。上限・再送・応答喪失・待機後認可・停止/復旧 | 他の更新経路・backup barrier・実負荷。[MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| DAVロックの全体受付・確定記録 | migration0031、LOCK/refresh/UNLOCKの共有枠、lock変更/記録/解放の一括確定、60秒保持 | Node4・workerd22件追加。実ControlDO待機、HTTP503、失効/停止、応答喪失、別処理のunlock、rollback、旧DB移行 | HTTP応答喪失後のtoken再取得・別RPCの結果再生は未実装。実環境未検証 |
| app password更新の全体受付 | 発行・失効・pepper更新の共有枠、KDF後取得、current authorityと確定記録/解放を同一batch | workerd32件追加。混雑HTTP503、失効/停止、ACK/readback喪失、root/20件上限、別owner拒否、実ControlDOのKDFと32枠 | 他のaccount更新とbackup統合、実環境未検証 |
| atomic mutation | operation claim/lookup、permit、LockDO、rollback、commit unknown収束 | 同時再送、競合、失効、応答喪失、全step rollback | 実ControlDO admission下のstaging試験 |
| Files UI | React/TanStackの一覧・操作・trash・確認付き上書き/再開upload・logout、認証付きprivate assets | ローカル実APIの19 browser scenario、NodeのCSRF競合4件 | 共有・media・実環境。検索は[SEARCH](SEARCH.md)。詳細は[FILES_UI](FILES_UI.md) |
| フォルダー集計 | Accessのaccount stats、所有folderの再帰件数/現在のlogical bytes、1万件上限と部分結果、Files情報dialog | D1の12件と検索9件の回帰、実APIでのbrowser集計/再集計/拒否時非表示。全check成功 | 実D1予算・負荷、共有/media別集計。[FOLDER_STATS](FOLDER_STATS.md) |
| 検索 | Access検索API、現行権限/祖先、名前の正規化、範囲10,000・page200、用途/条件付きcursor、Files検索と元の保存先の保持 | Node query/cursor、実D1階層・共有/削除/失効・旧索引・上限、実browser検索/上書き/201件pagination/世代競合 | media metadata parser/同期、索引version再構築運用、実D1予算。[SEARCH](SEARCH.md) |
| Files REST | node詳細、breadcrumb、children、folder作成、rename、trash、MOVE、COPY、operation照会 | 実D1/DO、cursor改変・期限・tree変更、Outbox provenance | 全route profile・実環境 |
| Trash | 一覧、restore、purge、別trash子退避、名前衝突解決、GC稼働中の永続pauseと既存削除drain | 最大64層・1,000 node、冪等再送、期限/識別子/停止競合、応答喪失・再起動、実browser復元 | 単一hold、実環境、大規模非同期trash/purge。詳細は[RESTORE_GC](RESTORE_GC.md) |
| 停止中GC drain | 旧deletingのみのblob/orphan回収、claim epoch・dispatch counter、ControlDO内部RPC、前後の監査初期化 | 応答喪失、停止/epoch/lease変更、遅延削除、二重精算防止、回収後の全復旧監査 | 外部置換objectの猶予、実R2・完全restore drill |
| GC | 35日猶予candidate・最後のnamespace参照解除による期限延長、claim lease、pin/ref/pause fence、R2 delete/head、physical精算 | 実workerd R2、複数pin、pause、応答喪失、lease再取得 | unknown multipart ID、既知keyの不正置換、実Cron運用 |
| 未追跡object | D1のページcursor/lease、HEAD照合、隔離台帳、35日猶予、実physical会計、再利用拒否、Cronと停止中inventory | 応答喪失、同時走査/回収、置換・再出現、owner後日復元、pause/epoch、復旧監査 | incomplete multipart、他prefix、実R2運用 |
| multipart S3診断 | 署名付きListMultipartUploads/ListParts/GetBucketLifecycleConfiguration、1 GET/最大100件/1 MiB/10秒、停止中ControlDO診断 | XML/設定/署名/timeout/ページ失敗、実D1 fenceとControlDO監査再初期化、予約保持 | 全体不在証明・予約精算、実S3/lifecycle試験 |
| R2/S3対応検証 | migration `0023`、固定64-byte system probeのfresh nonce/CAS更新、scope付きD1 fence、ControlDO検証と復旧監査 | 実R2条件付きPUT、遅延create/更新、誤bucketの古い値、応答喪失、epoch/pause/lease、system容量保持 | multipart全体閉鎖・予約精算への接続、実S3試験 |
| 未追跡multipartの中止・容量保留 | migration `0027`/`0028`、全`u/`走査、正確なkey/ID照合、part最大観測bytesのphysical保留、発見handleの中止・不変receipt、停止中ControlDOと復旧fence | 観測27件と中止19件。ページ、並行処理、応答喪失、遅い応答、source/proof、所有者復元、64回上限、0-byte再開拒否 | 全体閉鎖・容量精算、実S3、Cron/HTTP。[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md) |
| multipart ID修復 | migration `0022`のscan/handle台帳、毎回freshなBLOBS/S3対応検証、既存uploadの全ID走査・abort・不変receipt・physical観測、停止中ControlDO repair | 複数ID/ページ、claim・page・receipt応答喪失、遅延ID、epoch/token/pin/lease、S3障害時の会計。対応検証と同一batchの失効境界 | 全体不在証明・予約精算、実S3、Cron |
| private単一upload | HMAC capability、D1予約、1回だけのR2 PUT、SHA-256、GETによる応答喪失回収、原子的新規作成/上書き、status/abort HTTP、24時間後のCron回収・GC接続 | 実D1/R2/LockDO、0 byte、同時送信、10 step rollback、失効、DB/R2応答喪失、CSRF/Origin、回収lease競合、旧epoch、実ControlDO停止中repair | 公開共有、未知object修復、stagingは未完了 |
| private multipart upload | D1予約・immutable geometry、R2一度限りcreate、UploadDO認可RPC・状態/part mirror、streaming part/SHA-256、4並列・3試行、R2一度限りcomplete/HEAD、原子的新規/上書き公開、terminal照合、既知R2 IDのabort/期限切れ回収・GC接続、HTTP create/part/status/page/complete/abort | D1/R2/DO/LockDO、64 MiB+末尾の公開、同時確定、応答喪失、storage全喪失、失効、10 step rollback、complete/abort排他 | 未知ID回収後の予約精算は未接続 |
| WebDAV | OPTIONS、GET/HEAD/Range、PROPFIND Depth 0/1、MKCOL、PROPPATCH、PUT、DELETE、COPY、MOVE、LOCK/UNLOCK | path、If/Lock-Token、ETag、dead props、95MB stream、各mutation、実HTTPの空本文操作。詳細は[EMPTY_HTTP_BODY](EMPTY_HTTP_BODY.md) | 実OS client gate、cross-owner copy、残るmethod/profile。[内部共有DAV](DAV_SHARED.md) |
| ZIP保存 | 所有者・内部共有・公開リンクの発行/取得APIと保存画面、v2固定manifest、STORE、日本語名・空folder、期限付きpin、共通budget | D1/R2/DOで元credential・共有期限/停止・変更拒否・R2異常・切断と会計を検証。画面を含む最新結果はIMPLEMENTATION_STATUS | 最大規模・実Cloudflare/OS検証。[詳細](ZIP_DOWNLOADS.md) |
| content ticket | target manifest、ticket発行/取消、Cookie交換、current blob配信、BudgetDOの対象重複排除/共有使用量、R2/bodyへのlease期限伝播 | D1/R2、署名、失効、Range、budget reserve/settle、実HTTPの発行・交換・空本文取消し、上書き/別target配信、1MiB/対象数上限、期限更新/遅延R2/停止body/取消し。詳細は[BUDGET_ALLOWANCE](BUDGET_ALLOWANCE.md)と[CONTENT_LEASES](CONTENT_LEASES.md) | page/entry/track、全route会計、長時間download再開UI・実環境 |
| quota・会計 | logical ref、pin、used/reserved/physical bytes、reservation | counter drift、上限、rollback、物理削除精算 | 実運用repairとalert |
| Outbox | durable producer、lease再送、ID-only Queue message、consumer、共通受付と固定25秒期限 | send/D1応答喪失、重複delivery、主要node event provenance | 実Queue/DLQ、残るevent kind |
| 復旧基盤 | epoch履歴、quiesce、paged recovery audit、FTS rebuild、限定cleanup、受付/GCの段階再開、永続repair hold | DO eviction/全喪失、実LockDO mutation、HTTP bootstrap、応答喪失・停止競合、最終batch fence | 完全restore drill、実環境、account mutation・終了証明を失ったKDFの運用収束 |
| media形式基盤 | AVIF/AV1/Opus判定、bounded sniff、ZIP STORE serializer | format vector、境界、CRC、Unicode、cancel | parser、変換、配信、player/gallery/reader |

今回のQueue受付とS3試験修正の検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。

## 実装済みだがstaging未検証・未公開

- Workerのprivate/content/DAV handler。ControlDOは監査後に再開可能だが、実環境の設定・公開は未実施。
- Queue consumer、Cron outbox dispatch、Cron GC。ローカルworkerdでは検証済みだが実Queue/DLQ/Cron deliveryは未検証。
- Cloudflare Images bindingの入力境界。実codec、制限、費用は未検証。
- Access JWT、app password、content ticket、cursor鍵。remote secretと実鍵rotationは未設定・未検証。
- 実D1/R2/KV/DO/Queue/Rate Limit/Assets間のネットワーク断、retry、region挙動。
- WebDAVのWindows/macOS/Linux実client相互運用。
- custom domain、host分離、CORS/Cookie、workers.dev/preview無効化の実環境確認。

## 未実装

### サービスとデータ処理

- multipartのunknown creation IDの全体閉鎖・予約精算と実7日incomplete lifecycle検証。既存uploadの未知ID中止とfresh nonceによるBLOBS/S3対応検証は実装済み。S3設定読取りと一覧/partのbounded診断は接続済み（[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)）。
- upload行自体が失われたincomplete multipartの全体閉鎖・容量精算。全`u/`のhandle走査・中止receipt・part容量保留は接続済み（[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md)）。未知の完成済み`u/` objectの隔離・35日回収も接続済み。
- 大規模tree向けの非同期trash/restore/purge job。
- 残るoperationの認可tuple、terminal lookup、Outbox consumer/repair。
- 動画/音声のmetadata parser、metadata検索索引同期、索引version再構築運用。新しいupload・DAV PUTの画像抽出は[IMAGE_METADATA](IMAGE_METADATA.md)へ接続済みで、既存データ再抽出とcopy/move引継ぎは残る。所有folderの要求時bounded statsは[FOLDER_STATS](FOLDER_STATS.md)へ接続済み。名前検索APIと現行権限付きpaginationは接続済み（[SEARCH](SEARCH.md)）。
- 公開linkのthumb/page/track配信。ZIPは[ZIPダウンロード](ZIP_DOWNLOADS.md)へ接続済み。受け取り専用共有のHTTP/画面は[UPLOAD_ONLY_SHARES](UPLOAD_ONLY_SHARES.md)へ接続済み。所有者管理API/画面・password保存・匿名unlock/CSRF/logout・独立公開bundle・閲覧/保存・create/rename/delete・upload/overwrite APIと画面は[PUBLIC_SHARES](PUBLIC_SHARES.md)、内部共有の管理CRUD・一覧APIは[INTERNAL_SHARES](INTERNAL_SHARES.md)、受信閲覧/contentは[SHARED_WORKSPACE](SHARED_WORKSPACE.md)へ接続済み。
- archive entry、EPUB page、audio/video track、thumbnail/derivativeの完全なHTTP配信。ZIP downloadは所有者・内部共有・匿名readリンクへ接続済み（[ZIP_DOWNLOADS](ZIP_DOWNLOADS.md)）。
- バックアップ定時起動・通知先の実設置、Time Travel手順、live restore automation。実行監視・HTTPS通知adapterはローカル実装済み。専用bindingによるrun/daily/health/maintain/prune/sweep・生成/検証・R2保存/取得・完了記録・オフライン復元はローカル実装済み。
- `u/`以外の未追跡生成物、catalogueに残るkeyの不正置換。既存deletingの停止中blob/orphan drainは接続済み（[GC_RECOVERY](GC_RECOVERY.md)）。

### UI

- File System Access handle、詳細preview。
- コピー追跡のタブ終了後・別端末での復元、公開link管理、media metadata検索、大量gridの仮想化。
- Gallery/lightbox、Bookshelf/EPUB reader、Audio player。
- AVIF/AV1/Opusの実browser再生試験とfallback。

### 制御・運用

- account mutationの未接続経路とbackup統合（namespace・DAVロック・app password更新・session/bootstrap/logout・content budget/ticket・upload新規予約/転送/中止/検証は同時32・待機256へ接続済み）、終了証明を失ったKDFの運用収束と共有password/IP制限。KDFの全体rate/枠・isolate内制限とbackup専用barrierは接続済み。
- operator HTTP/管理UIと実環境の停止・全復旧監査・段階再開drill。内部RPCの最終再開gateは[CONTROL_ADMISSION](CONTROL_ADMISSION.md)に実装済み。
- staging/production resource inventory、remote migration、deploy。
- monitoring、alert、Logpush、capacity/費用確認。
- 実環境でのbackup/restore drill、release、rollback、障害対応runbookの実行。ローカルのバックアップ/隔離復元ドリルは実行済み。

## 未検証

未実装項目は当然未検証である。それ以外に、実装済みでも次は未検証である。

- 実Cloudflare Access + MFA + service token。
- 実Queueのack loss、最大retry、DLQ、requeue。
- 実Cronの重複・遅延・同時実行。
- 実R2のdelete/head障害、429、長時間ネットワーク断、lifecycle。
- 実D1 Time Travelとlogical exportからの復元。
- 実CloudflareでのControlDO storage lossを含む完全な停止→監査→再開。ローカルfixtureは検証済み。
- 実Images codecとAVIF生成。
- 複数ブラウザー、モバイル、支援技術、実WebDAV client。
- セキュリティheader、CORS、Cookie、domain aliasのdeploy後検査。
- 負荷、長時間運転、大量データ、費用上限。

## セッションをまたいで保持する事項

### 目標

Foundationだけで完了扱いにせず、[DESIGN](DESIGN.md) と [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) の製品完了条件まで進める。ユーザー確認が不要なローカル実装、試験、通常commit、承認済みの`origin/codex/database-restore`への通常pushは継続する。

### 許可と禁止

- 検証済みのまとまりはcommitし、`origin/codex/database-restore`へ通常pushしてよい。共有mainへのpushは自動承認レビューに拒否されている。
- force pushはしない。
- GitHubへのpushをCloudflare production deployの許可と解釈しない。
- remote resource作成、remote D1 migration、secret設定、staging/production deployは、具体的な環境情報と実行段階の確認が必要。
- secretをrepository、`wrangler.jsonc`、logへ書かない。

### 壊してはいけない条件

- ControlDO再開は全監査と同一D1 batchの最終fenceを通す。flagsを直接解除しない。実環境再開は未実施。
- D1がnamespace・authorization・ledgerの正本、R2がimmutable contentの正本。
- mutationはcurrent auth、epoch、permit、revision/tree fence、operation terminalを同じatomic boundaryで確認する。
- `blobs.state='deleting'` とGC `deleting`は不可逆。
- blob参照追加は`deleting/deleted`を拒否する。
- GCはref=0、全pinなし、current control mode・epoch・claim所有を各dispatch/精算時に再検査する。通常GCはpause解除時のみ、停止中drainは既存deletingのみ。不在確認後だけphysical精算する。
- 適用済みmigrationを書き換えず、新しい番号のmigrationを追加する。
- AVIF・AV1・Opusを保存・配信・Gallery/player要件から外さない。詳細は [MEDIA_FORMATS](MEDIA_FORMATS.md)。

### 次の優先順

1. 復元後の各領域の修復を要求単位のoperator/CLIへ接続する。KDF/R2の保持された終了証拠との照合は[実装済み](DATABASE_RESTORE_NATIVE.md)。upload/multipart・予約・outbox・旧backup記録の収束を進める。未知nativeや証拠喪失を終了扱いにしない。
2. 予約後の安全な中止、logical import、大規模snapshotの再開/RTO、旧schemaの移行手順、実Time Travel/全storage喪失の復旧drill。事前予約・1回送信・snapshot照合・停止中epoch採用・全監査/段階再開はローカル実装済み。
3. unknown multipart IDの全体不在証明・予約精算と、upload行喪失時の全bucket閉鎖・保留容量精算。freshなS3/BLOBS対応検証・走査・中止receiptは接続済み。
4. Queueの残るevent kindとrepair、終了証明を失ったKDFの運用収束。
5. Files UIの残り、共有/公開link、media metadata検索、ZIP/reader/media配信。
6. Gallery/Bookshelf/Audio、AVIF/AV1/Opusの実browser検証。
7. 定時バックアップと通知先の設置、全storage喪失からの運用復旧。
8. staging inventory、実OS client、実環境gateと公開。

### 次回開始時の確認

```sh
cd /home/hiroshi/ドキュメント/Nextcloud-flare
git status --short
git diff
git log -5 --oneline
gh run list --limit 3 --json databaseId,headSha,status,conclusion,url
```

変更前に既存差分を保護する。変更後は最低限 `git diff --check`、該当テスト、typecheckを行い、checkpoint前に全check、Web build、Wrangler dry-runを実行する。schema変更時は新migrationを追加し、`node scripts/generate-schema-contracts.mjs`とschema testを更新する。

## 文書更新ルール

checkpointごとに次を更新する。

1. この文書の該当行を「実装済み」「staging未検証」「未実装」の間で移動する。
2. [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ実行コマンド、件数、結果を記録する。
3. [HANDOFF](HANDOFF.md)の次作業と注意事項を更新する。
4. READMEの短い概要が古くなっていないか確認する。
