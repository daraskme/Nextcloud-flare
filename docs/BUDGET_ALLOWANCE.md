# 異なる配信対象と共有budget

更新: 2026-09-24。

同じuserのbudgetを再利用した際、最初に配信したtarget setのtotal bytesだけでbyte上限が固定され、大きなfileや上書き後の内容が拒否される問題を修正した。対象を変える通常操作と、同じ対象のticket/session再発行を区別する。

## 対象の重複排除

BudgetDOの同じ有効期間内で、認可済みmanifestに含まれるimmutableなpurpose/blob IDをSQLite台帳に記録する。上限は台帳にある内容のsize合計×3。同じ内容が新しいmanifest・session・tab・COW別名に現れても加算しない。異なるblobは新しい対象として一度だけ加える。既知blobに異なるsizeを割り当てたmanifestは拒否する。

使用済みbyte、request数、active lease、期限は対象追加でリセットしない。既知の未使用byteだけをsettleで返し、結果不明の予約は全額を保持する。同じ対象を組み替えた集合を繰り返して枠を増やすことはできない。

manifestはD1のID/ref/hash/total bytesに照合し、R2から最大1 MiB・1,000 targetsの既存parserで読み取る。取得後にも現行D1 credential/ticket/session/share/controlと同じmanifest情報を再確認する。instance内には検証したmanifestを1件だけcacheする。cache keyはID/ref/hash/total bytesで、各requestのD1認可を省略しない。

## 原子性と上限

DOの同期transactionに、必要なら期間初期化、対象追加、expired lease整理、同時数/回数/byte検査、新leaseと使用量更新をまとめる。後段で拒否した要求は対象追加もrollbackする。D1/R2 I/Oはこのtransactionの外側で行う。

- request: 1,024回/10分、同時active lease: 8。短いticketに由来するbyte期限が先に切れても、同じepochの10分windowとrequest数を保持する。
- 対象台帳: 最大1,024件、lease台帳: 最大1,024件。
- SQLite databaseSize: 1 MiB以内。超過する変更はrollbackする。
- 対象台帳はbudgetの従来の有効期限またはepoch更新で、使用量と一緒に初期化する。ticket/sessionの追加だけでは期間を初期化しない。

旧DO保存領域には対象の内訳がない。そのlive budgetに新しい枠を重ねず、従来の上限・使用量を期限まで保持する。旧枠で足りない配信は429となり、次の期間から新台帳を使う。配備時に最大10分の制限が残り得る。現在リモート配備は行っていない。

app originからのcontent errorにも固定originのCORSを付け、429/404/503をブラウザーが判別できるようにした。許可しないoriginへCORSを開くことはない。

## 検証と残る範囲

workerdの実D1/R2/DOで、異なる対象への加算、同じ内容の再発行/重複集合/COWの非加算、eviction後の使用量、size矛盾・manifest破損、R2取得中のticket失効、旧保存領域の期限、短いticket期限での回数制限保持、1,024 targetsと最大lease行での1 MiB上限を検証する。同時数超過時に新しい対象の加算もrollbackする。HTTPの実byte上限拒否でCORSと使用量不変も検証する。

実browserの上書き後・別file・0 byte・Range配信を確認する。全結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。

実環境での負荷・R2 manifest読取り費用、未実装のthumb/page/entry/track/ZIP/public経路、完全restore drillは残る。D1 schema/migrationの追加はない。
