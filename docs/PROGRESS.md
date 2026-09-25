# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

前回の世代補充`7a1378e`は[CI36087130182](https://github.com/daraskme/Nextcloud-flare/actions/runs/36087130182)の全5ジョブ（Ubuntu、Windows両分割、backup、browser）が成功しました。

「pnpm backup prune」を追加しました。指定したcompleted世代について、サーバーの開始時刻から35日を厳密に超えること、D1の不変receiptとR2 manifestの実hash・世代情報が一致することを確認し、1回最大20部品を回収します。manifestは他のobjectがなくなってから最後に削除し、prefixの不在まで確認します。D1 receipt・元BLOBS・ローカル世代は維持します。

削除前にepoch・バックアップ停止状態・receiptを再確認し、同じControlDO instanceでは同時1件、外部要求は各10秒・開始から固定25秒の期限で制限します。進捗はR2に残るkeyから再取得するため、応答喪失・eviction後も同じUUIDから再開できます。manifest欠落時に部品が残る場合や未知key、未完了/失敗世代は推測で回収しません。CLIは最大100 RPC、完了0・継続必要2・失敗1を返します。旧epochの世代でも、引数は現在のControlDO epochを使います。

Node12件・workerd26件を追加しました。Node全674件（39file、30.53s）、回収26件と既存完了17件の計43件（12.79s）が成功しています。専用bindingドリルは67table・SQL11,322bytes、全8操作の権限拒否、期限切れfixtureの回収・eviction後再送、新しい世代の削除拒否も成功しました。実CLIドリルもSQL9,079bytesで成功し、pruneの新しい世代の拒否・期限切れfixture回収・再実行・receipt保持を確認しました。全checkが成功し、Node674件・workerd2,087件（99file、1,143.07s）、計2,761件を確認しました。型・契約/設定検査、Web build・Worker dry-run、最終lint361fileも成功。期限試験の時計設定を調整後、回収26件（6.29s）と型検査も再確認しました。実行記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。schema0039・通常67table・依存は維持しています。詳細は[BACKUP_PRUNING](BACKUP_PRUNING.md)。

次は期限切れ世代の自動走査・定期起動と外部通知の運用接続です。maintain/timerへの削除接続、破損・未完了世代の回収、Time Travel・live復旧・新epochと全監査、D1/全storage喪失後の信頼できる世代選択、旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。remote migration・deployは未実施です。
