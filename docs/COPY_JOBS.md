# 所有者をまたぐコピー

更新: 2026-09-28。非同期copy jobに必要な対象固定・保持・容量予約の内部処理を実装した。HTTP受付、ジョブの永続記録、Queue、R2転送、一括公開、取消し・再試行は後続で、画面から所有者間コピーを使える状態にはまだしていない。最終要件は[DESIGN](DESIGN.md)と[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)を維持する。

## コピー開始時の固定

`services/copyPreparation.ts` の `prepareCrossOwnerCopy` は、現在のAccess利用者について転送元readと転送先createを別々に認可する。両側の選択share ID/versionを複製して固定する。明示的な個人領域はactor本人の所有が必要で、失効した共有を別の広いgrantで補わない。上書き対象には転送先のtrash権限、親・名前の一致を要求する。同じ所有者のコピーは既存COW経路を使い、この準備処理へ切り替えない。

対象にはノード構成、保存名と正規化名、revision、client mtime、hidden、現在のblob、dead propertiesを含める。blobは保存キー・サイズ・保存済みETag・content ETag・hash・MIMEを保持し、記録済みの物理サイズとownerの一致を検査する。コピー元rootの外のparent IDは結果に含めない。Depth 0はcollectionとその属性だけ、Depth infinityは全配下を固定する。上書き対象も別のsnapshotとして固定する。

コピー元と上書き対象を合わせて10,000 node・10,000 property、UTF-8で8 MiBまでのメタデータを扱う。走査には索引付きsuccessor walkと10,001件目の検出を使い、上限超過を切り捨てて成功扱いにしない。大きすぎる属性は値をWorkerへ読み出す前に検出する。深さは絶対depth 64まで。さらに大きいmanifestの分割保存は未実装で、この準備の成功をジョブ完了とはしない。

返却するplanと全配下は凍結し、SHA-256 digestを付ける。`copyPreparationAssertions` は生成元のrequest-local proofだけを受け付け、複製・JSON読戻し・偽造したobjectを認可の代わりにできない。開始を確定する同じD1 batchで、両側の資格情報・共有・世代・全メタデータ・現在の名前衝突を再検査する。構成追加、属性の同じ長さでの置換、content変更、共有停止も拒否する。

## 保持と容量予約

`preparedCopyBlobs` はsource blobごとに転送先blob ID、pin ID、reservation IDを割り当てる。コピー元にCOW aliasが複数あっても同じblobの転送・予約・pinは一つ。画面上の合計サイズを表すlogical bytesと、実際に転送・予約するunique bytesを分ける。folder全体を単一uploadのサイズ上限へ押し込まず、各blobについて既存の予約上限を使う。

`reservePreparedCopyStatements` は、上記の再認可と一意なblobごとの予約・pinをまとめたSQLを返す。**呼出側は、永続job/manifest・idempotency digest・Outboxの記録と、適切なmutation admissionを同じbatchに入れる必要がある。このSQLだけを単独で実行するHTTP経路は設けていない。**

予約は転送先owner、pinはコピー元blobへ付ける。namespaceや実在R2 bytesはまだ増やさない。quota不足やsource ref上限で最後のchunkが失敗しても、先に入れたpinと予約を含めて全rollbackする。既存のpinを期限だけで消すことはせず、後続のjob終了・取消し・復旧処理が実際の転送終了を確認して精算する。

## 次に接続する処理

1. 永続job・manifest、要求の再送照合、actor/credential/選択grant/epochを保存し、QueueにはIDだけを送る。
2. 固定したsource blobをpinしたままRangeで読み、転送先の単一/分割uploadへ流す。chunkごとに現行権限とclaim fenceを検査し、native R2の送信・結果不明・実終了の記録を残す。
3. 全blobを検証してから、固定manifest・衝突方針・dead propertiesをnamespaceの原子的な公開へ接続する。フォルダーの一部だけを公開しない。
4. job read/cancel/retry、停止・recovery・Outbox、pin/予約/physicalの精算、Shared画面の宛先選択と進捗を接続する。

同期DAVは引き続き同一owner・1,000 node・10 GiBまでで、cross-owner要求をREST jobへ自動fallbackしない。[DAV Shared](DAV_SHARED.md)を参照。検証結果と残る全体要件は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とする。
