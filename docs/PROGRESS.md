# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[復元後のKDF/R2終了記録の修復](DATABASE_RESTORE_NATIVE.md)を実装しました。通常の精算後もDOへ終了証拠を36日間保持し、復元されたpending行と照合するprivate operator・CLIを追加しています。1ページ最大20行の進捗を保存し、未知行を保留しながら後続を修復します。修復後はFTS/全監査をやり直すまで受付を再開できません。

schema0046・通常68table・依存追加なし。新規Node13/workerd17ケースを含む全体checkはNode1,155件＋workerd2,551件＝3,706件成功。型・lint457file・契約/設定・Web build・Worker dry-runも成功しました。全26復旧操作の権限拒否と、空のnative修復走査から12ページ全監査・段階再開までのprivate binding通し試験も成功。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はupload/multipart・予約・outbox・旧backup記録など、復元後に残る各領域の修復を要求単位のoperatorへ接続する工程です。今回の履歴は導入前の削除済み証拠や全storage喪失を補えず、unknownは保持します。安全な中止、logical import、大規模DBの再開/RTO、終了履歴の実容量/負荷測定も残ります。通知先・timer設置、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。先行422bea3の[CI36336294169](https://github.com/daraskme/Nextcloud-flare/actions/runs/36336294169)は全5job成功。直前a57175cの[CI36337843692](https://github.com/daraskme/Nextcloud-flare/actions/runs/36337843692)はUbuntu・Windows分割2・backup・browser成功、Windows分割1は53file/1,268件成功後に30分のjob上限で取消し。今回からWindowsを3分割へ変更しています。今回のpush/CIはgit statusとgh run listで確認します。
