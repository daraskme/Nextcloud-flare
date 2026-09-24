# Next-cloud-flare

Cloudflare 上で動かすセルフホスト型ファイル管理アプリ。仕様は
[設計書](docs/DESIGN.md)、実装順序は [実装ブリーフ](docs/IMPLEMENTATION_BRIEF.md) を参照。

**別セッションでの再開は [引き継ぎ資料](docs/HANDOFF.md) から。** 実装済み・未実装・検証済み・未検証の一覧は [現在状態](docs/CURRENT_STATE.md) にまとめています。

現在は **Phase 0 のローカル検証基盤、Phase 1 の大半、Phase 2 / WebDAV / Phase 3 の一部**を実装済み。
67通常テーブル、migration `0001`〜`0033`、147経路の契約があり、主要なFiles REST/WebDAV mutation、trash/restore/purge、fenced R2 GC、content ticket/blob配信、private単一・分割アップロードまでローカル接続しています。
アップロードは予約・R2送信・原子的確定・中止・既知IDの期限切れ回収を実装し、[private HTTP](docs/UPLOAD_HTTP.md)から接続しています。未知の完成済みobjectは[隔離・35日後の回収](docs/ORPHAN_INVENTORY.md)まで接続しています。既存uploadの未知multipart IDは[永続走査・中止](docs/MULTIPART_INVENTORY.md)まで接続しました。upload行が失われたhandleの[全bucket走査・中止とpart容量保留](docs/MULTIPART_BUCKET_INVENTORY.md)も接続しました。完全な閉鎖証明と予約・保留容量の精算は未完了です。[Files UI](docs/FILES_UI.md)の一覧・操作・再開uploadはローカルAPIに接続済みです。ControlDOは[全監査後の受付・GC段階再開](docs/CONTROL_ADMISSION.md)をローカル実装済みです。実環境の受付再開・配備は未実施で、製品としてはまだ利用できません。
[共通の更新受付](docs/MUTATION_ADMISSION.md)は、namespace・DAVロック・app password更新・session登録/初回owner/logout・配信budgetとticketの発行/交換/取消し・upload新規予約・単一送信開始/読戻し/検証済み情報・multipart初期化/complete送信claim/検証済み情報・利用者によるupload中止を同時32件・待機256件で制御します。更新と確定記録・枠解放を一括保存します。同じ要求IDのupload予約再取得は枠を増やさず、混雑中も利用できます。残るinventory/Queue・backupなどの経路への接続は続けて開発しています。
物理容量の観測、multipartのHEAD予算・既知R2 ID・初期化停止・緊急abort予算を共通受付へ接続しました。復旧用の内部RPCも通常操作・bootstrapと同じ32 active/256 waiting・5秒期限を使います。安定したopen/closed状態のD1 mirrorを確認し、失効・owner無効化・maintenance後の必要な事実を記録できます。 migration0033でsystem/modeを不変にし、通常操作・namespace permitへの流用を拒否します。停止・再開・epoch更新で古い枠を閉じます。DB-onlyの応答喪失はexact receiptで回収し、外部HEAD/abortはclaim batchの直接ACKだけで許可します。結果不明や混雑でも予約容量を推測で返しません。
UploadDOの台帳初期化・通常の台帳反映・停止時の反映・台帳喪失時の停止を共通受付へ接続しました。初期化と通常反映は現在の利用者認可、停止反映と喪失処理は復旧用system受付を使い、すべて同じ32 active/256 waiting枠を共有します。 初期化markerや部品送信につながる台帳反映は、D1 batchの直接ACKがなければローカル台帳を確定せず、送信許可も返しません。混雑・rollback・応答喪失でもdirty行、アラーム、予約容量を保持します。台帳全喪失では停止記録を回収できても再初期化しません。
単一・分割アップロードの自動回収を共通の復旧用受付へ接続しました。停止claim、HEAD/abort予算、物理観測、既知handleの閉鎖、容量精算・GC引渡し、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 停止claimは正確なcleanup tokenで回収できますが、外部HEAD/abortは予算batchの直接ACKが必要です。確定済みDB記録はexact receiptで照合し、他の回収処理の終端記録で自分の未確定枠を返しません。待機・遅いACKで実行時間を超えた場合は外部送信を止め、予約・leaseを保持します。ControlDO内の復旧は同じinstanceの受付を直接使い、自己RPCや別枠を作りません。
台帳に登録済みのファイルを対象に、GC（不要ファイルの物理回収）の通常実行・停止中の回収・ゴミ箱復元中の回収を共通system受付へ接続しました。claim、delete/HEAD予算、完了精算、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 deleteとHEADはそれぞれ予算batchの直接ACKが必要です。受付待ちと遅いACKの後も実行期限を確認し、pin・参照・未精算upload・lease・epoch/mode・復元token/operation/期限を再検査します。待機後のSQL時計で60秒leaseを設定し、失敗したclaimも処理上限に数えます。DB-onlyのexact receipt回収と完全な終端照合を維持し、他の回収処理の成功で自分の未確定枠を返しません。
既存upload行に紐づく未知multipart IDの調査・回収を共通system受付へ接続しました。走査の再初期化、外部呼出し予算、物理観測、遅れて判明したID、ページ保存、中止確認、lease返却、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 待機後にfreshなR2/S3対応証明、epoch/pause、cleanup token/lease、scan round・cursor、pin/refを同じbatchで再検査します。HEAD・S3一覧・abortはそれぞれ予算batchの直接ACKが必要で、受付待ちと遅いACKの後も実行期限を確認します。DB-onlyのexact receipt回収と既存の厳密なscan/中止照合を維持し、全ページ取得やhandle中止だけでは予約容量を返しません。
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
