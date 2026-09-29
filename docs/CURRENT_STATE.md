# 現在状態：実装・残件・検証

更新: **2026-09-29**。ソース確認の基準は **`81b351e`**（同じ所有者内の書籍COPY）。今回の更新は資料の整理で、アプリの追加実装は行っていない。

**主要なファイル操作・共有・Gallery・Audio・ZIP/CBZ本棚はローカル接続済み。製品全体は未完成で、staging／productionの稼働・リリース判定は未実施。** Foundationや一つの機能の成功を製品完成と扱わない。

## 判定と基準

| 表記 | 意味 |
|---|---|
| 実装済み | 記載したサービス・API・画面がコードに接続されている。分野全体の完成や実環境の動作保証ではない |
| 一部実装／未完了 | 使用可能な範囲はあるが、仕様の一部・運用への接続が残る |
| 検証済み | 記載したコード・環境・試験範囲で成功した記録がある |
| 未検証 | 実装の有無にかかわらず、その環境・条件での成功を確認していない |

- schemaはmigration `0001`〜`0077`、通常81テーブル。route manifestは152契約。**契約に載っていてもhandlerが未接続の経路があるため、152 API完成とは数えない。**
- 基準ブランチは `codex/database-restore`。資料整理前は作業ツリーclean、ローカル追跡参照 `origin/codex/database-restore` は `472e682`、基準コードはその33コミット先。
- 上記はローカル参照の確認であり、今回fetchやGitHubの再照会はしていない。資料更新コミットはこの差分数に含めない。
- 現在状態は本書、検証履歴は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、最近の変更は [PROGRESS](PROGRESS.md)、次の作業は [HANDOFF](HANDOFF.md)。履歴中の「今回」「未実装」は当時の状態として読む。

## 実装済みの範囲と残件

全phaseの完了条件は [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) §2と [DESIGN](DESIGN.md) を維持する。以下の各行には残件または実環境の確認があるため、phase全体の完了宣言はしない。

