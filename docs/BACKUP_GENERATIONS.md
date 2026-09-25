# 論理バックアップ世代とオフライン復元

更新: 2026-09-25。`pnpm backup`は凍結済みD1から通常67tableをWranglerで抽出し、同一versionの隔離SQLiteへ復元・照合して、ローカルの世代ディレクトリへ保存する。検証済み世代のR2保存・ダウンロードも接続した。D1の完了記録と停止解除は[内部ControlDO RPC](BACKUP_COMPLETION.md)で確定し、[専用bindingのrunコマンド](BACKUP_OPERATOR.md)で開始から一連に呼び出す。日次実行は[運用コマンド](BACKUP_OPERATOR.md)、保持判定は[health](BACKUP_RETENTION.md)へ接続済み。定時起動・自動補充/削除、live D1 restore・epoch更新・全復旧監査は後続である。

## コマンド

```sh
pnpm backup capture --config CONFIG --database DB --local --id UUID --epoch EPOCH --directory GENERATIONS
pnpm backup verify --directory GENERATIONS/UUID
pnpm backup publish --directory GENERATIONS/UUID --local --config CONFIG
pnpm backup download --id UUID --directory DOWNLOADED --local --config CONFIG --manifest-sha256 HASH
pnpm backup restore-offline --directory GENERATIONS/UUID --target NEW_FILE.sqlite
pnpm backup:drill
```

captureは[ControlDO.beginBackup](BACKUP_BARRIER.md)が`frozen`を返した世代を前提にする。D1 flagsを直接変更して開始する運用コマンドではない。`--local`か`--remote`の一方を必須とし、必要なら`--environment NAME`を指定する。remoteはCLIの実装経路のみで、この変更では実行・検証していない。各呼出しでconfigの内容が変わっていないことを確認する。localは指定config配下の既定`.wrangler/state`を使う。データはWranglerのD1 queryで読み取り、凍結済みの値からdata-only SQLを生成する。

captureは開始・解除のRPCを代行せず、成功時も失敗時もbarrierを保持する。全source fingerprint取得とexportの前後で同じ凍結世代・epoch・token・watermarkを確認する。途中で解除・世代変更が起きた出力は採用しない。exportのsnapshot開始点が確認できていないため、抽出前のACKだけで解除しない。

`backup:drill`は`.wrangler/backup-drill-*`に専用config、local D1/R2、fixture、世代と復元先を作り、実際のcapture→verify→publish→download→restore-offlineコマンド、FTS検索、容量、元DBの凍結保持を検査する。実local R2への条件付きPUTが既存manifestの置換を拒否することも確認する。既存開発DBを消さず、remoteを呼び出さない。fixtureの凍結はこの隔離試験だけの準備であり、運用RPCや全復旧監査の実証ではない。

## 世代の内容と一致検証

世代ディレクトリには`data.sql`と`manifest.json`を保存する。manifest v1はgeneration UUID/epoch/token/作成時刻/watermark、捕捉時刻、全migrationの名前とSHA-256、schema digest、SQLのbyte数/SHA-256、通常全tableの行数/SHA-256を含む。SQLやmanifestにbearer token・ダウンロードURLを追加しない。SQL自体には利用者情報と認証recordが含まれるため、作成先はprivate directoryを使い、ファイルを0600で保存する。

sourceのschemaはversioned migrationから作ったschemaと一致させる。Wranglerがコメントを除去するため、SQLのコメント・引用符外の空白だけを正規化する。引用文字列やindex/triggerの意味を消す正規化はしない。FTS virtual/shadow dataはexport対象から除外し、FTSの定義はversioned schema、内容は`search_index`から再構築する。

全tableをprimary key順に4行ずつkeyset走査し、型とcolumn順を固定した行のdigestを作る。唯一primary keyを持たない`_assert`はrowid順で値を検査する。OFFSETによる全件再走査を避け、SQLファイルはstreamで読み、一文を8MiB以下に制限する。安全な整数で表現できない値や対応していない形式は採用しない。

