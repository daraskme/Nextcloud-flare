# 現在の実装状態

更新: 2026-10-04。直近の到達点は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

`785faf3` の暗号化レビュー修正をstagingへ反映済み（Worker `654609ce-781a-4e0d-98d7-b047c280bb4c`、0054適用、53 migrations・86通常table・174 routes）。所有者署名、管理者鍵照合、検証済みblobマーカー、サーバーでの暗号化必須と迂回拒否を導入した。実管理者の既存3件は、64,932,182 bytesを全復号して以前のSHA-256と照合してから署名と管理者receiptを追加。実画面の画像表示・音声/動画再生・seek、新規v2 uploadと平文拒否も成功した。

週次暗号化バックアップと毎時monitorを設置済み。初回世代 `e4312702-1f92-4b9b-aff9-35f84a84d5f2` / epoch2 は2026-10-04 09:28:25 JSTに完了した。外付けの暗号化アーカイブ131,145,497 bytesから独立したローカルSQLiteとファイル領域へ実際に復元し、86 tables・19 objects（130,603,898 bytes）を検証。復元した画像・音声・動画3件の全復号SHA-256も以前の記録と一致し、所有者署名・管理者receipt・markerを確認した。検証用の復元データと定期処理の作業コピーは削除済み。復旧JSONは元の端末内に保持し、Cloudflareや定期処理へ保存していない。

保存先は `/run/media/hiroshi/ボリューム/Nextcloudflare-backups`、毎週日曜03:30 JST（次回2026-10-11）。ユーザーsession再開時の取り逃し実行と、失敗時の同じ世代からの再試行に対応する。完了後のremote receiptはcompleted/released、maintenance・gc_paused・backup_frozenは0、一時bridgeは削除済み。`BACKUP_OPERATOR_ENABLED=true`、`CLIENT_ENCRYPTION_REQUIRED=true`、`STAGING_CONTROL_OPERATOR_ENABLED=false`、GitHub staging Environmentの`STAGING_WEEKLY_BACKUP_ENABLED=true`を確認した。

デスクトップ通知2件、重複抑止（重複0件・pending 0件）、バックアップ正常復帰通知1件の送達を確認。monitorはbackup healthy・live reachable・pending 0件。Billing APIの結果は`unattributed_below_threshold`で、アカウント全体の請求からstaging追加費用を厳密に分離できない。費用通知は月1万円で自動停止する仕組みではない。 詳細は[実装進捗](IMPLEMENTATION_STATUS.md)と[引き継ぎ](HANDOFF.md)。

以下のcheckpointは署名追加前または各記録時点の履歴であり、現在状態ではない。

追加checkpoint: 実stagingのR2保存世代から83table・388行を独立SQLiteへ復元し、原本6 object・64,953,590 bytesの複写照合が成功した。保守状態と一時Cron bridgeは解除・削除済み。動画シーク時の429を4MiBのRange予約へ修正し実環境で8回連続シークを確認した。読み取り専用automation GET 2経路は実装済みだがAccessでの実利用はまだ有効化していない。本人＋管理者のクライアント暗号化は単体・統合3,125件と全ブラウザー48件を通過し、stagingへ反映した。実Chrome固有のSW取得時のAccess転送は単一公開bootstrapで解消し、実登録と鍵未設定時の送信拒否を確認した。続いて実管理者の鍵で既存メディア3件・64,932,182 bytesの暗号化コピーを作り、実環境で復号後の全byte・SHA-256と再生/seekを確認した。移行修正後のfocused暗号化3件は成功し、全49件が8.6分で成功。一般利用者2人は使わないとのユーザー指示により暗号化設定・既存空ファイル移行を省略し、管理者1人での運用を対象とする。承認を受けて管理者の元の平文3件をアプリとゴミ箱から削除したが、R2原本は35日以上のGC猶予で残り、過去バックアップも保持している。[初回設定](CLIENT_ENCRYPTION_SETUP.md)を参照する。

