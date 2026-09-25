# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

GC保護・過去世代対応は`2563731`までmainへプッシュ済みです。[CI36082097219](https://github.com/daraskme/Nextcloud-flare/actions/runs/36082097219)は確認中です。今回の値を保持する出力修正`3a6e46d`のCIはプッシュ後に確認します。

凍結済みD1から型情報付きで値を読み、順次SQLへ出力する方式へ変更しました。実改行とliteral backslashが混在するとdumpが値を変える問題と、WranglerのJSON表示がBLOBを文字列にする問題を解消します。NULを含むTEXTは限定したhex CASTで表し、SQLを実行せず値として読み戻します。既存の書込み停止・全table/schema・全行hash・FK・FTS検査を維持しています。

Node16件を追加し、統合後の全600件（36file、18.58s）が成功しました。schema0039の3ドリルも成功し、通常CLIは67table/SQL9,755bytes、専用bindingは9,582bytes、実CLI run→receipt→download→restore-offlineは9,079bytesでした。実D1でUnicode・引用符・CR/LF・literal backslash・NUL・BOM、BLOBと似たTEXT、NULL・小数の保持を確認しています。保存済み0037/0038/0039世代の実CLI検証も成功。lint348file・契約/設定検査も成功しました。

直前のGC保護では、全体workerd2,013件中2,012件が成功し、旧仕様の即時削除を期待していたDAV試験1件を35日の猶予へ更新後、対象17件（7.06s）が成功しました。再実行を含め全2,013件を確認済みです。その後Worker本体・migrationは変更していません。型検査・Web build・Worker dry-runもGC修正後に成功しています。

schema0039・通常67table。過去世代は0037以降の信頼済みmigration列だけを受け付けます。整数は安全に表現できる範囲に限定し、未知型や不正UTF-8を拒否します。remoteでの互換性、大規模DBの実行時間・費用は未検証です。35日の保護は元BLOBS bucket内の削除猶予で、別bucketへの複製や削除済みobjectの復元ではありません。

詳細は[BACKUP_EXPORT](BACKUP_EXPORT.md)、[BACKUP_HISTORY](BACKUP_HISTORY.md)、[BACKUP_GC_PROTECTION](BACKUP_GC_PROTECTION.md)。

次は日次実行と最大35日/最少5世代の保持・不足通知を進めます。Time Travel・live復旧・新epochと全監査、全storage喪失からの運用復旧、旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。remote migration・deployは未実施です。
