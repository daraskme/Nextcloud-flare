# バックアップの完了記録

更新: 2026-09-25。`ControlDO.completeBackup(epoch, id, manifestSha256)`は、凍結中の世代に対応するR2 manifestと全partを検証し、D1の完了記録と書込み停止の解除を同じbatchで確定する内部RPCである。認証付き運用コマンド・日次実行・保持管理・live復旧は後続。

## 呼出し元と信頼境界

呼出し元は[論理バックアップ生成・検証](BACKUP_GENERATIONS.md)を完了した、信頼された運用実行者に限定する。引数のhashは元DBとSQLの全行・schema・FK・FTS検証を通したtransport manifestのSHA-256を表す。利用者が指定したhashを転送する公開APIではない。一般のservice principalへbackup/repair権限を拡張しない。

ControlDOは実際の`BACKUPS` bindingからそのhashのmanifestとpartを読むため、CLIが誤ったbucketにだけ保存した場合は完了できない。ただしmanifest hash自体は電子署名ではなく、呼出し元によるSQL検証の証言である。ControlDOはSQLを再importせず、論理manifest内の全行hash・schema hash・SQL全体hashの意味検証は運用実行者の検証結果を信頼する。内部RPCを未認証HTTPとして公開してはならない。

保存対象はD1の論理SQL。元の`BLOBS` object本体の保護、旧versionの変換、新epochでのlive restore、共有・credential・会計等の全復旧監査を完了したことにはならない。

## R2照合と中断後の継続

1. epoch、世代ID、凍結状態とD1のtoken/revision/未解除のexporting行を照合する。
2. 世代とmanifest hashをControlDO SQLiteへ固定する。最初の失敗後も別hashへの切替を拒否する。誤ったhashで開始した場合は、完了確定前なら明示的にcancelし、新しい世代を作る。
3. manifestを最大16MiBで読み、その実SHA-256と共有parserで形式を検証する。generationのID/epoch/token/createdAt/watermark、通常全tableの集合を現行凍結と照合する。
4. 1回のRPCで最大1part・8MiBを読み、実byte数/SHA-256を検査する。R2要求ごとに本文を含む10秒期限を持ち、遅延応答は完了証明に使わない。同じControlDOインスタンスで同時に複数の検証を走らせず、重複要求にはbusyを返す。
5. もう一度D1の凍結を確認してから、同じ世代/hash/cursorの条件でSQLiteのcursorを進める。未完了なら`state: verifying`と`partsVerified/partsTotal`を返す。同じ引数で続行する。evictionでcursorやhashを失わない。
6. 最後のpartを検証したら、後述の完了処理へ進む。遅延したR2/DB応答、cancel後や次世代開始後の要求は現在のtoken・phaseと一致しなければ反映しない。

同じ生成物の再送はR2を書き換えない。既存partの破損や削除を修復した場合も、同じhashとcursorから検証を再開する。R2の外部管理者による削除・置換を将来にわたって禁止するObject Lock保証ではない。

## 完了と停止解除の原子性

全part検証後に`completing` intentをSQLiteへ保存する。D1ではflagのみのthaw、元の受付/管理者GC設定の復元、`released_at`、`state=completed`、manifest key/hash、`completed_at`を同一batchで確定する。途中の失敗なら全体がrollbackし、凍結を維持する。元がclosedならclosedへ、openならopenへ戻し、保留uploadの予約は解放しない。

commitの応答を失った場合は、epoch/token/revision・復元先policy・世代・manifest key/hash・完了時刻の存在をprimaryから照合する。照合も失えばintentを保持する。同じcomplete要求を再送すると、eviction後も確定済み結果を回収できる。`completing`中の通常release/cancelは拒否し、完了処理だけで収束させる。通信期限を理由に自動thawしない。

migration `0038_backup_completion.sql`は完成済み行の必須receipt形状と、completed/failedのmanifest key/hash/完了時刻の変更禁止を追加する。0037の世代identity、状態遷移と凍結guardを維持する。新しい通常tableは増えない。

`releaseBackup`単独は従来どおり`exporting`を残す。明示的に未検証解除した世代を後からcompleteへ昇格させない。完了済み要求の再照会は現在の保存済み世代だけが対象で、新しい世代開始後の古いcomplete要求は拒否する。履歴照会用の運用APIは別途接続する。

## 検証範囲

実ControlDO/D1/R2で、単一part・8MiB超の複数part、eviction、closed/open policy、予約保持、R2欠落/改変/世代不一致、同時検証、途中rollback、commit/primary両応答喪失、遅延R2/DB要求と次世代の競合を検査する。形式・本文上限・期限・schema移行とterminal receiptの不変性も試験する。最新の実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

RPC試験のSQL payloadはtransport用fixtureであり、運用のSQL検証を省略できる証拠ではない。実SQLのsource fingerprint→抽出→隔離検証→R2保存→取得→復元は別の`backup:drill`で検証する。両者を認証付き運用経路でつなぐ一連のドリル、remote環境、全storage喪失からの運用復旧は未完了。
