# セッション引き継ぎ

[Audioの曲一覧と再生位置API](AUDIO.md)を接続しました。所有者・内部共有・公開リンクで現在のOpus情報を一覧し、ログイン利用者は本人の再生位置だけを保存できます。原本差し替え・共有解除・別タブの先行保存を検査します。schema0072・通常79table・149 routeを維持します。専用一覧画面・常駐player・自動保存と再開は次の接続対象です。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

## 先行実装の記録

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

Git送信は承認待ちです。5854920の通常pushが自動承認審査で「外部宛先へのコード送信の明示承認がない」と拒否され、宛先daraskme/Nextcloud-flare・codex/database-restoreと対象5854920を明示した質問を提示済みです。未回答のまま再送せず、後続変更もローカルで進めます。5854920だけの承認なら、そのcommitだけを送信対象にします。

[サムネイル変換の実行部](IMAGE_TRANSFORMS.md)を追加しました。固定原本のサイズ・静止画・寸法を確認し、条件付きR2ストリームからsm256/md768/lg1600のWebPを生成します。生成物の寸法・metadata非保持・SHA-256を検査し、期限後の応答と途中中断も処理します。費用claim・native終了記録は後続のIMAGE_COSTSで接続済みです。R2保存は後続の0070で接続済みです。Queue・配信、Gallery UIは次の接続です。この実行部を追加した時点はschema0067・76table・147 route、依存追加なし。

[画像メタデータ](IMAGE_METADATA.md)を通常upload・WebDAV PUTの完了Outboxへ接続しました。JPEG/PNG/WebP/AVIFの寸法と許可したEXIFだけをbounded Rangeで抽出し、元blob・parent・actor・claimを確認してMIMEと同じbatchで保存します。新しいDAV PUTは利用者申告だけでinline mediaにしません。サムネイル生成・Gallery画面・既存データ再抽出と動画/音声は後続です。

