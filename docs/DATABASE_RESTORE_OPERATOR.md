# 復旧準備とSQL検証の運用コマンド

更新: 2026-09-28。`pnpm database:restore`は準備・復旧元/対象照合・D1凍結・[epoch事前予約](DATABASE_RESTORE_EPOCH.md)、既定で無効の[Time Travel送信・実応答記録](DATABASE_RESTORE_TIME_TRAVEL.md)、[復元後snapshotの隔離検証](DATABASE_RESTORE_SNAPSHOT.md)に対応する。logical世代と復元後snapshotのSQLを隔離SQLiteで検証し、ControlDOへ証言を保存する。[採用用停止batchと新epoch採用](DATABASE_RESTORE_ADOPTION.md)も接続済み。[FTS再構築・全監査・hold解除・段階再開](DATABASE_RESTORE_RECOVERY.md)も接続済み。全外部I/Oの運用終了証明、未終了処理の全ケースの修復、実環境の復旧は後続。

## 専用の権限

main Workerのnamed entrypoint `DatabaseRestoreOperator`は、`prepare/inspect/verify/attest/challengeD1/attestD1/attestBookmark/verifyBlobs/challengeBackups/attestBackups/verifyBindings/freeze/reserveEpoch/beginTimeTravel/finishTimeTravel/challengeSnapshot/attestSnapshot/beginAdoption/attestAdoption/auditRecovery/repairNative/rebuildRecoveryFts/releaseRecovery/resumeRecovery/resumeRecoveryGc/cancel`の26操作を提供する。HTTPのfetchは404で、任意SQLやControlDOの汎用recover/resumeは受け付けない。beginTimeTravel、最初のbeginAdoptionとreleaseRecoveryは追加のRESTORE_WRITE_ENABLED設定が必要。finishTimeTravelは発行済みgrantの実応答だけを記録する。

targetの`RESTORE_OPERATOR_ENABLED=true`と、呼出し元service bindingの`props.purpose=database-restore-v1`、`props.environment=targetのENVIRONMENT`の一致が必要。既存の`BACKUP_OPERATOR_ENABLED`や`logical-backup-v1`だけでは復旧準備を操作できない。標準wrangler.jsoncでは復旧権限を有効にしない。

SQL検証の証言をするため、このcapabilityは信頼された検証者にだけ渡す。`attest`は受け取ったhashからSQL検証の実行を独立に証明するAPIではない。利用者が渡したhashをそのまま転送するHTTP窓口を作らない。CLIは固定のentrypoint/purposeを持つ一時設定を生成し、`RESTORE_CONTROL`一つだけを接続する。

## コマンド

対象ControlDOは初期化済みで、現行epochと保存済み完了世代のid・epoch・manifest hashが既知であること。復旧要求用UUIDは世代IDとは別に一度生成し、応答喪失後も同じ値で再送する。

descriptorは`{"service":"next-cloud-flare-local","environment":"development"}`形式。localでは同じ端末のWrangler dev登録を使い、remote bindingは無効。remote descriptorには明示的な`accountId`も必要で、Wrangler認証を使う。

```sh
pnpm database:restore prepare --local --operator-config restore-operator.json \
  --epoch <現在のepoch> --id <復旧要求UUID> \
  --source-id <完了世代UUID> --source-epoch <保存時epoch> \
  --manifest-sha256 <完了記録のhash>

pnpm database:restore verify --local --operator-config restore-operator.json \
  --config <対象Workerの設定> --epoch <現在のepoch> --id <同じ復旧要求UUID>

pnpm database:restore inspect --local --operator-config restore-operator.json \
  --epoch <現在のepoch> --id <同じ復旧要求UUID>

pnpm database:restore cancel --local --operator-config restore-operator.json \
  --epoch <現在のepoch> --id <同じ復旧要求UUID>
```

`prepare`は通常書込みとGCを止める。`inspect`は保存された要求を読む。`cancel`は要求を取り消し、受付とGCは停止を維持する。凍結済みならD1の凍結解除と停止token更新を確認してからDOの取消しを確定する。失敗時に自動でcancelや再開はしない。

`verify-d1 --config <対象設定>`を追加した。新しい停止tokenを発行して、CLIから独立に読んだDBがWorkerのDB bindingと一致することを照合する。毎回再検証し、対象と5分以内の観測をControlDOへ保存する。SQL検証とは別工程で、`verify`と順に実行する。詳細は[DATABASE_RESTORE_TARGET](DATABASE_RESTORE_TARGET.md)。

`freeze --remote --config <対象設定>`はfreshなD1/BLOBS/BACKUPS照合後にD1書込みを凍結する。状態は`preparing → freezing → frozen`、取消しは`cancelling → cancelled`。同じ対象・要求の再実行で応答喪失から再照会できる。凍結後に新しいchallengeを作らない。これはD1書込み障壁であり、外部R2の全終了や実上書きは別工程。[設定・再送・取消し](DATABASE_RESTORE_FREEZE.md)を参照する。

`reserve-epoch --remote --config <対象設定>`は事前のsource検証とfreeze後に実行し、`epoch_reserving → epoch_reserved`へ進む。D1の旧epochと凍結を保ち、同じ要求に固定したnewEpochを返す。予約開始後の通常cancelは拒否する。応答喪失では同じIDでinspect/reserve-epochを再実行し、新しいIDに替えない。[手順と制限](DATABASE_RESTORE_EPOCH.md)を参照する。

`apply-time-travel --remote --config <対象設定> --timestamp <元の時刻>`は再照合後に1回だけ実POSTし、`restore_pending → restore_written`をDOへ記録する。結果不明のgrantは再発行せず、POSTも再送しない。成功後も停止を維持する。実環境の終了証明と復元後検証は未完了のため、既定の無効状態を維持する。[手順と制限](DATABASE_RESTORE_TIME_TRAVEL.md)を参照する。

