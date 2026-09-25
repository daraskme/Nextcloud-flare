# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

直前の`3b897ea`までmainへプッシュ済みで、[CI36083116061](https://github.com/daraskme/Nextcloud-flare/actions/runs/36083116061)はWindows2分割・Ubuntu・backup・browserの全5ジョブが成功しました。今回の日次実行もローカル検証が完了しました。今回のCIはプッシュ後に確認します。

「pnpm backup daily」を追加しました。ControlDOが開始前に世代IDを永続化し、応答喪失・日付変更・eviction・別runnerからの再実行でも未完了の同じ世代を継続します。同日の完了世代はD1の完了記録とR2の全データ・SQLを検証してから省略します。日付はサーバーのUTC取得日で判断し、翌日の完了を新しいsnapshotとして数えません。手動開始した別世代との競合や不明な状態を自動取消ししません。

ローカルの作業世代を失っても、公開済みR2 manifestがあれば全part・SQLを検証して同じ世代を復元し、開始・抽出を繰り返さずに完了へ進めます。欠落・改変・異なる世代は拒否します。

Node17件とworkerd17件を追加しました。全Node617件（36file、33.23s）、バックアップ関連workerd55件（3file、36.73s）、その後追加した日跨ぎ完了を含む日次17件（3.93s）が成功し、重複を除く関連56件を確認済みです。lint349file・型・契約/設定検査・Web build・Worker dry-runも成功しました。

専用service bindingの実D1/DO/R2ドリルは67table・SQL9,582bytesで成功し、dailyを含む5操作の権限・環境・無効化による拒否を確認しました。実CLIのdaily→同日再検証→明示run再送→receipt→download→restore-offlineもSQL9,079bytesで成功しました。

schema0039・通常67tableと依存は変更していません。日次計画はControlDO内の1行です。コマンドは1回ごとに終了し、schedulerの設置や実環境での自動運転はまだ行っていません。35日保護は元BLOBSの削除猶予であり、独立した複製ではありません。詳細は[BACKUP_OPERATOR](BACKUP_OPERATOR.md)。

次は最大35日・最少5世代の保持判定と不足通知を進めます。定時起動の設置、Time Travel・live復旧・新epochと全監査、全storage喪失からの運用復旧、旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。remote migration・deployは未実施です。
