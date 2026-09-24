# Next-cloud-flare

Cloudflare 上で動かすセルフホスト型ファイル管理アプリ。仕様は
[設計書](docs/DESIGN.md)、実装順序は [実装ブリーフ](docs/IMPLEMENTATION_BRIEF.md) を参照。

**別セッションでの再開は [引き継ぎ資料](docs/HANDOFF.md) から。** 実装済み・未実装・検証済み・未検証の一覧は [現在状態](docs/CURRENT_STATE.md) にまとめています。

現在は **Phase 0 のローカル検証基盤、Phase 1 の大半、Phase 2 / WebDAV / Phase 3 の一部**を実装済み。
67通常テーブル、migration `0001`〜`0037`、147経路の契約があり、主要なFiles REST/WebDAV mutation、trash/restore/purge、fenced R2 GC、content ticket/blob配信、private単一・分割アップロードまでローカル接続しています。
アップロードは予約・R2送信・原子的確定・中止・既知IDの期限切れ回収を実装し、[private HTTP](docs/UPLOAD_HTTP.md)から接続しています。未知の完成済みobjectは[隔離・35日後の回収](docs/ORPHAN_INVENTORY.md)まで接続しています。既存uploadの未知multipart IDは[永続走査・中止](docs/MULTIPART_INVENTORY.md)まで接続しました。upload行が失われたhandleの[全bucket走査・中止とpart容量保留](docs/MULTIPART_BUCKET_INVENTORY.md)も接続しました。完全な閉鎖証明と予約・保留容量の精算は未完了です。[Files UI](docs/FILES_UI.md)の一覧・操作・再開uploadはローカルAPIに接続済みです。ControlDOは[全監査後の受付・GC段階再開](docs/CONTROL_ADMISSION.md)をローカル実装済みです。実環境の受付再開・配備は未実施で、製品としてはまだ利用できません。
[共通の更新受付](docs/MUTATION_ADMISSION.md)は、namespace・DAVロック・app password更新・session登録/初回owner/logout・配信budgetとticketの発行/交換/取消し・upload新規予約・単一送信開始/読戻し/検証済み情報・multipart初期化/complete送信claim/検証済み情報・利用者によるupload中止を同時32件・待機256件で制御します。更新と確定記録・枠解放を一括保存します。同じ要求IDのupload予約再取得は枠を増やさず、混雑中も利用できます。以下の復旧処理とQueueも同じ枠を使います。旧epoch repairも接続済みで、[backup barrier](docs/BACKUP_BARRIER.md)をローカル実装し、logical export/restore drillは開発中です。
物理容量の観測、multipartのHEAD予算・既知R2 ID・初期化停止・緊急abort予算を共通受付へ接続しました。復旧用の内部RPCも通常操作・bootstrapと同じ32 active/256 waiting・5秒期限を使います。安定したopen/closed状態のD1 mirrorを確認し、失効・owner無効化・maintenance後の必要な事実を記録できます。 migration0033でsystem/modeを不変にし、通常操作・namespace permitへの流用を拒否します。停止・再開・epoch更新で古い枠を閉じます。DB-onlyの応答喪失はexact receiptで回収し、外部HEAD/abortはclaim batchの直接ACKだけで許可します。結果不明や混雑でも予約容量を推測で返しません。
UploadDOの台帳初期化・通常の台帳反映・停止時の反映・台帳喪失時の停止を共通受付へ接続しました。初期化と通常反映は現在の利用者認可、停止反映と喪失処理は復旧用system受付を使い、すべて同じ32 active/256 waiting枠を共有します。 初期化markerや部品送信につながる台帳反映は、D1 batchの直接ACKがなければローカル台帳を確定せず、送信許可も返しません。混雑・rollback・応答喪失でもdirty行、アラーム、予約容量を保持します。台帳全喪失では停止記録を回収できても再初期化しません。
単一・分割アップロードの自動回収を共通の復旧用受付へ接続しました。停止claim、HEAD/abort予算、物理観測、既知handleの閉鎖、容量精算・GC引渡し、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 停止claimは正確なcleanup tokenで回収できますが、外部HEAD/abortは予算batchの直接ACKが必要です。確定済みDB記録はexact receiptで照合し、他の回収処理の終端記録で自分の未確定枠を返しません。待機・遅いACKで実行時間を超えた場合は外部送信を止め、予約・leaseを保持します。ControlDO内の復旧は同じinstanceの受付を直接使い、自己RPCや別枠を作りません。
台帳に登録済みのファイルを対象に、GC（不要ファイルの物理回収）の通常実行・停止中の回収・ゴミ箱復元中の回収を共通system受付へ接続しました。claim、delete/HEAD予算、完了精算、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 deleteとHEADはそれぞれ予算batchの直接ACKが必要です。受付待ちと遅いACKの後も実行期限を確認し、pin・参照・未精算upload・lease・epoch/mode・復元token/operation/期限を再検査します。待機後のSQL時計で60秒leaseを設定し、失敗したclaimも処理上限に数えます。DB-onlyのexact receipt回収と完全な終端照合を維持し、他の回収処理の成功で自分の未確定枠を返しません。
既存upload行に紐づく未知multipart IDの調査・回収を共通system受付へ接続しました。走査の再初期化、外部呼出し予算、物理観測、遅れて判明したID、ページ保存、中止確認、lease返却、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 待機後にfreshなR2/S3対応証明、epoch/pause、cleanup token/lease、scan round・cursor、pin/refを同じbatchで再検査します。HEAD・S3一覧・abortはそれぞれ予算batchの直接ACKが必要で、受付待ちと遅いACKの後も実行期限を確認します。DB-onlyのexact receipt回収と既存の厳密なscan/中止照合を維持し、全ページ取得やhandle中止だけでは予約容量を返しません。
Queueの送信・受信処理を共通system受付へ接続しました。送信claim、送信前の確認、送信済み記録、受信claim、処理完了が通常操作と同じ32 active/256 waiting枠を使います。受付対象は元operationの所有spaceで、通知を起こしたactorのspaceと混同しません。 待機後にepoch/maintenance、正確なtokenとlease、受信側の現行credential・認可・元operationの証明を再検査します。DB-onlyの記録はexact receiptで回収しますが、今回のQueue送信には別受付と直接ACKが必要です。送信応答を失った通知はlease後に同じIDで再送でき、確定済みcompleted/failedの再配信は追加受付なしで確認します。Cron・Queue batchは共通の25秒期限を使い、未処理メッセージをretryします。
所有者を持たないR2接続確認を共通受付へ接続しました。専用global RPCは通常操作・初回登録・所有者付きsystem更新と同じ32 active/256 waiting枠を使い、架空のownerや別枠を作りません。 migration0034で既存の全確定記録、受付sequence、外部キー、索引と60秒保持を維持します。globalのscopeは明示nullで、owner/system・bootstrap・namespace許可への流用を拒否します。R2確認のclaim・各GET/条件付きPUT/S3読取り予算は直接ACKと固定25秒の開始期限が必要です。段階記録・終了はDB-onlyのexact receiptで回収し、待機後のnonce/source/token・元の60秒lease・epoch/pauseを再確認します。エラー記録も同じ確定記録方式を使い、現epoch/pauseと自己nonce/source/tokenで制限します。期限切れ後のエラー記録でも容量を返しません。ControlDO内は同一instanceの受付を使います。
未追跡の完成済みR2 objectの調査・回収を共通global受付へ接続しました。scanのclaim・外部予算・観測・ページ保存・lease返却と、GCのclaim・外部予算・置換観測・削除確定・エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 owner不在でもscopeは明示nullで、架空のspaceを作りません。待機後にepoch/mode/pause、元のtoken・60秒lease、object世代・全catalogueからの独立を再検査します。LIST・HEAD・deleteは各回の直接ACKが必要で、既定20秒/最大25秒の開始期限を受付後とACK後に確認します。DB-onlyの確定記録と既存の厳密なtoken/終端照合を維持し、他の処理の完了で自分の未確定枠を返しません。35日猶予・後日owner復元・不在確認後だけのphysical精算を維持し、ControlDO内部は同じinstanceの受付を使います。

