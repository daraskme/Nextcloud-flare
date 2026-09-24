# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit2bb6659はmainへプッシュ済み。[CI36044950637](https://github.com/daraskme/Nextcloud-flare/actions/runs/36044950637)はUbuntu・browser成功、Windowsは既存multipart inventoryのrollback-release試験1件で失敗しました。UbuntuはNode416/workerd1525、browser19。WindowsはNode416件成功、workerd1,524件成功・1件失敗です。今回のglobal受付はまだ含まれません。

## 今回の変更

所有者を持たないR2接続確認を共通受付へ接続しました。専用global RPCは通常操作・初回登録・所有者付きsystem更新と同じ32 active/256 waiting枠を使い、架空のownerや別枠を作りません。

migration0034で既存の全確定記録、受付sequence、外部キー、索引と60秒保持を維持します。globalのscopeは明示nullで、owner/system・bootstrap・namespace許可への流用を拒否します。R2確認のclaim・各GET/条件付きPUT/S3読取り予算は直接ACKと固定25秒の開始期限が必要です。段階記録・終了はDB-onlyのexact receiptで回収し、待機後のnonce/source/token・元の60秒lease・epoch/pauseを再確認します。エラー記録も同じ確定記録方式を使い、現epoch/pauseと自己nonce/source/tokenで制限します。期限切れ後のエラー記録でも容量を返しません。ControlDO内は同一instanceの受付を使います。

前回修正したS3本文タイムアウト試験はWindowsでも成功しました。今回のWindows失敗はmultipart inventoryの故障注入が発火していない点で、具体的原因は未確定です。現在のglobal接続後の関連回帰では同じ試験が成功しています。 次回失敗時に受付種別と到達段階が分かる診断表示を試験へ追加しました。製品の受付期限と検証条件は変更していません。

Node6件・workerd68件追加（probe境界58件・実ControlDO等9件・移行1件）。全体check成功、Node422件（25file、6.04秒）・workerd1,593件（79file、851.58秒）、計2,015件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。診断表示の追加後も関連59件（44.02秒）と型検査が成功。schema0034/通常67table、依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

orphan/全bucket inventory・旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
