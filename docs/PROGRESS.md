# 開発進捗

更新: 2026-09-27

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

blob GCとorphan GCのDELETEを送信・終了の永続記録へ接続しました。削除の応答不明をHEAD不在やlease満了で解消せず、物理容量を保持して同keyの再回収・復元準備完了を拒否します。実際に終了した記録だけを反映し、通常・停止中・ゴミ箱復元中のclaimと期限を再検査します。空ファイルPUT・配信manifestと合わせて5操作が対象です。詳細は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)。

schema0042・通常68table・依存追加なし。Node972件＋workerd2,358件の計3,330件を再実行を含めて検証しました。全体実行で失敗したCron試験2件はfixture修正後に該当62件が成功。最終lint411file・型・契約/設定検査・Web build・Worker dry-runと、68tableのprivate binding運用ドリルも成功しました。実行記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

次は既存upload/multipart・binding probe・BACKUPS保存・epoch履歴も含めた外部I/O全終了の証明、新epoch予約、実D1上書き後の採用・全監査・段階再開です。記録済み5操作にもnative結果不明を解消する運用証明は残ります。現在の凍結だけでD1上書きは開始できません。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前a57fc8fの[CI36314574203](https://github.com/daraskme/Nextcloud-flare/actions/runs/36314574203)は、Windows分割1の再実行を含め全5ジョブが成功しました。初回multipart準備の失敗原因は未確定で、診断を追加しています。今回のpush/CIはgit statusとgh run listで確認します。
