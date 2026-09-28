# 開発進捗

更新: 2026-09-28

CIで見つかった共有編集の再送テストの競合を修正しました。再読込後の一覧には既に作成済みfolderが表示されるため、表示だけで完了判定せず、元Idempotency-KeyのPOST応答201と未確認表示の解消を待ちます。Windowsの1万件検索timeoutはローカルでは再現しておらず、失敗時だけ処理段階・所要msを出す診断を追加しました。90秒・1万件・検索SQLと権限検査は維持しています。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。次の製品実装はコピー途中multipartの中止・精算です。

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[所有者間コピーの停止・精算](COPY_JOBS.md)を追加しました。元の両側権限を再検査して取消し、期限/epoch/予算で失敗停止します。停止だけでは保持を返さず、未着手・明示的not_started・保存済みの証拠が揃うblobだけを原子的に精算します。保存済みobjectはphysical容量を維持して35日猶予のGCへ渡します。途中multipartの中止、結果不明/観測欠落の修復、最大転送規模の完走予算、Queue/HTTP/画面は未完成です。

schema0057・通常75table。不変のcopy_cleanup_receiptsとbulk_jobsの停止時刻/epoch、証拠付き精算・native履歴保持guardを追加しました。全Node1,410件・関連workerd304件の計1,714件が成功しました（修正したfileの再実行を含む）。型・lint522file・契約/設定・75tableのSQL backup往復も確認しました。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIPを進めます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済み専用`codex/database-restore`です。先行b1fedc7の[CI36377836985](https://github.com/daraskme/Nextcloud-flare/actions/runs/36377836985)はUbuntu・Windows2分割・browser・backupが成功、Windows分割1はsearch.test.tsの1万件検索が90秒timeoutで失敗しました（965/966件成功）。検索試験の遅延原因は未解決で、上限や検査を緩めていません。先行33a8a80の[CI36365491865](https://github.com/daraskme/Nextcloud-flare/actions/runs/36365491865)はUbuntu・Windows3分割・browser・backupの全6job成功です。前回の時刻依存テスト修正はWindows3分割でも成功しました。以前のorphan-admission回数不一致と21cd396のR2保存先照合失敗の原因は未確定です。先行af30646の[CI36367826306](https://github.com/daraskme/Nextcloud-flare/actions/runs/36367826306)は全6job成功です。先行7e933b1の[CI36369537337](https://github.com/daraskme/Nextcloud-flare/actions/runs/36369537337)は全6job成功です。先行a52b815の[CI36371093589](https://github.com/daraskme/Nextcloud-flare/actions/runs/36371093589)はUbuntu・Windows3分割・browser成功、backup:run-drillのsource fingerprints中にbackup_wrangler_failedで失敗しました。保存されたログだけでは子プロセスの失敗原因を特定できません。最新CI状態はgh run listで確認します。
