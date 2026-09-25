# 復旧元logical世代の照合

更新: 2026-09-25。[復旧準備](DATABASE_RESTORE.md)で固定したlogical世代を、現在のD1完了記録とR2 publicationへ照合する。これはSQL内容の再検証やD1上書き許可ではない。

## 確認する内容

現在のControlDOが同じ復旧要求を準備中で、受付がclosedであることを各外部I/Oの前後に確認する。D1側も同じepoch/revision/token、maintenance/GC pause、backup解除を要求する。

選択したid・保存時epoch・manifest hashに一致する`backup_runs.state='completed'`だけを受け付ける。作成・完了・解除時刻、manifest key、barrier token、watermarkを検査する。R2のmanifest本体をSHA-256で照合し、その世代情報が完了記録の全項目と一致することを確認する。

世代の年齢はD1完了記録とmanifestで一致する**作成時刻**を基準にし、ちょうど35日までは許可し、1msでも超えれば拒否する。未来の完了時刻、検証途中の期限超過、時刻逆行も拒否する。過去の成功を期限外まで延長しない。

1回につきmanifestと最大1つのSQL部品を読む。manifestは既存出版形式の上限16MiB、部品は最大8MiB。実部品の長さとSHA-256を確認してから、D1完了記録と停止mirrorを再確認する。各待機10秒・処理全体の開始基準25秒で、期限後の継続から次のI/Oや進捗更新へ進まない。

## 永続的な検証位置

DO SQLite `control_database_restore_source`に、復旧要求ID・epoch・hash・検証済み部品数・総部品数・世代情報・観測時刻・期限を保存する。クライアントからcursorを受け取らないため、部品を飛ばして完了扱いにできない。

ControlDOの内部RPC `verifyDatabaseRestoreSource(epoch, id)`は次の状態を返す。現在のepoch・singleton・保存済み要求・closed admissionを検査し、`ControlRestoreSource`へ接続する。

| state | 意味 |
|---|---|
| `verifying` | 今回の部品まで一致。次の同じ要求で続きを検証する |
| `parts_verified` | 保存された同じpublicationの全SQL部品を検証した。SQL/schema再検証・最終停止・上書きはまだ許可しない |

途中のR2欠落・破損、primary障害、ローカル保存失敗ではcursorを進めない。DO再起動後は同じ要求の次の部品から続ける。既に`parts_verified`でも、再照会時には完了記録・manifest・現在の停止状態・年齢を再確認する。過去に読んだSQL部品を毎回すべて再読する機能ではない。

同一instanceでの検証は1つに制限する。遅い別instanceの結果は、元のcursor・総数・世代情報・観測時刻・期限に対するCASで競合として拒否する。完了後の再照会ではcursorが変わらないため、時刻も比較して新しい観測結果を上書きしない。取消し中やrepairで停止revisionが変わった場合も進捗を保存しない。取消し履歴や検証済み部品を別の復旧要求に流用しない。

再起動後でも観測時刻が保存済みの時刻より古ければ拒否し、検証位置・観測時刻を巻き戻さない。保存直前にも期限を確認する。

## 範囲

この照合は、稼働中D1の信頼できる完了記録が残るlogical世代を対象にする。現在のD1が全喪失した場合、別account、独立して持ち込んだSQL、Time Travel bookmarkの検証には、それぞれ別の証言・対象DB確認が必要になる。

通常のbackup完了時と同じく、部品のhash一致だけからSQL/schema/FK/FTSが正しいと推定しない。隔離SQLiteへの全SQL復元検証を通した[専用運用CLIと証言の保存](DATABASE_RESTORE_OPERATOR.md)を接続した。D1/BLOBS/BACKUPSのbinding照合、R2/KDF/jobの全終了、新epoch予約、復元先採用、全監査と段階再開への接続は後続である。公開HTTP endpointや既存BackupOperatorへの復旧権限追加はない。

テストのpublication fixtureは転送検証専用で、SQL検証済みexportと呼ばない。検証位置の再開・遅い結果・取消し・期限をローカルDO/D1/R2で検証する。実Cloudflare restoreは実行していない。
