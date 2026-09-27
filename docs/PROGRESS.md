# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[復元後の修復コマンド](DATABASE_RESTORE_DOMAINS.md)へblob GC・orphan GC・孤立オブジェクト走査を追加しました。`repair-restored`は7種類に対応し、同じ復旧要求と停止状態で1回最大20件を処理します。GCは削除開始済みだけを扱い、pin・35日猶予・native保留を維持します。走査はHEADで確認した容量を計上し、ページcursorを保存します。処理中に停止が変わった場合は古い処理を中断し、実際の遅延DELETE終了は記録します。

schema0046・通常68table・依存追加なし。今回の関連テストはNode131件、再実行を含むworkerd7file/166件で計297件成功（新規40件）。型・lint464file・契約/設定・Web build・Worker dry-runと7種類の修復を通すprivate bindingドリルも成功しました。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はmultipart inventory・全bucketの未知handle・旧backup記録の修復を、同じ復旧要求へ固定した運用経路へ接続する工程です。元abortのD1記録がないsnapshot、導入前の削除済み証拠、全DO storage喪失などのunknownは引き続き保持します。安全な中止、logical import、大規模DBの再開/RTO、終了履歴の実容量/負荷測定も残ります。通知先・timer設置、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前7024160の[CI36344576265](https://github.com/daraskme/Nextcloud-flare/actions/runs/36344576265)は確認時点でUbuntu・Windows分割2/3と3/3・browserが成功し、Windows分割1/3とbackupは実行中。先行981ae36の[CI36342685456](https://github.com/daraskme/Nextcloud-flare/actions/runs/36342685456)とdaa143eの[CI36341055303](https://github.com/daraskme/Nextcloud-flare/actions/runs/36341055303)は全6job成功。今回のpush/CIはgit statusとgh run listで確認します。
