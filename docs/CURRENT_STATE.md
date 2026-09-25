# 現在の実装・検証状態

更新日: 2026-09-25

直近の到達点は[PROGRESS](PROGRESS.md)。直前commit `6711235`の[CI36076928005](https://github.com/daraskme/Nextcloud-flare/actions/runs/36076928005)は全5ジョブ成功。Node527・workerd2,009（Windowsは1,034+975）・browser19、重複を除く計2,555件と実CLI復元ドリルが成功しました。Ubuntu7m33s、Windows1/2は13m59s・2/2は10m39s、backup2m33s、browser2m12sです。今回の運用コマンドはこのCIに含まれません。 専用BackupOperator service bindingと、run/receipt/cancelの運用コマンドを追加しました。runは同じUUID/epochで停止→抽出→全SQL検証→R2保存→完了記録を呼び出し、失敗時は自動中止せず同じ世代から継続します。 検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

この文書は、実装済み・未実装・検証済み・未検証をセッション間で共有するための入口である。実際の作業ツリー、最新commit、CI結果は必ずコマンドで再確認する。詳細な実行履歴は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、次回作業の注意事項は [HANDOFF](HANDOFF.md)、製品全体の完了条件は [DESIGN](DESIGN.md) と [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) を正とする。

## 状態の意味

| 状態 | 意味 |
|---|---|
| 実装済み | repository内に本体と接続経路がある。ただしリモート公開済みとは限らない |
| 検証済み（local） | Node/SQLiteまたはworkerdのD1/R2/DO/Imagesで自動試験済み |
| 検証済み（CI） | GitHub ActionsのUbuntu/Windowsでrepository全checkが成功済み |
| 未検証（staging） | 実Cloudflare resource、Access、Queue、ネットワーク、browser等の試験が残る |
| 未実装 | 必要なサービス、UI、運用処理、または接続経路がまだない |

ローカル成功はstagingやproductionの成功を意味しない。現在productionへのmigration・deployは行っていない。

## 実装済みでローカル検証済み

| 分野 | 実装済みの範囲 | 検証済みの範囲 | 残る境界 |
|---|---|---|---|
| バックアップ運用コマンド | 専用capability、run/receipt/cancel、再実行と失敗時の停止維持 | Node25件を追加し、全552件（33file、19.71s）が成功しました。専用bindingの実ControlDO/D1/R2ドリルは67table・SQL9,613bytesで成功し、全4操作の権限/環境/無効化、eviction後の再実行、取消・履歴、復元先のFTS/会計を確認しました。R2保存先修正後の実CLI run→receipt→download→restore-offlineもSQL9,110bytesで成功し、同じ引数の再実行と元policyへの復帰を確認しています。従来CLIのcapture/publish/download/restore-offlineも修正後に67table・SQL9,599bytesで成功しました。全体checkも成功し、Node552件＋workerd2,009件（95file）の計2,561件、lint・型・契約・設定検査、Web buildとWorker dry-runを確認しました。 | 専用service bindingを持つ運用者だけがSQL検証済みhashを証言します。remote Cloudflareの認証・権限・実resourceによる運用検証は未実施です。日次実行・保持管理、元BLOBS保護、live復旧、全storage喪失からの運用復旧は未完了です。 |
| バックアップ完了記録 | 内部completeBackup、R2実体/cursor照合、D1 receiptと元policyへの原子的復帰、migration0038 | Node22件・workerd18件を追加し、全体checkが成功しました。Node527件（32file、14.22s）・workerd2,009件（95file、1,085.53s）、計2,536件を検証しています。lint335file・型・契約/設定検査・Web build・Worker dry-runも成功。schema0038で実CLIのcapture→verify→local R2 publish→download→restore-offlineが67table・SQL9,599bytesで成功しました。今回commitのCI/browserはプッシュ後に確認します。 | completeBackupは内部RPCです。SQL/source/schema/FK/FTSの全検証は信頼された生成コマンドが担い、ControlDOはそのhashでR2実体を再検査します。利用者が指定したhashを転送する公開APIは追加していません。remote運用の認証・権限検証、元BLOBSの保護、live復旧、全storage喪失からの運用復旧は未完了です。 |
| バックアップR2保存・取得 | 条件付きpart保存、manifest最終確定、応答喪失照合、download後の全検証 | 実CLI/local R2の保存・取得・隔離復元。8MiB超の複数part、再開、ACK喪失、同時公開、改変/欠落、期限・本文上限・署名を試験 | 保存対象はD1の論理SQL。remoteの運用接続検証、BLOBS本体の保護、日次実行・保持管理・live復旧は後続。remote S3は実装済み・実環境未検証。 |
| バックアップ世代・オフライン復元 | 実Wrangler抽出、全行/hash/schema/FK/FTS照合、ローカル世代保存、新規DB復元 | schema0038・全67tableの実CLIドリルで元DBの凍結保持、容量、FTS検索を確認。欠落/内容変化、不正SQL、checksum不一致、既存出力保護、UTF-8/文上限を試験 | 旧version/全データ形式の互換性、Time Travel・live restoreの新epoch/全監査、backup中の全storage喪失からの運用復旧は後続。 |
| バックアップ書込み停止 | 専用永続intent、全通常table凍結、watermark、元policyへの原子的復帰 | 全table guard、旧schema移行、確定順序、ACK/primary喪失、遅延開始/解除、全storage喪失、rollback。実ControlDOの完了記録は上記の通り検証 | 内部RPCとCLIを認証付き運用処理で接続する一連のドリル、停止中の全ControlDO喪失からの運用復旧は後続。 |
| DAVの転送と公開の分離 | 本文後のfresh30秒permit、開始受付、未結合記録の回収 | Node3件・workerd25件を追加。全体checkが成功し、Node427件（26file、6.34s）・workerd1,970件（93file、1,051.32s）、計2,397件を検証しました。31秒転送、元の認可・revision・lock維持、実ControlDOの共有枠・停止・eviction、未結合台帳の回収競合、前方移行を含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。schema0036/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。 | 旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。 |
| DAV PUTの保存台帳 | 送信前の永続記録・共通受付・未知結果の容量保留・回収/GC | Node2件・workerd47件を追加。全体実行はNode424件（25file、6.25s）・workerd1,944/1,945件（91file、1,010.68s）成功。唯一の失敗は移行数の旧期待値34で、35へ修正後に実D1のschema5件（2.71s）が全成功しました。ローカル計2,369件を検証済みです。最終lint・型・契約/設定・Web build・Worker dry-runも成功。Windows分割は実Vitestの91fileを46/45fileへ重複・欠落なしと確認し、CIでの実行結果は別途確認します。schema0035/通常67table、依存追加なし。 | 旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。 |
| upload公開失敗後の精算受付 | 実ownerの共通枠・物理計上証明・GC後の再照会 | workerd51件を追加（境界46件・実ControlDO4件・HTTP1件）。関連109件（66.06s）と実ControlDO4件に加え、全体checkが成功。Node422件（25file、6.20s）・workerd1,898件（87file、990.88s）、計2,320件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 | 旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。 |
| 旧epoch修復の全体受付 | 予約・通知・FTS、厳密な停止条件と自分の枠だけの例外 | workerd67件を追加（境界59件・実ControlDO8件）。追加67件（14.72s）・既存復旧23件（12.96s）と全体checkが成功。Node422件（25file、5.81s）・workerd1,847件（85file、983.56s）、計2,269件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 全体check後にCI試験を調整し、KDF統合20件（7.15s）・待機列Node8件（104ms）・lint・型検査を再確認しました。 | 旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。 |
| 全bucket multipartの全体受付 | scan/parts/abortの8経路、null scope、直接ACK、同一ControlDO | workerd82件を追加（境界73件・実ControlDO9件）。関連109件（97.66s）と全体checkが成功。Node422件（25file、5.68s）・workerd1,780件（83file、971.26s）、計2,202件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 | 旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| 未追跡object調査・回収の全体受付 | scan/GCの10経路、null scope、直接ACK、同一ControlDO | workerd105件追加（境界93件・実ControlDO12件）。全体check成功、Node422件（25file、6.01s）・workerd1,698件（81file、888.73s）、計2,120件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 | 全bucket multipart inventory・旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| 所有者なし更新の全体受付 | migration0034・global RPC・R2 probe、通常と同じ枠 | Node6件・workerd68件追加（probe境界58件・実ControlDO等9件・移行1件）。全体check成功、Node422件（25file、6.04秒）・workerd1,593件（79file、851.58秒）、計2,015件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。診断表示の追加後も関連59件（44.02秒）と型検査が成功。schema0034/通常67table、依存追加なし。 | orphan/全bucket inventory・旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| 既存uploadの未知multipart調査受付 | round・予算・観測・ID/page・中止receipt・lease返却・エラー、同一ControlDO受付 | workerd66件追加（境界59件・実ControlDO7件）。全体check成功、Node416件（25file、5.90秒）・workerd1,468件（75file、755.11秒）、計1,884件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 | orphan/全bucket inventory・旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| blob GCの全体受付 | 通常/停止中/復元中、claim・外部予算・精算・エラー、同一ControlDO受付 | workerd80件追加（GC境界73件・実ControlDO7件）。全体check成功、Node416件（25file、5.66秒）・workerd1,402件（73file、705.27秒）、計1,818件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 | 残るorphan/multipart inventory・Queueの更新受付とbackup barrier、未知KDF/multipartの収束、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| upload自動回収の全体受付 | claim・外部予算・観測・閉鎖・精算・エラー、ControlDO直接受付 | workerd62件追加。90c4593のローカル全check成功、Node416/workerd1322、計1,738件。CIは冒頭参照。 | 残るinventory/Queueの更新受付とbackup barrier、未知KDF/multipartの収束、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。 |
| UploadDO台帳の全体受付 | 初期化・通常反映・停止反映・喪失時停止、共有枠と直接ACK | workerd33件追加。8892b4fのローカル全check成功、Node416/workerd1260、計1,676件。CIは冒頭参照。 | 残るinventory・Queue/backupと実環境は後続 |
| 復旧用更新の全体受付 | migration0033、通常と同じ枠、物理観測・既知ID・初期化停止・外部claim | Node8件/workerd41件追加。f9dffcbのCI全成功、Node416/workerd1227/browser19、計1,662件。 | 残るinventory・Queue等の残る更新受付、backup barrier、未知KDF/multipartの収束、共有/メディア/実環境検証は後続です。 |
| upload中止/検証の全体受付 | single/multipart利用者中止、multipart検証済み情報、exact receiptと返却 | workerd45件追加。f62dad8のCI全成功、Node408/workerd1186/browser19、計1,613件。 | 残るinventory/Queue/backupは後続 |
| upload転送の全体受付 | 単一start/recover/verify、multipart start/completeの5経路、直接ACKによる外部送信とDB-only receipt回収を分離 | workerd45件追加。47160c4のCI全成功、Node408/workerd1141/browser19、計1,568件。 | 残るinventory/Queue/backupは後続 |
| upload予約の全体受付 | 単一/分割の新規予約、署名後取得、quota/blob/uploadと確定記録/解放を同一batch、既存receiptは読取りのみ | workerd42件追加、停止/失効/期限/quota/revision、全rollback、応答喪失、実ControlDO満杯での読取り・待機・返却 | 残るinventory/Queue/backupと実環境は後続 |
| 配信更新の全体受付 | budget・ticket発行/交換/取消し、共有もコンテンツ所有spaceで受付、変更/確定記録/解放を同一batch、取消し証明後のmanifest削除 | workerd70件追加、4 principal・実時計・停止/失効・応答喪失・遅延公開・実ControlDO32枠・HTTP503/CORS | upload転送/Queue/backup統合、実環境未検証 |
| Access sessionの更新受付 | migration0032、登録・初回owner・logout共有枠、既存JWTのread-only照合 | Node4/workerd22件追加、scope・移行・失効・応答喪失・実ControlDO待機、8e7243eのCI全成功 | 残る更新と実環境は未接続 |
| schema・契約 | migration `0001`〜`0038`、67通常table、FTS、147 route契約、FK graph、会計・状態遷移trigger | SQLiteとD1 migration、FK/CHECK/trigger、生成契約一致 | 全147 routeの機能実装は未完了 |
| 認証 | Access JWT/JWKS、user/service分離、bootstrap、session、logout、CSRF、app password | JWT失敗境界、鍵cache、bootstrap競合、session失効、PBKDF2 | 実Access/MFA policy、remote issuer/AUD/secret |
| KDF終了記録repair | DO SQLite最大20件の送信前/終端記録、DB精算再照合、停止中内部RPC、ローカル記録の復旧fence | 新規14件、既存認証・受付再開・GC停止の回帰、全check成功 | 証明喪失した未知試行の運用収束、実環境のrepair/restore drill |
| KDF実行制限 | Worker/ControlDO各1件・待機256件・5秒、D1の600回/65秒予算と未精算20枠、epoch cooldown、発行/認証/鍵更新と503応答 | 新規Node7件・workerd20件、既存認証34件、実ControlDO RPC/eviction/全喪失。詳細は[KDF_ADMISSION](KDF_ADMISSION.md) | 証明喪失試行の収束、共有password/IP制限、実CPU・処理量・切断 |
| 認可 | private/app-password/internal-share/anonymous-shareのnode authority、祖先検査 | 4 principal、失効対commit、別owner・削除祖先拒否 | 全operation・全routeのoperand tuple |
| namespace更新の全体受付 | migration0030、D1 active32/waiting256、ControlDO FIFO、LockDO全8許可経路、失効と最終commit fence | 新規Node4・workerd17件と全check成功。上限・再送・応答喪失・待機後認可・停止/復旧 | 他の更新経路・backup barrier・実負荷。[MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| DAVロックの全体受付・確定記録 | migration0031、LOCK/refresh/UNLOCKの共有枠、lock変更/記録/解放の一括確定、60秒保持 | Node4・workerd22件追加。実ControlDO待機、HTTP503、失効/停止、応答喪失、別処理のunlock、rollback、旧DB移行 | HTTP応答喪失後のtoken再取得・別RPCの結果再生は未実装。実環境未検証 |
| app password更新の全体受付 | 発行・失効・pepper更新の共有枠、KDF後取得、current authorityと確定記録/解放を同一batch | workerd32件追加。混雑HTTP503、失効/停止、ACK/readback喪失、root/20件上限、別owner拒否、実ControlDOのKDFと32枠 | 他のaccount更新とbackup統合、実環境未検証 |
| atomic mutation | operation claim/lookup、permit、LockDO、rollback、commit unknown収束 | 同時再送、競合、失効、応答喪失、全step rollback | 実ControlDO admission下のstaging試験 |
| Files UI | React/TanStackの一覧・操作・trash・確認付き上書き/再開upload・logout、認証付きprivate assets | ローカル実APIの19 browser scenario、NodeのCSRF競合4件 | 共有・media・実環境。検索は[SEARCH](SEARCH.md)。詳細は[FILES_UI](FILES_UI.md) |
| フォルダー集計 | Accessのaccount stats、所有folderの再帰件数/現在のlogical bytes、1万件上限と部分結果、Files情報dialog | D1の12件と検索9件の回帰、実APIでのbrowser集計/再集計/拒否時非表示。全check成功 | 実D1予算・負荷、共有/media別集計。[FOLDER_STATS](FOLDER_STATS.md) |
| 検索 | Access検索API、現行権限/祖先、名前の正規化、範囲10,000・page200、用途/条件付きcursor、Files検索と元の保存先の保持 | Node query/cursor、実D1階層・共有/削除/失効・旧索引・上限、実browser検索/上書き/201件pagination/世代競合 | media metadata parser/同期、索引version再構築運用、実D1予算。[SEARCH](SEARCH.md) |
| Files REST | node詳細、breadcrumb、children、folder作成、rename、trash、MOVE、COPY、operation照会 | 実D1/DO、cursor改変・期限・tree変更、Outbox provenance | 全route profile・実環境 |
| Trash | 一覧、restore、purge、別trash子退避、名前衝突解決、GC稼働中の永続pauseと既存削除drain | 最大64層・1,000 node、冪等再送、期限/識別子/停止競合、応答喪失・再起動、実browser復元 | 単一hold、実環境、大規模非同期trash/purge。詳細は[RESTORE_GC](RESTORE_GC.md) |
| 停止中GC drain | 旧deletingのみのblob/orphan回収、claim epoch・dispatch counter、ControlDO内部RPC、前後の監査初期化 | 応答喪失、停止/epoch/lease変更、遅延削除、二重精算防止、回収後の全復旧監査 | 外部置換objectの猶予、実R2・完全restore drill |
| GC | 7日猶予candidate、claim lease、pin/ref/pause fence、R2 delete/head、physical精算 | 実workerd R2、複数pin、pause、応答喪失、lease再取得 | unknown multipart ID、既知keyの不正置換、実Cron運用 |
| 未追跡object | D1のページcursor/lease、HEAD照合、隔離台帳、35日猶予、実physical会計、再利用拒否、Cronと停止中inventory | 応答喪失、同時走査/回収、置換・再出現、owner後日復元、pause/epoch、復旧監査 | incomplete multipart、他prefix、実R2運用 |
| multipart S3診断 | 署名付きListMultipartUploads/ListParts/GetBucketLifecycleConfiguration、1 GET/最大100件/1 MiB/10秒、停止中ControlDO診断 | XML/設定/署名/timeout/ページ失敗、実D1 fenceとControlDO監査再初期化、予約保持 | 全体不在証明・予約精算、実S3/lifecycle試験 |
| R2/S3対応検証 | migration `0023`、固定64-byte system probeのfresh nonce/CAS更新、scope付きD1 fence、ControlDO検証と復旧監査 | 実R2条件付きPUT、遅延create/更新、誤bucketの古い値、応答喪失、epoch/pause/lease、system容量保持 | multipart全体閉鎖・予約精算への接続、実S3試験 |
| 未追跡multipartの中止・容量保留 | migration `0027`/`0028`、全`u/`走査、正確なkey/ID照合、part最大観測bytesのphysical保留、発見handleの中止・不変receipt、停止中ControlDOと復旧fence | 観測27件と中止19件。ページ、並行処理、応答喪失、遅い応答、source/proof、所有者復元、64回上限、0-byte再開拒否 | 全体閉鎖・容量精算、実S3、Cron/HTTP。[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md) |
| multipart ID修復 | migration `0022`のscan/handle台帳、毎回freshなBLOBS/S3対応検証、既存uploadの全ID走査・abort・不変receipt・physical観測、停止中ControlDO repair | 複数ID/ページ、claim・page・receipt応答喪失、遅延ID、epoch/token/pin/lease、S3障害時の会計。対応検証と同一batchの失効境界 | 全体不在証明・予約精算、実S3、Cron |
| private単一upload | HMAC capability、D1予約、1回だけのR2 PUT、SHA-256、GETによる応答喪失回収、原子的新規作成/上書き、status/abort HTTP、24時間後のCron回収・GC接続 | 実D1/R2/LockDO、0 byte、同時送信、10 step rollback、失効、DB/R2応答喪失、CSRF/Origin、回収lease競合、旧epoch、実ControlDO停止中repair | 公開共有、未知object修復、stagingは未完了 |
| private multipart upload | D1予約・immutable geometry、R2一度限りcreate、UploadDO認可RPC・状態/part mirror、streaming part/SHA-256、4並列・3試行、R2一度限りcomplete/HEAD、原子的新規/上書き公開、terminal照合、既知R2 IDのabort/期限切れ回収・GC接続、HTTP create/part/status/page/complete/abort | D1/R2/DO/LockDO、64 MiB+末尾の公開、同時確定、応答喪失、storage全喪失、失効、10 step rollback、complete/abort排他 | 未知ID回収後の予約精算は未接続 |
| WebDAV | OPTIONS、GET/HEAD/Range、PROPFIND Depth 0/1、MKCOL、PROPPATCH、PUT、DELETE、COPY、MOVE、LOCK/UNLOCK | path、If/Lock-Token、ETag、dead props、95MB stream、各mutation、実HTTPの空本文操作。詳細は[EMPTY_HTTP_BODY](EMPTY_HTTP_BODY.md) | 実OS client gate、共有DAV、残るmethod/profile |
| content ticket | target manifest、ticket発行/取消、Cookie交換、current blob配信、BudgetDOの対象重複排除/共有使用量、R2/bodyへのlease期限伝播 | D1/R2、署名、失効、Range、budget reserve/settle、実HTTPの発行・交換・空本文取消し、上書き/別target配信、1MiB/対象数上限、期限更新/遅延R2/停止body/取消し。詳細は[BUDGET_ALLOWANCE](BUDGET_ALLOWANCE.md)と[CONTENT_LEASES](CONTENT_LEASES.md) | ZIP/page/entry/track、全route会計、長時間download再開UI・実環境 |
| quota・会計 | logical ref、pin、used/reserved/physical bytes、reservation | counter drift、上限、rollback、物理削除精算 | 実運用repairとalert |
| Outbox | durable producer、lease再送、ID-only Queue message、consumer、共通受付と固定25秒期限 | send/D1応答喪失、重複delivery、主要node event provenance | 実Queue/DLQ、残るevent kind |
| 復旧基盤 | epoch履歴、quiesce、paged recovery audit、FTS rebuild、限定cleanup、受付/GCの段階再開、永続repair hold | DO eviction/全喪失、実LockDO mutation、HTTP bootstrap、応答喪失・停止競合、最終batch fence | 完全restore drill、実環境、account mutation・終了証明を失ったKDFの運用収束 |
| media形式基盤 | AVIF/AV1/Opus判定、bounded sniff、ZIP STORE serializer | format vector、境界、CRC、Unicode、cancel | parser、変換、配信、player/gallery/reader |

今回のQueue受付とS3試験修正の検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。

## 実装済みだがstaging未検証・未公開

- Workerのprivate/content/DAV handler。ControlDOは監査後に再開可能だが、実環境の設定・公開は未実施。
- Queue consumer、Cron outbox dispatch、Cron GC。ローカルworkerdでは検証済みだが実Queue/DLQ/Cron deliveryは未検証。
- Cloudflare Images bindingの入力境界。実codec、制限、費用は未検証。
- Access JWT、app password、content ticket、cursor鍵。remote secretと実鍵rotationは未設定・未検証。
- 実D1/R2/KV/DO/Queue/Rate Limit/Assets間のネットワーク断、retry、region挙動。
- WebDAVのWindows/macOS/Linux実client相互運用。
- custom domain、host分離、CORS/Cookie、workers.dev/preview無効化の実環境確認。

## 未実装

### サービスとデータ処理

- multipartのunknown creation IDの全体閉鎖・予約精算と実7日incomplete lifecycle検証。既存uploadの未知ID中止とfresh nonceによるBLOBS/S3対応検証は実装済み。S3設定読取りと一覧/partのbounded診断は接続済み（[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)）。
- upload行自体が失われたincomplete multipartの全体閉鎖・容量精算。全`u/`のhandle走査・中止receipt・part容量保留は接続済み（[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md)）。未知の完成済み`u/` objectの隔離・35日回収も接続済み。
- 大規模tree向けの非同期trash/restore/purge job。
- 残るoperationの認可tuple、terminal lookup、Outbox consumer/repair。
- media metadataのparser/検索索引同期、索引version再構築運用。所有folderの要求時bounded statsは[FOLDER_STATS](FOLDER_STATS.md)へ接続済み。名前検索APIと現行権限付きpaginationは接続済み（[SEARCH](SEARCH.md)）。
- 共有作成・編集・解除、内部共有、公開link、password/unlock、upload-only共有の完全なHTTP surface。
- ZIP download、archive entry、EPUB page、audio/video track、thumbnail/derivativeの完全なHTTP配信。
- バックアップの認証付き運用接続・日次実行・保持管理、Time Travel手順、live restore automation。世代生成/検証・R2保存/取得・オフライン復元と、内部RPCの完了記録は実装済み。
- `u/`以外の未追跡生成物、catalogueに残るkeyの不正置換。既存deletingの停止中blob/orphan drainは接続済み（[GC_RECOVERY](GC_RECOVERY.md)）。

### UI

- File System Access handle、詳細preview。
- share管理、media metadata検索、大量gridの仮想化。
- Gallery/lightbox、Bookshelf/EPUB reader、Audio player。
- AVIF/AV1/Opusの実browser再生試験とfallback。

### 制御・運用

- account mutationの未接続経路とbackup統合（namespace・DAVロック・app password更新・session/bootstrap/logout・content budget/ticket・upload新規予約/転送/中止/検証は同時32・待機256へ接続済み）、終了証明を失ったKDFの運用収束と共有password/IP制限。KDFの全体rate/枠・isolate内制限とbackup専用barrierは接続済み。
- operator HTTP/管理UIと実環境の停止・全復旧監査・段階再開drill。内部RPCの最終再開gateは[CONTROL_ADMISSION](CONTROL_ADMISSION.md)に実装済み。
- staging/production resource inventory、remote migration、deploy。
- monitoring、alert、Logpush、capacity/費用確認。
- backup/restore drill、release、rollback、障害対応runbookの実行。

## 未検証

未実装項目は当然未検証である。それ以外に、実装済みでも次は未検証である。

- 実Cloudflare Access + MFA + service token。
- 実Queueのack loss、最大retry、DLQ、requeue。
- 実Cronの重複・遅延・同時実行。
- 実R2のdelete/head障害、429、長時間ネットワーク断、lifecycle。
- 実D1 Time Travelとlogical exportからの復元。
- 実CloudflareでのControlDO storage lossを含む完全な停止→監査→再開。ローカルfixtureは検証済み。
- 実Images codecとAVIF生成。
- 複数ブラウザー、モバイル、支援技術、実WebDAV client。
- セキュリティheader、CORS、Cookie、domain aliasのdeploy後検査。
- 負荷、長時間運転、大量データ、費用上限。

## セッションをまたいで保持する事項

### 目標

Foundationだけで完了扱いにせず、[DESIGN](DESIGN.md) と [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) の製品完了条件まで進める。ユーザー確認が不要なローカル実装、試験、通常commit、`origin/main`への通常pushは継続する。

### 許可と禁止

- 検証済みのまとまりはcommitし、`origin/main`へ通常pushしてよい。
- force pushはしない。
- GitHubへのpushをCloudflare production deployの許可と解釈しない。
- remote resource作成、remote D1 migration、secret設定、staging/production deployは、具体的な環境情報と実行段階の確認が必要。
- secretをrepository、`wrangler.jsonc`、logへ書かない。

### 壊してはいけない条件

- ControlDO再開は全監査と同一D1 batchの最終fenceを通す。flagsを直接解除しない。実環境再開は未実施。
- D1がnamespace・authorization・ledgerの正本、R2がimmutable contentの正本。
- mutationはcurrent auth、epoch、permit、revision/tree fence、operation terminalを同じatomic boundaryで確認する。
- `blobs.state='deleting'` とGC `deleting`は不可逆。
- blob参照追加は`deleting/deleted`を拒否する。
- GCはref=0、全pinなし、current control mode・epoch・claim所有を各dispatch/精算時に再検査する。通常GCはpause解除時のみ、停止中drainは既存deletingのみ。不在確認後だけphysical精算する。
- 適用済みmigrationを書き換えず、新しい番号のmigrationを追加する。
- AVIF・AV1・Opusを保存・配信・Gallery/player要件から外さない。詳細は [MEDIA_FORMATS](MEDIA_FORMATS.md)。

### 次の優先順

1. unknown multipart IDの全体不在証明・予約精算を実装。毎回freshなS3/BLOBS対応検証は走査・中止へ接続済み。upload行喪失時の全bucket走査・容量保留、S3診断と完成済み`u/` objectの隔離・35日回収も接続済み。
2. Upload/GC/Queueの未完了状態を復旧監査と修復に統合。
3. Queueの残るevent kindとrepair。
4. account mutation / 終了証明を失ったKDFの運用収束、backup logical export/manifest、実環境のrestore/再開drill。内部RPCの段階再開とbackup barrierはローカル実装済み。
5. Files UIの残り（共有・media・metadata検索）。
6. share、media metadata検索、ZIP/reader/media配信。
7. backup/export/restore drill。
8. staging inventoryと実環境gate。

### 次回開始時の確認

```sh
cd /home/hiroshi/ドキュメント/Nextcloud-flare
git status --short
git diff
git log -5 --oneline
gh run list --limit 3 --json databaseId,headSha,status,conclusion,url
```

変更前に既存差分を保護する。変更後は最低限 `git diff --check`、該当テスト、typecheckを行い、checkpoint前に全check、Web build、Wrangler dry-runを実行する。schema変更時は新migrationを追加し、`node scripts/generate-schema-contracts.mjs`とschema testを更新する。

## 文書更新ルール

checkpointごとに次を更新する。

1. この文書の該当行を「実装済み」「staging未検証」「未実装」の間で移動する。
2. [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ実行コマンド、件数、結果を記録する。
3. [HANDOFF](HANDOFF.md)の次作業と注意事項を更新する。
4. READMEの短い概要が古くなっていないか確認する。