| 分野 | 実装済み・接続済み | 未完了・未接続 | 詳細／既存の検証記録 |
|---|---|---|---|
| Foundation・認証（0/1） | D1 schema・原子的mutation、ControlDO epoch／停止／共通受付、LockDO、認可・CSRF・Access verifier・初回owner・logout・app password、容量／参照／pin、operation receipt・Outbox | 残る契約経路の接続、結果不明の外部処理の全ケースの修復、実Access・MFA・秘密鍵設定 | [FOUNDATION](FOUNDATION.md)、[MUTATION_ADMISSION](MUTATION_ADMISSION.md)、[検証履歴](IMPLEMENTATION_STATUS.md) |
| Files（2/5） | 一覧・詳細・名前検索、音声タグ検索、所有フォルダーの要求時集計、作成／改名／MOVE、同じ所有者内のCOW COPY、原本Range／HEAD、上書き時のversion／ref会計、Files UI | お気に入り・汎用タグのAPI/UI、詳細preview・File System Access handle、画像／動画等を含む汎用metadata検索・索引保守 | [FILES_UI](FILES_UI.md)、[SEARCH](SEARCH.md)、[FOLDER_STATS](FOLDER_STATS.md) |
| Upload（3） | 単一／multipart、新規／上書き、状態取得・再開・中止・既知ID期限切れ回収。private・内部共有・公開編集・受け取り専用の導線 | 未知multipartの全体閉鎖と予約／保留容量の精算、実R2 lifecycle・長時間障害の確認 | [UPLOAD_HTTP](UPLOAD_HTTP.md)、[UPLOAD_OVERWRITE](UPLOAD_OVERWRITE.md)、[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md) |
| 所有者間COPY（3） | 永続manifest・job、単一／分割転送、途中再開、一括公開、取消／精算、明示的retry、保存先選択・進捗・同じタブのreload復元、音声metadata引継ぎ | タブ終了後／別端末の追跡復元、未知native／part／handleを含む全修復、未索引書籍への接続 | [COPY_JOBS](COPY_JOBS.md)、[AUDIO_SEARCH](AUDIO_SEARCH.md) |
| Trash・GC（4） | ごみ箱一覧、同期restore／purge、fence付きGC、35日猶予、未知完成objectの隔離／回収、停止中の既存deleting drain | 大規模treeの非同期trash／restore／purge、未追跡生成物や不正置換の全修復、未知multipartの全体閉鎖／精算 | [GC_RECOVERY](GC_RECOVERY.md)、[ORPHAN_INVENTORY](ORPHAN_INVENTORY.md)、[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md) |
| 内部／公開共有（6） | 所有者の共有管理、受信Sharedのread／edit、公開password・unlock・CSRF・logout、閲覧／作成／改名／削除／upload／overwrite、公開編集のreload復元、受け取り専用リンク | 各共有を通した未実装機能の拡張、実domain／Cookie／CORS／Accessの検証 | [INTERNAL_SHARES](INTERNAL_SHARES.md)、[SHARED_WORKSPACE](SHARED_WORKSPACE.md)、[PUBLIC_SHARES](PUBLIC_SHARES.md)、[PUBLIC_EDIT_RECOVERY](PUBLIC_EDIT_RECOVERY.md) |
| Content・ZIP（6） | 用途別ticket／session／配信budget、原本、サムネイル、音声原本、ZIP/CBZページを内部／公開共有に配信。固定manifestのZIP STOREダウンロード | 任意archive entry・page thumb等。single-hostはattachment／原本fallbackで、別content hostと同じinline機能ではない | [THUMBNAIL_DELIVERY](THUMBNAIL_DELIVERY.md)、[ZIP_DOWNLOADS](ZIP_DOWNLOADS.md)、[SINGLE_HOST](SINGLE_HOST.md)、[ARCHIVE_READER](ARCHIVE_READER.md) |
| WebDAV（7） | Class 1/2のHTTP処理、XML／property／条件header／lock、COPY／MOVE、Shared mount、同じ所有者の別共有への転送 | Finder／Explorer／rclone／cadaver／litmus等の実クライアント対応表と通し試験 | [DAV_SHARED](DAV_SHARED.md)、[DAV_UPLOAD](DAV_UPLOAD.md)、[検証履歴](IMPLEMENTATION_STATUS.md) |
| Gallery（8A） | JPEG/PNG/WebP/AVIF情報抽出、sm/md自動・lg要求時生成、保存／費用／回収、一覧・grid/list・lightbox・共有、AV1動画原本再生 | 50,000候補gate未達（通常上限10,000）、自動一括再抽出、画像／動画metadataのCOPY連携、実Imagesと他browserの検証 | [GALLERY](GALLERY.md)、[IMAGE_QUEUE](IMAGE_QUEUE.md)、[LARGE_THUMBNAILS](LARGE_THUMBNAILS.md)、[TRACK_METADATA](TRACK_METADATA.md) |
| Audio（8C） | Opus／MP3／FLAC／WAV／AAC／Vorbis解析、曲一覧・常駐player・本人の再生位置、タグ編集／検索／旧cache再索引、MP3/FLAC/MP4/Ogg埋め込み表紙、既存音声／COPY先の表紙要求 | WAV/WebM表紙、parserの未対応領域、自動一括抽出、HE-AACの実復号・他browser／実端末の確認 | [AUDIO](AUDIO.md)、[AUDIO_SEARCH](AUDIO_SEARCH.md)、[AUDIO_COVERS](AUDIO_COVERS.md)、[AAC_VORBIS](AAC_VORBIS.md) |
| 既存media | 現在閲覧できる古い画像／音声／動画の情報抽出をFilesから明示要求し、Queueの結果を確認 | 全原本の自動走査、同じversionで完了後の強制再走査、失効した要求を別読者へ付け替える処理 | [MEDIA_EXTRACTION](MEDIA_EXTRACTION.md) |
| Bookshelf（8B） | 新規ZIP/CBZ/EPUBのbounded索引・Queue保存／回収、本棚一覧・フォルダー移動・個人登録、ZIP/CBZページ閲覧・本人位置、内部／公開共有、同じ所有者内のCOPYで索引／metadata再利用 | 既存／未索引／旧COPY／所有者間COPY先の索引要求、書籍metadata編集、表紙／page thumb、画像フォルダー／PDF／EPUB本文リーダー | [ARCHIVE_READER](ARCHIVE_READER.md)、下記の直近検証 |
| Backup・復旧（4/9） | 専用barrier、通常全テーブルの論理export／検証・R2世代保存／取得、日次補充・保持／回収・監視adapter・オフライン復元。復旧CLIの環境照合・epoch予約・Time Travel送信記録・snapshot検証・停止中採用・全監査・段階再開、domain repair | 未知nativeの終了証明・全修復、logical importによるlive復元、旧schemaからの自動移行、予約後の安全な取消、全DO喪失、大規模DBのRTO、元BLOBSの独立保管、実災害復旧 | [DATABASE_RESTORE_RECOVERY](DATABASE_RESTORE_RECOVERY.md)、[DATABASE_RESTORE_DOMAINS](DATABASE_RESTORE_DOMAINS.md)、[BACKUP_GENERATIONS](BACKUP_GENERATIONS.md) |
| DLQ・管理・Release（9） | DLQ保存・管理者一覧／requeue APIと画面、バックアップ監視／HTTPS通知adapter、ローカル検証とCI定義 | DLQ resolve／保持期限／通知、一般管理・automation経路、実通知先・定時実行・監視／Logpush、resource inventory・配備・release／rollback演習、横断UI品質 | [DEAD_LETTERS](DEAD_LETTERS.md)、[BACKUP_MONITORING](BACKUP_MONITORING.md)、[CI定義](../.github/workflows/ci.yml) |

