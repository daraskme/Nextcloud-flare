# バックアップ期間中の元ファイル保護

更新: 2026-09-25。logical exportの最大年齢35日、Time Travelの30日に合わせ、元BLOBSの通常GCを35日以上遅らせる。これは元bucket内の削除猶予であり、別bucket・別accountへのファイル複製ではない。

## 保護の開始点

`purgeTrash`、単一/分割uploadの共通cleanup、失敗したDAV PUTの3経路は、新しいGC候補をD1時刻から35日後に置く。D1の秒精度による早期削除を避けるため1秒を加算する。R2 HEADで不在と確認済みの未公開uploadは、物理削除を行わない既存の会計精算を継続する。

古いGC候補がcopyなどで再参照される場合もある。migration `0039_backup_gc_grace.sql`のtriggerは、最後の`nodes.current_blob_id`または`node_versions.blob_id`参照が外れる同じtransactionで、既存候補の`not_before`を再び35日以上先へ延ばす。node削除、current blob差替え、version削除を対象にし、既存の長い期限は短縮しない。

判定には実際のnode/version行を使う。`ref_count`には一時pinも含まれ、会計triggerの実行順にも依存するため、単純なref_count=0への遷移では判定しない。pin・参照数・uploadの収束・受付/epoch・GC pauseによる既存の削除禁止条件も維持する。参照が外れた時点で候補がなければ、その後の候補作成時から35日待つ。

GCが候補を読み取った後、受付を待つ間に再参照と解除が起きても、削除claimのatomic batchは最新の`not_before`を照合する。期限が延びていればblobの`deleting`変更もrollbackし、R2へ削除を送らない。既に`deleting`へ確定した対象の再試行・収束は延期も巻戻しもしない。

WebDAV LOCKで作る未公開の0-byte objectも、エラー直後には直接削除しない。同じoperationが競合して先に公開された場合、失敗した呼出し元の判断だけでは削除できないためである。未登録objectは既存のorphan inventoryがcatalogue非存在を確認し、発見から35日待って回収する。公開済みなら通常の参照/GC条件に従う。

## 移行と運用上の範囲

- 既存候補の作成時刻は記録されていないため、0039は`state=candidate`の期限を移行時刻から35日以上先に延ばす。長い期限、`deleting/deleted`の状態とclaimは保持する。table数は67のまま、既存migrationは編集しない。
- 実環境への適用は未実施。maintenance/GC pauseを伴う環境別の移行手順で適用し、既存候補の件数・容量を確認する。physical容量は実削除確認まで計上されるため、失敗uploadやpurge済み内容も猶予中は容量を消費する。
- 適用前に削除済みのobjectは復元しない。古いバックアップのファイル実在性を、この移行だけで証明したことにはならない。復旧時のinventory・会計・不可逆なdeletingの監査は引き続き必要。
- 世代の最大年齢はサーバー側の開始時刻を基準に35日以内で判定する必要がある。完了時刻や利用者指定の時刻からさらに35日延長して復旧対象にする運用は、このGC保護の根拠に含まれない。最少5世代に足りなくても期限切れ世代を有効扱いしない。
- 日次の実行、世代の保持管理/不足通知、Time Travel・live restore、bucket/account喪失に備えた複製は別工程である。

過去schemaのオフライン検証は[BACKUP_HISTORY](BACKUP_HISTORY.md)を参照。

## 検証

Node SQLiteで非空の旧DBへの移行、最後のnode/version参照、複数参照、pin、再利用、rollback、時刻の端数、不可逆状態を検証する。実D1/R2/DOでは3つの候補作成経路、期間内の削除拒否とphysical会計、期間経過後の回収、claim待機中の再参照競合、WebDAV空ファイルの重複実行と失敗を検証する。時間経過のfixtureは本番の期限を検証した後にテストDBだけを過去の候補に変更し、本番の時計や削除条件は変更しない。

結果と残る検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。
