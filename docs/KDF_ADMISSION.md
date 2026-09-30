# 認証KDFの実行・全体制限

更新: 2026-09-24。アプリパスワードの作成・検証・pepper更新を、Worker内の待機制限とControlDO/D1の全体予算へ接続した。D1はmigration `0029`、今回ControlDO SQLiteの終了記録と修復を追加。実CloudflareのCPU・費用・処理量・切断挙動と、共有passwordのper-share/IP制限は未検証・未接続。

## 実行経路

Workerの`auth/kdf.ts`は1件実行・FIFO256件・待機5秒を維持する。形式・長さ検査後、HMAC pepperを計算し、`auth/globalKdf.ts`からcanonical ControlDOへ32-byte中間値と16-byte saltを渡す。元のpasswordとpepperはRPCへ渡さない。

ControlDOの`ControlKdf`は独立したexecutorで同時1件・FIFO256件を処理し、PBKDF2-SHA256を100,000回、出力32 bytesに固定する。callerからアルゴリズム・反復回数・出力長は受け付けない。現構成は単一ControlDOなので通常の計算は1件ずつであり、20並列の処理能力を意味しない。D1の20枠は旧instanceとの重複と未精算の試行も含む全体上限として使用する。600回/分を必要とする実環境の処理量・待ち時間はstagingで測定する。

`AppPasswordPepperRing`はderivation backendを必須とする。productionのprivate API・DAV用設定は必ずControlDO backendを選び、ローカルPBKDF2への自動fallbackはしない。既存の暗号・認可fixtureだけがtest専用backendを明示する。発行・認証・pepper更新後の再検証も、それぞれ別の試行として数える。

## 永続予算と送信期限

`kdf_attempts`はattempt UUID、handler固有のdispatch token、epoch、開始・送信期限、状態・終了時刻だけを記録する。password、pepper、salt、入力中間値、計算結果は保存しない。

| 制約 | 動作 |
|---|---|
| rate | 直近65秒の受付を最大600件。送信遅延最大5秒を含め、実行開始の任意60秒で600件以下となる保守的な窓 |
| 全体の枠 | epochをまたぐ`claimed`を最大20件。期限切れやinstance再生成だけでは解放しない |
| 送信期限 | RPC発行から最大5秒。D1が保存した期限も再検査し、遅延ACK後には計算しない |
| queue | WorkerとControlDOそれぞれ1件実行・最大256件待機・5秒待機。期限は実行直前にも検査 |
| 保持と掃除 | `claimed`は削除禁止。終端receiptも65秒は保持し、次の受付で古い終端だけを削除 |
| epoch復旧 | D1のepoch変更時に65秒のcooldownを設定。既存rate・未精算行は消さない |

current epoch、maintenance、cooldown、rate、枠数をD1 insert triggerで検査する。claim保存応答が確認できてから、ControlDO/D1の現在状態・同期storage fence・期限を再検査してnative cryptoを呼ぶ。同じattempt IDを再送しても再実行しない。

[CloudflareのDO lifecycle仕様](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)では、新instanceの開始後にも古いRPCがstorageを使わずに完了する場合がある。このためメモリの同時実行数だけを全体制限に使わない。最後のstorageアクセスで古いinstanceを拒否し、開始済み・結果不明の枠はD1へ残す。

## 応答喪失・取消し・停止

- claimの応答喪失ではnative cryptoを呼ばない。handler自身のdispatch tokenだけを`not_started`に収束させる。別handlerによる同一ID再送は元の枠を解放できない。
- native cryptoが開始されたら、成功・例外の実際の終了後だけ`finished`へ精算する。計算は途中停止できず、callerの取消しや期限経過で先に枠を返さない。
- 精算応答を失った場合は同じID/tokenの終端receiptを読み直す。保存を確認できなければ503にし、未精算枠を保持する。rateは失敗・取消し・未送信でも返さない。
- Workerは取消し後の計算結果を使用せず、中間値を`finally`で消去する。DOも所有する入力・saltコピーを処理後に消去する。秘密値をlogへ出さない。
- 混雑・RPC失敗はローカルの`KdfUnavailableError`へ変換し、DAVと発行APIは`503 not_ready`・`Retry-After: 1`・`private, no-store`を返す。passwordの不一致を表す401と区別し、混雑時は`WWW-Authenticate`を付けない。
- 計算前のAccess/root/credential検査と、計算後の現行credential・digest・epoch・maintenance/最終D1認可assertionを維持する。復旧監査と最終再開fenceも未精算KDFを拒否する。

