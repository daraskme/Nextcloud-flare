# 復元後のupload・予約・outbox修復

更新: 2026-09-28

[予約epoch採用](DATABASE_RESTORE_ADOPTION.md)後、同じ復旧要求から既存の停止中修復を呼び出す。対象は単一upload、既知multipart、古い予約、対応済みのoutbox通知。namespaceの操作や通知そのものは再実行しない。

## 実行

```sh
pnpm database:restore repair-restored --remote \
  --operator-config restore-operator.json --epoch <元epoch> --id <同じUUID> \
  --kind single --limit 20
```

`--kind`を次の4種類から選ぶ。`--limit`は1〜20、既定20。1回の呼出しは1回の限定された修復だけを行い、CLI内で反復しない。private `database-restore-v1`権限、`RESTORE_OPERATOR_ENABLED=true`、`RESTORE_WRITE_ENABLED=true`が必要。採用前、hold解除後、別の要求、別のepochでは拒否する。

| kind | 処理と残る保護 |
|---|---|
| single | 元の24時間期限を過ぎたuploadを停止し、HEADで実体を確認する。不在が確定すれば容量を戻す。正しい実体があればphysicalを計上してGC候補へ渡す。未期限・公開済みoperation・pin・metadata不一致を迂回しない |
| multipart | 既知handleを元のlease/operation条件で中止し、閉鎖とHEADの両方を確認してから精算する。以前の中止の終了証拠があればDB上の閉鎖記録だけを補う。未知handleや不明なnative処理は保持する |
| reservations | 古いepochの予約のうち、uploadから参照されず、DAV PUT operationにも紐づかないものだけを解放する。uploadの容量は各cleanupへ残す |
| outbox | 古いepochの対応済みnode通知を、元のcommitted operation・種類・node step・owner/spaceへ照合してfailedにする。元operationは変更せず、通知を再送しない。未対応kindや未終了claimは残す |

最初にDOのlive KDF/R2記録が空であること、D1にも`claimed`/`pending`がないことを確認する。残っていれば[終了記録の修復](DATABASE_RESTORE_NATIVE.md)を先に行う。未知のnative処理を経過時間から終了扱いにしない。予約/outboxの修復には既存のquiescence・bootstrap確認も必要なので、まずuploadの停止と精算を進める。

## 元のmultipart中止の照合

R2でabortが成功した直後にD1の`multipart_cleanup_closed`更新が失敗すると、実体は閉じていてもDBに閉鎖記録が残らない。この状態へもう一度abortを送ってNoSuchUploadを受けても、成功の証拠にはならない。

新しいcleanup tokenを取得する前に、元upload・owner・key・cleanup tokenから`source_ref=["cleanup",uploadId,cleanupToken,null]`のR2記録を選ぶ。D1の全9識別列をhashした値・終了状態・元期限がDOの保存履歴と一致し、uploadの不変なhandleとの対応が保たれていることを要求する。

- `succeeded`が一致した場合は、同じ停止token、元のupload/handle/cleanup token/開始時刻、R2終端tupleを同じsystem mutationでassertして、閉鎖記録だけを補う。その後に通常のHEADと容量精算を行い、abortは再送しない。
- `not_started`が一致した場合は、元の呼出しが未送信であることを証明できるため、同じ元tupleをclaim時にも確認して新しいcleanupへ進める。
- 記録の欠落・D1だけの成功行・期限や識別列の不一致では元tokenと容量を保持する。`cleanup_error`を記録し、`cleanup_next_at`を60秒後へ送る。次の呼出しが別の対象へ進めるようにし、元の証拠は上書きしない。

新しいclaimにも読取った元tupleを渡して比較するため、照合後に別のcleanupへ変わった行は取得しない。DB応答喪失は元のsystem mutationまたは正確な閉鎖tupleの読戻しで確認する。保存履歴だけからR2結果を推測したり、HEADの不在だけでhandleの終了を認定したりしない。

## 停止と結果

全体を1つのmaintenance taskで実行し、前後で既存監査を無効にする。task開始後のepoch/revision/tokenへ束縛し、admissionの取得、R2 HEAD、native送信直前、各対象の間で再確認する。送信grantを返す前に停止が変わった場合は`not_started`を記録する。実際のR2完了が停止変更後に届いた場合も終了証拠を保存し、その後の古い修復は中断する。

出力は`kind/pending`と、uploadでは`cleanup/held`、予約では`released`、outboxでは`failed`を含む。`held`はこの回の事前照合で保留したmultipart件数。`cleanup.r2Calls`はI/O予算を取得した回数であり、native成功回数ではない。内部token・key・handleはCLI出力に含めない。

対象が残っていれば`pending=true`、CLI終了code 2。走査対象にならない未期限upload、未知handle、GCへの引渡し済み実体、参照付き予約、未対応通知も含めた保守的な残存判定である。同じコマンドを繰り返せば必ず解消するという意味ではない。GC候補へ正しく引き渡せた状態は、残存していても全監査の条件を満たし得る。再開の可否は[FTS再構築・全監査・最終fence](DATABASE_RESTORE_RECOVERY.md)で別に判定し、この修復コマンドだけでは受付もGCも開かない。

## 残作業

multipart inventory、全bucketの未知handle、orphan/GCの各処理、旧backup記録の修復は、復旧要求に固定した運用コマンドへ未接続。復元snapshotに元abortのD1記録がなく、履歴からも対応を再構成できない場合や、全DO storage喪失、旧実装で証拠が消えている場合をこの経路だけでは収束できない。元のD1終端記録は通常の保持期限を持つため、36日のDO履歴だけですべてのmultipart閉鎖を修復できるとは保証しない。

logical import、安全な中止、大規模DBのRTOと実Cloudflareでの復元・再開検証も未完了。D1 schema0046・通常68table・依存追加なし。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。