全bucketの未完了multipart調査・中止を共通global受付へ接続しました。scanとpartの開始・外部予算・ページ保存、中止の開始・結果保存の8経路が、通常操作と同じ32 active/256 waiting枠を使います。 所有者が未復元でもscopeは明示nullです。受付待ち後にfresh proof・epoch/mode/pauseとscan/partの元のround・cursorを再検査します。S3一覧とR2 abortは直接ACK後だけ送信し、probe開始から固定25秒の開始期限を受付後・ACK後にも検査します。初期化と中止結果のDB-only更新は自分の確定記録だけを照合し、一覧の結果付きbatchは応答喪失時に推測で成功を返しません。同じ中止attemptは再送せず、64回の生涯上限と容量保留を維持します。ControlDO内部は同じinstanceの受付を使います。

WebDAV PUTは本文保存後に公開用の30秒permitを取得する方式へ変更しました。31秒を超える実転送でも公開でき、本文受信中にnamespace permitや共通更新枠を保持しません。 詳細は[DAV PUTの保存台帳](docs/DAV_UPLOAD.md)。

バックアップ専用の書込み停止をControlDOへ接続しました。通常操作・内部復旧・KDFの新規受付を止め、通常67テーブルを凍結して、同じバックアップ要求だけで解除します。 詳細は[バックアップ書込み停止](docs/BACKUP_BARRIER.md)。