リモート配備・旧版へのrollbackは停止と復旧手順の下で行う。旧版のWorkerはローカル計算経路を持つため、混在した配備を新しい全体制限の検証済み状態としない。epoch復旧後、KDFはcooldown満了まで503を返す。ローカルbrowser fixtureは準備済み状態としてこの時刻を設定するが、productionへその設定経路は公開しない。

## 終了記録の修復

ControlDO SQLiteの`control_kdf_receipts`に、id・handler token・元epoch・元送信期限・状態だけを最大20件保存する。D1 claimより前に`reserved`を保存し、枠がなければ新しいclaim/計算を始めない。native計算の実終了後は`finished`、handlerが以後送信しないと確定した場合だけ`not_started`へ一度遷移する。入力・salt・結果はここにも保存しない。

終了記録を保存してから、同じid/token/epochのD1行を精算する。D1終端receiptを確認した後だけローカル記録を削除する。DB書込み・読戻しの応答喪失やeviction後も、次のKDF受付前に最大20件を照合する。内部RPC `repairKdfSettlements(expectedEpoch, limit=20)`は受付を停止し、復旧監査を前後で初期化して同じ処理を行う。返す件数は`checked/reconciled/pending/unknown`。public HTTPへの公開・自動alarm再試行は行わない。復旧監査と受付再開はD1未精算行に加え、ローカル未解決記録も拒否する。

SQL cursorは`await`前に配列として読み切る。[SQLite-backed DOのstorage契約](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)に従い、非同期I/Oをまたぐcursorをsnapshotとして使わない。保存とD1送信の順序は[DOのoutput gate](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)を前提とし、未確認書込みを許可する設定は使わない。

D1に同じtokenの行がない場合は、primaryの書込みbatchでcontrol行に書込みを行ってから、同一transaction内で不在とDB時刻を照合する。元送信期限を過ぎている場合だけ、**既に終了または未送信が確定した**ローカル記録を削除できる。後に実行されるclaimのSQLは元期限を再検査するため拒否される。単独SELECTやWorker側の時計だけではこの判定を行わない。[D1 batchのtransaction契約](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)と[SQLiteのwrite transaction直列化](https://sqlite.org/lang_transaction.html)に基づく処理で、遅延claim・書込み応答喪失をローカル試験する。不在を確認した場合も、計算結果を成功として返さない。

`reserved`のまま停止した記録は終了証明を持たないため、期限切れ・epoch変更・evictionだけでは修復も削除もしない。別handlerのtokenや異なる終端状態を上書きしない。完全なDO storage喪失、終了記録の保存前にinstanceが失われた場合、旧版が残したD1行など、証明のない試行は保留を維持する。稼働中D1 restore・時計異常・混在versionの安全な運用はstaging/restore gateに残る。

## 検証

- 既存Node executor試験: FIFO、256件、5秒、例外後の回復、待機/実行中の取消し、遅延timer。
- 新規Node budget 7件: 600/65秒境界、20枠と旧epoch、cooldown、未知枠保持、不変receipt、時計巻戻り。
- 新規workerd 20件: 実PBKDF2・D1・ControlDO RPC、instance内直列化、重複/未知枠の全体上限、claim/精算ACK喪失、送信直前の停止・期限・storage fence、取消し、3つの認証経路、600回境界と両HTTPの503、eviction/全storage喪失後の保持。
- 終了記録repairの追加14件が成功: D1/ローカル保存・ACK喪失、eviction、元epoch、未送信の遅延claim、別token、20件上限、不変receipt、重複repair、実ControlDO停止/修復/再監査、未知ローカル記録の再開拒否。
- 全体制限の既存認証34件と合わせた54件は前回成功。全check・browserの確定結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。

## 残作業

終了記録がある試行の内部repairは接続済み。終了証明を失った未知試行の運用上の収束、実Cloudflareでの修復・restore drillは未完了。経過時間や再起動だけで手動削除しない。共有password/unlock、per-share10/min・client IP30/min、account mutation32並列と待機列、backup専用barrierも残る。

実CloudflareでのCPU・処理量・費用、混在version、時計/ネットワーク遅延、接続切断の検証が必要。`enable_request_signal`を有効化しているが、以前のローカルWrangler前段ではHTTP切断がWorkerのsignalへ伝播しない経路があった。明示的AbortSignalの試験を実ネットワーク切断の証明にしない。
