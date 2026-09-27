# 復元後のupload・予約・outbox・GC修復

更新: 2026-09-28

[予約epoch採用](DATABASE_RESTORE_ADOPTION.md)後、同じ復旧要求から既存の停止中修復を呼び出す。対象は単一upload、既知multipart、古い予約、対応済みのoutbox通知、削除開始済みのblob/orphan、完成済みR2オブジェクトのinventory。namespaceの操作や通知そのものは再実行しない。

## 実行

```sh
pnpm database:restore repair-restored --remote \
  --operator-config restore-operator.json --epoch <元epoch> --id <同じUUID> \
  --kind single --limit 20
```

`--kind`を次の7種類から選ぶ。`--limit`は1〜20、既定20。1回の呼出しは1回の限定された修復だけを行い、CLI内で反復しない。private `database-restore-v1`権限、`RESTORE_OPERATOR_ENABLED=true`、`RESTORE_WRITE_ENABLED=true`が必要。採用前、hold解除後、別の要求、別のepochでは拒否する。

| kind | 処理と残る保護 |
|---|---|
| single | 元の24時間期限を過ぎたuploadを停止し、HEADで実体を確認する。不在が確定すれば容量を戻す。正しい実体があればphysicalを計上してGC候補へ渡す。未期限・公開済みoperation・pin・metadata不一致を迂回しない |
| multipart | 既知handleを元のlease/operation条件で中止し、閉鎖とHEADの両方を確認してから精算する。以前の中止の終了証拠があればDB上の閉鎖記録だけを補う。未知handleや不明なnative処理は保持する |
| reservations | 古いepochの予約のうち、uploadから参照されず、DAV PUT operationにも紐づかないものだけを解放する。uploadの容量は各cleanupへ残す |
| outbox | 古いepochの対応済みnode通知を、元のcommitted operation・種類・node step・owner/spaceへ照合してfailedにする。元operationは変更せず、通知を再送しない。未対応kindや未終了claimは残す |
| blob-gc | 既にdeletingのblobだけを現在のclaimでDELETE/HEADし、実終了・不在の確認後にphysicalを精算する。candidate、pin、参照、未精算upload、有効leaseを保持する |
| orphan-gc | 35日を過ぎたdeletingだけを処理する。前後のHEADと全metadataを照合し、置換された実体は容量と猶予を更新して保持する。quarantinedから新しい削除を始めない |
| orphan-inventory | BLOBSのu/を1ページだけ走査し、各未知keyのHEADから隔離台帳とphysicalを更新する。既知catalogueを重複計上せず、削除・予約解放はしない。cursorはD1に保存する |

最初にDOのlive KDF/R2記録が空であること、D1にも`claimed`/`pending`がないことを確認する。残っていれば[終了記録の修復](DATABASE_RESTORE_NATIVE.md)を先に行う。未知のnative処理を経過時間から終了扱いにしない。予約/outboxの修復には既存のquiescence・bootstrap確認も必要なので、まずuploadの停止と精算を進める。

## GCと孤立オブジェクト走査

3種類とも同じ`repair-restored`コマンドの`--kind`で選ぶ。停止中GCは既存deletingだけを処理するため、uploadからcandidateへ引き渡された実体をここで新たに削除しない。native DELETEの応答が不明なら、claim期限が過ぎても容量を戻さず、次のdomain修復はnative保留の事前検査で拒否する。途中で停止が変わった場合は古い修復を中断するが、実際に完了したDELETEの終了記録は保存する。

`orphan-inventory`はページの全件を処理した後だけcursorを進める。途中のHEAD失敗では既に確認した容量を保持し、同じページから再開しても二重計上しない。走査後の`completed=true`はそのwalkの終了であり、R2全体の固定snapshotや未知multipartの閉鎖証明ではない。停止変更後のLIST/HEAD結果は適用しない。

## 元のmultipart中止の照合

R2でabortが成功した直後にD1の`multipart_cleanup_closed`更新が失敗すると、実体は閉じていてもDBに閉鎖記録が残らない。この状態へもう一度abortを送ってNoSuchUploadを受けても、成功の証拠にはならない。