バックアップ生成・整合性検証・新規ファイルへのオフライン復元コマンドを追加しました。凍結中のDBと全67テーブルの内容が一致した世代だけをローカル保存します。 手順と残る運用範囲は[バックアップ世代](docs/BACKUP_GENERATIONS.md)。

単一・分割uploadで公開operationの失敗が確定した後の精算を共通system受付へ接続しました。実際の所有spaceで通常操作と同じ32 active/256 waiting枠を取得し、upload・blob・予約解放・確定記録を一つのbatchで保存します。 詳細は[公開失敗後の精算](docs/UPLOAD_FAILED_COMPLETION.md)。

旧epochの予約解放・Outbox通知の停止・検索索引の再構築を共通受付へ接続しました。予約と通知は実際の所有space、索引再構築は明示null scopeで、通常操作と同じ32 active/256 waiting枠を使います。 修復の前後は従来どおり全更新の停止を要求します。更新batch内だけは自分の有効な受付IDを除外し、他のactive/waiting、permit・claim・job・GC・uploadとbootstrap管理者の条件を待機後に原子的に再検査します。自分の枠が空いても他の更新が残れば修復しません。DB-onlyの確定記録と厳密な終端・索引照合で応答喪失を扱い、他の処理の完了では自分の未確定枠を返しません。uploadへ結び付いた予約は保持し、元の行・所有者・通知のoperation由来を再検査します。予約・通知は1回最大20件、次の更新開始には固定25秒の期限を使い、ControlDO内部は同じinstanceで受け付けます。
詳細は [Foundation 実装契約](docs/FOUNDATION.md) を参照してください。

