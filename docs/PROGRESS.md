# 開発進捗

更新: 2026-09-27

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

期限切れBACKUPS世代の部品・manifest削除も、送信・終了の永続記録へ接続しました。完成receipt・hash・35日保持期限・元の停止状態と削除対象keyを再検査し、最大20部品を一つのnative DELETEとして記録します。応答喪失では同じ世代の追加削除・凍結・再開を保留し、一覧の不在でunknownを解消しません。BLOBS/BACKUPS probe・upload・multipart・manifest・GCを合わせて14種類が対象です。詳細は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)。

schema0046・通常68table・依存追加なし。Node全1,001件と関連workerd215件、型・lint422file・契約/設定・Web build・Worker dry-runとprivate binding運用ドリルが成功。全体checkは直前のschema0045で3,402件成功済みで、今回の全体CIはpush後に確認します。検証範囲とCIの記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はBACKUPSの外部CLI保存・epoch履歴を含めた外部I/O全終了の証明、新epoch予約、実D1上書き後の採用・全監査・段階再開です。記録済み14種類にもnative結果不明を解消する運用証明は残ります。現在の凍結だけでD1上書きは開始できません。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前8a093f7の[CI36325641559](https://github.com/daraskme/Nextcloud-flare/actions/runs/36325641559)は実行中です。先行fa8f105のCIは全5job成功済みです。今回のpush/CIはgit statusとgh run listで確認します。
