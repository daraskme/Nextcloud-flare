# サムネイル生成物の回収

2026-09-29。schema0071、通常79table・147 route。[保存処理](IMAGE_DERIVATIVES.md)で保持した生成物のpinと物理予約を、安全な停止証拠に基づいて精算する。`jobs/imageDerivativeCleanup.ts`と`ControlImageDerivatives`を追加した。専用Cronは`1-59/2 * * * *`。ローカル設定だけで、remoteへの設置・配備は行っていない。

## 対象と走査

未公開の生成物は元のclaim期限またはepochが過ぎたときに停止する。公開済みの生成物は原本blobが不可逆なdeleting/deletedへ進むまで保持する。単に原本の参照数が0になっただけでは回収を始めず、復元・COW・保持中versionの余地を残す。

`image_derivative_cleanup`は生成物と同時に作成する。公開済みで原本が有効な行は走査対象から休止させ、原本の削除開始と同じtransactionで再び期限到来にする。`next_at,image_id`の部分索引で最大8件を順に処理する。共通25秒期限、claim token/epoch/deadline、失敗時60秒の待機を使い、未確定の1件が後続を止めない。旧0070の準備済み・保存済み・公開済み生成物は、元の行を変えずに回収行を補う。

## 書込みを止める証拠

最初にD1の停止理由・epoch・時刻を保存し、結果をfailed/image_retiredへ変更する。以後のimage.put grantとreadyへの公開はD1 triggerで拒否する。

次にControlDOが、元のImages成功記録の全identityと出力がD1と一致すること、およびそのR2 keyに独立台帳のpending書込みがないことを確認する。独立Images記録が失われた場合や、D1だけが古いsnapshotへ戻っていてDOにpendingが残る場合は、停止証拠を発行しない。

ControlDOは生成物ごとの不変な停止tokenとkeyを保存する。新しいimage.putはこの記録を同期検査して拒否するため、D1の停止行が失われても再送できない。停止記録はImages費用記録と同じgeneration単位で保持し、時刻だけで削除しない。成功したImages記録に対応するため、件数は既存の100万件上限に拘束される。大量履歴での容量・移行時間は未測定。

停止tokenのD1反映は共通global受付を使い、D1にもpendingがないことを検査する。応答喪失は同じtokenで照合できる。既存のnative終了記録の修復と区別し、停止処理でpendingをsucceeded/not_startedへ書き換えない。

## 容量とGC

停止証拠があり、保存事実が既にblob_storageへ記録済みなら、実容量を維持したまま予約を解放する。観測が欠ける場合はR2 HEADを1回実行し、実在なら観測したbytes/etagを計上し、不在なら予約を解放する。HEADは元のPUT終了を推測する用途には使わない。

HEADには直接ACKを得た予算更新が必要で、1leaseにつき1回・1生成物につき累計64回まで。予算更新のACK喪失でも回数を戻さず、timeout・エラー・遅い応答・claim差替えでは精算しない。通常停止・backup/restore freeze・epochの検査も共通受付に従う。

精算記録、予約解放、生成物pin解除、blobの状態変更を一つのbatchで確定する。実在する出力はorphanとして既存GCへ渡し、引渡しから35日以上の猶予を設ける。physical bytesの減算は、GCが削除と不在を確認した後だけ行う。不在が証明された出力はdeletedのkey墓標として残す。精算済みの記録を再実行しない。

## 残る接続

復元CLIの`repair-restored --kind images`からも同じ処理を呼べる。採用済み復旧要求のepoch/revision/tokenへ各batchを固定し、ControlDOの共通受付を直接使う。最大8件、25秒、保存済み画像の保持とGC猶予を維持する。遅延候補も含む保留判定と操作手順は[復元後の領域修復](DATABASE_RESTORE_DOMAINS.md)を参照。

native PUTの本当の結果が不明な場合、独立履歴が失われた場合、HEAD予算を使い切った場合はpinと予約を保留する。運用上の終了証明、予算再承認、通知・履歴整理は未接続。

[Queueのsm/md生成](IMAGE_QUEUE.md)は接続済み。lgの要求時生成、thumb ticket/配信、Gallery API/UIは未接続。保存成功が確認済みで未退役の生成物は、同じ通知の新claimから[公開を再開](IMAGE_DERIVATIVES.md)できる。失敗後の明示的な有料再試行は後続。公開済み生成物の配信は今後の現在認可に基づく別経路で行う。

検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。ローカルD1/DO/R2/Imagesの証明であり、実Cloudflare・最大履歴量・OSクライアントの検証ではない。
