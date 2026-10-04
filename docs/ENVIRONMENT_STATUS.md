# 環境別リビジョンと検証状態

この表をcheckout、ローカル運用runtime、staging、productionの状態比較の正本とする。配備や検証後はここを更新し、各機能文書に環境状態を重複記載しない。

| 環境 | リビジョン | 状態と確認済み範囲 |
|---|---|---|
| 開発ソース | この checkout（PR #43〜#46 と最終レビューの修正） | ZIP の取得費用計上、WebDAV 条件検査、章・再共有データの完全削除、利用者別 admission 上限に加え、EPUB の取得前予算予約と未確定 upload の purge 拒否を実装。`0064` までの63 migrations・90通常tables。[最終レビュー](reviews/astra-final-20261005.md)と対象 commit の CI を参照し、下記の配備済み版とは区別する。 |
| ローカル自動化runtime | `f131f80`（155 files） | 本人の明示承認後、56 migrations・88 tables対応版へ切替済み。日曜backup・毎時monitorのtimerはactive、両serviceはinactive。旧86-table版と直前の`355f61b`版はrollbackディレクトリへ保持。05:01:45 UTCのmonitorはhealthy / live reachable / pending 0、終了コード0。 |
| Cloudflare staging | コード `f131f80`、Worker version `35b6182f-33e4-4013-a546-aab8de1f1035` | `0057`まで適用。56 migrations・88通常tables・480 triggers・176 routes。FK違反0、epoch 2、maintenance / gc_paused / backup_frozenはいずれも0。配備後の匿名HTTP smokeは9件成功。実WebDAV取得・暗号化fixtureの復元制約試験は下記の`1cf8681`時点の記録。 |
| Production | なし | Productionへのmigration・Worker deployは未実施。stagingまたはlocalの成功をproductionの稼働確認として扱わない。 |

## 2026-10-04 レビューとPRの検証

READMEを利用者・開発者・運用者向けに整理し、各文書の古い配備記録を履歴として区別した。[レビュー対応](reviews/runtime-adversarial-20261004.md)に修正理由と検証範囲を記録する。

