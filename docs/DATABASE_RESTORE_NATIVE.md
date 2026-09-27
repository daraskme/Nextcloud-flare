# 復元後のKDF/R2終了記録の修復

更新: 2026-09-28

D1を巻き戻すと、実際には終了したKDF/R2操作の行が`claimed`/`pending`へ戻ることがある。通常の精算で削除していたDOの終了証拠を独立した履歴へ移し、[停止中epoch採用](DATABASE_RESTORE_ADOPTION.md)の後、元の復旧要求に限定して照合する。

## 証拠の保持

- `control_native_history`はSHA-256の32-byte識別値・終了状態・元の送信期限・保存時刻だけを保存する。KDFはid/token/epoch、R2はD1の全9識別列をdomain付きJSON配列としてhashする。password・salt・計算結果・R2本文・再送可能なgrantは保存しない。
- `finished`は実際のnative KDF終了、`succeeded`は実R2成功、`not_started`はhandlerが送信しなかったことの確定だけから保存する。D1だけの終端行、HEAD、期限切れから証拠を新設しない。
- D1終端の読戻し後、履歴の保存が確認できた場合だけlive receiptを削除する。R2はused markerと同じDO transaction、KDFは履歴INSERTからlive DELETEへ順に処理する。途中の障害では履歴とlive receiptが両方残り得るが、証拠を先に失わない。保存失敗では従来の20/32件枠を保持する。
- 保存時刻から36日を超えた記録を、新しい証拠の保存時に最大32件ずつ削除する。35日以内のlogical世代に余裕を持たせた保持期間であり、復旧要求がholdを保持している間は期限超過分も削除しない。時計の大幅な進みで証拠を失っても、その行はunknownとなり、終了扱いにはならない。
- SQL triggerで不変性・保持期間・件数を制約する。上限はKDF/R2合計5,000万件。600件/分の実行を36日続ける単純計算は3,110万4,000件で、未送信の終了記録とR2も上限を消費する。実際のDO容量、索引、書込み速度、費用を保証する数値ではない。容量/保存エラー時はlive証拠を保持して受付枠が閉じる。大規模負荷と実storage容量の測定は公開gateに残る。

KDFの実終了/未送信が既に確定し、D1行が存在しない場合は、従来の書込みbarrierとDB時刻による期限確認を通した後に同じ履歴を保存する。不在そのものから終了を推定しない。旧版で既に削除された証拠、保存前のinstance停止、全DO storage喪失には適用できない。この変更の配備前まで履歴があると仮定しない。

## CLIと修復条件

```sh
pnpm database:restore repair-restored-native --remote \
  --operator-config restore-operator.json --epoch <元epoch> --id <同じUUID> \
  --max-pages 100 --page-size 10
```

private `database-restore-v1`権限と`RESTORE_OPERATOR_ENABLED=true`が必要。採用後・hold解除前だけ実行できる。同じid/元epoch/採用済みepochを確認し、停止中maintenance taskとして実行する。FTS/監査の証明は前後で無効になる。task開始後の停止revision/tokenへ固定し、精算の各記録の前後と照合ページの待機後に確認する。途中で新しい停止へ切り替わると、その呼出しを中断する。既に分かったnative終了証拠は保持する。

各ページの前に、まだ履歴へ移せていないlive KDF/R2終了記録をそれぞれ`page-size`件まで既存の精算処理へ渡す。D1書込みや履歴保存の障害で残った、実終了または未送信が確定済みの記録だけが対象。R2の現epochの修復処理で発生した終了記録も精算できる。KDFの`reserved`、R2の`pending`は期限を過ぎても解除せず、native再実行もしない。live R2は既存精算と同様、正確な元grantと実終了から欠けた終端行を再作成し得る。live KDFの不在確認には書込みbarrierと元期限の確認を使う。

1ページは1〜20行。KDF、R2の順でpending行をid順に読み、DOへcursorとその走査の件数を保存する。未知行もcursorを進めるため、後ろにある既知行を修復できる。失敗したページはcursorを進めず、同じコマンドで再開する。完了済みの走査へ再実行すると最初から再走査する。

履歴との照合では、KDFは元id/token/epochが一致し、D1期限が元grant期限以下であることを確認する。R2はid/token/epoch/owner/kind/key/期限/開始時刻/source_refの全tupleが一致しなければならない。元epochは採用済みepoch未満に限定する。D1のUPDATEも読取った識別列全体とpending状態を比較し、同じ停止epoch/revision/token・maintenance/GC停止・backup/restore freeze解除を同じbatchでassertする。応答喪失時は同じ終端tupleと停止条件の読戻しだけで確認する。別の終端行は上書きせず、この履歴走査では欠けた行も再作成しない。

出力の`checked/reconciled/unknown`は履歴走査で保存できた累積件数であり、RPC応答喪失を挟んだ全実更新数の会計ではない。`completed`は履歴走査完了を示す。`live.kdf/live.r2`はそのRPCでの精算件数と残るDO記録の`pending/unknown`件数。`databasePending.kdf/r2`はページ後にD1全体から数えた件数で、走査済みcursorより前へ現れた行や現epochの行も含む。live/D1の件数は観測値であり、再開に必要な最終監査の代わりにはならない。

CLIの`pending`は未完了ページ、走査のunknown、DOまたはD1の未精算記録のいずれかがあればtrueとなり、終了codeは2。`completed=true, unknown=0`でもDOだけに未知の処理が残る場合や履歴保存が失敗している場合は成功終了しない。件数の欠落・不正な値も拒否する。完了した走査をCLI内で自動反復せず、必要なら同じ要求で明示的に再実行する。未知行の削除、native再実行、受付/GCの再開は行わない。修復後は[FTS再構築・全監査](DATABASE_RESTORE_RECOVERY.md)を完了してから段階再開する。

## 残作業

この処理が確定するのは共通KDF/R2呼出しの終了だけである。upload/multipartの容量精算、namespace公開、GC、outbox、旧backup記録など各領域の修復は別工程。native不明の運用収束、旧実装/全storage喪失、logical import、安全な中止、実Cloudflare復旧・負荷試験は未完了。D1 schemaは0046・通常68table、依存追加なし。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。
