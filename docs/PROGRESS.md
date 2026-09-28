# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[所有者間コピー](COPY_JOBS.md)で、実行期限直前に次の書込みを準備してしまう経路を修正しました。25秒期限を維持し、次の転送前に6秒の余裕を要求します。時間が足りなければ未着手blobをpendingのまま残し、次回に続行します。書込み許可・native・終了記録の元例外も内部causeとして保持します。REST受付・進捗照会・取消APIは実装済みですが、画面の宛先選択/ジョブ表示、retry/DLQ運用、未知nativeの全修復と最大規模の実環境検証は未完了です。全Node1,466件・関連workerd152件・全browser28件、計1,646件と静的検査/buildが成功しました。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

今回の修正ではschema/route追加はなく、migration0060・通常75table・147 routeを維持しています。依存追加はありません。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIPを進めます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

直前810ea19の[CI36402990343](https://github.com/daraskme/Nextcloud-flare/actions/runs/36402990343)は、確認時点でUbuntu・Windows分割2/4と3/4・backup bindings/cliの5job成功、browserは27/28件成功で上書き応答喪失試験1件失敗、Windows1/4と4/4は実行中です。browserの通信記録から待機順序の問題を確認し、今回修正しました。今回の変更のCIはpush後に確認します。

先行0b85355の[CI36400478502](https://github.com/daraskme/Nextcloud-flare/actions/runs/36400478502)は終了しました。Ubuntu・Windows分割1/4〜3/4・browser・backup bindings/cliの7job成功、Windows4/4はcopy-executorの2件で書込み許可取得に失敗しました（workerd813/815件成功）。以前の固定件数assertionとは異なります。残り3秒で次転送へ進む経路をローカルで再現し、6秒の事前余裕を追加しましたが、CIの元例外が隠れていたため、2件の根本原因を確定したとは扱いません。内部causeを保持して次回CIで確認します。

先行8dd74ecの[CI36394122457](https://github.com/daraskme/Nextcloud-flare/actions/runs/36394122457)は終了し、Ubuntu・Windows4分割・browser・backup bindings/cliの全8jobが成功しました。UbuntuのNode1,436件と全workerd137file/3,093件の成功もログで確認済みです。直前81e9f01の[CI36396573483](https://github.com/daraskme/Nextcloud-flare/actions/runs/36396573483)は終了し、Ubuntu・Windows分割1/4と3/4・browser・backup bindings/cliが成功しました。Windows2/4はQueue再開1件（796/797件成功）、4/4はexecutor3件（811/814件成功）が失敗しました。25秒で正常にyieldしても固定件数を要求していたため、0b85355で時間による中断後の再開と重複PUT防止を検証する形へ修正し、D1/R2予算境界は少量の実転送で独立に再現しています。製品の期限・上限は維持しています。今回の変更のCIはpush後に確認します。

CI分割変更ae79ecaの[CI36387497530](https://github.com/daraskme/Nextcloud-flare/actions/runs/36387497530)は終了しました。Ubuntu・Windows分割2/4・4/4・browser・backupのbindings/cliは成功、Windows分割1/4は30分のjob上限でcancelled（annotation確認）、3/4はcopy-executionのepoch変更試験の準備中にfixture_copy_failedで失敗しました（Node1,431件成功、integration717/718件成功）。SQLエラーと受付outcomeの診断はef5ee58へ追加済みですが、原因解消とは扱いません。コピー実行処理b7a32abの[CI36387145263](https://github.com/daraskme/Nextcloud-flare/actions/runs/36387145263)はUbuntu・Windows3分割・browser・backupの全6job成功です。ef5ee58の[CI36389252207](https://github.com/daraskme/Nextcloud-flare/actions/runs/36389252207)は終了し、Windows4分割・browser・backupのbindings/cliが成功しました。Ubuntuは全Node1,431件成功、integration3,046/3,047件成功で、control-restore-domainのfixtureがdispatch_before<=started_at+5000制約に違反しました。開始と期限でDate.now()を別々に取得していたため、8dd74ecで同じ開始値へ統一しました。製品の期限・assertionは維持しています。fdc7abaの[CI36390929822](https://github.com/daraskme/Nextcloud-flare/actions/runs/36390929822)は終了し、Windows4分割・browser・backupのbindings/cli成功、Ubuntu失敗です。UbuntuはNode1,431件成功、integration3,066/3,067件成功で、control-restore-gcの同じ時刻fixture問題でした。8dd74ecでこちらも同じ開始値へ統一しました。

先行5787368の[CI36385410210](https://github.com/daraskme/Nextcloud-flare/actions/runs/36385410210)はUbuntu・Windows分割2/3・3/3・browser・backup成功、Windows分割1/3は30分のjob上限でcancelledです（GitHub annotationで確認）。上記4分割化後のCIで完走を確認します。

先行de13fc6の[CI36384106965](https://github.com/daraskme/Nextcloud-flare/actions/runs/36384106965)はUbuntu・Windows分割1/3・3/3・browser成功、Windows分割2/3とbackupは30分のjob上限でcancelledとなりました（GitHub annotationで確認）。backup:run-drillは上限直前に全assertion成功とSQL 9,233bytesのPASSを出していますが、jobの正常終了は確認できません。Windows分割2/3も打切り直前まで試験が進行しており、上記のCI実行単位へ分割します。以前のbackup_wrangler_failedや検索個別timeoutの原因が解決したことは意味しません。

先行2f9b8bdの[CI36381492636](https://github.com/daraskme/Nextcloud-flare/actions/runs/36381492636)はbrowser・Windows分割1/2が成功、Ubuntu・Windows分割3は復旧snapshot試験の旧table数74という期待値で失敗しました。通常75tableとexport対象名の完全一致へ今回修正し、対象46件は成功しています。backupは通常drill・operator drill成功後、run-drill中に30分のjob上限で打ち切られました（GitHub annotationで確認）。保存ログだけでは遅延箇所を確定できず、調査を継続します。

送信先は承認済み専用`codex/database-restore`です。先行b1fedc7の[CI36377836985](https://github.com/daraskme/Nextcloud-flare/actions/runs/36377836985)はUbuntu・Windows2分割・browser・backupが成功、Windows分割1はsearch.test.tsの1万件検索が90秒timeoutで失敗しました（965/966件成功）。検索試験の遅延原因は未解決で、上限や検査を緩めていません。先行33a8a80の[CI36365491865](https://github.com/daraskme/Nextcloud-flare/actions/runs/36365491865)はUbuntu・Windows3分割・browser・backupの全6job成功です。前回の時刻依存テスト修正はWindows3分割でも成功しました。以前のorphan-admission回数不一致と21cd396のR2保存先照合失敗の原因は未確定です。先行af30646の[CI36367826306](https://github.com/daraskme/Nextcloud-flare/actions/runs/36367826306)は全6job成功です。先行7e933b1の[CI36369537337](https://github.com/daraskme/Nextcloud-flare/actions/runs/36369537337)は全6job成功です。先行a52b815の[CI36371093589](https://github.com/daraskme/Nextcloud-flare/actions/runs/36371093589)はUbuntu・Windows3分割・browser成功、backup:run-drillのsource fingerprints中にbackup_wrangler_failedで失敗しました。保存されたログだけでは子プロセスの失敗原因を特定できません。最新CI状態はgh run listで確認します。