### 本棚の「できる／できない」

- 新しいZIP/CBZをアップロードし、索引生成後に所有者・内部共有・公開リンクで読むところまで接続済み。位置の保存は所有者／内部共有の本人に限定し、匿名公開には保存・開示しない。
- 個人の登録フォルダーは本人所有のroot／folderを最大32件。共有フォルダーは共有画面から開く。一覧は200件ずつで、Audioの2,000曲上限を本棚へ適用していない。
- 同じ所有者内の単一／フォルダー／再コピーは、同じblobの公開索引を再利用する。metadataは独立させ、読書位置はコピーせず、索引の追加R2書込みは行わない。
- EPUBはコンテナ索引まで。PDFとEPUB本文は原本への導線であり、専用リーダーではない。OPF／目次／sanitization／trusted iframe／CFI／テーマは未実装。
- 既存書籍の索引要求は**未実装**。次の候補として調査しただけで、今回の資料更新で実装済みにはしていない。

### 契約だけでは完成と数えない例

[route manifest](../packages/worker/src/routes/manifest.ts) と [private router](../packages/worker/src/api/privateApp.ts)、[Worker入口](../packages/worker/src/index.ts) を照合した。お気に入り／汎用タグ、書籍item情報の取得・編集、app-hostのbook page／thumb／entry、管理者のuser無効化・所有権移譲・強制unlock、automation list／metadataには未接続の経路が残る。ZIP/CBZの実ページ配信はcontent hostの `/c/:nodeId/:blobId/pages/:page` に接続済みで、この経路との混同に注意する。

## 検証済み：直近の変更

`81b351e` の書籍COPY変更について、修正途中の成功と修正後の再実行を合わせた関連試験は **202件（Node37・workerd164・Chrome1、重複除外）**。これは単一の全suite実行結果ではない。最終修正後にはNode37・COPY/MOVE関連77・Chrome1を実行し、その他の成功は同じ変更作業中の先行実行から集計している。

| 区分 | 確認できたこと | 結果・証跡 |
|---|---|---|
| Node | COPY/MOVE digestの1,000件×最大128文字ID、旧hash互換、超過／不正ID、一般intent上限、転送先／共有選択 | 3file・37件成功、13.40秒。`/tmp/ncf-copy-library-unit.log` |
| workerd・最終実行 | 書籍COPY、rename/MOVE、DAV共有転送、選択共有の更新 | 4file・77件成功、95.17秒。`/tmp/ncf-copy-library-native-complete.log` |
| workerd・先行の成功分 | operation／旧receipt26件、ページ24件、読書位置23件、本棚14件 | 計87件。`/tmp/ncf-copy-library-native-final.log` のoperation分、`/tmp/ncf-copy-library-native-2.log` のページ／位置／本棚分。これらのログ全体には別試験の失敗も含む |
| 大量COPY境界 | 400冊のCOPY／MOVE、単一／フォルダー／再コピー、原本／出力の証拠、独立metadata／位置、追加PUT・physical加算なし、EPUBコンテナ、rollback／応答喪失 | 上記77件中の書籍11件。1,000冊の実環境負荷試験ではない |
| Chrome | 実Files UIからコピー→本棚で開く→元の2ページ目／コピー先の1ページ目を個別保存→reload後に再開 | 1件成功、50.2秒。`/tmp/ncf-copy-library-browser.log`、画像目視済み。artifact: `/tmp/ncf-copy-library-browser-results` |
| 静的検査 | typecheck、lint（850file）、契約／設定検査 | `/tmp/ncf-copy-library-{typecheck,lint,contracts,config}-complete.log`、全成功 |
| build | private／public Web、Worker dry-run | `/tmp/ncf-copy-library-build.log`、成功。Worker 2,081.22KiB、gzip 439.43KiB。実配備ではない |

初期失敗（D1式深度、fixtureの検索行・LIKE・許可解放、digest上限）は修正・関連再試験後に集計した。失敗した実行を丸ごと成功扱いにせず、同じ試験を重複加算しない。ChromeのローカルTLS診断出力はあるがrunnerは終了コード0。詳細は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) に残す。

`/tmp` のログ・画像はこのPCの一時証跡で、Git管理・永続保存を保証しない。将来ログが消えた場合は文書の記録と試験ソースを参照し、必要な範囲を再実行する。

## 過去に検証済みだが、現在の全体保証ではないもの

