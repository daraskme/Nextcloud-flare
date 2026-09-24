# 論理バックアップ世代とオフライン復元

更新: 2026-09-25。`pnpm backup`は凍結済みD1から通常67tableをWranglerで抽出し、同一versionの隔離SQLiteへ復元・照合して、ローカルの世代ディレクトリへ保存する。ControlDOの運用呼出し経路、R2への公開、日次実行・保持管理、live D1 restore・epoch更新・全復旧監査は後続である。

## コマンド

```sh
pnpm backup capture --config CONFIG --database DB --local --id UUID --epoch EPOCH --directory GENERATIONS
pnpm backup verify --directory GENERATIONS/UUID
pnpm backup restore-offline --directory GENERATIONS/UUID --target NEW_FILE.sqlite
pnpm backup:drill
```

captureは[ControlDO.beginBackup](BACKUP_BARRIER.md)が`frozen`を返した世代を前提にする。D1 flagsを直接変更して開始する運用コマンドではない。`--local`か`--remote`の一方を必須とし、必要なら`--environment NAME`を指定する。remoteはCLIの実装経路のみで、この変更では実行・検証していない。各呼出しでconfigの内容が変わっていないことを確認する。exportは`--persist-to`非対応のため、localは指定config配下の既定`.wrangler/state`を使う。

captureは開始・解除のRPCを代行せず、成功時も失敗時もbarrierを保持する。全source fingerprint取得とexportの前後で同じ凍結世代・epoch・token・watermarkを確認する。途中で解除・世代変更が起きた出力は採用しない。exportのsnapshot開始点が確認できていないため、抽出前のACKだけで解除しない。

`backup:drill`は`.wrangler/backup-drill-*`に専用config、local D1、fixture、世代と復元先を作り、実際のcapture/verify/restore-offlineコマンド、FTS検索、容量、元DBの凍結保持を検査する。既存開発DBを消さず、remoteを呼び出さない。fixtureの凍結はこの隔離試験だけの準備であり、運用RPCや全復旧監査の実証ではない。

## 世代の内容と一致検証

世代ディレクトリには`data.sql`と`manifest.json`を保存する。manifest v1はgeneration UUID/epoch/token/作成時刻/watermark、捕捉時刻、全migrationの名前とSHA-256、schema digest、SQLのbyte数/SHA-256、通常全tableの行数/SHA-256を含む。SQLやmanifestにbearer token・ダウンロードURLを追加しない。SQL自体には利用者情報と認証recordが含まれるため、作成先はprivate directoryを使い、ファイルを0600で保存する。

sourceのschemaはversioned migrationから作ったschemaと一致させる。Wranglerがコメントを除去するため、SQLのコメント・引用符外の空白だけを正規化する。引用文字列やindex/triggerの意味を消す正規化はしない。FTS virtual/shadow dataはexport対象から除外し、FTSの定義はversioned schema、内容は`search_index`から再構築する。

全tableをprimary key順に4行ずつkeyset走査し、型とcolumn順を固定した行のdigestを作る。唯一primary keyを持たない`_assert`はrowid順で値を検査する。OFFSETによる全件再走査を避け、SQLファイルはstreamで読み、一文を8MiB以下に制限する。安全な整数で表現できない値や対応していない形式は採用しない。

checksumだけが合っていても、元DBとの全行一致を示したことにはならない。exportの内容変化・欠落は、隔離復元後の全table digestをsourceと比較して検出する。現在のMiniflareのCR/LFエスケープ方式では、実改行と文字列`\\n`/`\\r`が混ざる値の変化を検出するケースを試験している。一致しないSQLを成功扱いにしたり、値を推測して修正したりしない。全データ形式・remoteでの互換性は引き続き検証が必要である。

## SQL読込みと復元

入力SQLを`exec()`へ渡さない。data-only INSERTの既知table・全column順・literalだけを解析し、bound parameterとして挿入する。NULL・有限number・文字列・hex BLOBと、Wranglerの限定されたCR/LF `replace(...,char(...))`を扱う。ATTACH、任意PRAGMA、DDL、UPDATE、関数・式・追加statement・重複columnは拒否する。UTF-8不正、途中切れ、文の上限超過も拒否する。

復元先は新規ファイルだけに限定する。versioned migrationを一つのtransactionで適用し、隔離先のtriggerだけを一時除去する。生成済みpurgeOrderでseed行を削除し、FKをdeferした同じtransactionでdataをimport、同一triggerを再作成、FK検査・FTS rebuild/integrity-checkを行う。稼働D1のtriggerは外さない。quota/ref/physical等をtriggerで二重加算せず、元の値を保存する。committed/failedのterminal履歴も書き換えない。

復元後もbackup freezeを保持し、control更新が拒否されることを確認する。`restore-offline`は別DBの確認用ファイルを作るだけで、旧epochのまま稼働再開するコマンドではない。ControlDOによる新epoch、R2実体、認可・operation由来・会計・共有等の全監査がlive復旧には必要である。

## 失敗・再実行・信頼の境界

検証完了まで一時ディレクトリに保存し、成功後だけ世代ディレクトリへrenameする。同じUUIDの世代や既存の復元先ファイルを上書きしない。失敗時は自分が作った一時出力だけを除去し、元DBや元barrierを変更しない。ローカルの同一世代処理はexclusive lock fileで直列化する。プロセス強制終了でlockが残った場合は、元の処理が終了していることを確認してから運用で処理する。時間切れを根拠に自動でlockやbarrierを解除しない。

checksumは破損検出であり署名ではない。manifestを含めて書き換えられる保存先の真正性や、power loss後の耐久性、R2世代公開の成功はこのローカル検証だけでは証明しない。CLIは元SQL・node値・providerのsigned URLをログへ出さず、段階と固定エラーcodeを返す。生成完了はbackup_runsの`completed`への更新ではない。

検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。製品全体の完了条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)を維持する。
