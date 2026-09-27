# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[復元後のKDF/R2終了記録の修復](DATABASE_RESTORE_NATIVE.md)を拡張しました。36日保持の履歴照合に加え、D1精算や履歴保存の障害でDO内に残った終了記録も、同じ復旧要求のコマンドから精算できます。D1の走査が完了してもDO/D1に保留が残ればCLIは終了code 2を返します。処理途中の新しい停止を検知し、外部処理を再実行せず、FTS/全監査が終わるまで受付を閉じたままにします。

schema0046・通常68table・依存追加なし。今回の関連テストはNode52件＋workerd105件＝157件成功（新規22件）。型・lint457file・契約/設定・Web build・Worker dry-runも成功しました。前回daa143eの全体checkは3,706件成功。今回の検証範囲とprivate binding試験の結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はupload/multipart・予約・outbox・旧backup記録など、復元後に残る各領域の修復を要求単位のoperatorへ接続する工程です。今回の履歴は導入前の削除済み証拠や全storage喪失を補えず、unknownは保持します。安全な中止、logical import、大規模DBの再開/RTO、終了履歴の実容量/負荷測定も残ります。通知先・timer設置、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前daa143eの[CI36341055303](https://github.com/daraskme/Nextcloud-flare/actions/runs/36341055303)は確認時点でUbuntu・Windows3分割・browserの5job成功、backupは実行中。a57175cのWindows分割1が30分上限で取消されたため、daa143eから3分割へ変更し、3分割すべての成功を確認しました。今回のpush/CIはgit statusとgh run listで確認します。
