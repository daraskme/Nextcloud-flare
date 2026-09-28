# 開発進捗

[単一ドメイン構成](SINGLE_HOST.md)を接続しました。APP_ORIGINとCONTENT_ORIGINが同じ場合も、Files・公開共有・原本配信・DAVをパスで振り分け、既存の認証・Cookie・CSP・会計を維持します。別ドメインの配信hostは従来どおり配信専用です。公開リンクの原本GET/HEAD、匿名編集・削除・所有者復元・再開可能なupload/overwriteも接続済みです。schema0065・通常76table・147 route、移行と依存追加なし。upload-only・thumb・ZIP・media、実環境検証と復旧側の残件は未完了です。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

更新: 2026-09-29

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[所有者間コピー](COPY_JOBS.md)の明示的な再試行をRESTと画面へ接続しました。元jobの停止と全blobの精算が証明された後、現在の内容から新しいjobを1件だけ受け付けます。異なるkeyの競合・応答喪失・reloadでも同じ後継を追跡し、元jobの容量保持やnative記録を解除しません。DLQの保持期限管理と通知、未知native/part/handleの全修復、最大規模の実環境検証、タブ終了後や別端末の追跡復元は未完了です。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

前回の再試行はmigration0061で後継受付の一意索引と確定時検査を追加し、通常75table・147 routeを維持しています。依存追加はありません。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はupload-onlyを接続します。copyのDLQ運用・未解決attemptの修復、ZIPも続けます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

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
