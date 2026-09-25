# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

日次バックアップは`221952f`までmainへプッシュ済みです。[CI36084559502](https://github.com/daraskme/Nextcloud-flare/actions/runs/36084559502)はUbuntu・Windows 2/2・backup・browserが成功し、Windows 1/2は確認中です。今回の保持判定もローカル検証が完了しました。今回のCIはプッシュ後に確認します。

「pnpm backup health」を追加しました。D1の完了記録とR2の全データ・SQLを照合し、35日以内の有効世代が5個以上、最新取得が24時間以内であるかを判定します。取得時刻を基準にし、5世代不足でも期限切れを数えません。検証後のサーバー時刻で再判定し、途中でepochやバックアップ状態が変わった検査は無効にします。

結果は世代別状態・不足数・エラーコードを含むJSONです。正常は終了コード0、不足・破損・検査未完了は2、判定不能は1を返します。監視に渡せる形式まで実装し、外部への通知送信は行っていません。一覧は100行ずつ読み、全体10,000行・データ検証100世代の上限を超えた場合も正常とは報告しません。

Node27件・workerd23件を追加しました。全Node644件（37file、34.40s）と、バックアップ関連workerd79件（4file、43.54s）が成功。実際に保存した5世代の全SQL検証と、1世代の破損によって有効数が4へ減ることを確認しました。35日の前後1ms、24時間、検査中の期限超過、同時開始、eviction、205行のページング、破損/不正receipt、検査上限と秘密情報の非出力を含みます。lint354file・型・契約/設定検査・Web build・Worker dry-runも成功しました。

専用bindingの実D1/DO/R2ドリルは67table・SQL9,582bytesで成功し、inventoryを含む6操作の権限・環境・無効化による拒否を確認しました。実CLIのdaily→再実行→receipt→health→download→restore-offlineもSQL9,079bytesで成功しました。healthは保存済み1世代を検証し、不足4世代と終了コード2を返し、元の停止状態を変更しませんでした。

schema0039・通常67tableと依存は変更していません。healthは読取り専用で、現在のD1が利用可能な場合の論理世代の検査です。source BLOBSの実在性・独立複製やlive復元の証明ではありません。運用方法と制限は[BACKUP_RETENTION](BACKUP_RETENTION.md)。

次は定時実行・外部通知の接続、5世代の自動補充、期限切れR2 objectの回収を進めます。Time Travel・live復旧・新epochと全監査、D1/全storage喪失後の信頼できる世代選択と運用復旧、旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。remote migration・deployは未実施です。
