# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限、WebDAVの転送と公開の分離を実装しています。

直前commit 303d620はmainへプッシュ済み。[CI36067451016](https://github.com/daraskme/Nextcloud-flare/actions/runs/36067451016)は全4ジョブ成功。Ubuntu7m27s、Windows 1/2は13m4s（47file/1,068件）、2/2は10m35s（46file/902件）、browser4m17sです。Node427・workerd1,970・browser19、重複を除く計2,416件を確認しました。今回のバックアップ変更はこのCIには含まれません。

## 今回の変更

バックアップ専用の書込み停止をControlDOへ接続しました。通常操作・内部復旧・KDFの新規受付を止め、通常67テーブルを凍結して、同じバックアップ要求だけで解除します。

migration0037と永続request/tokenで、開始・凍結・解除をD1 mirrorへ束縛します。open permit・claimed operation・共通受付を閉じ、active job leaseがなくなってから確定順のwatermarkを保存します。応答とprimary照合の両方を失っても停止intentを保持し、eviction後に再照合できます。解除は元の受付・管理者GC設定を原子的に復元し、保留uploadの容量を維持します。exportの完了やmanifestの公開を推測で成功扱いにはしません。

Node5件・workerd21件を追加。全体checkが成功し、Node432件（27file、7.90s）・workerd1,991件（94file、1,075.05s）、計2,423件を検証しました。旧schemaの移行、全通常tableのguard、同時刻の確定順序、ACK/primary喪失、遅延開始/解除、元のpolicy、総storage喪失、解除途中のrollbackを含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。実Wranglerのローカル67table data-only抽出と、隔離SQLiteへの同一schema復元・FK/容量一致・FTS再構築も成功しました。R2実体・運用経路・epoch更新を含む復旧試験とremote exportは未検証です。schema0037/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[BACKUP_BARRIER](BACKUP_BARRIER.md)。

## 後続の主要項目

logical export・checksum/manifest公開・FTSを含むrestore drill、backup停止中のControlDO全喪失からの運用復旧、旧DAV保留の証明付き回収、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
