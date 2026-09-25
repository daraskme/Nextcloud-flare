# バックアップ書込み停止

更新: 2026-09-25。内部ControlDO RPCとD1 barrierをローカル実装。[世代生成・R2保存・オフライン復元](BACKUP_GENERATIONS.md)と[完了記録](BACKUP_COMPLETION.md)を追加。認証付き運用呼出し・live restore・remote配備は後続。

バックアップ専用の書込み停止をControlDOへ接続しました。通常操作・内部復旧・KDFの新規受付を止め、通常67テーブルを凍結して、同じバックアップ要求だけで解除します。

migration0037と永続request/tokenで、開始・凍結・解除をD1 mirrorへ束縛します。open permit・claimed operation・共通受付を閉じ、active job leaseがなくなってから確定順のwatermarkを保存します。応答とprimary照合の両方を失っても停止intentを保持し、eviction後に再照合できます。解除は元の受付・管理者GC設定を原子的に復元し、保留uploadの容量を維持します。exportの完了やmanifestの公開を推測で成功扱いにはしません。

## 開始と凍結

beginBackup(epoch, UUID)は安定したopen/closedの受付・管理者GC設定をSQLiteへ保存し、preparing intentを外部I/Oより先に永続化する。進行中の復旧task・restore用GC hold・他のbackupがあれば拒否する。D1では元のepoch/revision/tokenとpolicyを照合し、専用token・maintenance/GC pause・backup_runsを保存してpermit/claim/共通枠を閉じる。準備中も新しいsystem/global grantを拒否する。

active job leaseがなくなってから、確定済み操作のwatermarkをbackup_runsとcontrol.backup_barrier_opへ保存し、backup_frozenを立てる。0037以後はcommittedへの遷移と同じtransactionでcontrol.backup_last_opを更新するため、同じ秒の確定も順序を維持する。適用前の履歴はupdated_at/op_id順で初期化し、元の同時刻内の順序を証明したとは扱わない。

凍結中は通常67tableへのINSERT/UPDATE/DELETEを拒否する。controlの削除・置換・epoch変更・watermark改変も拒否する。SELECTは可能。新しいtableやcontrol列を追加するmigrationではguard対象も拡張する。FTSはexport対象ではなく、restoreで再構築する。

## 応答喪失と解除

開始・凍結・解除のDB-only batchは自分のrequest/token/epoch/revision/状態をprimaryから照合する。照合も失えば永続intentを維持し、同じIDの再送で収束する。別backup・別token・遅延batchは状態を上書きできない。期限による自動解除はしない。

releaseBackupは凍結確認済みの要求だけを解除する。flagだけのthaw、元の受付/GC policyの復元、released_at保存を同じD1 batchで確定する。途中失敗なら全体がrollbackし、凍結を維持する。元がclosedなら再開せず、元がopenなら保留uploadを消費・解放せず復帰する。通常の復旧完了条件でpending uploadの24h満了を待たせる方式ではない。cancelBackupは準備中または凍結中の同じ要求をfailedとして解除できる。

開始の返却がfrozenのときだけexportできる。過去のIDのreleased応答は新しいsnapshot許可ではない。全tableに共通のsnapshot開始点が実証されるまでは全抽出期間barrierを保持する。release単独はexport完了やmanifest公開の証明ではなく、backup_runsはexportingのまま残る。[completeBackup](BACKUP_COMPLETION.md)は信頼されたSQL検証者のmanifest hashを固定してR2実体を検証し、completedへの更新と解除を同時に確定する。

ControlDOの通常evictionではSQLite intentから続行する。全storage喪失時はD1のbackup tokenを確認してrecoverを拒否し、R2へのepoch公開も実行しない。元のpolicyを推測して再開しない。全喪失からの運用復旧、およびlogical restoreされた凍結行の検証付き解除は後続。quiesce・復旧・epoch更新・GC設定変更はactive backup中に明示的に拒否する。

## 検証と後続

Node5件・workerd21件を追加。全体checkが成功し、Node432件（27file、7.90s）・workerd1,991件（94file、1,075.05s）、計2,423件を検証しました。旧schemaの移行、全通常tableのguard、同時刻の確定順序、ACK/primary喪失、遅延開始/解除、元のpolicy、総storage喪失、解除途中のrollbackを含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。実Wranglerのローカル67table data-only抽出と、隔離SQLiteへの同一schema復元・FK/容量一致・FTS再構築も成功しました。R2実体・運用経路・epoch更新を含む復旧試験とremote exportは未検証です。schema0037/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。

試験は実ControlDO/D1の開始・再照会・解除、全table snapshot一致、通常/system/global/KDF受付、既存permit/claim、pending予約、GC policy、job lease、ACK喪失、primary照合不能、eviction、総storage喪失、遅延batch、原子的rollbackを扱う。

別途、Wrangler 4.131.1の隔離local DBに37 migrationとfixtureを適用し、凍結中に`d1 export --local --no-schema --table <通常67table>`を実行した。FTSを持つDBから通常tableだけを抽出でき、全通常行は抽出前後で一致した。exportは`--persist-to`非対応のため、すべてのコマンドが専用config配下の既定stateを使う。復元先は別のNode SQLiteで、同じversionのschema/indexを用意し、その隔離先だけで356 triggerを一時除去、seed行の削除・data import・同一triggerの再作成を同一transactionで実行した。全67table・schema・FK・容量が一致し、FTS再構築後の検索と凍結guardも検証した。稼働DBのtriggerを外す運用ではない。この試験はR2実体・操作の由来の全監査・epoch更新・運用RPC・manifest公開を含まず、製品のrestore完了条件を満たしたとは扱わない。

logical export・checksum/manifest公開・FTSを含むrestore drill、backup停止中のControlDO全喪失からの運用復旧、旧DAV保留の証明付き回収、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。