[PR #37](https://github.com/daraskme/Nextcloud-flare/pull/37)は2026-10-04 04:53:18 UTCに`main`へマージした（`1073bf6df82feb495eade040aa6ee45f6d24607a`）。マージ直前にhead `f131f80`・base `1aa4317`・push/PR合計10 checksの成功を照合した。マージ後のGit treeは検証済みheadと同一。この表への最終結果追記は文書のみの変更である。

- 追加レビュー前の候補は`1cf8681`。CI [push run 37172124186](https://github.com/daraskme/Nextcloud-flare/actions/runs/37172124186) と [PR run 37172126899](https://github.com/daraskme/Nextcloud-flare/actions/runs/37172126899) は全5 jobs成功。追加8件の対応は後続の`09e489a`に含まれ、この旧候補のCI検証範囲には含まない。過去候補`c920122`・`355f61b`はテスト本体が通ったが診断gateが失敗したため、green runとして扱わない。
- 候補`1cf8681`のUbuntu `pnpm check`成功。Node単体83 files / 991成功・8 skip。統合は専用R2短尺1件と通常125 files / 2,288件の合計2,289件成功。専用プロセスの既知platformメッセージは2件、通常プロセスの未処理Promiseは0件。lint・型・契約・設定・ビルドも成功。
- ローカルの全ブラウザー試験は49成功・追加実メディア未指定2 skip。88-table backup drill成功。隔離試験ツール追加後のlint、Worker/Web/試験Workerの型検査、contracts、configとハーネス4テストも成功。
- 暗号化ファイルを共有親へ復元する迂回は実ControlDO/LockDOを使うローカル回帰で再現し、同期commitと非同期tree job両方に制約を追加。共有を途中で変更する競合も拒否する。修正後の関連4 suites / 42 tests成功。

### 添付レビューの追加修正

- lint・Worker/Web/試験Worker型検査・contracts・config成功。Node単体86 files / 998成功・8 skip。
- KDF修復と実行開始競合は45件成功、未処理Promise診断0件。公開共有・ticket・再共有の関連統合108件、DAV/renameの関連統合44件も成功。
- `0057`のprepare検証で56 migrations・88通常tables・480 triggers。stagingの事前read-only検査では旧55 migrations、100件超のnode_propsは0、claimed KDFは0、epoch 2・各停止flagは0。
- 計算開始後に両保存先の完了証明を失ったKDFは安全のため停止を維持する。sessionの単一source枯渇は抑えるが、分散sourceによる全体64枠の枯渇は残る。詳細はレビュー文書と各契約文書を参照。
- tree jobの上限・有効lease・再取得競合4件成功。88-table backup drillは0057適用後のcapture/verify/ローカルBACKUPS配布/offline restore/FK・FTS検査まで成功し、復元先の追加列・indexも確認。全browserは49成功・外部媒体未指定2 skip（7.7分）。`09e489a`のCIは2,304件成功・migration件数の期待値1件失敗（未処理Promise0）で止まったため成功扱いにしない。`f131f80`で55→56へ合わせ、schema 8件成功。
- 最終候補`f131f80`のCIは [push 37176688104](https://github.com/daraskme/Nextcloud-flare/actions/runs/37176688104) / [PR 37176689710](https://github.com/daraskme/Nextcloud-flare/actions/runs/37176689710)の両runで全5 jobs成功（Ubuntu、Windows 2 shards、browser、backup）。UbuntuのNode単体は86 files / 998成功・8 skip、通常統合は125 files / 2,305件、専用R2短尺は1件成功。専用プロセスの既知platformメッセージは2件、通常プロセスは0件で、両方とも未処理Promiseは0件。lint・型・契約・設定・ビルドと、CIのbackup / operator / run drillも成功。

### stagingの暗号化復元とWebDAV（`1cf8681`時点）

実管理者の専用テストフォルダーへ小さな署名済みNCFENC2画像を保存し、NixOSのrclone 1.75.1で一覧・全暗号文取得を確認した。Content origin経由の取得との全byte SHA-256が一致し、読み取り専用の一時app passwordを失効させるとアクセスは拒否された。

同じ暗号化fixtureをゴミ箱へ移し、空になった親を共有すると復元は409で拒否され、ゴミ箱と共有先の状態は変化しなかった。共有を無効化した後は同一node/blobへ復元できた。明示承認されたこのfixtureと空フォルダーだけをpurgeし、専用資格情報の失効も確認した。既存の画像・音声・動画3件はこの試験の操作対象外。

## 隔離した実Cloudflareの障害試験

run `c4df4902-2a97-4381-84cf-9dfcf1f082aa` は専用D1、R2 2個、Queue、DLQ、非公開Workerを使用した。アプリのリソースは破壊せず、53 migrations（`0054`まで）の専用DBで次を確認した。

- 実Cronのscheduledイベント到達。最初のfixture作成はQueue bootstrapで開始し、その後のCronでは重複実行しないことを確認。
- production outbox handlerによる実Queueの再試行とDLQ処理。completed 1 / failed 1 / dead letter 1。
- 専用ControlDOの`ctx.abort()`による再生成、新しいinstance nonce、epoch・停止状態・完了監査・D1鏡像の保持。
- 実R2の2-part complete、HEAD/GETの全byte SHA-256一致、別multipartの明示abortとobject不在。
- 終了後は専用6リソースを削除し、各GETが404となることを確認。

手順・制約は[FAULT_DRILL](../ops/staging/FAULT_DRILL.md)。7日（604,800秒）のincomplete multipart lifecycle設定は確認したが、7日経過後の削除は未検証。Cronだけによる初回setup、アプリsingletonの自然なidle eviction、Windows/macOSのWebDAV OSクライアントも未検証。

## staging backup復元確認

世代 `e4312702-1f92-4b9b-aff9-35f84a84d5f2` / epoch 2 は2026-10-04 00:28:25 UTCに完了した。外部アーカイブ `backup-e4312702-1f92-4b9b-aff9-35f84a84d5f2.ncf`（131,145,497 bytes）からoffline restoreし、86 tablesと19 objects（130,603,898 bytes）を検証した。実際の画像・音声・動画3件は復号後の全byte/SHA-256が既知hashと一致し、owner attestation、admin receipt、encryption markerも確認した。remote receiptは`completed/released`。maintenance、GC pause、backup freezeは解除され、一時bridgeは削除済み。

復旧JSONは本人の端末内だけで扱い、Cloudflareや定期処理へ保存していない。検証用復元データと一時作業コピーは照合後に削除した。timerは日曜03:30 JST（次回2026-10-11）と毎時monitor。PC停止中に予定時刻を過ぎた場合は、ユーザーsession再開後に実行する。

2026-10-04、本人の明示承認を受け、prepare/check済みの`f131f80`をローカル自動化runtimeへ有効化した。active manifestは155 files・56 migration SQL・88 tablesで一致し、backup stateはcompleted / archiveVerified=true。直前の`355f61b`版を`release.rollback-7d22580c-682e-4f80-b920-730f67088d53`へ保持し、旧86-table版も保持した。設定・資格情報・保存済みarchiveは切替対象外。切替後のmonitorは2026-10-04 05:01:45.200 UTCに正常終了し、backup healthy / live reachable / pending 0を確認した。これはruntimeと監視の確認であり、新しいバックアップ世代の作成・復元を再実行した記録ではない。

monitorはhealthy/live reachable、pending通知0。デスクトップ通知2件とバックアップ正常復帰通知1件を確認した。Billing APIがアカウント全体の請求を返すためstaging追加額を厳密に帰属できず、`unattributed_below_threshold`は予算内を保証しない。自動停止するhard capもない。