checksumだけが合っていても、元DBとの全行一致を示したことにはならない。exportの内容変化・欠落は、隔離復元後の全table digestをsourceと比較して検出する。Miniflareのdumpで実改行と文字列`\\n`/`\\r`が混ざると値が変化する問題があるため、現在のCLIは凍結したquery値からSQLを生成する。引用符・Unicode・実CR/LF・literal backslash・NULを保持し、既存の壊れたdumpを推測して修正しない。形式と上限は[BACKUP_EXPORT](BACKUP_EXPORT.md)、remoteでの互換性・実運用性能は引き続き未検証である。

## SQL読込みと復元

過去世代は保存時のmigration列がローカルの信頼済みSQLの完全な先頭列と一致する場合だけ、当時のschemaで検証する。最小schemaは0037で、復元時に後続migrationを自動適用しない。captureは現在の全migrationを必須とし、抽出前後の全table/view/virtual一覧も照合して未知のtableの取りこぼしを防ぐ。詳細は[BACKUP_HISTORY](BACKUP_HISTORY.md)。

入力SQLを`exec()`へ渡さない。data-only INSERTの既知table・全column順・literalだけを解析し、bound parameterとして挿入する。NULL・有限number・文字列・hex BLOB、NULを含むTEXT用の限定した`CAST(X'hex' AS TEXT)`と、旧Wranglerの限定されたCR/LF `replace(...,char(...))`を扱う。CASTのhexはUTF-8として厳密に検証する。ATTACH、任意PRAGMA、DDL、UPDATE、その他の関数・式・追加statement・重複columnは拒否する。UTF-8不正、途中切れ、文の上限超過も拒否する。

復元先は新規ファイルだけに限定する。versioned migrationを一つのtransactionで適用し、隔離先のtriggerだけを一時除去する。生成済みpurgeOrderでseed行を削除し、FKをdeferした同じtransactionでdataをimport、同一triggerを再作成、FK検査・FTS rebuild/integrity-checkを行う。稼働D1のtriggerは外さない。quota/ref/physical等をtriggerで二重加算せず、元の値を保存する。committed/failedのterminal履歴も書き換えない。

復元後もbackup freezeを保持し、control更新が拒否されることを確認する。`restore-offline`は別DBの確認用ファイルを作るだけで、旧epochのまま稼働再開するコマンドではない。ControlDOによる新epoch、R2実体、認可・operation由来・会計・共有等の全監査がlive復旧には必要である。

## R2への保存・ダウンロード

`publish`はローカル世代の全検証を通してからR2を読み書きする。SQLを8MiB単位（最後だけ短くできる）の通常objectへ分割し、最大131,072個・合計1TiBに制限する。圧縮やSQLの書換えはせず、ダウンロード時に元のbyte列へ連結する。multipart uploadは使わない。manifestは最大16MiB。これはCLIの対応上限であり、最大容量での実運用性能を実証した値ではない。

保存keyは`sys/backups/v1/UUID/parts/000000-SHA256.bin`と`sys/backups/v1/UUID/manifest.json`に限定する。partは順序番号・内容hash、manifestは世代IDに束縛する。transport manifest v1は元の論理manifest、固定chunkBytes、順序付きのpart byte数/SHA-256を持ち、任意のkeyやURLを含めない。JSONのobject keyは決定的な順序で保存する。

保存前にGETで既存byte列を照合し、不在の場合だけ`If-None-Match: *`付きでPUTする。PUT後は必ずGETして一致を確認する。応答を失った場合も、実際に一致したobjectだけを採用する。全partとSQL全体のhashを確認した後に、manifestを最後に確定・読み戻す。既存内容が異なる世代を上書きせず、同じ世代の再実行では一致済みpartを再利用する。保存中のローカルSQL変更も検査する。

`download`はmanifestの形・世代ID・part数/サイズ/順序を検査し、一つずつchecksumを照合して新規ディレクトリへ取り込む。その後、元の`verify`と同じschema/FK/FTS/全行hash検証を通った世代だけを確定する。既存のダウンロード先を置換しない。`--manifest-sha256`にはpublishの最終JSONが返す`manifestSha256`を指定できる。別途信頼できる場所に記録した値との照合であり、署名ではない。

