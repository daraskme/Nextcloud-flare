# Migrations

Phase 1 用の forward migrations。`0001` は identity / namespace / ledger、
`0002` は content / media / search、`0003` は不変条件の trigger、
`0004` は機械生成した operation catalogue / FK index。
`0005` は reservation/参照 counter trigger と R2 実在会計行。非0の旧 physical counter は個別 inventory 移行が必要なため拒否する。
`0006` は permit identity と open 一意性。適用前に全 open permit を収束させる。
`0009` は content session を発行元 ticket に束縛する。旧 session 行の `ticket_id` は NULL のまま残り、content read assertion では拒否するため、短い TTL の満了後に cleanup する。
`0011` は DAV lock の取得時 display href を追加する。適用前に最大1時間の既存 lock を全て収束させる。
`0021` は未知の完成済みR2 objectの隔離台帳と走査cursor/lease。58通常tableのexport/purge契約に追加し、owner physical監査に隔離bytesを含める。同keyのcatalogue登録と隔離登録は相互guardで排他にし、削除後もkey tombstoneを保持する。
`0039` は既存GC候補を移行から35日以上保護し、最後のnode/version参照が外れた候補の期限も同じtransactionで延長する。既にdeleting/deletedの対象は変更しない。physical容量は猶予中も保持する。[バックアップ用GC保護](../../../docs/BACKUP_GC_PROTECTION.md)を参照。
schema contract generator は適用済み migration を再生成せず、今後の catalogue/index 変更も forward migration で追加する。

テストは `readD1Migrations` + `applyD1Migrations` で隔離 D1 に適用する。
既存の Phase 0 probe schema は別 test file の隔離 DB を使い、混在させない。

本番 DB へはまだ適用しない。down migration は提供せず、既存データがある場合の rollback は
maintenance / GC pause / epoch bump を含む承認済み restore 手順で行う。
ローカル開発の空 DB には `pnpm exec wrangler d1 migrations apply DB --local` で適用できる。

FK graph、生成順序、状態遷移、復旧境界は `docs/FOUNDATION.md` を参照。

`0052` は非同期copyの受付operationと、固定manifest・分割BLOB・保持対応の3tableを追加する（72通常table）。同期DAVの同一space制限は維持する。既存`bulk_jobs(kind='node.copy')`があれば、元実装と転送・保持状態の個別照合が必要なため移行を拒否する。受付だけを公開せず、転送と精算を接続してからHTTPを有効化する。旧Workerへのrollbackはmaintenanceを保持して対応schema/コードを再検証する。[所有者間コピー](../../../docs/COPY_JOBS.md)を参照。

`0053` は既存job leaseへinvocationのR2 call counterを追加する（通常72tableのまま）。既存token/epoch/期限/試行回数を保持し、新columnは0から開始する。copy claimと読取りは内部serviceのみで、checkpoint進行・転送先保存・精算は後続。

`0054` はcopy.putをnative書込み台帳へ追加し、全既存receiptとcopy保持行を保存する（72table）。copy保持行へ転送state/attempt/claim/hash/固定source nodeを追加し、転送先blobの削除も保持中は拒否する。既存multipart照合とfreezeガードを再作成する。停止・未凍結・open permit/claimed operation/未閉鎖admissionなしで適用し、旧Workerへ戻す場合もmaintenanceを維持する。

`0055` は分割copyのupload/part用2tableを追加する（74table）。既存15種のnative receiptを全field維持し、copy multipartのcreate/part/completeを加える。旧copy保持行はsingle modeを維持する。geometry・不変identity・native/physical記録・連続partを検査し、取消し/精算実装までは削除を拒否する。copy保持中のkeyは全bucket用abortも拒否する。新tableをbackup/restore freeze・export/purge順序へ含める。適用前提とrollback時の停止維持は0054と同じ。

`0057` はcopy停止時刻/epochと不変の精算receiptを追加する（75table）。停止だけでは保持を返さず、未着手/明示的not_started/実保存とnative終了の証拠が揃うblobだけを精算する。copy保持中のnative receiptを自動削除しない。途中multipart/未知結果は保留する。新tableをbackup/restore freeze・export/purgeへ含め、移行条件は0056と同じ。

`0058` は既知copy multipartの中止attempt/epoch/開始時刻/期限と未送信履歴の索引を追加する（75table）。精算receiptへabortedを追加し、全旧行・16依存trigger・freezeを保存する。中止準備、native grant、精算で先行nativeの終了と正確なidentityを照合する。欠落・unknown・timeoutでは保持を返さない。適用前提と旧Workerへのrollback時の停止維持は0057と同じ。