2026-10-04 は手元の実ファイルによるAVIF・Opus/MP4・1080p 10-bit AV1+Opus/MP4のupload・表示・再生・seek・全byte照合を追加した。AVIFをMP3と誤判定してGalleryから消す問題、画像MIMEの保存不足、サーバー間の時計差による受付期限の誤拒否を修正し、stagingへ配備した。個人メディアはrepositoryに含めない。

2026-10-03 の追加は、監査付き読み取り専用の [管理者ファイル閲覧](ADMIN_FILES.md) と、実upload後のMP3/Opus/AV1形式判定・再生経路の修正。現在のschemaは52 migrations（最新`0053`）、83通常table、168 route契約。stagingは配備済みで、管理者1人と一般利用者2人のログイン、upload/download、一般利用者間の一覧分離をユーザーが確認した。追加機能の配備・試験結果は進捗表と [staging runbook](../ops/staging/README.md) を参照する。

以下は2026-10-02までの分野別checkpoint。以前の「remote未実施」は現在のstaging状態を表さない。

最新の変更ではQueue dead-letter修復、audio/video metadata、画像metadataとimmutable `sm256` thumbnail、bounded private/public ZIP/EPUB、private/public media UI、direct-user・group internal share、bounded reshare、編集可能なshared DAV、multipart closure settlement、1,001〜10,000 nodeのdurable非同期trash/restore/purge、管理者招待による複数Access利用者の作成とstaging設定案を統合した。内部共有UIはowner lifecycle、再共有ポリシー、recipient provenanceと現在有効な操作を表示する。migrationは50件（最新`0051`）、通常tableは81、route契約は162。

video、group internal share、multipart closureのPR #16、#17、#19は全5 CIを通過してmainへ統合済みである。group shareのaction変更後は`share.version`、member削除/再追加後はmembership versionでbudget identityをrotateし、revoke済みbudgetを再利用しない。

multipart closureはquiet period、bounded bucket verification、immutable closure run、handle/upload settlement receipt、ControlDO inspect/advance/settle、owner ledger・recovery fenceを持つ。backup drillは80 tableでPASSしている。