新しいcleanup tokenを取得する前に、元upload・owner・key・cleanup tokenから`source_ref=["cleanup",uploadId,cleanupToken,null]`のR2記録を選ぶ。D1の全9識別列をhashした値・終了状態・元期限がDOの保存履歴と一致し、uploadの不変なhandleとの対応が保たれていることを要求する。

- `succeeded`が一致した場合は、同じ停止token、元のupload/handle/cleanup token/開始時刻、R2終端tupleを同じsystem mutationでassertして、閉鎖記録だけを補う。その後に通常のHEADと容量精算を行い、abortは再送しない。
- `not_started`が一致した場合は、元の呼出しが未送信であることを証明できるため、同じ元tupleをclaim時にも確認して新しいcleanupへ進める。
- 記録の欠落・D1だけの成功行・期限や識別列の不一致では元tokenと容量を保持する。`cleanup_error`を記録し、`cleanup_next_at`を60秒後へ送る。次の呼出しが別の対象へ進めるようにし、元の証拠は上書きしない。

新しいclaimにも読取った元tupleを渡して比較するため、照合後に別のcleanupへ変わった行は取得しない。DB応答喪失は元のsystem mutationまたは正確な閉鎖tupleの読戻しで確認する。保存履歴だけからR2結果を推測したり、HEADの不在だけでhandleの終了を認定したりしない。

## 停止と結果

全体を1つのmaintenance taskで実行し、前後で既存監査を無効にする。task開始後のepoch/revision/tokenへ束縛し、admissionの取得、R2 HEAD、native送信直前、各対象の間で再確認する。送信grantを返す前に停止が変わった場合は`not_started`を記録する。実際のR2完了が停止変更後に届いた場合も終了証拠を保存し、その後の古い修復は中断する。

出力は`kind/pending`と、uploadでは`cleanup/held`、予約では`released`、outboxでは`failed`、GCでは`cleanup`、孤立走査では`inventory`を含む。GCはclaimed/deleted/retried/r2Callsに加え、orphanで置換観測のchangedを返す。走査はclaimed/examined/observed/advanced/completed/r2Callsを返す。`held`はこの回の事前照合で保留したmultipart件数。`r2Calls`はI/O予算を取得した回数であり、native成功回数ではない。内部token・key・handle・cursorはCLI出力に含めない。

対象が残っていれば`pending=true`、CLI終了code 2。走査対象にならない未期限upload、未知handle、GCへの引渡し済み実体、参照付き予約、未対応通知も含めた保守的な残存判定である。同じコマンドを繰り返せば必ず解消するという意味ではない。GC候補へ正しく引き渡せた状態は、残存していても全監査の条件を満たし得る。再開の可否は[FTS再構築・全監査・最終fence](DATABASE_RESTORE_RECOVERY.md)で別に判定し、この修復コマンドだけでは受付もGCも開かない。

GCの`pending`は該当台帳のdeleting残存を示す。若いorphan、pin付きblob、有効leaseなども含む。candidate/quarantinedだけならこのGC判定ではfalseになり得る。孤立走査ではページを進められなかった場合や続きのcursorがあればtrue。どのkindでもfalseはその処理範囲だけの結果であり、全監査の代わりにはならない。

## 残作業

[multipart inventory](DATABASE_RESTORE_INVENTORY.md)の調査・中止は別コマンドへ接続済み。未知multipart全体の閉鎖証明と予約/physicalの最終精算、旧backup記録の修復は未完了。復元snapshotに元abortのD1記録がなく、履歴からも対応を再構成できない場合や、全DO storage喪失、旧実装で証拠が消えている場合をこの経路だけでは収束できない。元のD1終端記録は通常の保持期限を持つため、36日のDO履歴だけですべてのmultipart閉鎖を修復できるとは保証しない。

logical import、安全な中止、大規模DBのRTOと実Cloudflareでの復元・再開検証も未完了。D1 schema0046・通常68table・依存追加なし。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。
