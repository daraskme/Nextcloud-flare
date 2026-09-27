# Time Travel復旧候補の照合

更新: 2026-09-27。`prepare --bookmark`と`verify-bookmark`で、Time Travelの候補を固定し、指定時刻に対するproviderのbookmark応答を照合する。CLIによる信頼された観測をControlDO SQLiteへ保存する。D1上書き・新epoch採用・受付再開は未接続。

## コマンド

現行epoch、復旧要求用UUID、選択済みbookmark、そのbookmarkを取得した時刻を指定する。選択を変更する場合は明示的にcancelして新しい要求IDを使う。

```sh
pnpm database:restore prepare --remote --operator-config restore-operator.json \
  --epoch <現在のepoch> --id <復旧要求UUID> --bookmark <選択済みbookmark>

pnpm database:restore verify-bookmark --remote --operator-config restore-operator.json \
  --config <対象WorkerのWrangler設定> [--environment <Wrangler環境名>] \
  --epoch <同じepoch> --id <同じ復旧要求UUID> \
  --timestamp 2026-09-27T00:00:00.000Z
```

時刻は実際に選択した時刻へ置き換える。小数秒3桁と`Z`を含むUTC形式を必須とし、未来・不正な日付・時刻省略を拒否する。logical用の`--source-id/--source-epoch/--manifest-sha256`と`--bookmark`は併用できない。Time Travelコマンドは明示的な`--remote`のみ受け付ける。operator権限は[復旧CLI](DATABASE_RESTORE_OPERATOR.md)、対象設定の一致条件は[D1照合](DATABASE_RESTORE_TARGET.md)に従う。

## 読取りと保存

1. 要求の`preparing`状態と`time_travel`選択を確認する。
2. 毎回新しいD1 challengeを発行し、固定したaccount・DBに対する独立SELECTとWorker側の再読取りで停止tokenを照合する。過去の成功結果を再利用しない。
3. 同じ最小Wrangler設定の`DB`へ、`d1 time-travel info DB --timestamp <指定時刻> --json`だけを実行する。子プロセスは30秒・出力1MiBまで。設定とoperator descriptorを呼出し前後にbyte一致で確認する。
4. providerのbookmarkが準備時の選択と完全一致した場合だけ、専用private RPC `attestBookmark`へchallenge・bookmark・指定時刻を渡す。不一致時は選択を書き換えない。
5. ControlDOは準備状態・選択・remote対象・同じchallengeのD1検証済み記録・現行停止revision/token・時刻を確認し、最大10秒でD1を再読取りする。読取り後も取消し・challenge変更・期限・時計逆行を検査してから保存する。

`control_database_restore_bookmark`には要求ID・epoch・対象JSON・bookmark・指定時刻・challenge ID・revision/token・検証時刻・期限を保存する。期限は元challengeの発行から5分で、証言によって延長しない。保存失敗やRETURNING行なしでは成功を返さず、既存の新しい検証時刻を古い時刻へ上書きしない。D1 migration・通常67table・依存は維持する。

成功出力は`state:bookmark_verified`・方式`time-travel-bookmark-v1`と対象・選択・時刻で、停止tokenやproviderの余分な応答フィールドを出力しない。再実行は新しいchallengeとprovider読取りから始める。エラーでも自動cancel・再開は行わない。

## 証言の範囲

[公式bookmark API](https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/methods/get_bookmark/)は、指定時刻以前で最も近いbookmarkを返す。指定時刻が復元される全データの厳密な時刻を表すとは限らない。CLIは[公式Time Travel infoコマンド](https://developers.cloudflare.com/d1/wrangler-commands/#d1-time-travel-info)と固定Wrangler 4.131.1の実装に合わせている。

この証言は、指定account/DBへの時刻検索が選択済みbookmarkを返したという観測である。bookmark自体からDBや保持期限を推測しない。providerの保持期間や将来の復元成功は保証せず、保持期限を一律30日と仮定しない。時刻検索で選択bookmarkを再取得できない場合は、このコマンドでは検証できない。

信頼されたCLIのcapabilityであり、Worker単独ではprovider呼出しを独立に証明できない。任意のbookmark証言を転送する公開HTTP窓口を作らない。保存行は取消し・停止更新・新challenge・期限経過後にも履歴として残る。将来の採用処理は、行の存在だけで判定せず、現行要求・target・challenge・revision/token・期限を再照合する必要がある。

実CloudflareでのTime Travel検索・復元は未検証。Node試験ではprovider応答と子プロセスを模擬し、workerdとnamed service bindingドリルでは実ローカルD1/DOに合成remote対象を渡す。これをremote接続や復元の成功とは扱わない。BLOBS照合は[verify-blobs](DATABASE_RESTORE_BLOBS.md)へ接続した。各CLIは新しいchallengeを使うため、別工程の過去の証言をまとめて上書き許可にしない。同じD1 challengeでの[BLOBS/BACKUPS一括照合](DATABASE_RESTORE_BINDINGS.md)も接続済み。R2/KDF/job/repairの終了証明、最終停止、新epoch予約、D1上書き・採用・全監査・段階再開は後続。検証件数は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。
