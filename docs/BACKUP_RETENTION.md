# バックアップの保持判定と健全性検査

更新: 2026-09-25。`pnpm backup health`は、現在のD1にある完了記録とBACKUPSの実データを照合し、論理バックアップの有効世代数・鮮度・検査範囲をJSONで返す。更新・開始・解除・取消し・R2削除は行わない。

## 判定条件

- 最大年齢は35日。サーバーが世代開始時に記録した`generation.createdAt`を使い、ダウンロード後に再取得したサーバー時刻との差が35日を超えた世代を除外する。ちょうど35日は範囲内である。`capturedAt`や`completedAt`を更新して有効期間を延ばさない。
- 最少5世代。異なるUUIDのcompleted行について、manifest key/hash・完了/解除時刻を検査し、R2の全partとSQL・信頼済みschema・全table digest・FK・FTSを検証できたものだけ数える。古いepochも正しい完了世代なら検証対象にする。schema0037以降の互換性は[過去世代](BACKUP_HISTORY.md)を参照。
- 最も新しい有効世代の取得から24時間を超えたら日次不足とする。24時間ちょうどは範囲内である。
- 5世代未満でも、35日超の世代を有効に戻さない。pending/exporting/failedや、取得不能・破損・未対応schema・世代不一致は数えない。検査中に期限を超えた世代も最終結果から除外する。

## 実行と終了コード

```sh
pnpm backup health --local \
  --operator-config scripts/backup/operator.local.example.json \
  --config wrangler.jsonc --epoch <現在のepoch>
```

localは同じ対象Workerのdev登録とBACKUPS設定を使う。remoteは`--remote --operator-config <descriptor> --epoch <epoch>`と[R2保存用環境変数](BACKUP_GENERATIONS.md)を使う。remoteのhealthには`--config`と`--environment`を渡さない。D1の任意SQL接続設定は受け取らず、世代一覧は専用`BackupOperator.inventory` bindingから読む。remote認証・実環境運用は未検証である。

| 終了コード | 意味 | 対応 |
|---|---|---|
| 0 | 検査完了、5世代以上・24時間以内・検査した有効期間内に破損なし | 検査時刻とレポートを記録する |
| 2 | 不足・破損・日次欠落、または検査上限による未完了 | JSONの`alerts`と`missing`を通知・確認する |
| 1 | 権限・接続・一覧取得・epoch/世代競合などで判定できない | 原因を解消して再検査する。成功と扱わない |

最後のJSON行は`command:health`と`result`を持つ。`result`には`healthy/complete/eligible/missing/observedAt/latestCreatedAt/alerts/generations`がある。世代ごとの状態は`eligible/expired/invalid/unchecked`。providerのURL、SQL本文、秘密情報は出力せず、検証失敗は限定したエラーコードにする。

`backup_generations_insufficient`は5世代不足、`backup_daily_missing`は24時間超または有効世代なし、`backup_generation_invalid`は有効期間内の検証失敗、`backup_health_incomplete`は未検査範囲が残ることを示す。`eligible`は実際に検証できた数であり、未完了時の全件数を推測しない。

定時実行には[maintain](BACKUP_MAINTENANCE.md)で日次・検査・不足/鮮度補充を一連に行い、非0終了を監視へ渡す。schedulerや外部通知先はまだ設置していない。不足時は保存先の障害・破損原因を確認し、新しいUUIDで`backup run`を実行して現在の世代を追加し、healthを再実行する。日次コマンドは同日の完成済み世代を再利用するため、それだけで複数世代を補充したことにはならない。途中失敗は同じUUID/epochで再送し、自動取消ししない。過去日のsnapshotを取得できたと装わない。

## 一貫性と上限

一覧はprimary D1の`backup_runs`主キー順に100行ずつ取得する。新しいindexやmigration、通常tableは追加しない。ControlDOのepoch・バックアップtoken/phaseを全ページとデータ検査後に照合し、途中で変わったら検査全体を無効にする。D1のepoch・停止状態との不一致も拒否する。DOにpreparing intentだけがある場合も`active`へ表示し、D1 receiptがないことを開始失敗の証拠にはしない。

1回のhealthは一覧100ページ・最大10,000行、データ検証100世代まで。新しい取得時刻から順に検証する。上限に達して未検査世代が残れば、5世代が検証済みでも正常終了しない。R2本文上限・1要求の期限とSQL制限は既存のdownload/verifyと共通である。世代ごとの作業用ファイルは専用の一時ディレクトリに作り、終了時にそのディレクトリだけを削除する。大容量の世代検証は転送量・時間を必要とする。実運用での測定は未実施。

これは論理SQL世代の検査時点の保持判定である。期限切れR2 objectの物理削除、source BLOBSの実在確認・独立複製、D1喪失後の信頼できる世代選択、Time Travel、live restore、新epoch発行・全監査は別工程である。healthの成功だけを根拠に稼働中DBを復元しない。オフライン調査は期限切れ世代でも可能だが、復旧対象への採用とは区別する。
