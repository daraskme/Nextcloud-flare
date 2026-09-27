# 復元後snapshotの隔離検証

更新: 2026-09-28

`verify-restored`は、Time Travelの実成功応答をDOに保存した要求に対して、復元後D1を読み取り、隔離SQLiteへ再構成して検証する。ControlDOの観測と独立CLIの読取りを照合し、全通常tableの行数・hash、信頼済みschema、外部キー、FTS再構築を確認した証言をDOへ保存する。遠隔D1を書き換えず、旧DO epochと復旧holdを保持する。

## 接続経路

```sh
pnpm database:restore verify-restored --remote --operator-config restore-operator.json \
  --config <対象Workerの設定> [--environment <Wrangler環境名>] \
  --epoch <元のDO epoch> --id <同じ復旧要求UUID>
```

`apply-time-travel`が`restore_written`になった要求だけから開始する。`restore_pending`はprovider結果不明なので受け付けない。既存のprivate `database-restore-v1`権限と`RESTORE_OPERATOR_ENABLED=true`が必要。読み取り工程なので追加の送信フラグは不要で、Time Travel POSTを再実行しない。D1/BLOBS/BACKUPSの3対象とprovider結果は元の実行記録から固定する。

private operatorに`challengeSnapshot`と`attestSnapshot`を追加した。公開HTTPや任意SQLのRPCは設けない。CLIは固定したWrangler設定から読取りを行い、対象設定とoperator設定を各境界で再確認する。

## 観測と全データの検証

1. DOは通常/復旧用epoch履歴のnative終了、予約内容とR2 record、現行DO epoch、KDF/R2/maintenance/backupのholdを確認する。復元前のD1凍結mirrorは巻き戻され得るため、ここでは使用しない。
2. DOに新しいchallenge IDを保存して以前の証言を無効化し、D1のcontrol全列・schema・table catalogueを読む。snapshot epochは正の数で元DO epoch以下を要求する。要求・将来epoch・3対象・provider結果・観測hashをchallengeへ束縛する。1 RPCは25秒、challengeは1時間以内とし、期限切れ・時計逆行・新challengeで古い継続を拒否する。
3. CLIは`d1_migrations`がrepository内の信頼済みmigrationの完全なprefixであることを確認する。対応範囲は0037以降。schemaや未知のtable/view/virtual tableも検査する。復元先を最新schemaへ自動移行しない。
4. 信頼済みmigrationだけで隔離SQLiteを初期化する。D1の全通常tableを主キー順・4行ずつ読み、型を保持した行数/hashを計算する。同じ読取りから所有する一時ディレクトリへSQLを出力し、隔離DBへ全行importする。NULを含むTEXTと引用符を保持し、入力SQLは既存の制限付きINSERT parserで処理する。
5. 隔離DBで外部キーを検査し、base `search_index`からFTSを再構築・検証する。隔離DBの全table hashが最初のD1読取りと一致することを確認する。D1全tableをもう一度読み直して同じhashを要求し、control/schema/catalogueも再照合する。遠隔D1のFTSには書き込まない。
6. DOはchallengeの一致・期限・epoch履歴・最新のcontrol/schema/catalogueを再確認し、信頼されたCLIの証言を保存する。CLIが読む全行をDOが再読取りする設計ではない。この信頼境界はlogical世代の隔離SQL証言と同様である。

controlのhashは列名をソートした全値、schemaの観測hashはD1から得たSQL、catalogueのhashは名前順の種別を対象とする。証言側の`schemaSha256`は既存backup形式と同じ、コメント等を正規化した信頼済みschemaのhashであり、challenge内のraw SQL観測hashとは区別する。内部tokenやcontrolの値をCLIの結果へ出力しない。

読取りは1呼出し30秒・最大64MiBで、1時間内に完了しなければ新しいchallengeから全検証をやり直す。中断後のtable cursor再開や大規模DBのRTO測定は未対応。一時SQL/SQLiteは成功・失敗とも閉じて削除する。

## 永続状態と再実行

DO SQLiteの`control_database_restore_snapshot`にchallengeと証言を保存する。D1の巻戻しでこの記録は消えない。

| 公開状態 | 意味 |
|---|---|
| snapshot_checking | challenge作成を開始した。読取り失敗・期限切れ・未記録の結果もこの状態で停止を保持 |
| snapshot_verified | 同じchallengeの隔離検証証言を保存済み。`snapshotVerifiedAt`は観測記録時刻 |

同じchallengeと同じ証言の再送はidempotentに扱う。異なる内容への差替え、別要求・対象・epoch・provider結果、新しいchallengeに対する旧証言は拒否する。新しい`verify-restored`は過去の成功を省略理由にせず、新challengeと全読取りから始める。記録ACKを失っても自動cancel・Time Travel再送・epoch採用・受付再開は行わない。

## 保証の範囲と次の工程

この結果は、観測した復元先のschemaとデータを隔離再構成できたという証言である。元のTime Travel指定時点はproviderの実成功応答に束縛するが、別の過去snapshotの全行を独立に取得して照合したものではない。D1 bindingの新しい書込みchallengeや、検証後も全行が不変であるという障壁も設けていない。`snapshot_verified`は有効期限後も過去の検証記録として残り、epoch採用の許可にはならない。

後続の[予約epoch採用](DATABASE_RESTORE_ADOPTION.md)ではcontrol全列のCASを伴う停止batchと新しいtokenの独立読戻しを行う。snapshot証言だけでDO epochを変更せず、採用後も復旧holdを維持する。全監査・R2実体/会計照合・段階再開は引き続き必要。採用intent保存後は新しいsnapshot challengeを拒否する。

外部I/O全終了の運用証明、旧実装・DO全storage喪失、logical import、安全な中止、実Cloudflareの復旧ドリルも未完了。送信フラグは既定で無効のまま。ローカルprivate bindingドリルのcontrol行巻戻しと合成provider応答を、実Time Travel成功として扱わない。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。