| 資料 | 用途 |
|---|---|
| [HANDOFF](docs/HANDOFF.md) | セッション再開の入口・直近の作業順序 |
| [CURRENT_STATE](docs/CURRENT_STATE.md) | 実装/検証の4区分、未完了一覧、セッション間の固定事項 |
| [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md) | 実装状況・検証記録・未完了 gate |
| [FOUNDATION](docs/FOUNDATION.md) | 現在の内部サービスと DB の契約 |
| [FILES_UI](docs/FILES_UI.md) | Files画面、再開upload、private assets、browser試験と残る制約 |
| [UPLOAD_HTTP](docs/UPLOAD_HTTP.md) | private単一/分割アップロードのHTTPと再送契約 |
| [ORPHAN_INVENTORY](docs/ORPHAN_INVENTORY.md) | 未追跡の完成済みobjectの隔離・会計・35日回収 |
| [CONTROL_ADMISSION](docs/CONTROL_ADMISSION.md) | 停止・全監査・受付とGCの段階再開 |
| [UPLOAD_OVERWRITE](docs/UPLOAD_OVERWRITE.md) | 確認付き上書き・競合拒否・元fileからの再開 |
| [BUDGET_ALLOWANCE](docs/BUDGET_ALLOWANCE.md) | 配信対象の重複排除と共有budgetの使用量保持 |
| [FOLDER_STATS](docs/FOLDER_STATS.md) | 要求時のファイル数・合計サイズと集計上限 |
| [SEARCH](docs/SEARCH.md) | フォルダー配下の検索・署名cursor・範囲と件数の上限 |
| [CONTENT_LEASES](docs/CONTENT_LEASES.md) | 配信期限の伝播・取消し・旧leaseの保持 |
| [EMPTY_HTTP_BODY](docs/EMPTY_HTTP_BODY.md) | 本文なしHTTP操作の判定・期限・実通信試験 |
| [KDF_ADMISSION](docs/KDF_ADMISSION.md) | app password計算のisolate内実行制限と残る全体制御 |
| [RESTORE_GC](docs/RESTORE_GC.md) | GC稼働中のごみ箱復元・期限付き停止と解放 |
| [GC_RECOVERY](docs/GC_RECOVERY.md) | 停止中の既存GC回収と復旧監査 |
| [MULTIPART_BUCKET_INVENTORY](docs/MULTIPART_BUCKET_INVENTORY.md) | upload行喪失時の未完了handle走査・part容量保留・復旧gate |
| [MULTIPART_INVENTORY](docs/MULTIPART_INVENTORY.md) | S3未完了multipart/part/lifecycleの診断と修復前提 |
| [OUTBOX](docs/OUTBOX.md) | Queueの共通受付・確定記録・ID再送と固定batch期限 |
| [IMPLEMENTATION_BRIEF](docs/IMPLEMENTATION_BRIEF.md) | 全体の実装順序・R6 確定条件 |
| [DESIGN](docs/DESIGN.md) | 製品全体の設計・受入条件 |
| [MEDIA_FORMATS](docs/MEDIA_FORMATS.md) | AVIF・AV1・Opus の追加要件 |
| [REVIEW_LOG](docs/REVIEW_LOG.md) | 過去レビューの経緯。関連箇所だけ参照 |

## 開発

Node **24.21.0** / pnpm **12.4.1** を使用します。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

`pnpm dev` はローカル binding だけを使用します。`wrangler.jsonc` の resource ID はローカル専用です。
リモート DB、bucket、Access policy の作成・配備は行いません。

| コマンド | 内容 |
|---|---|
| `pnpm lint` / `pnpm typecheck` | 静的検査 |
| `pnpm test:unit` | Node / SQLite 単体テスト |
| `pnpm test:integration` | assets build 後、workerd の D1 / R2 / DO / Images を検証 |
| `pnpm test:browser` | 隔離したlocal Worker/D1/R2とChromiumでFiles画面を検証 |
| `pnpm verify:contracts` | バージョン固定・公開日・上限・禁止 API の検査 |
| `pnpm verify:config` | ローカル binding と外部公開設定の検査 |
| `pnpm build` | Web build と Worker の dry-run bundle |
| `pnpm check` | 上記の検査・テスト・build を一括実行 |

`.dev.vars*`、`.env*`、`.wrangler/` は Git 対象外です。
`pnpm test:browser` は隔離したローカル状態を使う別検証で、`pnpm check` には含みません。

## 検証の範囲

D1 の全 rollback、G01 の3反例、commit 応答喪失、permit/session/epoch の commit 述語、
95MB ストリーム、SHA-256、Range、ZIP STORE、PBKDF2、binding のローカル検証を含みます。
JWT/JWKS の失敗境界、bootstrap の競合/応答喪失、4 principal の node 認可と失効対 commit も検証しています。

Cloudflare 上の実 D1、ネットワーク障害、Images の実サービス制限・codec・費用、
Access、環境分離、Queue retention は staging gate に残っています。
ローカルテスト合格を Phase 0 全体や製品機能のリリース判定には使いません。
詳細と次の作業は [進捗・復旧手順](docs/IMPLEMENTATION_STATUS.md) に記録しています。
