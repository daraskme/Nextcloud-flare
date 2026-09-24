# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit a9b8af2はmainへプッシュ済み。[CI36064368977](https://github.com/daraskme/Nextcloud-flare/actions/runs/36064368977)は全4ジョブ成功。Ubuntu6m46s、Windows 1/2は16m1s（46file/1,057件）、2/2は12m19s（45file/888件）、browser2m6sです。Node424・workerd1,945・browser19、重複を除く計2,388件を確認しました。Windows分割後も全件とbuild/dry-runを通過し、前回の30分上限中断を解消しました。今回の転送と公開の分離はこのCIには含まれません。

## 今回の変更

WebDAV PUTは本文保存後に公開用の30秒permitを取得する方式へ変更しました。31秒を超える実転送でも公開でき、本文受信中にnamespace permitや共通更新枠を保持しません。

migration0036で、開始時のupload/reservationを操作ID未結合のまま保持できます。実ownerのdav.put-start受付で現在の認可・lock・予約・不変attemptを一括確定し、直接ACK後だけ条件付きPUTを送ります。保存事実を記録した後に新しい短期permitを取得し、元のrevision/parent/tree/blob/credential/lockを検査して、operationへの結合とcreate10/overwrite8 stepの公開を原子的に行います。HTTPで解決した対象revisionも渡します。再送・ACK喪失・停止で本文を再送せず、未知結果の容量を保持します。

Node3件・workerd25件を追加。全体checkが成功し、Node427件（26file、6.34s）・workerd1,970件（93file、1,051.32s）、計2,397件を検証しました。31秒転送、元の認可・revision・lock維持、実ControlDOの共有枠・停止・eviction、未結合台帳の回収競合、前方移行を含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。schema0036/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[DAV_UPLOAD](DAV_UPLOAD.md)。

## 後続の主要項目

旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
