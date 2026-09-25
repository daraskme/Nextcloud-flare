# 開発進捗

更新: 2026-09-25

## 確定した到達点

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。

運用コマンドのcommit `21cc605`とWindows試験期限の修正`bc33e7c`をmainへプッシュ済みです。運用コマンドのローカル全体checkはNode552＋workerd2,009の計2,561件とビルドが成功。21cc605のWindows CIで9MiBのSQL検証試験1件が既定5秒を超過したため、この試験だけ上限20秒へ修正しました。修正後の[CI36080273377](https://github.com/daraskme/Nextcloud-flare/actions/runs/36080273377)はWindows2分割・Ubuntu・backup・browserの全5ジョブが成功しています。今回のGC保護はこのCIに含みません。

## 今回の変更

バックアップの最大年齢35日に合わせ、元ファイルのGC猶予を35日以上へ統一しました。purge・upload cleanup・失敗DAV PUTを対象に、再利用した候補も最後のnode/version参照が外れたtransactionで期限を延ばします。

migration0039は既存candidateも移行時刻から保護し、既にdeleting/deletedの対象は変更しません。GC受付待機中の再参照競合では、最新期限を再照合してR2削除を止めます。WebDAV空ファイルの競合再送で作成済みobjectが削除される不具合を実D1/R2/DOで再現し、直接削除を除去しました。通常tableは67のままです。

Node565件（34file、18.55s）が成功しました。workerd全体は2,013件中2,012件が成功し、失敗した1件は旧仕様の即時削除を期待するDAV試験でした。35日以内の削除拒否・容量保持と期間経過後の回収へ更新し、そのfileの17件（7.06s）が成功。再実行を含めworkerd全2,013件を確認しています。lint345file・型・契約/設定検査、Web build・Worker dry-runも成功しました。schema0039の実D1試験5件と、従来CLI（67table・SQL9,599bytes）、専用binding（9,613bytes）、実CLI run→receipt→download→restore-offline（9,110bytes）の3ドリルも成功しました。この変更のCIはプッシュ後に確認します。

35日保護は元BLOBS bucket内の削除猶予です。移行前に削除済みのobjectを復元せず、bucket/account喪失への別保管も提供しません。remote認証・権限・実resourceへの適用は未実施です。日次実行・世代保持管理、旧schema/全形式、Time Travel・live復旧・全storage喪失からの運用復旧は未完了です。

詳細は[BACKUP_GC_PROTECTION](BACKUP_GC_PROTECTION.md)、[BACKUP_OPERATOR](BACKUP_OPERATOR.md)、[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

## 後続の主要項目

次は過去schema世代の検証互換性と、未知tableの抽出漏れを防ぐ照合を統合・実D1検証します。その後に全データ形式、日次実行・最大35日/最少5世代の保持管理を進めます。Time Travel・新epoch・全復旧監査、旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。remote migration・deployは未実施です。
