# 環境別リビジョンと検証状態

この表をcheckout、ローカル運用runtime、staging、productionの状態比較の正本とする。配備や検証後はここを更新し、各機能文書に環境状態を重複記載しない。

| 環境 | リビジョン | 状態と確認済み範囲 |
|---|---|---|
| 開発checkout | `1aa4317` | 現在のローカルソース。staging配備コードより新しい変更を含む。ローカル検証は隔離SQLite/workerdの結果であり、stagingの動作を証明しない。 |
| ローカル自動化runtime | 通知修正 `3566415` | desktop notification用busctl引数修正を設置済みruntimeへ適用。週次暗号化backupと毎時monitorが稼働し、2026-10-04の世代を外部暗号化archiveから独立DB・19 objectsへ復元照合した。 |
| Cloudflare staging | コード `785faf3`、Worker version `654609ce-781a-4e0d-98d7-b047c280bb4c` | migration `0054`適用、53 migrations・86 tables・174 routes。暗号化と実メディア検証、週次backup/archive復元を確認。CI run [37162606409](https://github.com/daraskme/Nextcloud-flare/actions/runs/37162606409) と [37163402437](https://github.com/daraskme/Nextcloud-flare/actions/runs/37163402437) はそれぞれ5 job成功。 |
| Production | なし | Productionへのmigration・Worker deployは未実施。stagingまたはlocalの成功をproductionの稼働確認として扱わない。 |

## staging backup復元確認

世代 `e4312702-1f92-4b9b-aff9-35f84a84d5f2` / epoch 2 は2026-10-04 00:28:25 UTCに完了した。外部アーカイブ `backup-e4312702-1f92-4b9b-aff9-35f84a84d5f2.ncf`（131,145,497 bytes）からoffline restoreし、86 tablesと19 objects（130,603,898 bytes）を検証した。実際の画像・音声・動画3件は復号後の全byte/SHA-256が既知hashと一致し、owner attestation、admin receipt、encryption markerも確認した。remote receiptは`completed/released`。maintenance、GC pause、backup freezeは解除され、一時bridgeは削除済み。

復旧JSONは本人の端末内だけで扱い、Cloudflareや定期処理へ保存していない。検証用復元データと一時作業コピーは照合後に削除した。timerは日曜03:30 JST（次回2026-10-11）と毎時monitor。PC停止中に予定時刻を過ぎた場合は、ユーザーsession再開後に実行する。

monitorはhealthy/live reachable、pending通知0。デスクトップ通知2件とバックアップ正常復帰通知1件を確認した。Billing APIがアカウント全体の請求を返すためstaging追加額を厳密に帰属できず、`unattributed_below_threshold`は予算内を保証しない。自動停止するhard capもない。