`verify-restored --remote --config <対象設定>`は`restore_written`から新しい観測challengeを作り、schema・全通常table・隔離SQL/FK/FTSを検証する。`snapshot_checking → snapshot_verified`へ進み、証言をDOへ保存する。元のD1を書き換えず、旧DO epochと復旧holdを維持する。証言はepoch採用や再開の許可ではない。[手順と制限](DATABASE_RESTORE_SNAPSHOT.md)を参照する。

remoteの`verify`は`--remote`を指定し、`--config/--environment`を受け取らない。BACKUPSの読取りには既存の`R2_BACKUP_*`設定を使う。この`verify`はR2へ書き込まない。remote認証・実resourceでの検証と配備は未実施。

## SQL検証と保存する証言

`verify`は保存済みのlogical要求だけを使い、次の順に実行する。

1. ControlDOに最大100回問い合わせ、サーバーに保存された位置からR2部品を検証する。未完了なら`complete:false`と終了コード2を返す。同じコマンドを再実行して続きを処理する。
2. 全部品が一致したら、選択したmanifest hashを必須にしてR2から一時ディレクトリへ全SQLを取得する。`downloadGeneration`の既存検証を再利用し、信頼済みmigration列、保存時schema、SQL全体hash、全tableの内容、FK、FTS再構築、保存時の凍結状態を隔離SQLiteで検証する。外部SQLをそのまま実行せず、許されたINSERT値だけを取り込む。
3. generation epoch・part数・作成時刻由来の期限もサーバー結果と照合する。
4. 同じ復旧要求とhashで`attest`を送る。サーバーは全R2部品の完了を要求し、完了receipt・manifest・停止mirror・35日期限を再確認する。取消し、停止revision変更、期限超過、古いepochなら保存しない。

ControlDO SQLiteの`control_database_restore_sql`に、要求ID・epoch・manifest hash・サーバー検証時刻・世代の期限・検証方式`logical-sql-v1`を保存する。D1を巻き戻してもこの記録は巻き戻らない。同じ要求への再証言は時刻を後退させず、別世代へ置き換えない。INSERTの成否はRETURNING行で判断し、索引更新を含むrowsWrittenを変更件数と取り違えない。

成功結果は`state:sql_verified`と`complete:true`。これはSQL検証工程の完了であり、復旧全体の完了ではない。停止中repairの終了、BLOBSとの対応確認、新epoch予約、実D1上書き・採用・全監査が必要。manifest/SQLの一致は同じbucket/accountであることの証明にもならない。

1 RPCの待機は最大60秒。応答喪失では結果不明として同じ要求を照会する。SQL検証の再実行時は全SQL検証を通してから同じhashを証言し、過去の成功結果だけで検証を省略しない。Time Travelの実POSTは例外で、pendingに対して再送しない。`prepare --bookmark`と`verify-bookmark`は[bookmark照合](DATABASE_RESTORE_BOOKMARK.md)へ、`verify-blobs`は[BLOBS binding照合](DATABASE_RESTORE_BLOBS.md)へ、`verify-backups`と`verify-bindings`は[BACKUPS・同一challengeの一括照合](DATABASE_RESTORE_BINDINGS.md)へ接続済み。実環境での復旧は未検証。

## ローカル検証

Node試験は実SQLの復元と改変・不正SQL・schema/table不一致、100 step継続、誤った応答、応答喪失、設定の取り違えと秘密非出力を確認する。workerd試験は不完全な部品・誤hash・期限・取消し・停止revision競合・保存失敗・再起動と内部RPCを確認する。

`backup:operator-drill`は実named service bindingで全27操作の拒否境界と、実SQL世代の検証・記録・D1の新しい停止token照合・eviction後再実行を確認する。epoch予約・同番号の再照会・予約後cancel拒否に加え、1回だけのTime Travel送信・結果記録・模擬D1 control巻戻し後の旧DO epochと停止維持、復元後68tableの隔離検証とDO証言保存、採用用D1停止batch・marker独立読戻し・DO epoch採用・eviction後の停止維持、pendingなしのnative修復走査と空の4種類のdomain修復、FTS再構築・12ページ全監査・hold解除・受付/GCの段階再開も確認する。`backup:run-drill`は実CLIとWrangler dev/getPlatformProxyをつなぎ、prepareの再送、verify、verify-d1の再送、inspect、cancel、元epochと停止維持を確認する。実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。bookmark検索・実行とS3応答は合成providerで、Cloudflare上の実D1復旧ドリルとは区別する。

採用後にpendingへ戻ったKDF/R2は`repair-restored-native`で[独立した終了証拠](DATABASE_RESTORE_NATIVE.md)と照合する。各ページの前にDO内の既知の終了記録も精算し、元epoch/要求IDへ固定した最大20行の永続cursorで修復する。D1だけでなくDOだけの未知記録も保持し、いずれかの未精算が残ればCLIは終了code 2を返す。修復後はFTS/全監査からやり直す。

`repair-restored --kind single|multipart|reservations|outbox --limit 20`は、同じ要求へ固定した[各領域の修復](DATABASE_RESTORE_DOMAINS.md)を1回だけ実行する。`RESTORE_WRITE_ENABLED=true`とnative保留なしが前提。元の期限・容量・operation証拠を保持し、multipartの元abort成功が証明できれば閉鎖記録だけを補う。`pending=true`なら終了code 2であり、未期限・inventory・GC引渡し・未対応通知など、別工程が必要な状態も含む。自動反復や受付再開は行わない。