読み取り専用public shareのGallery/Audio/Bookshelf/Video UI、thumbnail/audio/video ticket、EPUB metadata/page/entry、bounded ZIP delivery、大規模treeの非同期trash/restore/purge、bounded reshare、編集可能なshared DAVを既存のauthority、projection、ticket、content-origin、BudgetDO、Queueへ接続した。group lifecycle・recipient reshare・app password・Recent/Starred・private ZIPの各UIとmedia resume stateも接続済み。Files gridの仮想化、private Galleryのticket取消し、移動Outboxの移動元親権限検査に加え、現行audio投影に限定したmetadata検索とFiles UI、移動結果照会の移動元親権限・node step検査を追加した。実AVIF静止画のChromium表示も確認した。次はvideo/image metadata検索、残るoperation/Outbox/repair、復旧・運用を進める。timerの実設置・外部通知、破損・未完了世代の回収、Time Travel・live復旧、D1/全storage喪失後の信頼できる世代選択、未知KDF、AV1/Opusを含む複数browser実ファイル再生、実OS client・実環境検証・公開は未完了である。remote migration・deployは未実施。

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
| 公開リンク | owner作成/一覧/参照/無効化、password/fragment unlock、share Cookie、読み取り専用metadata/children/download、Gallery/Audio/Bookshelf/Video UI、thumbnail/audio/video ticket、EPUB metadata/page/entry、bounded ZIP、upload-onlyのsingle/multipart受信・owner/share予約・名前非開示、独立shell/assets、Files共有dialog | capability/session/version/epoch/root coverage、owner分離、失効、ZIP idempotency、budget再利用、content-origin交換/redirect、R2配信、media cursor/projection、EPUB projection/source/entry fence、GET/HEAD/Rangeとexact budget、upload receipt/transfer/status/complete/abort、完了再試行、衝突回避、read/list拒否、hashed assetsとexact route | stagingと実browser/media file。[PUBLIC_SHARES](PUBLIC_SHARES.md) |
| 内部共有・shared DAV | ownerによるdirect-user/group share作成/一覧/action更新/revoke、group/member API、rename-stable mount、bounded reshare policy/delegation、owner/recipient管理UI・group lifecycle・recipient reshare UI、`/dav/Shared/<mount>`のread/create/edit/delete | active user/group/member/grant/share、membership/share/policy/delegation version、live ancestry、epoch、maintenance、action、rename/revoke後の失効、budget rotation、shared DAV context fencing | 実OS client |
| 期限切れ世代の自動走査 | sweep・永続round/cursor・既知破損の保留・maintainの明示option | Node22/workerd13追加、eviction・100件超の不在receipt・固定期限・競合、9操作のbindingドリル | timer実設置・外部通知・remote運用は後続。[BACKUP_SWEEP](BACKUP_SWEEP.md) |
| 期限切れSQL世代の明示回収 | 専用prune・実receipt/hash/年齢照合・20部品/100RPC・manifest最終削除 | Node12/workerd26追加、境界・応答喪失・eviction・遅延DELETE、専用bindingドリル | 未完了/破損世代の回収、remote運用は後続。[BACKUP_PRUNING](BACKUP_PRUNING.md) |
| 日次運用と世代補充 | maintain・完了ID照合・不足/鮮度補充・定時起動例 | Node18/workerd8追加、Node662件と関連87件、実5世代ドリル成功 | timer設置・外部通知・remote/live復旧は未完了。[BACKUP_MAINTENANCE](BACKUP_MAINTENANCE.md) |
| バックアップ保持判定 | inventory/health、実R2/SQL検証・35日/最少5世代/最新24時間・終了コード通知 | Node27/workerd23追加、全Node644件・関連79件成功 | 外部通知・live復旧は未接続。[BACKUP_RETENTION](BACKUP_RETENTION.md) |
| 日次バックアップ | サーバー所有ID・同日実データ検証・R2からの再開 | Node17/workerd17追加、関連56件・全Node617件成功 | 定時起動の設置・外部通知・live復旧は未完了。[BACKUP_OPERATOR](BACKUP_OPERATOR.md) |
| 値を保持するデータ出力 | 型情報・BLOB hex・NUL TEXT・bounded SQL writer | Node16件追加、統合600件と実D1/CLIの3ドリルが成功 | remote・大規模運用は未検証。[BACKUP_EXPORT](BACKUP_EXPORT.md) |
| 過去schemaと全table照合 | 信頼済みprefix、保存時schema、未知tableの拒否 | Node19件追加、統合584件と実D1の3ドリルが成功 | 全データ形式・live復旧は後続。[BACKUP_HISTORY](BACKUP_HISTORY.md) |
| バックアップ用GC保護 | migration0039・35日猶予・最後の参照による延長・WebDAV空ファイルの直接削除除去 | Node565件（34file、18.55s）が成功しました。workerd全体は2,013件中2,012件が成功し、失敗した1件は旧仕様の即時削除を期待するDAV試験でした。35日以内の削除拒否・容量保持と期間経過後の回収へ更新し、そのfileの17件（7.06s）が成功。再実行を含めworkerd全2,013件を確認しています。lint345file・型・契約/設定検査、Web build・Worker dry-runも成功しました。schema0039の実D1試験5件と、従来CLI（67table・SQL9,599bytes）、専用binding（9,613bytes）、実CLI run→receipt→download→restore-offline（9,110bytes）の3ドリルも成功しました。この変更のCIはプッシュ後に確認します。 | 35日保護は元BLOBS bucket内の削除猶予です。移行前に削除済みのobjectを復元せず、bucket/account喪失への別保管も提供しません。過去schemaは0037以降の信頼済みmigration列だけを受け付けます。追加データ形式、定時起動、Time Travel・live復旧・全storage喪失からの運用復旧とremote検証は未完了です。 |
| バックアップ運用コマンド | 専用capability、run/receipt/cancel、再実行と失敗時の停止維持 | Node25件を追加し、全552件（33file、19.71s）が成功しました。専用bindingの実ControlDO/D1/R2ドリルは67table・SQL9,613bytesで成功し、全4操作の権限/環境/無効化、eviction後の再実行、取消・履歴、復元先のFTS/会計を確認しました。R2保存先修正後の実CLI run→receipt→download→restore-offlineもSQL9,110bytesで成功し、同じ引数の再実行と元policyへの復帰を確認しています。従来CLIのcapture/publish/download/restore-offlineも修正後に67table・SQL9,599bytesで成功しました。全体checkも成功し、Node552件＋workerd2,009件（95file）の計2,561件、lint・型・契約・設定検査、Web buildとWorker dry-runを確認しました。 | 専用service bindingを持つ運用者だけがSQL検証済みhashを証言します。remote Cloudflareの認証・権限・実resourceによる運用検証は未実施です。定時起動、元BLOBSの独立保管、live復旧、全storage喪失からの運用復旧は未完了です。 |
| バックアップ完了記録 | 内部completeBackup、R2実体/cursor照合、D1 receiptと元policyへの原子的復帰、migration0038 | Node22件・workerd18件を追加し、全体checkが成功しました。Node527件（32file、14.22s）・workerd2,009件（95file、1,085.53s）、計2,536件を検証しています。lint335file・型・契約/設定検査・Web build・Worker dry-runも成功。schema0038で実CLIのcapture→verify→local R2 publish→download→restore-offlineが67table・SQL9,599bytesで成功しました。今回commitのCI/browserはプッシュ後に確認します。 | completeBackupは内部RPCです。SQL/source/schema/FK/FTSの全検証は信頼された生成コマンドが担い、ControlDOはそのhashでR2実体を再検査します。利用者が指定したhashを転送する公開APIは追加していません。remote運用の認証・権限検証、元BLOBSの独立保管、live復旧、全storage喪失からの運用復旧は未完了です。 |
| バックアップR2保存・取得 | 条件付きpart保存、manifest最終確定、応答喪失照合、download後の全検証 | 実CLI/local R2の保存・取得・隔離復元。8MiB超の複数part、再開、ACK喪失、同時公開、改変/欠落、期限・本文上限・署名を試験 | 保存対象はD1の論理SQL。remoteの運用接続検証、BLOBS本体の独立保管、定時起動・live復旧は後続。remote S3は実装済み・実環境未検証。 |
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
| schema・契約 | 50 migrations（最新`0051`）、81通常table、FTS、162 route契約、FK graph、会計・状態遷移trigger | SQLiteとD1 migration、FK/CHECK/trigger、生成契約一致、81-table backup drill | 全162 routeの機能実装は未完了 |
| 認証 | Access JWT/JWKS、user/service分離、単一管理者bootstrap、明示的な7日間招待による追加利用者の`iss+sub`固定、session、logout、CSRF、app password | JWT失敗境界、鍵cache、bootstrap競合、招待の権限・期限・失効・競合、session失効、PBKDF2 | 実Access/MFA policy、remote issuer/AUD/secret、stagingでの複数利用者試験。[STAGING_ACCESS](STAGING_ACCESS.md) |
| KDF終了記録repair | DO SQLite最大20件の送信前/終端記録、DB精算再照合、停止中内部RPC、ローカル記録の復旧fence | 新規14件、既存認証・受付再開・GC停止の回帰、全check成功 | 証明喪失した未知試行の運用収束、実環境のrepair/restore drill |
| KDF実行制限 | Worker/ControlDO各1件・並行要求は予約前に即503、D1の600回/65秒予算と未精算20枠、epoch cooldown、発行/認証/鍵更新 | 新規Node7件・workerd20件、既存認証34件、実ControlDO RPC/eviction/全喪失、実browserの8同時DAV接続。詳細は[KDF_ADMISSION](KDF_ADMISSION.md) | 証明喪失試行の収束、共有password/IP制限、実CPU・処理量・切断 |
| 認可 | private/app-password/internal-share/anonymous-shareのnode authority、祖先検査 | 4 principal、失効対commit、別owner・削除祖先拒否 | 全operation・全routeのoperand tuple |
| namespace更新の全体受付 | migration0030、D1 active32/waiting256、ControlDO FIFO、LockDO全8許可経路、失効と最終commit fence | 新規Node4・workerd17件と全check成功。上限・再送・応答喪失・待機後認可・停止/復旧 | 他の更新経路・backup barrier・実負荷。[MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| DAVロックの全体受付・確定記録 | migration0031、LOCK/refresh/UNLOCKの共有枠、lock変更/記録/解放の一括確定、60秒保持 | Node4・workerd22件追加。実ControlDO待機、HTTP503、失効/停止、応答喪失、別処理のunlock、rollback、旧DB移行 | HTTP応答喪失後のtoken再取得・別RPCの結果再生は未実装。実環境未検証 |
| app password更新の全体受付 | 発行・失効・pepper更新の共有枠、KDF後取得、current authorityと確定記録/解放を同一batch | workerd32件追加。混雑HTTP503、失効/停止、ACK/readback喪失、root/20件上限、別owner拒否、実ControlDOのKDFと32枠 | 他のaccount更新とbackup統合、実環境未検証 |
| atomic mutation | operation claim/lookup、permit、LockDO、rollback、commit unknown収束 | 同時再送、競合、失効、応答喪失、全step rollback | 実ControlDO admission下のstaging試験 |
| Files UI | React/TanStackの一覧・操作・trash・確認付き上書き/再開upload・logout、認証付きprivate assets | ローカル実APIの19 browser scenario、NodeのCSRF競合4件 | 共有・media・実環境。検索は[SEARCH](SEARCH.md)。詳細は[FILES_UI](FILES_UI.md) |
| フォルダー集計 | Accessのaccount stats、所有folderの再帰件数/現在のlogical bytes、1万件上限と部分結果、Files情報dialog | D1の12件と検索9件の回帰、実APIでのbrowser集計/再集計/拒否時非表示。全check成功 | 実D1予算・負荷、共有/media別集計。[FOLDER_STATS](FOLDER_STATS.md) |
| 検索 | Access検索API、現行権限/祖先、名前とaudio title/artist/albumの正規化、現行audio blob/generator投影限定の`mode=audio`、範囲10,000・page200、mode付き署名cursor、Files検索UIと元の保存先の保持 | Node query/cursor、実D1階層・共有/削除/失効・旧索引・上限・audio投影、実browser検索/上書き/201件pagination/世代競合とmode切替 | video/image metadata検索、索引version再構築運用、実D1予算。[SEARCH](SEARCH.md) |
| Files REST | node詳細、breadcrumb、children、folder作成、rename、trash、MOVE、COPY、operation照会 | 実D1/DO、cursor改変・期限・tree変更、Outbox provenance | 全route profile・実環境 |
| Trash | 一覧、同期restore/purge、1,001〜10,000 nodeの非同期trash/restore/purge、別trash子退避、名前衝突解決、GC pause、D1確定後のGC candidate | 最大64層・10,000 node、冪等再送、job cursor/lease、期限/識別子/停止競合、応答喪失・再起動 | 実Queue/DLQ/Cron、実環境。詳細は[RESTORE_GC](RESTORE_GC.md) |
| 停止中GC drain | 旧deletingのみのblob/orphan回収、claim epoch・dispatch counter、ControlDO内部RPC、前後の監査初期化 | 応答喪失、停止/epoch/lease変更、遅延削除、二重精算防止、回収後の全復旧監査 | 外部置換objectの猶予、実R2・完全restore drill |
| GC | 35日猶予candidate・最後のnamespace参照解除による期限延長、claim lease、pin/ref/pause fence、R2 delete/head、physical精算 | 実workerd R2、複数pin、pause、応答喪失、lease再取得 | unknown multipart ID、既知keyの不正置換、実Cron運用 |
| 未追跡object | D1のページcursor/lease、HEAD照合、隔離台帳、35日猶予、実physical会計、再利用拒否、Cronと停止中inventory | 応答喪失、同時走査/回収、置換・再出現、owner後日復元、pause/epoch、復旧監査 | incomplete multipart、他prefix、実R2運用 |
| multipart S3診断 | 署名付きListMultipartUploads/ListParts/GetBucketLifecycleConfiguration、1 GET/最大100件/1 MiB/10秒、停止中ControlDO診断 | XML/設定/署名/timeout/ページ失敗、実D1 fenceとControlDO監査再初期化、予約保持 | 実S3/lifecycle試験 |
| R2/S3対応検証 | migration `0023`、固定64-byte system probeのfresh nonce/CAS更新、scope付きD1 fence、ControlDO検証と復旧監査 | 実R2条件付きPUT、遅延create/更新、誤bucketの古い値、応答喪失、epoch/pause/lease、system容量保持 | 実S3試験 |
| multipart closure | migration `0046`、quiet period、bounded bucket verification、immutable closure run、handle/upload settlement receipt、ControlDO inspect/advance/settle | 応答喪失・再送、epoch/maintenance/ownership fence、physical accounting、backup/schema回帰 | 実S3/lifecycle、Cron/運用監視 |
| 未追跡multipartの中止・容量保留 | migration `0027`/`0028`、全`u/`走査、正確なkey/ID照合、part最大観測bytesのphysical保留、発見handleの中止・不変receipt、停止中ControlDOと復旧fence | ページ、並行処理、応答喪失、遅い応答、source/proof、所有者復元、64回上限、closure settlementへの接続 | 実S3、Cron/HTTP。[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md) |
| multipart ID修復 | migration `0022`のscan/handle台帳、毎回freshなBLOBS/S3対応検証、既存uploadの全ID走査・abort・不変receipt・physical観測、closure settlement | 複数ID/ページ、claim・page・receipt応答喪失、遅延ID、epoch/token/pin/lease、S3障害時の会計 | 実S3、Cron |
| private単一upload | HMAC capability、D1予約、1回だけのR2 PUT、SHA-256、GETによる応答喪失回収、原子的新規作成/上書き、status/abort HTTP、24時間後のCron回収・GC接続 | 実D1/R2/LockDO、0 byte、同時送信、10 step rollback、失効、DB/R2応答喪失、CSRF/Origin、回収lease競合、旧epoch、公開upload-only回帰 | stagingは未完了 |
| private multipart upload | D1予約・immutable geometry、R2一度限りcreate、UploadDO認可RPC・状態/part mirror、streaming part/SHA-256、4並列・3試行、R2一度限りcomplete/HEAD、原子的新規/上書き公開、terminal照合、既知/未知IDの回収とclosure settlement、HTTP create/part/status/page/complete/abort | D1/R2/DO/LockDO、64 MiB+末尾の公開、同時確定、応答喪失、storage全喪失、失効、10 step rollback、complete/abort排他 | 実S3/lifecycle・staging |
| WebDAV | OPTIONS、GET/HEAD/Range、PROPFIND Depth 0/1、MKCOL、PROPPATCH、PUT、DELETE、COPY、MOVE、LOCK/UNLOCK、`/dav/Shared` mountのread/create/edit/delete | path、If/Lock-Token、ETag、dead props、95MB stream、各mutation、共有mountの認可/rename/revoke、share/grant/group/membership/action/version context。詳細は[DAV_UPLOAD](DAV_UPLOAD.md) | 実OS client gate、残るmethod/profile |
| content ticket | target manifest、ticket発行/取消、Cookie交換、current blob/audio-video track/thumbnail配信、private/public ZIP STORE、private/public bounded EPUB page/entry、public thumbnail/audio/video ticket、BudgetDOの対象重複排除/共有使用量、R2/bodyへのlease期限伝播 | D1/R2、署名、失効、Range/HEAD、budget reserve/settle、ZIP tree/path/blob pinとexact size、thumbnail/video/EPUB projection fence、実HTTPの発行・交換・取消し。詳細は[BUDGET_ALLOWANCE](BUDGET_ALLOWANCE.md)と[CONTENT_LEASES](CONTENT_LEASES.md) | 全route会計、長時間download再開UI・実環境 |
| quota・会計 | logical ref、pin、used/reserved/physical bytes、reservation | counter drift、上限、rollback、物理削除精算 | 実運用repairとalert |
| Outbox | durable producer、lease再送、ID-only Queue message、consumer、共通受付と固定25秒期限、dead-letter台帳とbounded requeue、audio/image/video/EPUB projection | send/D1応答喪失、重複delivery、dead-letter再投入、各media projectionのclaim/fence収束 | 実Queue retry exhaustion/DLQ、残るevent kind |
| 復旧基盤 | epoch履歴、quiesce、paged recovery audit、FTS rebuild、限定cleanup、受付/GCの段階再開、永続repair hold | DO eviction/全喪失、実LockDO mutation、HTTP bootstrap、応答喪失・停止競合、最終batch fence | 完全restore drill、実環境、account mutation・終了証明を失ったKDFの運用収束 |
| media形式基盤 | AVIF/AV1/Opus判定、bounded sniff、ID3 audio metadata、画像width/height・immutable `sm256` WebP、video metadata、EPUB index/entry、ZIP STORE serializer、private/public Gallery/Audio/Bookshelf/Video UI、thumbnail/audio/video ticket・EPUB metadata/page/entry・bounded ZIP・media resume state | format vector、audio/image/video/EPUB projection、private/public EPUB metadata/page/entry、thumbnail/track/ZIP配信、reader/ギャラリーのstale ticket取消し、video revocation/unsupported fallback、CRC、Unicode、cancel | 追加操作、実Images codec、複数browser実ファイル再生 |

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

- 残るoperationの認可tuple、terminal lookup、未接続Outbox event kind。
- 残るmedia/archive metadata parser、検索索引version再構築運用。所有folderの要求時bounded statsは[FOLDER_STATS](FOLDER_STATS.md)、名前検索APIは[SEARCH](SEARCH.md)へ接続済み。
- 残る共有・DAV method/profile、追加のmedia/archive metadata parser。group lifecycle、recipient reshare、app password/WebDAV設定、Recent/Starred、private ZIP、media reading/playback resume stateは接続済み。
- バックアップの定時起動の設置・外部通知、Time Travel手順、live restore automation。専用bindingによるrun/daily/health/maintain/prune/sweep・生成/検証・R2保存/取得・完了記録・オフライン復元はローカル実装済み。
- `u/`以外の未追跡生成物、catalogueに残るkeyの不正置換。既存deletingの停止中blob/orphan drainは接続済み（[GC_RECOVERY](GC_RECOVERY.md)）。

### UI

- File System Access handle、詳細preview。
- media metadata検索。group管理・recipient reshare、app password/WebDAV設定、Recent/Starred、private ZIP、Files gridの仮想化、owner/recipient internal share管理、新規読み取り専用・upload-only linkの発行/無効化/password保護は接続済み。
- Gallery/Audio/Bookshelf/Videoの追加操作と実ファイル・複数browser検証。
- AVIF/AV1/Opusの実browser再生試験とfallback。

### 制御・運用

- account mutationの未接続経路とbackup統合（namespace・DAVロック・app password更新・session/bootstrap/logout・content budget/ticket・upload新規予約/転送/中止/検証は同時32・待機256へ接続済み）、終了証明を失ったKDFの運用収束。共有password/IP制限、KDFの全体rate/枠・isolate内制限とbackup専用barrierは接続済み。
- operator HTTP/管理UIと実環境の停止・全復旧監査・段階再開drill。内部RPCの最終再開gateは[CONTROL_ADMISSION](CONTROL_ADMISSION.md)に実装済み。
- staging/production resource inventory、remote migration、deploy。
- monitoring、alert、Logpush、capacity/費用確認。
- 実環境でのbackup/restore drill、release、rollback、障害対応runbookの実行。ローカルのバックアップ/隔離復元ドリルは実行済み。

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

1. private/public media UIを実ファイル・複数browserで検証する。
2. Filesのvideo/image metadata検索と詳細previewを進める。audio metadata検索は現行投影限定で接続済み。
3. 残るoperation/Outbox eventを復旧監査・repairへ統合する。
4. Queueの実DLQ/retry exhaustion、account mutation / 終了証明を失ったKDFの運用収束を閉じる。
5. Files UIの残り（File System Access handle・大量データ時の操作性）を進める。
6. 定時バックアップの設置、外部通知、Time Travel/live restore drillを整備する。
7. 実S3 lifecycle、実OS DAV client、実codec/browser mediaを検証する。
8. staging inventory、remote migration、deploy、production gateを実施する。

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
