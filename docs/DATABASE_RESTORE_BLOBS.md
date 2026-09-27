# 復旧先BLOBSの照合

更新: 2026-09-27。`pnpm database:restore verify-blobs`は、新しく照合したD1と同じ復旧要求にBLOBSのaccount・bucket・jurisdictionを固定する。WorkerのBLOBS bindingで固定probeを更新し、指定bucketへの署名付きS3 GETで同じ値を読めたことをControlDO SQLiteへ保存する。

## コマンドと前提

同じ復旧要求を[prepare](DATABASE_RESTORE_OPERATOR.md)で作成しておく。logical世代とTime Travel候補の両方を受け付ける。要求は`preparing`、現epoch、maintenance/GC停止中で、backup凍結が解除済みでなければならない。

```sh
pnpm database:restore verify-blobs --remote --operator-config restore-operator.json \
  --config <対象WorkerのWrangler設定> [--environment <Wrangler環境名>] \
  --epoch <現在のepoch> --id <復旧要求UUID>
```

- 明示的な`--remote`を必須とする。選択されたWrangler設定に一つずつの`DB`と`BLOBS` bindingが必要。account ID、Worker名、環境、D1 UUIDの条件は[D1照合](DATABASE_RESTORE_TARGET.md)と同じ。
- `BLOBS.bucket_name`と`jurisdiction`（省略時`default`）を固定する。D1とBLOBSは同じaccountを要求する。別対象への切替えは同じ復旧要求IDでは受け付けない。
- 対象Workerには専用の復旧権限と、既存の`R2_INVENTORY_ACCOUNT_ID`、`R2_INVENTORY_BUCKET`、必要な`R2_INVENTORY_JURISDICTION`、`R2_INVENTORY_ACCESS_KEY_ID`、`R2_INVENTORY_SECRET_ACCESS_KEY`を設定する。S3側には当該bucketのprobe読取り権限が必要。これらはWorker側の設定を使用し、RPC引数からcredentialsや任意endpointを受け取らない。秘密値はリポジトリへ保存しない。
- CLIの一時Wrangler設定にはD1だけを含める。BLOBS bindingやWorkerの秘密値をコピーしない。元の設定とoperator descriptorのbyte一致をD1照合の前後とBLOBS RPCの前後で確認する。

## 処理と永続化

1. CLIは毎回新しいD1 challengeを取得し、固定account/DBに対する独立SELECTとControlDOのD1 mirror照合を完了する。
2. ControlDOは照合済みchallengeとWorkerのS3設定を照合する。復旧要求・epoch・D1対象・BLOBS対象を`control_database_restore_blobs`へ固定し、試行IDを更新して以前の成功記録を無効にする。
3. 既存の[R2/S3対応検証](MULTIPART_INVENTORY.md)で`system/r2-binding-probe-v1`を読む。新しい256-bit nonceを64文字の本文にし、既存objectにはETag条件、新規objectには`If-None-Match: *`を付けて保存する。
4. Workerの署名付きS3 GETがそのnonceを返した場合だけ照合済みに進める。probe leaseの解放と最後のD1 mirror再検査が成功してから、DOへ`verified_at`を保存する。

返り値は`state:blobs_verified`、`validator:r2-binding-v1`、D1/BLOBS対象、試行ID、challenge ID、revision、観測時刻、元challengeの期限。停止token・probe nonce・credentialsをCLIの成功結果に含めない。

復旧要求に結び付いた観測はD1と別のDO SQLiteに保存し、eviction後も対象固定を維持する。現在のD1 schemaは0045、通常68table。既存の`r2_binding_probe`台帳とsystem容量64 bytesを再利用し、`r2_write_attempts`へ各PUTの送信と実終了も記録する。probeは恒久的に保持し、成功・失敗・取消しで削除しない。遅延した新規PUTが後から別のprobeを作ることを防ぐためである。利用者のファイルやBACKUPSのobjectは変更しない。

条件付きPUTの失敗ではR2 Workers APIが`null`を返す。成功した書込み後の読取りについては[公式Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)の整合性契約に依存する。jurisdictionはbucketの区分として固定し、単なるlocation hintと混同しない（[公式data location](https://developers.cloudflare.com/r2/reference/data-location/)）。

## 失効・応答喪失

probeのclaim、各外部操作の予算、段階記録、解放は既存の同時32・待機256の共通受付を使う。ControlDO内部は同一instanceで受付を行う。D1更新batchにはepoch・停止revision/token・maintenance/GC停止・backup非凍結の条件を追加する。外部GET/PUT/S3 GETは、その回の予算batchの直接ACKを受けた場合だけ送信する。

PUTはさらに`probe.put`の永続grantを要求する。元のlease token/nonce/source/期待ETagと停止revision/tokenを同じD1 batchで検査し、grant受領後にもDOの復旧scopeを同期検査する。送信前にscopeが閉じていればnot_startedを記録する。R2から実成功が返った場合だけ終了を反映し、timeout後の実成功は検証済み証言へ進めない。新しいprobeの成功やlease満了では、古い結果不明のPUTを精算しない。詳細は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)。

DO側でもawaitの前後に現在の要求・試行・challenge・停止状態を再検査する。元challengeは5分、BLOBS検証はその残り時間と25秒の短い方に制限する。S3読取りは既存の10秒・64-byte上限を使う。timeout、取消し、停止更新、epoch変更、時計逆行、別試行への置換があれば、遅い応答から次の外部操作を開始しない。既に送信したR2処理の完了を推測せず、未確定の60秒leaseと容量を保持する。

失敗時は成功記録を返さない。RPC応答喪失は結果不明として扱い、同じ復旧要求IDで新しいD1 challengeとprobeを使ってやり直す。古いleaseが残っていれば期限後の再実行が必要になる。取消しや失敗でmaintenance/GC停止を自動解除しない。内部のS3/R2例外はCLIでは安全な汎用エラーへ置き換える。

## 残る工程と検証範囲

この観測は短期の接続先照合であり、R2処理全体の終了証明やD1上書き許可ではない。`verify-d1`・`verify-bookmark`・`verify-blobs`はいずれも新しい停止challengeを作るため、別コマンドの過去の証言を組み合わせて復元許可にしない。同じ最終停止へ全検証を接続する工程は後続である。

BACKUPS bindingのfresh照合と、同じD1 challengeでの[BLOBS/BACKUPS一括照合](DATABASE_RESTORE_BINDINGS.md)を追加した。R2/KDF/job/repairの終了証明、最終停止、新epoch予約、実D1上書き・採用・全監査・段階再開は未完了。BLOBS自体の独立バックアップも追加していない。

Node試験はCLI/config/RPC境界を、workerdは実D1/DO/R2で照合・取消し・競合・応答喪失・保存失敗・期限を確認する。named service bindingドリルは全9復旧操作の権限拒否とprobe更新・eviction後再検証を確認する。S3 provider応答とremote descriptorはローカルfixtureで模擬しており、実Cloudflareの接続・復元・deployは実施していない。実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。
