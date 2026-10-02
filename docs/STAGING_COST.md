# Staging の追加費用管理

対象は `darask.date` の staging 専用リソースにより増える Cloudflare 請求額で、上限は **月 10,000 円**。既存の有料プラン料金はこの枠に含めない。ただし Cloudflare の無料枠と有料プランの包含量はアカウント全体で共有されるため、staging のリソース使用量を単価に掛けるだけでは追加請求額を確定できない。

## 初回配備前に記録する値

Cloudflare Billing と各サービスの Analytics から、作成前日の値を保存する。請求月の区切り、請求通貨、税、換算レートも請求画面で確認する。既存利用量の変動がある場合は、直近 7 日の日次値も記録して基準にする。

| 記録欄 | 値 | 確認先 |
| --- | --- | --- |
| 請求月の開始・終了、タイムゾーン | 未記入 | Billing |
| 既存プラン以外の当月利用料、税、通貨 | 未記入 | Billing |
| 直近 7 日の既存利用量と通常の増加傾向 | 未記入 | Billing / Analytics |
| Workers requests / CPU、Durable Objects requests / duration / storage | 未記入 | Workers / DO Analytics |
| D1 rows read / written / storage | 未記入 | D1 Analytics |
| R2 storage / Class A / Class B | 未記入 | R2 Analytics |
| KV reads / writes / deletes / lists / storage | 未記入 | KV Analytics |
| Queues operations、再試行、DLQ | 未記入 | Queues Analytics |
| Images の一意な変換数 | 未記入 | Images Analytics |
| 追加 Access 利用者の契約上の席数・単価 | 未確認 | Zero Trust plan / Billing |

staging 作成後は `next-cloud-flare-staging`、`ncf-staging`、`ncf-staging-blobs`、`ncf-staging-backups`、`ncf-staging-jobs`、`ncf-staging-jobs-dlq`、専用 KV のメトリクスを同じ請求月で日次に記録する。アカウント全体の利用料の増加と照合し、他の workload による変動を差し引く。区別できない料金は暫定的に staging 側へ計上する。請求確定後は実際の増分で見直す。

## 日次の判断

1. staging の当月増分を請求通貨で集計し、請求に使われる換算と税を含めて円に直す。Cloudflare の表示が推定額なら、その旨を記録する。
2. `当月増分 + max(直近の日額, 予定する負荷試験の日額) × 月末までの日数` を月末見込み額とする。保存容量が増え続ける場合は、その増加分も加える。
3. 月末見込み額が **5,000 円**を超えたら新しい負荷試験を始めず、利用量を確認する。**8,000 円**を超えたら試験と追加利用者の招待を止め、原因と継続可否を確認する。**10,000 円**に達する見込みなら staging の負荷を止める。Cron、Queue、外部アクセスなど継続して費用が出る入口も確認する。

これは人が実施する運用ゲートであり、Cloudflare 側の強制的な課金上限ではない。Pay-as-you-go アカウントで利用できる [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) はアカウント全体の USD 建て累計利用料を通知するだけで、staging 単独の上限設定や自動停止には使えない。設定できる場合は別途アカウント全体の早期通知として使い、通知先と受信を確かめる。

初回の実環境試験は少数の招待利用者、小さな fixture、手動の短時間 smoke に限定する。大量アップロード、並列負荷、動画変換、Queue の長時間再試行、バックアップの大量複製は、日次メトリクスと月末見込み額が読めるまで実行しない。毎分 Cron は 30 日で約 43,200 回起動するため、リクエスト数だけでなく実 CPU 時間と後続の D1/Queue 操作を確認する。

## 価格確認先

実額は請求プランとアカウント全体の残り包含量で決まる。配備時と請求月の開始時に以下の公式価格を再確認する。

| サービス | 確認する課金単位 | 公式資料 |
| --- | --- | --- |
| Workers | requests、CPU 時間 | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Durable Objects | requests、duration、SQLite storage / read / write | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| D1 | rows read / written、storage | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| R2 | storage、Class A / B operations | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| KV | reads / writes / deletes / lists、storage | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| Queues | operations。送信、受信、削除や再試行を含む | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| Images | 一意な変換数 | [Images pricing](https://developers.cloudflare.com/images/pricing/) |

staging の作成前には請求基準値がまだ埋められない。実際の Cloudflare アカウントで上の記録を埋めてから費用見込みを判断する。
