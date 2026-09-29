# 開発進捗

[AAC（M4A/MP4）・Vorbis（Ogg）](AAC_VORBIS.md)の情報抽出と原本再生を追加しました。AACの音声構成とVorbisの3ヘッダーを上限付きで検査し、タグ・時間・形式を既存の一覧と常駐playerへ接続します。AAC-LCとVorbisのmono/stereo原本を所有者・公開リンクで実際に再生しました。HE-AACは構成解析までで実音源の復号は未検証です。schema0073・通常79table・149 API routeを維持します。cover・override編集/検索、Bookshelf、既存原本の再抽出/copy引継ぎ、運用修復と実環境gateは継続します。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

## 先行実装の記録

[MP3・FLAC・WAVの情報抽出と再生](AUDIO_FORMATS.md)を追加しました。原本ヘッダーと読み取り上限を検査し、曲名・artist・album・時間を既存の一覧と常駐playerへ接続します。所有者と公開リンクで実際の原本を再生し、利用者別位置の保存も確認しました。schema0073・通常79table・149 API routeを維持します。AAC/Vorbis、cover・override編集、Bookshelf、既存原本の再抽出と運用修復、実環境gateは継続します。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[Audioの2,000曲表示](AUDIO.md)をローカルChromeで検証し、再生時刻の更新による一覧全体の再描画を抑えました。長いタグでも一覧と固定プレーヤーの高さを保ちます。所有者画面とスマホ幅の公開リンクで、実APIによる200件ずつの読み込み・上限・再生・前後移動・終了を確認しました。schema0073・通常79table・149 API routeを維持します。追加形式・cover・override編集、Bookshelf、運用修復と実環境gateは継続します。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[Audio一覧の探索量](AUDIO.md)を制限しました。表示可能な項目の索引から1回につき1,000候補と続行確認1件を読み、音声以外や非表示の項目が大量にあっても全件走査を避けます。空ページもカーソルで続けられ、画面は最大3回まで自動で進みます。2,000曲上限と現在の認可・原本・再生位置の検査は維持します。schema0073・通常79table・149 API route。追加形式・cover・override編集、Bookshelf、運用修復と実環境gateは継続します。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[Audioの一覧と常駐プレーヤー](AUDIO.md)を所有者・内部共有・公開リンクへ接続しました。画面を移動してもOpus原本の再生を継続し、ログイン利用者は15秒ごとと一時停止時に本人の位置を保存して再開できます。保存競合では上書きせず現在の位置を再取得します。共有解除・ログアウトと配信期限に合わせて音声を破棄します。追加音声形式・cover・override編集、Bookshelf、運用修復と実環境検証は継続します。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[Audioの曲一覧と再生位置API](AUDIO.md)を接続しました。所有者・内部共有・公開リンクで現在のOpus情報を一覧し、ログイン利用者は本人の再生位置だけを保存できます。原本差し替え・共有解除・別タブの先行保存を検査します。schema0072・通常79table・149 routeを維持します。専用一覧画面・常駐player・自動保存と再開は次の接続対象です。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[AV1・Opusの情報抽出と動画再生](TRACK_METADATA.md)を接続しました。MP4/WebMのAV1動画（8/10-bit、Opus付き／音声なし）をGalleryで開き、所有者・内部共有・公開リンクの原本URLから再生します。再生不可時は同じ認可のダウンロードを提供します。OpusのOgg/WebM/MP4情報と限定タグは既存DBへ保存し、Filesから原本を開いて再生できます。schema0072・通常79table・149 routeを維持します。Audio専用UIと位置保存、Bookshelf、既存データ再抽出/copy引継ぎ、運用修復は継続します。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[大きいプレビューの要求時生成](LARGE_THUMBNAILS.md)をGalleryへ接続しました。開いた画像だけにlg1600を要求し、所有者・内部共有・公開リンクでプレビューと原本を切り替えられます。同じ原本への要求を集約し、現在の閲覧権限をQueueの生成・公開時にも検査します。schema0072・通常79table・149 route。動画情報・player、Bookshelf/Audio、未知nativeや失効した生成要求の運用修復は継続します。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[Galleryの画像一覧と閲覧](GALLERY.md)を所有者・内部共有・公開リンクへ接続しました。撮影日時順の200件ページ、グリッド／リスト、再帰切替、原本ライトボックスと前後移動に対応します。現在の原本・生成version・認可を固定し、サムネイル取得は画面付近の同時4件に制限します。50,000候補の読み取り行数gateが未達のため、設計に従い通常10,000候補へ縮小します。schema0071・通常79table・147 routeを維持します。lg要求時生成、動画情報・player、Bookshelf/Audioと運用の残件は継続します。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

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

更新: 2026-09-29

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

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
