# Staging の追加費用管理

対象は `darask.date` の staging 専用リソースにより増える Cloudflare 請求額で、上限は **月 10,000 円**。既存の有料プラン料金はこの枠に含めない。ただし Cloudflare の無料枠と有料プランの包含量はアカウント全体で共有されるため、staging のリソース使用量を単価に掛けるだけでは追加請求額を確定できない。

## 現在のアカウント基準値

2026-10-03 の確認値: Workers Paid、R2 Paid、Cloudflare One Free。請求画面の契約一覧に Images Paid はないため Images Free と見込むが、画像変換試験の前に Dashboard で確定する。Cloudflare の請求期間は 2026-09-19 開始で、10-02 までのアカウント全体の billable usage は **USD 0.30**。この $0.30 は staging 配備前の基準であり、staging の費用ではない。アカウント全体のサービス別内訳と各共有枠の残量は別途 Dashboard で照合する。Cloudflare One Free は50人以下を対象とするプランで、今回の3人の Access 利用者はその範囲内である（[Cloudflare One plans](https://www.cloudflare.com/plans/zero-trust-services/)）。プランと請求期間は変更され得るため毎月確認する。

Billing Read 権限を持つ token が環境変数にある NixOS では、次の読み取り専用コマンドで [Cloudflare の billable usage API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/paygo/) を確認できる。token や個々の請求行は表示・保存せず、アカウント全体の従量請求額を日別に集計する。`reportedPeriodEnd` は最も新しい返却行の区間終了であり、その日付の行がすべて揃った証拠ではない。2026-10-03 の照会では 10-02 分は通常より少ない 6 行だけだったため、最新日の金額を確定値として使わない。API の数値だけで staging 増分を確定せず、各専用リソースの Analytics と照合する。

```sh
source "$XDG_RUNTIME_DIR/ncf-staging-bootstrap.env"
node ops/staging/billing-snapshot.mjs --execute
```

## 月額の目安

次は公式単価を使った概算。円換算は比較用に **USD 1 = ¥150** と仮定する（請求換算、税、カード手数料とは一致しない）。Workers Paid の $5/月はすでにアカウントで契約済みなので、今回の「追加費用」には含めない。Workers、D1、DO、KV、Queues の included usage はアカウント単位の共有枠であり、残りがあれば追加課金は $0、使い切っていれば下の超過分が追加になる。R2 の Standard 無料枠も同様にアカウント共有。表の金額は記載した workload から計算できるサービス分だけで、D1/KV の実量、DO の compute duration、画像変換、その他の従量項目を含まない。したがって、未計測分があるシナリオの値は総額ではなく下限の目安である。

| 月の利用例 | 月間 workload | 全包含量が残る想定 | 共有枠が残らない想定 |
| --- | --- | ---: | ---: |
| 少人数の手動試験 | 3 人、月10万 Worker requests・平均 CPU 5 ms、D1/DO/Queue/KV は各 Paid 包含量以下、R2 Standard 5 GB・PUT 5万・GET 50万 | **$0（追加従量分）** | 各サービスの実量を下の単価式に入れる。D1 rows/storage と DO duration が未計測なので一つの数字には固定しない。 |
| 継続利用と中程度の fixture | 15 million Worker requests・平均7 ms CPU、DO 1.5 million requests、R2 Standard 50 GB・Class A 2 million・Class B 20 million、Queue 1 million messages | **約 $12.65（約 ¥1,900）** | **約 $25.05（約 ¥3,760）** |
| 負荷試験の例 | 100 million Worker requests・平均7 ms CPU、R2 Standard 100 GB・Class A 10 million・Class B 100 million、Queue 10 million messages | **約 $126.25（約 ¥18,940）** | **約 $138.50（約 ¥20,780）** |

「全包含量が残る」は追加費用が少なくなる側の仮定である。包含量が一部残る場合の請求額は両列の間になる。中程度シナリオは残量ありの場合 Workers $3.00 + DO $0.15 + R2 $8.70 + Queues $0.80 = $12.65、残量なしの場合 Workers $6.60 + DO $0.30 + R2 $16.95 + Queues $1.20 = $25.05。負荷試験例は同様に $126.25 / $138.50。D1 と KV の実操作量、DO の duration、画像変換は表の前提に含めておらず、超過すればさらに追加費用が生じる。実際の残量はアカウント全体の usage を見て選ぶ。

少人数の手動試験は、記載 workload の範囲なら ¥10,000/月をかなり下回る見込みだが、未計測の DO duration や D1/KV 操作を含めた総額の保証ではない。Cloudflare は staging 単独のハード上限を提供しないため、実際の増分は請求画面とリソース別 Analytics で日次確認する。とくに R2 の繰り返し PUT/GET、Queue retry/DLQ、Cron の実 CPU と毎分の R2 inventory/list を追う。画像変換 Free は月 5,000 unique transformations までで、超過時は有料化ではなく新しい変換がエラーになる。

簡易式（USD、全包含量が残っている前提の超過目安。共有量がゼロなら `max(0, usage - allowance)` を `usage` に置き換える）。Cloudflare はサービスと計量単位に応じて超過分を請求単位へ切り上げるため、以下は連続値で計算した概算式であり、境界付近では実請求が高くなることがある。R2 は GB-month と operation を次の billing unit へ切り上げ、DO は請求対象の request / GB-s を次の million 単位へ切り上げる:

```text
Workers = max(0, requests - 10,000,000) / 1,000,000 * 0.30
        + max(0, CPU_ms - 30,000,000) / 1,000,000 * 0.02
R2 Standard = max(0, GB-month - 10) * 0.015
            + max(0, Class_A - 1,000,000) / 1,000,000 * 4.50
            + max(0, Class_B - 10,000,000) / 1,000,000 * 0.36
Queues = max(0, operations - 1,000,000) / 1,000,000 * 0.40
```

有料枠の D1/DO SQLite は 25 billion rows read、50 million rows written、5 GB-month が包含量で、超過単価はそれぞれ $0.001/million、$1/million、D1 $0.75/GB-month・DO SQLite $0.20/GB-month。KV は 10 million reads・1 million write/delete/list が包含量で、超過は reads $0.50/million、write/delete/list $5/million。ここに表示した個別上限もアカウント全体の利用で消費される。

## 初回配備時の基準値と日次で記録する値

Cloudflare Billing と各サービスの Analytics から、作成前日の値を保存する。請求月の区切り、請求通貨、税、換算レートも請求画面で確認する。既存利用量の変動がある場合は、直近 7 日の日次値も記録して基準にする。

| 記録欄 | 値 | 確認先 |
| --- | --- | --- |
| 請求月の開始・終了、タイムゾーン | 2026-09-19 開始。終了と timezone は請求画面で確認 | Billing |
| 既存プラン以外の当月利用料、税、通貨 | 2026-10-02 時点 USD 0.30（アカウント全体の基準値） | Billing |
| 直近 7 日の既存利用量と通常の増加傾向 | 未記入 | Billing / Analytics |
| Workers requests / CPU、Durable Objects requests / duration / storage | 未記入 | Workers / DO Analytics |
| D1 rows read / written / storage | 未記入 | D1 Analytics |
| R2 storage / Class A / Class B | 未記入 | R2 Analytics |
| KV reads / writes / deletes / lists / storage | 未記入 | KV Analytics |
| Queues operations、再試行、DLQ | 未記入 | Queues Analytics |
| Images の一意な変換数 | 未記入 | Images Analytics |
| 追加 Access 利用者の契約上の席数・単価 | Cloudflare One Free。3 利用者は公式 Free plan の50人以下の対象範囲 | [Cloudflare One plans](https://www.cloudflare.com/plans/zero-trust-services/) / Billing |

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

料金表は変更され得るため、配備日にも公式資料を再確認する。例の単価と計算は budget forecast であり、Cloudflare 請求の確定見積りではない。
