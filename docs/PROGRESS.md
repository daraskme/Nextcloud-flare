# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

保持判定は`3609dae`までmainへプッシュ済みです。[CI36085658959](https://github.com/daraskme/Nextcloud-flare/actions/runs/36085658959)はUbuntu・backup・browserが成功しましたが、Windowsの両ジョブでNodeテスト/fixture準備の時間上限に達しました。今回、Windowsの単体試験を2並列・テスト30秒・準備60秒へ調整しました。製品の期限は変更していません。直前の日次実行`221952f`の[CI36084559502](https://github.com/daraskme/Nextcloud-flare/actions/runs/36084559502)は全5ジョブ成功です。

「pnpm backup maintain」を追加しました。日次世代を再開・取得し、保持判定の不足分を最大5世代まで追加して再検査します。世代数が足りていても最新取得が24時間を超えていれば1世代を追加します。初回は通常1+4世代を作り、現在のsnapshotを確保します。過去日の状態を取得したことにはしません。

追加取得では直前の完了IDを照合し、再送・応答喪失・同時要求で次の世代を重複して割り当てないようにしました。未完了の同じ世代を引き継ぎ、手動の別世代は奪いません。破損した同日世代を残したまま新しい世代を補充でき、破損警告は最終結果にも残します。検査未完了なら補充を始めません。

Node18件・workerd8件を追加しました。Windowsと同じ並列数・上限を指定した全Node661件（38file、40.70s）が成功。その後追加した鮮度回復を含む補充18件（151ms）も成功し、重複を除く662件を確認しています。バックアップ関連workerd87件（4file、43.78s）、lint356file・型・契約/設定検査・Web build・Worker dry-runも成功しました。Windows実機側の結果は今回のCIで再確認します。

実ControlDO/D1/R2の専用bindingドリルで、日次1世代と追加4世代を作り、5世代すべての検証、eviction後の再実行で世代が増えないこと、取得・隔離復元を確認しました。7操作の権限拒否、67table・SQL11,322bytesも確認済みです。実CLIのdaily/run/receipt/health/download/restore-offlineもSQL9,079bytesで成功し、maintainが旧epochを変更前に拒否することを確認しました。成功する5世代補充は専用bindingドリルで検証しています。

Linux用service/timerと空欄の環境変数例を追加し、systemd 261で構文とUTC時刻式を確認しました。設定例の設置・enable・起動や外部通知は行っていません。schema0039・通常67tableと依存は維持しています。詳細は[BACKUP_MAINTENANCE](BACKUP_MAINTENANCE.md)。

次は期限切れR2 objectの回収と、定期起動・外部通知の実運用接続を進めます。Time Travel・live復旧・新epochと全監査、D1/全storage喪失後の信頼できる世代選択と運用復旧、旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。remote migration・deployは未実施です。
