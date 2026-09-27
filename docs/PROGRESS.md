# 開発進捗

更新: 2026-09-27

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

外部CLIのBACKUPS保存に向け、ControlDOとprivate bindingへ[送信受付・終了記録](BACKUP_PUBLICATION_WRITES.md)を追加しました。凍結世代の全tuple・key/hash/bytesを照合して送信前にpendingを保存し、未終了の間は完了・取消し・解除を拒否します。D1全68tableの凍結を維持し、DO eviction・応答喪失・正確なobject読戻しでもpendingを解消しません。CLI実PUTとの接続は次の工程です。既存14種類のR2記録は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)。

schema0046・通常68table・依存追加なし。保存受付の新規18件を含むworkerd57件、CLI接続42件、移行fixture15件、型・lint425file・契約/設定・Web build・Worker dry-runとprivate binding運用ドリルが成功。世代削除の先行CIではWindowsのNode1件が失敗し、該当fixtureの秒境界依存を修正しました。今回の全体CIはpush後に確認します。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はBACKUPSの外部CLI保存・epoch履歴を含めた外部I/O全終了の証明、新epoch予約、実D1上書き後の採用・全監査・段階再開です。記録済み14種類にもnative結果不明を解消する運用証明は残ります。現在の凍結だけでD1上書きは開始できません。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。世代削除は0dbb5a5としてpush済み。[CI36326186367](https://github.com/daraskme/Nextcloud-flare/actions/runs/36326186367)のWindows分割1はNode 1,000/1,001件成功・1件失敗で、integrationは未実行です。先行8a093f7はUbuntu・Windows2分割・browserが成功しbackupが実行中、fa8f105は全5job成功済み。今回のpush/CIはgit statusとgh run listで確認します。