| 対象 | 過去の成功・制限 | 現在の扱い |
|---|---|---|
| 本棚 `6ec3a5c` | 関連172件（Node46・workerd118・Chrome8）。212冊ページング、50,050件規模の疎な候補探索、登録・共有・390px表示。空pageのUI試験のみ応答fixture使用 | 記録済み。直近HEADで172件全てを再実行したわけではない |
| 読書位置 `55daa6a` | 関連169件（Node38・workerd127・Chrome4）。本人分離、CAS競合、原本上書き、失効、保存失敗、再開 | 記録済み。匿名への位置非開示を維持する |
| Gallery | ローカル50,050画像fixtureで50,000候補の一覧SELECTは550,203行、設計の60,000行gate未達。通常上限10,000へ縮小 | **50,000件性能gateは不合格のまま**。縮小後も実D1のp95未検証。[詳細](GALLERY.md) |
| Audio | ローカルD1の候補探索予算、Chromeの2,000曲・CPU 4倍制限、390px表示／原本再生・player描画 | ローカルの回帰検知。実モバイル機器・Cloudflare性能の証明ではない。[詳細](AUDIO.md) |
| Backup／復旧 | ローカルD1/R2／専用binding／CLI／オフライン復元ドリル、合成providerとD1巻戻しによる復旧試験 | 実Time Travel・本番災害復旧とは区別する。schema0077／最新HEADで全ドリルを再実行していない |
| GitHub CI | 先行 `dad1f95` の全10job成功等を履歴に保存。一方、別実行のWindows timeout／multipart HEAD不在、backupのR2照合・子プロセス失敗等の原因未確定記録もある | 最新HEADのCI未確認。後の成功だけで過去失敗の根本原因解決と扱わない。今回remote再照会なし |

過去の全suiteの件数を現在の件数へ足さない。正確な実行条件・失敗／再実行・CI参照は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) に保存している。

## 未検証・リリース前に残る確認

| 確認対象 | 現状 |
|---|---|
| 最新コードでの全回帰 | `pnpm check` 全体、全browser／single-host suite、全backup／operatorドリル、最新GitHub CIは未実施・未確認。直近は上記の対象限定検証 |
| Cloudflare認証・公開境界 | 実Access・MFA・service token、秘密鍵／pepper、配備後のCSP・CORS・Cookie・domain alias未検証 |
| D1・R2・Queue・Cron | 実D1予算／競合／障害、R2の遅延・429・切断・delete／HEAD障害・7日multipart lifecycle、Queue ack loss／retry／DLQ／requeue、Cron重複・遅延を実環境で未検証 |
| Media | 実Images codec／AVIF変換と費用、AVIF／AV1／Opusを含む他OS／Firefox／Safari／実端末の対応範囲未確定 |
| WebDAV | 実Finder／Explorer／rclone／cadaver／litmusの対応表未確定 |
| 復旧 | 実D1 Time Travel、logical exportからのlive復元、全DO storage喪失、完全停止→修復→監査→受付／GC再開、大規模DB RTO未検証・一部未実装 |
| UI・性能 | 支援技術／a11y、touch、低性能端末、長時間連続運転、最大規模負荷、capacity／費用上限の全体判定未完了 |
| 運用 | staging／production inventory、定時起動／通知先／監視／Logpushの実設定、remote migration／deploy、release／rollback・障害対応runbookの実行なし |

## 次の開発順序

1. **既存／コピー済み書籍の索引要求**：現在の閲覧権限で明示受付し、本棚から結果確認・閲覧へつなぐ。旧要求の失効・結果不明を新要求へ無条件に付け替えない。
2. **本棚の残り**：表紙／ページthumb、書籍metadata編集、entry配信、画像フォルダー・PDF・EPUB本文、安全なreaderとCFI。各段階で原本・索引世代・共有失効を検証する。
3. **Files／処理の残り**：未接続の契約、大規模非同期trash／restore／purge、COPY追跡復元、media COPY／一括再抽出、Gallery性能gate、横断UI品質。
4. **復旧の残り**：未知native／multipartの終了証明と精算、全DO喪失、旧schema／logical import／安全な取消、運用UI・DLQ保守。
5. **全体回帰と実環境gate**：コードを固定して全検証を行い、対象環境を確定した上でstaging／実クライアント／復旧・rollback演習へ進む。

## リモート操作と文書維持

ローカル実装・検証・通常commitは継続対象。pushは、先行の自動承認審査が「外部宛先へのコード送信の明示承認がない」と拒否した後の宛先確認が未回答のため保留中。対象は `daraskme/Nextcloud-flare` の `codex/database-restore`。後続commitへの差替えで再試行せず、force pushもしない。Cloudflareのresource作成・remote migration・secret設定・配備は実行しておらず、GitHubへのpushと別の操作として扱う。

今後は本書の該当行と基準コードを更新し、検証の環境・範囲・失敗・再実行を [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) に追記する。過去の文章を現在状態へ重複追記しない。設計上の完了条件は、ローカル成功や作業上の都合で緩めない。
