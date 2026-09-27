# 開発進捗

更新: 2026-09-27

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

単一upload・WebDAV PUTとmultipartの作成/part/完了/全中止経路を、送信・終了の永続記録へ接続しました。元のattemptの二重送信を防ぎ、grant待機後に現行認可と元の転送/cleanup証明を再検査します。送信開始の5秒期限と本文転送の最大15分leaseを分け、応答不明の間は予約解放・cleanup完了・対象GC・復旧凍結を保留します。空ファイル・manifest・GCを合わせて11種類が対象です。詳細は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)。

schema0043・通常68table・依存追加なし。Node983件とbrowser19件が成功。全workerdは2,378件中2,324件が成功し、失敗54件は修正後の関連355件と復旧監査11件の再実行ですべて成功しました。再実行を含めローカル計3,380件を検証。初回の全統合実行自体の終了コードは1です。最終lint415file・型・契約/設定検査・Web build・Worker dry-runとprivate binding運用ドリルも成功。失敗原因・再実行・CIの記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はbinding probe・BACKUPS保存・epoch履歴を含めた外部I/O全終了の証明、新epoch予約、実D1上書き後の採用・全監査・段階再開です。記録済み11種類にもnative結果不明を解消する運用証明は残ります。現在の凍結だけでD1上書きは開始できません。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前43597a6の[CI36317210449](https://github.com/daraskme/Nextcloud-flare/actions/runs/36317210449)はWindows2分割・backup・browserが成功し、Ubuntu全checkは15分のjob枠で打ち切られました。今回Ubuntuのjob枠も30分に変更し、アプリの期限は維持します。今回のpush/CIはgit statusとgh run listで確認します。
