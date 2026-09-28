# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[所有者間コピー](COPY_JOBS.md)に停止後の自動回収を追加しました。Queueに残らない取消し・失敗job、旧epoch・期限/予算超過を専用Cronで拾い、既知multipart中止と実保存後の観測修復を証明済み精算へつなぎます。巡回位置・lease・次回時刻・R2消費を永続化し、未知の書込みを保留したまま後続へ進みます。最大規模の完走、未知/未送信attemptの再試行管理、DLQ運用、HTTP/UIは未完了です。Node1,436件と関連workerd304件、計1,740件が成功しました。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

migration0059でbulk_jobsへ保守用の7columnを追加し、通常75tableを維持しています。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIPを進めます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

CI分割変更ae79ecaの[CI36387497530](https://github.com/daraskme/Nextcloud-flare/actions/runs/36387497530)は終了しました。Ubuntu・Windows分割2/4・4/4・browser・backupのbindings/cliは成功、Windows分割1/4は30分のjob上限でcancelled（annotation確認）、3/4はcopy-executionのepoch変更試験の準備中にfixture_copy_failedで失敗しました（Node1,431件成功、integration717/718件成功）。SQLエラーと受付outcomeの診断はef5ee58へ追加済みですが、原因解消とは扱いません。コピー実行処理b7a32abの[CI36387145263](https://github.com/daraskme/Nextcloud-flare/actions/runs/36387145263)はUbuntu・Windows3分割・browser・backupの全6job成功です。ef5ee58の[CI36389252207](https://github.com/daraskme/Nextcloud-flare/actions/runs/36389252207)は終了し、Windows4分割・browser・backupのbindings/cliが成功しました。Ubuntuは全Node1,431件成功、integration3,046/3,047件成功で、control-restore-domainのfixtureがdispatch_before<=started_at+5000制約に違反しました。開始と期限でDate.now()を別々に取得していたため、今回同じ開始値へ統一しました。製品の期限・assertionは維持しています。fdc7abaの[CI36390929822](https://github.com/daraskme/Nextcloud-flare/actions/runs/36390929822)は終了し、Windows4分割・browser・backupのbindings/cli成功、Ubuntu失敗です。UbuntuはNode1,431件成功、integration3,066/3,067件成功で、control-restore-gcの同じ時刻fixture問題でした。今回こちらも同じ開始値へ統一しました。

先行5787368の[CI36385410210](https://github.com/daraskme/Nextcloud-flare/actions/runs/36385410210)はUbuntu・Windows分割2/3・3/3・browser・backup成功、Windows分割1/3は30分のjob上限でcancelledです（GitHub annotationで確認）。上記4分割化後のCIで完走を確認します。

先行de13fc6の[CI36384106965](https://github.com/daraskme/Nextcloud-flare/actions/runs/36384106965)はUbuntu・Windows分割1/3・3/3・browser成功、Windows分割2/3とbackupは30分のjob上限でcancelledとなりました（GitHub annotationで確認）。backup:run-drillは上限直前に全assertion成功とSQL 9,233bytesのPASSを出していますが、jobの正常終了は確認できません。Windows分割2/3も打切り直前まで試験が進行しており、上記のCI実行単位へ分割します。以前のbackup_wrangler_failedや検索個別timeoutの原因が解決したことは意味しません。

先行2f9b8bdの[CI36381492636](https://github.com/daraskme/Nextcloud-flare/actions/runs/36381492636)はbrowser・Windows分割1/2が成功、Ubuntu・Windows分割3は復旧snapshot試験の旧table数74という期待値で失敗しました。通常75tableとexport対象名の完全一致へ今回修正し、対象46件は成功しています。backupは通常drill・operator drill成功後、run-drill中に30分のjob上限で打ち切られました（GitHub annotationで確認）。保存ログだけでは遅延箇所を確定できず、調査を継続します。

送信先は承認済み専用`codex/database-restore`です。先行b1fedc7の[CI36377836985](https://github.com/daraskme/Nextcloud-flare/actions/runs/36377836985)はUbuntu・Windows2分割・browser・backupが成功、Windows分割1はsearch.test.tsの1万件検索が90秒timeoutで失敗しました（965/966件成功）。検索試験の遅延原因は未解決で、上限や検査を緩めていません。先行33a8a80の[CI36365491865](https://github.com/daraskme/Nextcloud-flare/actions/runs/36365491865)はUbuntu・Windows3分割・browser・backupの全6job成功です。前回の時刻依存テスト修正はWindows3分割でも成功しました。以前のorphan-admission回数不一致と21cd396のR2保存先照合失敗の原因は未確定です。先行af30646の[CI36367826306](https://github.com/daraskme/Nextcloud-flare/actions/runs/36367826306)は全6job成功です。先行7e933b1の[CI36369537337](https://github.com/daraskme/Nextcloud-flare/actions/runs/36369537337)は全6job成功です。先行a52b815の[CI36371093589](https://github.com/daraskme/Nextcloud-flare/actions/runs/36371093589)はUbuntu・Windows3分割・browser成功、backup:run-drillのsource fingerprints中にbackup_wrangler_failedで失敗しました。保存されたログだけでは子プロセスの失敗原因を特定できません。最新CI状態はgh run listで確認します。
