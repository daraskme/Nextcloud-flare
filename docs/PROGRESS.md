# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[復元後のmultipart inventory](DATABASE_RESTORE_INVENTORY.md)をprivate operatorとCLIへ接続しました。`inventory-restored`から接続照合、upload単位修復、bucket走査、部品観測、中止試行を明示的に実行します。採用済みのbucketと同じ停止状態へ固定し、毎回fresh probeで照合します。同じattemptのabortは再送せず、空一覧や個別中止成功から全体閉鎖と容量解放を推測しません。

schema0046・通常68table・依存追加なし。今回の関連テストはNode191件と、再実行を含むworkerd10file/221件で計412件成功（新規83件）。運用ドリルも28復旧methodの権限拒否、multipart操作、全監査と受付/GC再開を確認しました。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次は未知multipartの全体閉鎖証明と予約/physicalの最終精算、旧backup記録の修復を進める工程です。inventoryの調査・中止コマンドを接続しても、scan/handleのholdを解除するだけで完了にはしません。元abortのD1記録がないsnapshot、導入前の削除済み証拠、全DO storage喪失などのunknownは引き続き保持します。安全な中止、logical import、大規模DBの再開/RTO、終了履歴の実容量/負荷測定も残ります。通知先・timer設置、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前d50c58bの[CI36345681064](https://github.com/daraskme/Nextcloud-flare/actions/runs/36345681064)は確認時点でUbuntu・Windows3分割・browserの5job成功、backupは実行中。先行7024160の[CI36344576265](https://github.com/daraskme/Nextcloud-flare/actions/runs/36344576265)と981ae36の[CI36342685456](https://github.com/daraskme/Nextcloud-flare/actions/runs/36342685456)は全6job成功。今回のpush/CIはgit statusとgh run listで確認します。