先行472e682の[CI36473189569](https://github.com/daraskme/Nextcloud-flare/actions/runs/36473189569)は公開編集再開後の全10job成功。今回の画像処理は後続の変更です。

[公開編集の再開](PUBLIC_EDIT_RECOVERY.md)を実装しました。フォルダー作成・改名・削除の元intentを送信前に保存し、再読み込み後は同じsession/keyで明示確認します。別タブの同時実行、記録の差替え、ログアウト後の遅い応答による再保存を拒否します。サーバーAPI・schema・依存の追加はありません。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

[ZIPダウンロード](ZIP_DOWNLOADS.md)を所有者・内部共有・公開リンクのAPIと画面へ接続しました。固定snapshot、日本語名・空フォルダー、正確なサイズ会計、期限付きblob保持に対応し、共有停止・内容変更・元credentialを各取得時に検査します。schema0067・通常76table・147 routeを維持し、今回のmigration/依存追加はありません。thumb/page/track・media、復旧側の残件、実環境検証は未完了です。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

先行ebcc9faの[CI36469054574](https://github.com/daraskme/Nextcloud-flare/actions/runs/36469054574)は、ZIP配信接続後のUbuntu/Windows Node・全native shard・通常/単一host browser・backup bindings/cliの全10jobが成功しました。今回の公開編集再開は後続の変更です。

先行c886e85の[CI36465246546](https://github.com/daraskme/Nextcloud-flare/actions/runs/36465246546)は、Ubuntu/Windows Node・全native shard・通常/単一host browser・backup bindings/cliの全10job成功。D1の結果列上限に対応した分割projectionと、Nodeの同時実行制限後の結果です。過去のWindows native失敗の根本原因特定とは区別します。

先行f2c6c33の[CI36460457472](https://github.com/daraskme/Nextcloud-flare/actions/runs/36460457472)はWindows全Node/4分割・通常/単一host browserの7job成功、backup bindings/cliとUbuntu Nodeの3job失敗で終了しました。バックアップはローカル実D1でも再現し、uploadsが51列になったことで型と値の102列SELECTがD1の結果列上限100を超えると特定しました。今回、同じ凍結keyset pageを100列以内のprojectionへ分割し、各pageのkey/順序/件数を照合するよう修正しています。Ubuntuはbackup-operator試験の5秒timeoutで、Nodeの同時実行を全OSで2に制限しました。製品の期限やUbuntuの試験timeoutは変更していません。CLI jobの保存ログはbackup_run_drill_command_failedのみで、詳細artifactは取得できなかったため、その失敗の同一原因までは確定せず修正後CIで確認します。修正後の検証は上記実装記録を参照してください。

更新: 2026-09-29。次のセッションはこの資料から開始する。実際の `git status` / `git log` とコードを正とし、過去の会話だけで作業状態を推測しない。

公開リンク管理の入口はservices/linkShares.ts・linkShareRead.ts、auth/shareSecrets.ts、api/shares.ts。専用SHARE_PASSWORD_KEYS/SHARE_PASSWORD_ACTIVE_KIDと既存global KDFを使う。所有者POSTのreceipt照会まで失われたら再送せず一覧から確定済みlinkを探し、現行versionで秘密値を更新する。匿名側はapi/publicShares.ts・publicShareConfig.ts、services/shareUnlock.ts、auth/shareTokens.ts、do/controlShareUnlock.ts。専用SHARE_COOKIE_KEYS/SHARE_COOKIE_ACTIVE_KIDとpublic CSRF鍵を設定する。unlock POSTのchallenge段階は5分のHttpOnly Cookieと本文tokenを返し、続く秘密値送信で一致を要求する。同じchallengeの再送は同じsessionへ収束し、有効な共有Cookieがあれば新規登録せず再利用する。rate ledgerは新規/喪失後60秒待機。公開閲覧はapi/publicShareRead.ts・web/src/public-share・assets/publicApp.tsへ接続済み。所有者UIはweb/src/features/shares/LinkShareDialog.tsx。閲覧/編集の新規リンクと権限切替に対応した。公開編集はapi/publicShareMutations.ts・web/src/public-share/editor.tsxへ接続し、POST nodes/PATCH node/DELETE nodeと元credentialのoperation照会を扱う。Share-Sessionで元unlock credentialを固定し、lookupにはX-Share-Idを付ける。公開uploadはapi/uploads.tsの共通handlerとauth/uploadPrincipal.tsへ接続済み。source=privateは従来のcapability転送形式を表し、匿名identityはlink_share_id/versionへ別保存する。migration0064は停止・未処理受付なしで適用する。公開画面はweb/src/public-share/{upload,uploadStore,uploads}へ接続済み。公開削除もapi/publicShareMutations.ts・services/trashNode.tsへ接続済み。原本GET/HEADはapi/publicShareContent.ts、delivery:"app"のセッション発行はapi/publicShareRead.tsへ接続済み。単一hostはindex.tsのcontentPath分岐へ接続済み。upload-onlyもapi/uploads.tsとweb/src/public-shareへ接続済み。公開budgetはs:<shareId>:c:<unlockId>なので、同じ有効なunlock sessionを別tabや更新で使い回し、budgetを作り直さない。公開機能全体を完成扱いにしない。

再開時のDLQ入口はjobs/deadLetters.ts、api/deadLetters.ts、services/deadLetterRead.ts、web/src/features/admin/DeadLettersDialog.tsx。queue_dead_lettersはmessage単位の観測で、outbox/jobの停止やnative終了を証明しない。0063で一度だけ追記する再投入受付を追加した。services/requeueDeadLetter.tsとjobs/outboxRequeue.tsが元operand/current authority・epoch・lease/native保持・既存予算を確定時にも検査する。APIはDBの受付だけを行い、Queue送信は通常producerが担当する。応答喪失時は同じactor/credential/keyの受付を読み戻す。通常Cronは観測保存後も同じoutboxを再送するため、古いDLQを新しい失敗や停止と解釈しない。未知参照はFKなしで保持し、本文は保存しない。

## 目標とユーザーの追加条件

Cloudflare 上のファイル管理アプリを設計の完了条件まで実装する。Foundation のみを完成扱いにしない。
継続目標は「完成まで続けて」。完成した範囲は検証後にコミット・プッシュし、引き継ぎ資料も更新する。この checkpoint は全体完成ではない。

- 切りのよい単位で検証後にcommitする。`codex/database-restore`への通常pushは先行472e682まで実行済みだが、後続5854920の送信が自動承認審査に拒否された。上記の宛先・対象commitを明示した承認質問が未回答のため、後続を含めローカルcommitで保持する。force pushはしない。
- ユーザーが事前に **画像 AVIF・動画 AV1・音声 Opus** にエンコードする。保存・配信・Gallery/player を必須対応にする。具体的なコンテナと試験条件は [MEDIA_FORMATS](MEDIA_FORMATS.md)。
- リモート Cloudflare の resource 作成・migration・配備は実行していない。GitHub push の許可を production 配備の許可とみなさない。
- 許可済みの可逆な実装・検証は継続し、必要な情報が足りる作業で確認を挟まない。

## 資料の読み方

1. [CURRENT_STATE](CURRENT_STATE.md) で実装済み・未実装・検証済み・未検証と、セッション間の固定事項を確認する。
2. この資料で直近の状態と再開点を確認する。
3. [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) をテスト件数・実行記録の正本とする。
4. [FOUNDATION](FOUNDATION.md) で変更対象の内部契約だけを読む。
5. [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) §2 が全 phase の順序、§8 が R6 の確定条件。
6. [DESIGN](DESIGN.md) v0.6 の該当章を参照。R6 は BRIEF §8、メディア追加要件は MEDIA_FORMATS を併読する。

`reviews/` と REVIEW_LOG は判断経緯。通常の再開時に全レビューを読み直す必要はない。

## 今回の再開点

先行dad1f95の[CI36455427980](https://github.com/daraskme/Nextcloud-flare/actions/runs/36455427980)は、Ubuntu・Windows全Node/4分割・通常/単一host browser・backup bindings/cliの全10jobが成功して終了しました。過去のWindows native失敗の根本原因が特定されたことを意味しません。

先行937b434の[CI36450383559](https://github.com/daraskme/Nextcloud-flare/actions/runs/36450383559)は8job成功、Windows4/4失敗で終了しました。multipart-uploadの64 MiB + 3 bytes試験で完了直後のHEADが不在となりupload_complete_pending、867/868件成功です。R2 complete直前の受付・native結果・観測のどの段階が原因かは保存ログだけで確定できず、未解決として追跡します。/tmp/ncf-public-delete-ci-windows4.log。

先行837cfedの[CI36444362854](https://github.com/daraskme/Nextcloud-flare/actions/runs/36444362854)は、Ubuntu・Windows2/4〜4/4・backup bindings/cliの6job成功、browser失敗、Windows1/4が30分上限でcancelledでした。browserの4件は仮想スクロールの表示範囲外を直接操作していたため、検索してから操作する形へ修正しました。Windows全Node（1,573件成功、約9分）を独立jobへ分け、全4integration shardの検査と30分上限を維持します。今回のCIはpush後に確認します。

[所有者間コピー](COPY_JOBS.md)の明示的な再試行をRESTと画面へ接続しました。元jobの停止と全blobの精算が証明された後、現在の内容から新しいjobを1件だけ受け付けます。異なるkeyの競合・応答喪失・reloadでも同じ後継を追跡し、元jobの容量保持やnative記録を解除しません。DLQの保持期限管理と通知、未知native/part/handleの全修復、最大規模の実環境検証、タブ終了後や別端末の追跡復元は未完了です。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

前回の再試行はmigration0061で後継受付の一意索引と確定時検査を追加し、通常75table・147 routeを維持しています。依存追加はありません。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はlg要求時生成、動画情報/playerとpage/track・media配信、copyのDLQ運用・未解決attemptの修復を進めます。ZIPの実環境・最大規模検証も残っています。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

先行2d34118の[CI36440037128](https://github.com/daraskme/Nextcloud-flare/actions/runs/36440037128)は、Ubuntu・Windows4分割・browser・backup bindings/cliの全8job成功で終了しました。下記の先行Windows失敗の根本原因が特定されたことを意味しません。

先行4cf6153の[CI36435508999](https://github.com/daraskme/Nextcloud-flare/actions/runs/36435508999)は、Ubuntu・Windows1/4/2/4/4/4・browser・backup bindings/cliの7job成功、Windows3/4失敗で終了しました。3/4はmultipart-bucket-control-admissionのscan-page試験でr2_binding_verification_failedとなり、773/774件成功でした。保存ログでは根本原因を特定できず、解決済みとは扱いません。

先行1cee05dの[CI36430025491](https://github.com/daraskme/Nextcloud-flare/actions/runs/36430025491)は、Ubuntu・Windows4分割・browser・backup bindings/cliの全8job成功で終了しました。Windows全Nodeを1/4に集約後の全shard完走を確認しています。

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

copy retryは`services/retryCopyJob.ts`、確定/復旧検査は`jobs/copyRetryProof.ts`とmigration0061。受付の原子的な関係はoperations.operands_json.retryOfに保存し、一意索引で確定済み後継を1件に制限する。元jobを変更せず、拒否された受付だけ新keyでやり直せる。copy受付は`services/createCopyJob.ts`、保存/読戻しは`jobs/copyManifest.ts`。内部`copy.enqueue`をLockDO/common admissionへ接続し、成功receipt 202は受付の確定だけを表す。`bulk_jobs.op_id`はその受付operationを参照する。実行claimは`jobs/copyClaim.ts`、固定sourceの読取りは`jobs/copyRead.ts`。owner同時2claim、25秒、8MiB/Range、112 R2 call/invocationとD1実測予算を上限とする。単一保存は`jobs/copyPut.ts`、ControlDOでの送信証明は`db/r2Copy.ts`。転送先staging/physical/native完了を照合してcheckpointを進める。multipartはjobs/copyMultipart.ts、一括公開はjobs/copyPublication.ts。0056のcopy.publishはコピー先spaceのpermitを取り、namespace・容量・保持を一括確定する。停止/照会/限定精算はjobs/copyLifecycle.ts。既知handleの中止はjobs/copyMultipartAbort.tsとdb/r2CopyAbort.tsへ接続済み。実成功後のobject観測修復はjobs/copyReconcile.ts、元送信と共通の事実記録はjobs/copyObject.ts。実行全体はjobs/copyExecutor.ts、Queue ACK判定はjobs/copyQueue.ts。停止後の巡回はjobs/copyMaintenance.ts、実行証明/予算はjobs/copyMaintenanceClaim.ts。専用2分Cronは通常保守と別invocationで、通常稼働時だけ動く。REST受付はapi/nodeMutations.ts、job read/cancelはapi/copyJobs.tsからprivateAppへ接続した。進捗の共有型はshared/src/copyJobs.ts。画面の宛先選択・ジョブ表示/取消・同一タブreload再開は接続済み。明示的retryも接続済み。次はDLQと未知native/未送信/part・handle観測、中止attempt再試行、最大規模の完走検証を仕上げる。保存済みmanifestを読んでもrequest-local authorization proofは再発行しない。0057では停止履歴と、未着手/未送信/実保存の証拠が揃うblobに限り精算receiptで保持の解放を許可する。copy保持中のnative receiptは期限で削除せず、guardだけを外さない。0058では既知multipartの実中止を証明した精算も許可する。終了証拠の不足と未知結果は保留を返す。詳細は[COPY_JOBS](COPY_JOBS.md)。JSON ID集合→主キーのCROSS JOINも保つ。

コピー画面はweb/src/features/copy/{CopyDestination,CopyJobsPanel,records}へ接続済み。app.tsxは実際のAccountと共有source scopeを分け、受付とpending操作再確認の両経路でrememberCopyを呼んでからpending intentを削除する。明示retryの原要求/停止/新jobの結び付けも実装済み。次はDLQ運用、未記録nativeの終了証拠、最大規模の完走を進める。タブのsessionStorage追跡は最大100件で、タブ終了/別端末後の復元はまだない。元credentialが失効してjobが404になっても新copyを自動作成しない。先行45a72d2のWindows1/4ではbackup-operatorとdatabase-restoreのbeforeEachが60秒timeout。fixtureGenerationを含む準備の遅延を調べ、製品の期限と検査を緩めずに改善する。

DAV Sharedの入口は`dav/path.ts`・`dav/shared.ts`・`api/dav.ts`。migration0050はDAV保存元のowner一致条件を選択付き受信者へ広げ、0049の不変pair/completion照合を維持する。migration0051のdestination tupleとauth/transferScope.tsで転送先選択を独立に保存する。省略はlegacy、share:nullは明示的なactor所有spaceであり相互に代替しない。same-ownerの別mount転送だけを許可し、cross-owner要求はDAVから拒否し、RESTのcopy jobを使う。直接file mount上書きでは保存名と非公開parentを内部proofから使い、返却しない。0050/0051適用後の旧Workerへのrollbackはmaintenanceを維持し、対応版で再検証する。ごみ箱の一覧・復元・完全削除は所有者だけに許可する。

今回のmultipart入口は`restoreInventoryRepair.ts`/`restoreInventory.ts`/`scripts/restore/inventory.mjs`。private `repairInventory`は28番目のmethod。共有の`restoreRepairContext.ts`がsystem/global受付とBLOBS読取りを同じ停止へ固定し、実完了のfinishだけは停止後も保存する。各inventory jobへBindingVerificationScopeを渡し、S3 sourceを採用済みBLOBS対象と照合する。全体25秒のtimeoutでactiveを失わせ、遅延GETから新たなnativeを送らない。既知multipartの元abort照合は`restoreMultipartAbort.ts`。DO履歴はhashだけなので、元D1 tuple欠落はそれだけで修復できない。

送信先は承認済み専用`codex/database-restore`です。先行b1fedc7の[CI36377836985](https://github.com/daraskme/Nextcloud-flare/actions/runs/36377836985)はUbuntu・Windows2分割・browser・backupが成功、Windows分割1はsearch.test.tsの1万件検索が90秒timeoutで失敗しました（965/966件成功）。検索試験の遅延原因は未解決で、上限や検査を緩めていません。先行33a8a80の[CI36365491865](https://github.com/daraskme/Nextcloud-flare/actions/runs/36365491865)はUbuntu・Windows3分割・browser・backupの全6job成功です。前回の時刻依存テスト修正はWindows3分割でも成功しました。以前のorphan-admission回数不一致と21cd396のR2保存先照合失敗の原因は未確定です。先行af30646の[CI36367826306](https://github.com/daraskme/Nextcloud-flare/actions/runs/36367826306)は全6job成功です。先行7e933b1の[CI36369537337](https://github.com/daraskme/Nextcloud-flare/actions/runs/36369537337)は全6job成功です。先行a52b815の[CI36371093589](https://github.com/daraskme/Nextcloud-flare/actions/runs/36371093589)はUbuntu・Windows3分割・browser成功、backup:run-drillのsource fingerprints中にbackup_wrangler_failedで失敗しました。保存されたログだけでは子プロセスの失敗原因を特定できません。最新CI状態はgh run listで確認します。

## 現在動いている範囲

Phase 0 のローカル基盤、Phase 1 の大半と Phase 2 / WebDAV / Phase 3 の一部。76通常テーブル、migration `0001`〜`0063`、147 route の契約がある。
JWT/JWKS、bootstrap、sessions、read/create/rename/content write/automation 認可、CSRF、quota/ref/pin/physical 会計、epoch 復旧、D1 permit、create/rename 用 LockDO、operation claim/lookup を実装済み。

直近の追加: WebDAV の MKCOL / PROPPATCH / PUT / DELETE / COPY / MOVE / LOCK と、private Files REST の folder create / rename / trash / MOVE / COPY を原子的 namespace mutationへ接続した。REST/DAVそれぞれのoperation provenanceをOutbox consumerと復旧監査まで検証する。content ticket、Cookie、R2 target manifest、current blob配信もHTTPへ接続済み。直近の検証件数と CI は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を正とする。ControlDO admissionは全監査後の段階再開をローカル実装済み。実環境では再開・配備していない。

主要な内部成果物（最新状態は進捗表を参照）:

| ファイル | 実装内容 |
|---|---|
| `jobs/multipartBucketInventory.ts` / `jobs/multipartBucketAbort.ts` / ControlDO内部RPC | migration `0027`/`0028`、upload行不要の全bucket走査・part容量保留・発見handleの中止・不変receipt。fresh proofと復旧fence、所有者後日復元。全体閉鎖/精算は後続 |
| `do/controlAdmission.ts` / `ControlDO.resumeAdmission`・`resumeGarbageCollection` | migration `0025`、永続intentとD1 revision/token、最終batch fence、repair hold、停止と応答喪失の競合、初回bootstrapと実LockDO mutation |
| `jobs/gc.ts` / `jobs/orphanInventory.ts` / `ControlDO.drainBlobGarbageCollection`・`drainOrphanGarbageCollection` | migration `0024`、旧deletingのみの停止中回収、dispatch/final fence・counter・physical精算、全復旧監査fixture |
| `jobs/r2BindingVerification.ts` / `ControlDO.verifyInventoryBinding` | migration `0023`、固定64-byte system objectのfresh nonce/CASによるBLOBS/S3検証。scope内のみ有効なD1 fence、復旧監査・容量保持。全体閉鎖への接続は次段階 |
| `jobs/multipartInventoryRepair.ts` / `ControlDO.repairUnidentifiedMultipartUploads` | migration `0022`でscan/handleを永続化。全ページ後の実BLOBS abort、immutable receipt、physical観測。予約・復旧再開は保持 |
| `r2/s3Inventory.ts` / `jobs/multipartInventory.ts` / `ControlDO.inspectIncompleteMultipart` | S3署名付き未完了multipart/part/lifecycleのbounded診断。停止中のepoch fenceと監査再初期化へ接続。既存uploadの未知ID走査・中止は別serviceへ接続。予約解放は未接続 |
| `jobs/orphanInventory.ts` / `ControlDO.inventoryOrphanObjects` | 永続cursor/lease付き完成済みR2走査、未知keyの隔離・実physical会計・35日回収・同key再利用拒否、停止中の走査と復旧監査 |
| `services/uploads/` / `api/uploads.ts` / `auth/uploadCapability.ts` | private単一/分割uploadの予約、HMAC capability、R2送信/照合、LockDO/D1原子的complete、abort intent、期限切れ後のreceiptと最大200 partのHTTP照会 |
| `jobs/uploadCleanup.ts` / `ControlDO.repairExpiredUploads` | 24時間後のHEAD照合、lease付き回収、予約/physical会計、GC handoff、停止中の旧epoch修復。汎用予約回収は全uploadを除外 |
| `packages/worker/src/do/UploadDO.ts` / `uploadLedger.ts` / `uploadPlan.ts` | 固定multipart分割、SQLite attempt台帳、4並列/3試行/15分lease、認可RPC、D1 marker/mirror、停止alarm、complete/abort排他。`services/uploads/multipart.ts`でR2 create/part、`multipartComplete.ts`でcomplete/HEAD・原子的公開・terminal照合を接続。既知ID cleanupはCron/停止中repairに接続済み。private HTTPも接続済み |
| `packages/shared/src/names.ts` | NFC/portable name、Unicode 17 full casefold、folder-name search text/bigram |
| `packages/worker/src/services/fsMutation.ts` | SQL assertion、全 step と terminal の atomic commit、確実な rollback と commit_unknown の分離 |
| `packages/worker/src/services/createFolder.ts` | LockDO/認可/claim/7 step/terminal/release を接続した最初の folder create |
| `packages/worker/src/services/renameNode.ts` | 対象と親の lock、FTS 更新、operation/terminal/outbox を一括確定する改名 |
| `packages/worker/src/services/blobRead.ts` | Cookie→current credential/session/ticket/target manifest/blob plan と BudgetDO reserve/settle 付き R2 immutable blob HEAD/Range 配信基盤 |
| `packages/worker/src/do/BudgetDO.ts` | `budget_id` ごとの SQLite lease/byte/request/parallel counter。公開 fetch は未有効化 |
| `packages/worker/src/services/contentBudget.ts` | principal/share/unlock 単位の安定 budget ID を current D1 認可で確保・再利用。ticket 内部発行サービスに接続済み |
| `packages/worker/src/services/contentTicket.ts` | R2 target manifest の staging と読戻し、現行認可の一括証明、D1 ticket/target set 確定、応答喪失時の照合・object cleanup |
| `packages/worker/src/services/contentTicketCancel.ts` | current credential を照合し、ticket と派生 content session を同一 D1 batch で失効。共有 budget は維持 |
| `packages/worker/src/api/contentTickets.ts` | Access 認証済み private request の CSRF・bounded JSON 検査から ticket 発行/取消へ接続 |
| `packages/worker/src/api/privateApp.ts` / `privateAppConfig.ts` | app host の Access JWT→D1 session→`/me`・CSRF 発行・logout・app password・private ticket handler。必要な issuer/AUD/署名鍵/bootstrap 設定が無ければ 503 |
| `packages/worker/src/api/account.ts` | current credential を再確認する `/me`、CSRF 後の D1 session 失効と Access logout 303 |
| `packages/worker/src/services/nodeRead.ts` / `api/nodes.ts` | current ancestry と maintenance を D1 batch で確認する node 詳細・root-first breadcrumb・最大200件の keyset children 一覧 |
| `packages/worker/src/services/trashRead.ts` / `api/trash.ts` | owner space rootのcurrent認可とmaintenanceをD1 batchで再確認する、最大200件の署名keyset trash一覧 |
| `packages/worker/src/services/restoreTrash.ts` | 固定trash membershipをGC/permit/current destination fenceの下で深さ順に原子的復元するprivate RESTサービス |
| `packages/worker/src/services/purgeTrash.ts` | operation束縛node/blob manifestからFK順・depth降順にnamespaceを削除しGC candidateへ接続する原子的purge |
| `packages/worker/src/jobs/gc.ts` | ref/pin/pauseを再検査するclaim lease、R2 delete/head収束、physical bytes最終精算を行うbounded GC |
| `packages/worker/src/api/nodeMutations.ts` | CSRF と bounded JSON / Idempotency-Key の検査から folder 作成・rename・trash・MOVE・COPY、確定・競合・結果不明の HTTP 応答、同 credential の operation 照会 |
| `packages/worker/src/auth/nodeCursor.ts` | credential/parent/owner/epoch/tree generation と最終 sort key を10分の専用 HMAC kid ring に束縛 |
| `packages/worker/src/auth/appPassword.ts` / `api/dav.ts` | DAV Basic 用の厳密な入力境界、kid 別 pepper + PBKDF2 digest、認証前後の current D1 照合。OPTIONS、file GET/HEAD/Range、PROPFIND Depth 0/1、MKCOL、PROPPATCH、streaming PUT、subtree DELETE、same-owner COPY/MOVE、LOCK/UNLOCKを接続 |
| `packages/worker/src/dav/conditions.ts` / `conditionState.ts` / `etag.ts` | bounded `If` / `Lock-Token` 文法、tagged/untagged条件評価、独立token submission、same-origin D1 path/ancestor lock/ETag state。GET/HEAD・PROPFIND・条件評価のDAV validatorを共有し、MKCOL/PROPPATCHへtokenを接続 |
| `packages/worker/src/services/appPasswords.ts` / `api/appPasswords.ts` | Access/CSRF 付き app password 発行・一覧・失効、scope/root/件数/期限、秘密の一度きりの応答。発行した資格情報をDAV Basic認証へ接続 |
| `packages/worker/src/api/content.ts` | content host の ticket 交換/CORS と Cookie 配信 HTTP handler。ControlDO と署名鍵 gate は Worker entry |
| `packages/worker/src/auth/contentTokens.ts` / `contentAccept.ts` | kid ring の HS256 ticket/Cookie と D1 redemption。`content_sessions.ticket_id` は migration `0009` |
| `packages/worker/src/jobs/outbox.ts` | token/lease 付き producer、ID-only send、期限切れ再送、bounded repair scan |
| `packages/worker/src/jobs/consumeOutbox.ts` | create/rename event の current authority、元 operation step、保存済み operand/result を照合する consumer |
| `packages/worker/test/integration/fs-mutation.test.ts` | 全必須 step の rollback、並行再送、応答喪失、失効対 commit |
| `packages/worker/test/integration/outbox.test.ts` | producer 競合、送信/D1 応答喪失、completed の巻戻し拒否 |
| `packages/worker/test/unit/names.test.ts` | Unicode同名・portable禁止・長さ境界・検索正規化 |

直近の test 件数と CI は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を正とする。checkpoint の commit SHA と最新 CI は下記の Git コマンドで確認する。資料内に self-reference の commit SHA を固定しない。

## 公開・接続していないもの

- content/private/DAV HTTP handler は追加済みだが、ControlDO maintenance と署名鍵・remote secret未設定で実公開は停止中。Files SPAは[FILES_UI](FILES_UI.md)の範囲を接続済み。147 route の存在は handler の完成を意味しない。
- **ControlDOは起動/epoch回復時に閉じる。** 全監査後の`resumeAdmission`と最後の`resumeGarbageCollection`を内部RPCで実装済み。実環境の再開・operator UIは未実施。flagsを直接変更しない。[CONTROL_ADMISSION](CONTROL_ADMISSION.md)参照。
- LockDO namespace mutation の成功テストは test-only admission と実 DO SQLite/D1 を組み合わせる。実 ControlDO による稼働許可を実証したものではない。
- Queue handler と Cron は ControlDO/D1 admission gate を通過した場合に outbox を処理する。ControlDO が閉じている間は Queue を retry し、Cron は送信しない。実 Queue ack/DLQ の配信試験は未完了。
- private単一uploadのHTTP・D1予約・R2送信・原子的complete・abort・期限切れ回収・GC handoffは接続済み。multipartのD1予約/認可RPC/状態mirrorとR2 create/part送信は内部接続済み。multipartのR2 complete/HEAD・原子的新規/上書き公開は内部接続済み。既知IDのR2 abort・期限切れ回収は接続済み。private HTTPは接続済み。Files UIの一覧・操作・確認付き上書き/再開uploadは接続済み。未知object/multipart修復、全 operation の認可 tuple、検索/共有/contentの残り、DAV実client gate、Gallery/Bookshelf/Audio、運用・release は未完了。trash一覧・同期restore・同期purge・purge blob GCは接続済み。実環境のControlDO admission/Access/署名鍵設定、全route会計は未完了。ローカルbrowser fixtureは実ControlDOで受付を再開する。
- AVIF/AV1/Opus は形式基盤まで。実 track parser・配信経路・player/lightbox・ブラウザー実ファイル試験は未接続。
- Cloudflare staging inventory/Access/MFA・実 Images codec/費用・実 D1/Queue・backup復旧等の gate は未完了。ローカル成功で代替しない。
- private app route のリモート設定は `ACCESS_ISSUER`、`ACCESS_USER_AUDIENCE`、`ACCESS_SERVICE_AUDIENCE`、`BOOTSTRAP_OWNER_EMAILS`/`BOOTSTRAP_OWNER_IDENTITIES`、`BOOTSTRAP_QUOTA_BYTES`、`CSRF_PRIVATE_KEYS`/`CSRF_PUBLIC_KEYS` と各 active kid、content ticket/Cookie の kid ring。local `wrangler.jsonc` に秘密を置かず、未設定時は 503。
- app password 作成と DAV 認証には `APP_PASSWORD_PEPPERS` と `APP_PASSWORD_ACTIVE_KID` の pepper ring が必要。未設定なら 503。remote secret 登録は未完了。
- children とtrash一覧の続きには `NODE_CURSOR_KEYS` と `NODE_CURSOR_ACTIVE_KID` の専用 ring が必要。未設定時も node 詳細は使えるが両一覧 route は 503。
- 単一uploadは専用 `UPLOAD_CAPABILITY_KEYS` / `UPLOAD_CAPABILITY_ACTIVE_KID` が必要。32-byte base64url鍵をkidで選ぶ。旧kidは有効uploadの期限まで保持する。remote secret未設定ならupload routeは503。

## 次に進める順序

製品側の次の接続は[公開リンク](PUBLIC_SHARES.md)のthumb/page/track配信。ZIPは[ZIPダウンロード](ZIP_DOWNLOADS.md)へ接続済み。公開deleteはapi/publicShareMutations.tsからtrashNodeへ接続し、選択時revision・元share/session/keyを固定する。migration0065が既存trash actorを保持したまま匿名null actorを認め、元operation/credentialとの帰属と不変性を検査する。jobs/trashProvenance.tsを復旧最終監査へ接続済み。元sessionからのoperationとoutbox照会では元の親の現行edit権限を必要とする。共有rootの改名・削除禁止、read権限の書込み拒否、別credential/grantへの代替禁止を維持する。公開create/rename/deleteも[PUBLIC_EDIT_RECOVERY](PUBLIC_EDIT_RECOVERY.md)のIndexedDB保存・明示再開へ接続済み。入口はweb/src/public-share/{editStore,edit,editor}。

公開uploadの入口はservices/uploads/{create,access,complete,multipart,multipartComplete}.tsとapi/uploads.ts。create/access/completeはuserとlink_shareを許可し、auth/uploadPrincipal.tsで保存済みlink/session/versionを照合する。sourceのprivate/dav CHECKは維持する。編集linkはowner予約を使用し、UploadDO・native/R2証明・repair・backup監査へも接続した。multipart cleanupの停止条件とpublication条件は同じbatch内の別assertionとし、D1の式深度100以内に抑える。upload-onlyはshare/owner双方の予約、情報非開示receipt、確定batchでの自動改名、再開画面へ接続済み。[UPLOAD_ONLY_SHARES](UPLOAD_ONLY_SHARES.md)を参照。

共通更新受付、DAV PUTの失敗精算と不明結果の保留、backup barrier、logical export/隔離restore drill、日次取得と補充、期限切れ指定世代の回収、自動走査とmaintain/service例への接続まで実装済み。非0終了・長時間実行・24時間超の成功欠落を扱う運用通知も接続済み。次はTime Travel/live復旧と全storage喪失後の世代選択を整備する。外部通知先や設置先の設定を要しないローカル実装から進める。実環境の設置・通知・配備には具体的な環境情報が必要。検証状態と未完了の製品機能は冒頭の再開点とCURRENT_STATEを参照。

復旧の次の具体的な接続点: 採用済み要求の`ControlRestoreRecovery`から既存の停止中upload/multipart・予約・outbox修復を呼び、元要求/採用epochを固定したprivate operatorへ接続する。`repair-restored-native`は共通native呼出しの終了のみを確定し、容量精算やnamespace公開は行わない。旧backup記録の扱い、旧schemaから現行監査への移行も確認する。採用用の原子的停止batchは接続済みであり、凍結をSQLで無条件解除したり、既存完了operationをfailedへ変更したりしない。ローカルfixtureの成功を実Time Travel成功とは区別する。

最終停止の調査結果: D1凍結とsystem/global修復の新規受付拒否を実装済み。RECOVERY_FINAL_QUERYはnamespace/会計整合性も要求するため、壊れたD1に対する外部処理終了証明としては代用しない。14種類のR2書込み、BACKUPS外部CLI保存、通常/復旧epoch履歴、KDFとmaintenance taskの記録は接続済み。未知native・旧実装・全DO喪失時の運用収束は残る。期限・HEAD不在・通信timeoutだけで未知結果を終了扱いにしない。

以下は以前のcheckpoint記録（当時の「最新」「未実装」「CI確認予定」を含む）。

最新はKDF終了記録の修復。ControlDO SQLiteに送信前reserved/実終了finished/未送信確定not_startedを最大20件保存し、D1精算を確認してから削除する。次回受付前と内部`repairKdfSettlements`で再照合する。後者はmaintenanceと監査初期化を伴う。未知reservedは時間で削除せず、復旧監査と再開にもローカル記録のfenceを追加。D1に行がない終端proofはwrite barrierとDB側期限の照合後だけ掃除し、計算成功とはしない。新規14件と全check Node396+workerd891=1,287件成功。今回のCI/browserはpush後に確認する。詳細はKDF_ADMISSION、検証結果はIMPLEMENTATION_STATUS。D1 migrationは追加せず0029/66tableを維持。次はaccount mutation admission、残るQueue/backupと製品の後続phaseを進める。未知KDF・未知multipartの保留を勝手に解除しない。

直前commit `4dbafdd`の[CI run35997960544](https://github.com/daraskme/Nextcloud-flare/actions/runs/35997960544)は全成功、Node396+workerd877+browser19=1,292件。以下は以前のcheckpoint記録。

最新はアプリパスワードKDFのControlDO/D1全体制限。migration `0029`、通常66table。WorkerのHMAC中間値から固定100k PBKDF2を実行し、D1で600受付/65秒・未精算20枠を保留。通常は単一ControlDO内1件ずつで、20並列の処理能力を主張しない。同じattemptを再送せず、claim応答喪失では未送信を自身のtokenでのみ精算する。nativeの実終了後だけ枠を返し、DB精算不明は保持して復旧再開を止める。epoch変更後65秒cooldown。発行/認証/鍵更新とHTTP503を接続済み。新規Node7件とworkerd20件、既存認証34件成功。全checkはNode396 + workerd877、browser19も成功して合計1,292件。詳細はIMPLEMENTATION_STATUS。今回のCIはpush後に確認する。契約と残るrepair/実環境gateは[KDF_ADMISSION](KDF_ADMISSION.md)。次はKDF未精算repair、account mutation admission、Queue・backupと製品の後続phaseを進める。

直前commit `026f534`の[CI run35993638387](https://github.com/daraskme/Nextcloud-flare/actions/runs/35993638387)は全成功。Ubuntu2分42秒・Windows13分57秒・browser1分32秒、Node389 + workerd857 + browser19 = 1,265件。Windowsの新規中止19件も成功。以下は以前のcheckpoint時点の記録。

最新の追加は発見済み未追跡handleの中止と不変attempt台帳（migration `0028`）。毎回fresh proofを取り、bucket/part走査完了・稼働upload/lease不在を検査する。claim応答確認後のみ正確なkey/IDへ1回dispatch、同一attemptは再送しない。64件の生涯上限・10秒待機、遅い応答でもhold/隔離は維持する。新規19件とschema検証は成功。全check結果はIMPLEMENTATION_STATUSへ記録する。中止receiptを全体閉鎖と解釈して精算しない。次はprovider保証・実S3の閉鎖条件を詰め、独立に進められるaccount/KDF admission、Queue、共有・mediaも続ける。

直前commit `284a202`の[CI run35966922855](https://github.com/daraskme/Nextcloud-flare/actions/runs/35966922855)は全成功。Ubuntu2分39秒・Windows8分55秒・browser2分11秒、Node389 + workerd838 + browser19 = 1,246件。以下の2件のWindows fixture失敗は解消済み。

以下は以前のcheckpoint時点の記録（当時の未完了項目を含む）。現在の状態は上記とCURRENT_STATEを優先する。

CI補足: commit `5544432`の[CI run35965874860](https://github.com/daraskme/Nextcloud-flare/actions/runs/35965874860)はUbuntu（3分7秒）・browser（2分17秒）成功。Windowsの検索9件は成功したが、既存content-leaseのlate GETテストだけ90秒timeout（837/838件成功）。fixtureの初期期限5秒を準備中に超えると、BudgetDOが仕様どおり更新済みticketの2分期限へrenewするため、短い期限の試験にならない。準備を含むfixture期限を15秒にし、2回目のgrantが元の期限を保持することを直ちに検査する。本番コード・期限は変更しない。 最終結果は最新SHAと照合する。

CI補足: commit `dfd2468`の[CI run35964611990](https://github.com/daraskme/Nextcloud-flare/actions/runs/35964611990)はUbuntu（6分23秒）・browser（19件、2分7秒）成功。Windowsは新機能27件を含む837/838件が成功し、既存の1万件検索fixtureだけ個別60秒でtimeout。個別指定を既存Windows runner予算と同じ90秒へ揃える。検索の1万件上限・アサーション・本番期限は変更しない。 修正後の結果は最新SHAと照合する。

最新はupload行喪失時の未完了multipart走査とpart容量保留。migration `0027`、64通常table。[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md)が契約。各RPCでfresh proofを取得し、100件以下のページをD1へ原子的保存する。keyとR2 IDの完全一致だけtracked、その他は隔離する。partの最大観測bytesをowner physicalへ差分加算し、縮小・空一覧・404・遅延IDで解除しない。隔離handleは0 bytesでも復旧を止める。次は中止・遅延create/part/complete・完成物の照合・全体閉鎖と精算。元台帳のdelete guardやholdを外すだけで完成扱いにしない。直前commit `9811560`のUbuntu/Windows/browser CIは全成功（run35954162544）。今回の結果はIMPLEMENTATION_STATUSを参照。

未知multipart IDの修復に毎回freshなBLOBS/S3対応検証を接続した。maintenance/GC pauseを必須とし、claim・round reset・dispatch counter・page/receipt・physical観測・lease解放をcurrent proof fenceと同一batchで確定する。過去の成功や保存済みpageだけでは次のdispatchを許可しない。複数修復はprobe leaseで直列化する。詳細は[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)、試験結果はIMPLEMENTATION_STATUS。全体閉鎖・容量精算・upload行喪失時の中止・実S3は引き続き未完了。scanの完了を閉鎖証明として使わず、reservation holdを外さない。

進捗は[PROGRESS](PROGRESS.md)へ記録する。commit `26c4d07`はpush済み。直前のCI run35919687576はWindowsのmigration hook10秒、run35919870356はWindowsのcontrol-admission3件30秒でtimeout。Windowsのworkerdテストに限りtest90秒/hook60秒へ調整し、他OSとアプリ内部期限は維持した。同commitの[CI run35926517271](https://github.com/daraskme/Nextcloud-flare/actions/runs/35926517271)はUbuntu・Windows・browser全job成功を確認済み。

所有folderの要求時集計APIとFiles情報dialogを追加。現在のファイル数・サブフォルダー数・logical bytesを、Access認可/epoch/maintenance/世代と同一batchで取得する。検索と共通の索引付きsuccessor walkでscope込み1万ノード・深さ64、部分結果とcontent不足を明示。再集計中/拒否後は古い数値を隠す。migration・依存変更なし。詳細は[FOLDER_STATS](FOLDER_STATS.md)。共有/media別集計、実D1予算、以下の製品要件は未完了。

Accessのフォルダー配下検索APIとFiles検索画面を接続。共通正規化、literal query、scope10,000/page200、現在のcredential/祖先/共有read grant、検索専用cursor、同一batchの世代assertを使う。走査は索引付きsuccessor walkで全siblingの先行展開を避ける。検索結果のparentIdを上書きに渡し、保存場所への移動、世代競合/拒否時の古い結果の非表示を実browserで検証。子一覧だけが更新されたfolderのrename/move失敗も再現・修正。詳しくは[SEARCH](SEARCH.md)。media metadata/索引再構築運用/実D1予算、共有・media・全体admission・復旧/公開の全体要件は残る。

配信leaseの期限をDOのbyte期間内へ制限し、旧実装の有効なleaseは精算まで保持する処理を追加。`/c`も返された期限をR2 HEAD/GETとbody終了まで引き継ぎ、停止した読み込み・未読応答・取消しを扱う。精算は1回、結果不明は全額保持。実D1の期限更新で有効なleaseが消える問題と、修正前の配信関数が期限後の3 byteを返す問題を再現した。詳細は[CONTENT_LEASES](CONTENT_LEASES.md)。実HTTP切断伝播、長時間downloadのRange/ticket更新UI、全media/public配信経路と実環境gateは残る。

作成応答喪失と対象更新が重なる場合のreceipt回収を修正した。同じcreate key/bodyへの再送は現在のnode権限・credential・epoch・owner・parentを原子的に検査し、元のID/capabilityを返す。新規予約・R2初期化・本文・確定の旧revision検査は維持し、multipart初期化が対象変更で止まれば202で中止可能なreceiptを返す。実HTTPの競合/予約不変/失効境界5件、browserの単一・分割の応答喪失/reload/中止2件を追加。対象の移動・削除・失効・期限切れは引き続き制限される。詳細は[UPLOAD_OVERWRITE](UPLOAD_OVERWRITE.md)、全結果はIMPLEMENTATION_STATUS。

前回の追加は[確認付き上書き](UPLOAD_OVERWRITE.md)と[異なる配信対象のbudget台帳](BUDGET_ALLOWANCE.md)。上書きは対象node/revision/blobと元file名を保持し、全partのIf-Match、競合停止、完了応答喪失からのreceipt照合へ接続。配信budgetは認可manifestのpurpose/blobを重複排除し、対象追加でも使用量・回数・期限をリセットしない。同期transaction、1,024対象/lease・1 MiB上限、旧DO保存領域の期限までの制限を文書化した。実環境・共有/検索/media・全体admission等は引き続き未完了。全検証結果はIMPLEMENTATION_STATUSを参照。

前回の追加は[KDF isolate内制限](KDF_ADMISSION.md)。app passwordの作成・検証・pepper更新を同時1件、待機256件・5秒へ制限した。取消し中の実計算が終わるまで枠を保持し、混雑は503 + Retry-Afterで返す。作成前のAccess/root検査と計算後の現行D1 assertionを維持する。Node/workerd/独立HTTPの試験を追加。ControlDOによる全体600回/分・20並列とmutation32並列・待ちqueueは未実装なので、local executorで完了扱いにしない。

前回の追加は[本文なしHTTP操作](EMPTY_HTTP_BODY.md)。実HTTPで本文なしMKCOLが415になる不具合を修正し、DAVのCOPY/MOVE/DELETE/UNLOCK、private ticket/app-password取消し、logoutも共通検査へ接続した。実データ・既読/locked・失敗・取消しを拒否し、5秒・16回のreadで待機を制限する。Node境界13件、workerdの待機中失効/停止2件を追加し、既存D1/LockDO試験をclosed streamで拡張。独立HTTPでDAV作成から移動/コピー/削除/lock解除とticket取消しを検証した。`pnpm check`とbrowser試験は同一checkoutでは順番に実行する。並行buildによる開発サーバーreloadは進行中のfixtureを壊す。

直近は[通常稼働中の復元](RESTORE_GC.md)を実装。migration `0026`、61通常table。管理者GC設定と復元用の単一・5分期限holdを分け、既存deletingだけをdrainする。LockDO grantと原子的restoreの両方でoperation/token/epoch/期限を検査し、finally/alarmで解放する。alarmの失敗回数はepoch/revision/tokenごとに永続化し、連続6回でclosing intentを作って自動再試行を停止する。DB全面障害時もDOの受付は閉じ、復旧後にquiesce再送・repair・全監査が必要。古い失敗は新hold/管理者設定を閉じず、cleanup alarmも失わない。遅延処理、応答喪失、停止・epoch変更、eviction/全喪失を検証する。Files browser fixtureもGCを再開し、復元前後と応答喪失の再照会を試験する。次はaccount/KDF admissionと残るQueue、共有・検索・media UIを進める。Nodeとブラウザー型は分離。`pnpm test:browser`はlocal専用entryと`.wrangler/browser-tests`を使い、通常開発DBやremoteを変更しない。全checkにbrowser試験は含まれず、CIは別job。

直近はControlDOの受付とGCの段階再開を追加した。migration `0025`、61通常table。全監査とD1最終assert、永続revision/token、repair holdを使い、応答喪失・停止/epoch競合・eviction/全喪失を検証。手順と限界は[CONTROL_ADMISSION](CONTROL_ADMISSION.md)。Files UIの残り、account/KDF admission、残るQueue/共有/検索/媒体サービス、backup/exportと実環境gateを続ける。

直近は停止中GC drainを追加した。[GC_RECOVERY](GC_RECOVERY.md)に対象・上限・再試行と残作業を記録した。通常blob GCも各R2 dispatchと最終精算でepoch/mode/leaseを再確認する。schemaは61通常table/migration `0024`。未知multipartの全体閉鎖は進行中partとの競合を含むR2保証の確認が必要で、予約holdは解除していない。

その前の変更はmigration `0023`と`withVerifiedR2Inventory`によるBLOBS/S3対応検証。固定system keyの64-byte nonceを条件付きPUTで更新し、S3 GETとの一致を同じ60秒lease内で確かめる。成功booleanは後日再利用せず、callbackのcurrent D1 fenceと同じbatchでのみ後続変更を確定する。全体閉鎖・予約精算への接続は次段階。system probeを通常処理で削除しない。

その前の変更は既存uploadに対する未知multipart IDの永続走査とabort。`multipart_inventory_scans`登録と永久停止/claimを同じbatchにし、以後は普通のknown-ID cleanupによる早期精算を拒否する。別source/epochでcursorを再開せずroundを作り直す。1回1page/20件、既定10handleのabort。marker破壊を避けて全ページ後に中止する。R2 abort成功を各handleに保存し、S3の空一覧・NoSuchUpload・応答喪失は全体閉鎖としない。S3障害時にも完成物を計上するためHEADを一覧取得前と処理後に行う。後から判明した元IDも追加handleとして扱う。schemaは61通常table/migration `0023`。次は対応検証との接続・完全な不在証明と予約精算。scan/handleのdelete guardや予約holdを外すだけで完成扱いにしない。

未完了multipartのS3取得境界と停止中ControlDOの診断RPCを追加した。詳細は[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)。1回1 GET、20件既定/100件上限、1 MiB/10秒、manual redirect・retryなし、XML/echo/markerを検査する。`aws4fetch@1.0.20`をexactで追加し選定証拠を記録した。実S3設定・接続試験は未実施。返却の`bindingVerified:false`/`closureProven:false`を変更して修復扱いにしない。migration `0022`で複数IDの永続走査とpermanent stop/drain後のabortを追加済み。fresh nonceによるBLOBS/S3対応検証は別serviceへ追加済み。次は全体不在証明、予約精算へ接続する。D1 snapshotでpart行がないだけでは未完了bytesなしと推測できず、最初のIDだけuploadsへ保存して予約を解放してはいけない。

直近はprivate multipart HTTPのcreate/part/status/page/complete/abortを既存route契約へ接続した。契約は[UPLOAD_HTTP](UPLOAD_HTTP.md)。完成済み`u/` objectのinventory/35日回収も追加済み（[ORPHAN_INVENTORY](ORPHAN_INVENTORY.md)）。次はunknown multipart IDのS3 inventory修復と、Queue drain・復旧監査・再開gateを進める。readUploadは現在認可をsnapshot batchで再確認するD1照会専用で、DO台帳を再初期化しない。期限/idle/回収後も現在権限でreceiptを読むが、transfer fenceは維持する。multipart DELETEはD1のcreated/uploadingだけをabortingへCASし、completing/completedは409。遅延partの予約はR2回収まで保持する。`claim`の`dispatch`だけが新しいR2 callを許し、同attempt再送の`in_flight`では送信しない。`not_started`はR2未呼出しが確定している場合だけ使用する。D1のimmutable `multipart_ledger_id`をSQLite初期化より先に確定する。markerの応答喪失やDO storage全喪失では`upload_ledger_recovery_required`として停止し、空の新規台帳でbudgetをリセットしない。dirty part mirrorはSQLiteのrevisionで保持し、D1応答喪失時も同attemptへdispatchを再発行しない。D1 mirror失敗後の停止intentには再試行alarmを残す。R2 createの結果不明IDは再作成せず予約を保持するため、unknown IDは外部inventory/lifecycle実確認に基づくrepairが必要。7日経過だけでは予約を解放しない。

migration `0019`はmultipart_complete_attempt/lease、multipart_object_etag、成功partの不変性とcompleted終端guardを追加。R2 complete claimの応答喪失では再送せずHEADへ進み、不在だけでは再completeや予約解放を許さない。全partのD1 geometry/etag/hash証明、R2 objectのsize/metadata/etag、physical observationを最終fsMutationでも検査する。multipartのwhole sha256_verifiedはNULLを維持する。確定中の権限失効ではphysicalだけ計上し予約を維持、既知namespace失敗ではobject proofがある時だけ予約を解放する。D1 committed operation/digest/operand/result/stepをDO terminal照合の正本とし、ack喪失や旧epochで公開済みblobをcleanupへ戻さない。HEAD用control_calls上限64はcleanup counterと独立。

migration `0020`のmultipart_cleanup_started_atは回収開始後の再送/再初期化/completeを永続拒否し、multipart_cleanup_closedはR2 abort成功または既知complete attemptに対応する完成物のHEAD照合だけで固定する。activeなinit/part/complete leaseは待ち、期限/idle/旧epoch/停止intentをbounded scanで回収する。中止応答不明やNoSuchUploadとHEAD不在だけでは予約を戻さない。実bytesの観測を先に保存し、予約解放とGC handoffは同じbatch、physical減算はR2不在後のみ。CronとControlDO.repairStoppedMultipartUploadsに接続し、DO alarmは恒久停止markerを検出するとmirrorせず終了する。未知ID・不正metadataは隔離を維持する。

単一uploadの回収は24時間まで待ち、60秒claimのcurrent tokenでのみHEAD結果を精算する。HEAD失敗・metadata不一致では予約を保持する。physical観測、予約解放、GC handoffは原子的に確定し、R2不在確認前にphysicalを戻さない。単一uploadの未知object隔離は汎用inventory/repairの代替ではない。upload用のControlDO repairは完成objectを削除せず、multipartの既知handleのみabortする。別RPCの停止中GC drainだけが既存deleting objectの削除を完了する。admissionを再開しない。

以下の全体gateも引き続き必要:

1. **outbox Queue 実サービス / repair**: `node.created` と `node.renamed` のローカル handler を基に実 Queue/DLQ/requeue を検証し、残る kind の saved operand/result CAS と chunk fencing を実装する。ControlDO admission が閉じている間は `retryAll` を維持する。
2. **ControlDOの残る制御**: namespace以外のaccount mutation受付とbackup統合、終了証明を失ったKDFの運用収束・共有password/IP制限、backup専用barrier、実restore drill。全監査後の受付再開は空DB/実データ両方で実装・検証済み。未知multipartの予約hold・最終fenceは維持する。
3. **Phase 1 の残り**: 各 operation の operand tuple、HTTP host/profile/CSRF、app-password/share secret 検証、operation lookup/commit_unknown response を接続。R6 §8 の全 fixture と完了条件を現在のテストへ対応付ける。
4. Phase 1 gate を閉じてから BRIEF の後続 phase を順に実装する。メディア形式の追加条件を維持し、最後に実環境 gate とリリース確認を行う。

フォルダー作成は current parent/revision/tree を読み、7 step を一括確定する内部サービス。SQL plan は server code のみで生成し、外部から任意 step/SQL を受け付けない。
名前検索は private API と Files UI へ接続済み（[SEARCH](SEARCH.md)）。media metadata の全文索引・索引更新の運用・実 D1 の処理量/応答時間 gate は未完了。

## 再開コマンド

作業場所は実環境で確認する。現在の NixOS workspace は `/home/hiroshi/ドキュメント/Nextcloud-flare`（2026-09-23にユーザー指定で移動）。`/tmp/Nextcloud-flare`は移動前の保管用コピーで、開発先として使わない。Windows workspace は `C:\Users\micro\Documents\Nextcloud-flare`。remote: `https://github.com/daraskme/Nextcloud-flare.git`、branch: `codex/database-restore`。

```powershell
git status --short
git log -5 --oneline
gh run list --limit 3 --json databaseId,headSha,status,conclusion,url
node --version
pnpm --version
```

Node 24.21.0 / pnpm 12.4.1。依存は exact、公開後7日以上。`docs/toolchain.json` に選定証拠、`pnpm-lock.yaml` に固定版。
環境の準備が必要なら `pnpm install --frozen-lockfile`、変更後の checkpoint は `pnpm check`。
このPCにはGit対象外の`.local-toolchain/`に両固定版を用意した。NixOS用loaderで起動でき、repository rootから`.local-toolchain/run pnpm check`、`.local-toolchain/run pnpm dev`で使える。Node配布物は公式SHASUMS256との一致を確認後にloader/RPATHのみ調整した。OS全体の設定は変更していない。
範囲を絞った検証例:

```powershell
pnpm exec vitest run --config vitest.config.ts packages/worker/test/integration/fs-mutation.test.ts packages/worker/test/integration/outbox.test.ts
pnpm exec vitest run --config vitest.unit.config.ts packages/worker/test/unit/names.test.ts
```

schema 変更時は新 migration を追加し `node scripts/generate-schema-contracts.mjs` を実行する。既存適用済み migration を書き換えず、schema test のテーブル数/適用数も整合させる。
`pnpm build` は Vite + Wrangler **dry-run**。`pnpm dev` もローカル binding のみ。全0の resource ID を実環境の ID として利用しない。

## 環境で分かった注意点

- Windows の sandbox 内で esbuild の親 directory 読取りが拒否される場合がある。既存セッションでは承認された制限外プロセスで pnpm test/check/build を実行した。
- Git の index 書込みと network push に sandbox escalation が必要だった。拒否を lock 残骸と誤認して `.git/index.lock` を削除しない。
- Git author は global 未設定。必要時は `gh api user` と既存 commit の author を確認し、per-command config を使う。既存は `darask` / `102633287+daraskme@users.noreply.github.com`。global 設定は変更していない。
- `.gitattributes` は LF 固定。Windows CI の過去の改行失敗は修正済み。
- Vitest Workers pool 0.22 の intentional RPC rejection は cleanup を停止させることがある。拒否は `runInDurableObject` の内側で捕捉する。成功側を含め、admission fixture と実 RPC の検証範囲を区別する。
- 同梱 workerd の都合で compatibility date は2026-08-15。日付や依存更新は別途 gate を通す。
- ローカル試験の R2/DB fixture と実 inventory は別物。会計 fixture の一部は metadata のみで実 R2 object を作らないため、resume verifier 試験には整合する専用 fixture が必要。
- commit_unknown で namespace を補償しない。単純な `meta.changes` の JS 判定で rollback と判断しない。DO epoch を時刻から生成しない。秘密値・全 JWT・lock token をログしない。
