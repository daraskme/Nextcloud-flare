# 開発進捗

更新: 2026-09-27

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

BLOBS/S3接続検証の条件付きPUTも、送信・終了の永続記録へ接続しました。元のlease token・nonce・source・期待ETagをgrant batchで再検査し、復旧先照合では停止revision/tokenも固定します。新しいprobeの成功や60秒lease満了で、古い不明なPUTを終了扱いにしません。既存upload・multipart・空ファイル・manifest・GCを合わせて12種類が対象です。詳細は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)。

schema0044・通常68table・依存追加なし。全体checkが成功し、Node989件＋workerd2,392件を確認しました。その後に期限境界2件を追加し、最終のR2/probe/upload/GC/復旧の回帰260件も成功。追加2件を含め計3,383ケースを確認しました。最終lint418file・型・Web build・Worker dry-runとprivate binding運用ドリルも成功。検証範囲とCIの記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はBACKUPS側の接続probe・保存/削除・epoch履歴を含めた外部I/O全終了の証明、新epoch予約、実D1上書き後の採用・全監査・段階再開です。記録済み12種類にもnative結果不明を解消する運用証明は残ります。現在の凍結だけでD1上書きは開始できません。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前3ffbba0の[CI36320613487](https://github.com/daraskme/Nextcloud-flare/actions/runs/36320613487)はUbuntu・Windows2分割・backup・browserの全5jobが成功しました。今回のpush/CIはgit statusとgh run listで確認します。
