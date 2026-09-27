# 開発進捗

更新: 2026-09-27

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

空ファイルPUTと配信manifestの保存・削除に、送信前からの永続記録を追加しました。ControlDOとD1の正確な試行記録を使い、応答不明や再起動で保留を消さず、凍結確定・受付再開・対象GCを拒否します。未公開manifestは停止中も証明付きで回収でき、公開済みmanifestの削除は拒否します。詳細は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)。

schema0041・通常68table・依存追加なし。全体checkが成功し、Node965件＋workerd2,346件の計3,311件、lint410file・型・契約/設定検査・Web build・Worker dry-runを確認しました。68tableのprivate binding運用ドリルも成功しました。実行記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

次は既存upload/GC/multipart・binding probe・BACKUPS保存・epoch履歴も含めた外部I/O全終了の証明、新epoch予約、実D1上書き後の採用・全監査・段階再開です。今回の3操作にもnative結果不明を解消する運用証明は残ります。現在の凍結だけでD1上書きは開始できません。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前45167e7の[CI36311386230](https://github.com/daraskme/Nextcloud-flare/actions/runs/36311386230)はUbuntu・Windows両分割・backup・browserの全5ジョブが成功しました。今回のpush/CIはgit statusとgh run listで確認します。
