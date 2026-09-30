# Filesの上書きアップロード

更新: 2026-09-24。ローカル実装・実API試験の記録。実Cloudflareへの配備は未実施。

## 操作と保持する情報

fileの操作メニューから「ファイルを上書き」を開き、現在の名前・サイズと選択したローカルfileを確認して開始する。確認前の取消しはuploadを作成しない。folderには表示しない。保存先の名前は維持し、異なるローカルfile名も選択できる。0 byte、single、multipartに対応する。

IndexedDBのupload recordに、元file名と上書き先のnode ID・revision・blob IDを保存する。旧recordは従来のnameを元file名として扱う。再開時のname/size/mtime/sample照合はローカルfileを対象にし、server上の名前と混同しない。file本体は保存しない。

開始前と未完了uploadの再開時に現行nodeを照会する。これは早期の変更通知であり、書込みの認可は既存のserver fenceが行う。作成JSONには固定したtargetId/targetRevisionを渡し、single PUTと全multipart partには固定したblobのstrong If-Matchを送る。変更を検知しても、対象やrevisionを自動更新しない。利用者は送信を中止して一覧から選び直す。

namespaceへの確定が成功して応答だけ失われた場合は、保存済みupload ID/capabilityで完了receiptを確認する。自分自身の上書きでrevisionが変わっていても、completedを先に確認し、本文を再送しない。create/complete keyとpart attemptの保持は新規uploadと同じである。

作成応答が失われ、その間に別の更新で対象revisionが進んでも、同じcreate key/bodyで元のreceiptとcapabilityを取得できる。再送によるreceipt取得は現在のcredential/epoch・owner・parent・node権限を再検証し、予約を追加しない。新規予約、R2初期化、single/part本文、確定では固定した旧revisionとの一致を引き続き要求する。multipartの初期化がrevision変更で止まった場合も、現在の権限を再確認して202のreceiptを返す。UIはその情報を保存してから対象変更を通知し、旧送信の中止へ進める。

## 検証

- 実browser: 確認前の取消し、異なる元file名、node ID・保存名の維持、revision増分と新内容、0 byteへの置換。
- 実browser: 完了commit後の応答喪失→reload→元file選択→receipt照合。create/PUT/completeを増やさない。
- 実browser: 確認前の別更新をenqueue前に拒否し、PUT直前の別更新もserverで拒否する。新しい内容を保持し、古い送信の中止後も変えない。
- 実browser: 96 MiB multipartの中断・reloadで同じ対象、If-Match、upload、attemptを維持する。完了partを再送せず、公開後のRange内容も確認する。
- 実browser: single/multipart作成の成功応答を破棄→別の実上書き→reload→元file選択で、同じkey/ID/capabilityを回収する。旧本文やcompleteを送らずに中止し、新しい内容を維持する。
- workerd HTTP: 実上書き後のcreate再送、予約不変、同一keyの別body/新規keyの旧revision拒否、旧本文/確定拒否、中止後の内容保持。receiptを返す最終batch前のcredential失効も拒否する。予約直後のrevision変更ではR2初期化を一度も呼ばない。
- desktop/mobileの確認画面を実画面で検査する。

上書き後の内容確認で発見した配信枠の修正は[BUDGET_ALLOWANCE](BUDGET_ALLOWANCE.md)を参照。全体の成否・件数は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)が正本。

公開/内部共有、File System Access handle、大容量・低速網・実Access/R2と複数browserのgateは残る。今回のreceipt回収は同じ親の認可済み対象のrevision変更を扱う。対象の移動・削除、credential失効、期限切れなどで再確認できない未完了uploadはserverの期限切れ回収・停止中repairに従う。未知の予約をローカル記録だけで解放したことにはしない。
