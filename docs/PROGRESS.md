# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

外部CLIのBACKUPS保存を[送信受付・終了記録](BACKUP_PUBLICATION_WRITES.md)へ接続しました。publish/run/daily/maintainはpart/manifestごとにgrantを取得し、S3またはlocal bindingの実応答だけから終了を記録します。保存前後に未終了試行を照会するため、全objectが既存でもunknownを回避できません。timeout後の実応答は終了記録だけへ反映し、古い保存処理は再開しません。単独publishにもoperator設定が必要です。既存14種類の共通R2記録は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)。

schema0046・通常68table・依存追加なし。Node全1,023件と関連workerd83件、型・lint428file・契約/設定・Web build・Worker dry-run、private binding運用ドリルが成功。単独publishとdaily/run/maintainの実CLIドリルも成功しました。今回の全体CIはpush後に確認します。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はepoch履歴とnative結果不明の運用証明を含めた外部I/O全終了の確認、新epoch予約、実D1上書き後の採用・全監査・段階再開です。現在の凍結だけでD1上書きは開始できません。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。先行3f2217bの[CI36327086181](https://github.com/daraskme/Nextcloud-flare/actions/runs/36327086181)はUbuntu・Windows2分割・backup・browserの全5job成功。世代削除0dbb5a5は4job成功・Windows分割1の移行fixture失敗で終了し、fixtureは3f2217bで修正済み。8a093f7とfa8f105は全5job成功済み。今回のpush/CIはgit statusとgh run listで確認します。