localは指定configの`BACKUPS` bindingを使う。Wranglerの`remoteBindings: false`と`envFiles: []`を明示し、configがremote bindingを指定していてもlocalで操作する。remoteは`--local --config CONFIG`を`--remote`へ置き換え、次の環境変数を設定する。remoteでconfig/environmentは受け付けない。

| 環境変数 | 用途 |
|---|---|
| `R2_BACKUP_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BACKUP_BUCKET` | private backup bucket名 |
| `R2_BACKUP_JURISDICTION` | `default`（既定）、`eu`、`us`、`fedramp` |
| `R2_BACKUP_ACCESS_KEY_ID` | 対象bucketのobject読取り・書込み資格情報 |
| `R2_BACKUP_SECRET_ACCESS_KEY` | 対応するsecret。コマンド引数やログへ記載しない |

remoteの接続先は上記account/bucketから生成する固定R2 S3 endpointに限る。署名付きGETと条件付きPUTだけを使い、redirectとtransportの自動retryはしない。署名から本文読取りまで1要求60秒、object本文の実byte数も制限する。GET404だけを不在、PUT412だけを条件競合として扱い、それ以外の通信失敗を不在に読み替えない。providerの本文・signed URL・資格情報をエラーへ含めない。

APIの根拠はCloudflareの[R2 S3互換性](https://developers.cloudflare.com/r2/api/s3/api/)、[R2制限](https://developers.cloudflare.com/r2/platform/limits/)、[Wrangler API](https://developers.cloudflare.com/workers/wrangler/api/)。署名・異常応答はfake transport、条件付き書込みと一連のCLIは実local R2で検証した。remote R2の相互運用は未検証である。

途中失敗のpartは残し、再実行で照合する。delete/list、保存期限、世代の自動回収はまだ実装しない。遅延したPUTがあり得るため、経過時間だけで未完了partを消さない。このCLIによる上書き拒否はbucket全体のObject Lock保証ではない。保存先の真正性はprivate bucketと運用資格情報の管理に依存する。

保存対象はD1の論理SQLであり、元の`BLOBS` object本体は含まない。publish単独では元DBのbarrierを解除せず、`backup_runs.completed`を更新しない。runは[completeBackup](BACKUP_COMPLETION.md)で実BACKUPS bindingの世代とpartを照合し、完了receiptと解除を原子的に確定する。元BLOBSの削除猶予は[GC保護](BACKUP_GC_PROTECTION.md)を参照。保持判定は[health](BACKUP_RETENTION.md)へ接続済み。自動補充/削除、元BLOBSの独立保管、live復元は後続。

local R2の永続先は指定configの親ディレクトリから`.wrangler/state/v3`へ固定する。getPlatformProxyの既定値は呼出しcwdを基準にするため、configを別ディレクトリに置くとWrangler devと異なる保存先になっていた。runの完了照合でこの相違を検出し修正した。従来の別cwdへのlocal保存物を自動移動せず、必要なら検証済み世代を正しいconfigで再publishする。remote保存先は変更しない。

## 失敗・再実行・信頼の境界

検証完了まで一時ディレクトリに保存し、成功後だけ世代ディレクトリへrenameする。同じUUIDの世代や既存の復元先ファイルを上書きしない。失敗時は自分が作った一時出力だけを除去し、元DBや元barrierを変更しない。ローカルの同一世代処理はexclusive lock fileで直列化する。プロセス強制終了でlockが残った場合は、元の処理が終了していることを確認してから運用で処理する。時間切れを根拠に自動でlockやbarrierを解除しない。

checksumは破損検出であり署名ではない。manifestを含めて書き換えられる保存先の真正性や、power loss後の耐久性、R2世代公開の成功はこのローカル検証だけでは証明しない。CLIは元SQL・node値・providerのsigned URLをログへ出さず、段階と固定エラーcodeを返す。生成完了はbackup_runsの`completed`への更新ではない。

検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。製品全体の完了条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)を維持する。
