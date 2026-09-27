# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[復元後の監査と段階再開](DATABASE_RESTORE_RECOVERY.md)をprivate operator・CLIへ接続しました。FTS再構築と同じtokenの全監査を完了し、D1最終fence・DO未終了処理・予約履歴を再確認して復旧holdを解除します。受付とGCは別操作で順に再開し、後の停止やGC pauseを古い復旧要求が上書きしないよう、解除と再開の証拠を保存します。

schema0046・通常68table・依存追加なし。新規Node22/workerd10ケースを含むCLI関連110件・workerd関連144件が成功しました。全25復旧操作の権限拒否と、実R2ファイル・12ページの全監査から受付/GCの段階再開までのprivate binding通し試験、型・lint453file・契約/設定・Web build・Worker dry-runも成功。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次は復元後に残る未終了処理を、実終了の証拠に従って収束させる修復経路の整備です。未知のKDF/R2やmultipart、旧backup記録を成功扱いにして監査を通しません。旧実装/全storage喪失時の外部I/O終了証明、安全な中止、logical import、大規模DBの再開/RTOも残ります。通知先・timer設置、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。1e2207fの[CI36334806558](https://github.com/daraskme/Nextcloud-flare/actions/runs/36334806558)は全5job成功。直前422bea3の[CI36336294169](https://github.com/daraskme/Nextcloud-flare/actions/runs/36336294169)は記録時点でUbuntu・Windows分割1・browser成功、Windows分割2・backup実行中。今回のpush/CIはgit statusとgh run listで確認します。
