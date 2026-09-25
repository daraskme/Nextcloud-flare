# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

前回の明示回収`c9a7ecd`は[CI36109311905](https://github.com/daraskme/Nextcloud-flare/actions/runs/36109311905)の全5ジョブ（Ubuntu、Windows両分割、backup、browser）が成功しました。

「pnpm backup sweep」と「maintain --prune-expired」を追加しました。ControlDOがround・開始時刻・最大ID・走査cursorを永続化し、期限切れcompleted世代を少量ずつ回収します。100 stepで未完了なら次回へ継続し、破損世代は残して警告を保存しながら後続へ進みます。未知の通信失敗は同じ候補から再照合します。D1 receipt・元BLOBS・ローカル世代は維持します。

maintainは日次取得・不足/鮮度補充と最終healthが正常な場合だけ、明示optionによる回収を実行します。Linux service例にも接続しましたが、hostへの設置・起動は行っていません。検査済みのhealthと回収結果cleanupを分け、回収未完了・破損保留は終了コード2で通知できます。1 RPCは100行・1世代・最大20部品、D1走査待ちを含む固定25秒の開始期限とR2要求ごとの10秒待機上限を維持します。詳細は[BACKUP_SWEEP](BACKUP_SWEEP.md)。

Node22件・workerd13件を追加しました。全Node696件（40file、44.23s）、新しい走査13件と既存prune26件の計39件（19.40s）が成功しています。専用bindingドリルは67table・SQL11,322bytes、全9操作の権限拒否、5世代の実取得と期限切れ回収、破損警告とhealthの分離を確認しました。型検査とsystemd構文検査も成功。実CLIドリルもSQL9,079bytesで成功し、4世代補充と最終5世代の検証、自動回収・再送・receipt保持を確認しました。全checkが成功し、Node696件・workerd2,100件（100file、1,245.15s）、計2,796件を確認しました。lint365file・型・契約/設定検査・Web build・Worker dry-runも成功。実CLIの4世代補充を追加したためbackup CI上限を30分へ延長しました。実行記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。schema0039・通常67table・依存は維持しています。

次は運用通知への接続と復旧手順の整備です。timerの実設置・外部通知、破損・未完了世代の回収、Time Travel・live復旧・新epochと全監査、D1/全storage喪失後の信頼できる世代選択、旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。remote migration・deployは未実施です。
