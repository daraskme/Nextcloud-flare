# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[実保存後のコピー観測修復](COPY_JOBS.md)を追加しました。元nativeの実成功と転送先HEADのhash/metadataを照合し、欠落したphysical/hash/ETag・stored情報を原子的に復元します。通常の再認可付き進捗確定、または停止済み精算へ戻せます。結果不明の処理は保持し、part/handle観測・未送信attemptの再試行・全体完走予算とQueue/HTTP/UIは後続です。

今回はschema0058・通常75tableを維持し、元の保存処理と観測記録を共通化しました。修復29件を含む関連workerd7file/194件、全Node75file/1,431件の計1,625件が成功。型・lint529file・契約/設定検査とWeb build/Worker dry-runも成功しました。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIPを進めます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

先行de13fc6の[CI36384106965](https://github.com/daraskme/Nextcloud-flare/actions/runs/36384106965)は最終確認時にbrowser成功、Ubuntu・Windows3分割・backupは実行中です。完了結果は同じrun IDで確認します。

先行2f9b8bdの[CI36381492636](https://github.com/daraskme/Nextcloud-flare/actions/runs/36381492636)はbrowser・Windows分割1/2が成功、Ubuntu・Windows分割3は復旧snapshot試験の旧table数74という期待値で失敗しました。通常75tableとexport対象名の完全一致へ今回修正し、対象46件は成功しています。backupは通常drill・operator drill成功後、run-drill中に30分のjob上限で打ち切られました（GitHub annotationで確認）。保存ログだけでは遅延箇所を確定できず、調査を継続します。

送信先は承認済み専用`codex/database-restore`です。先行b1fedc7の[CI36377836985](https://github.com/daraskme/Nextcloud-flare/actions/runs/36377836985)はUbuntu・Windows2分割・browser・backupが成功、Windows分割1はsearch.test.tsの1万件検索が90秒timeoutで失敗しました（965/966件成功）。検索試験の遅延原因は未解決で、上限や検査を緩めていません。先行33a8a80の[CI36365491865](https://github.com/daraskme/Nextcloud-flare/actions/runs/36365491865)はUbuntu・Windows3分割・browser・backupの全6job成功です。前回の時刻依存テスト修正はWindows3分割でも成功しました。以前のorphan-admission回数不一致と21cd396のR2保存先照合失敗の原因は未確定です。先行af30646の[CI36367826306](https://github.com/daraskme/Nextcloud-flare/actions/runs/36367826306)は全6job成功です。先行7e933b1の[CI36369537337](https://github.com/daraskme/Nextcloud-flare/actions/runs/36369537337)は全6job成功です。先行a52b815の[CI36371093589](https://github.com/daraskme/Nextcloud-flare/actions/runs/36371093589)はUbuntu・Windows3分割・browser成功、backup:run-drillのsource fingerprints中にbackup_wrangler_failedで失敗しました。保存されたログだけでは子プロセスの失敗原因を特定できません。最新CI状態はgh run listで確認します。
