# 過去schemaのバックアップ検証

更新: 2026-09-25。`verify`・`restore-offline`・R2のpublish/downloadは、保存時点のschemaを再現して検証する。新しいcaptureは引き続き現在の全migrationとsource schemaの一致を要求する。

## 信頼済みmigrationだけを使用する

manifestのmigration列は、リポジトリにあるSQLファイルの先頭から、保存時点までの完全な列でなければならない。各ファイル名、順序、SHA-256とJSONの形を照合する。途中欠落・順序違い・改変・未知の将来version・追加SQL属性は拒否する。schemaの作成にはローカルのSQLだけを使い、バックアップ内のschema SQLは実行しない。

最小schemaは永続的な書込み停止を導入した`0037_backup_barrier.sql`。これより前のDBを、新しい凍結済みgenerationと推測して受け付けない。復元先には選択したmigrationまでを適用し、後続migrationを自動適用しない。保存当時のschema digest、全67通常tableの列・全行/hash、FK、FTS rebuild、watermarkと凍結状態を検査する。既存のDBファイルは上書きしない。

現在の過去schemaは同じ67通常table契約を使う。今後tableの増減を伴うmigrationを追加する場合は、過去世代のtable契約と検証試験も維持すること。時刻が古くてもオフライン検査はできるが、これを35日以内のlive復旧候補と判断したことにはならない。

## captureで全テーブルを照合する

既知tableのschema digestだけでは、追加された未知のtableを検出できない。captureは抽出の前後に、migration列、`PRAGMA table_list`による全オブジェクトの名前/種別、既知schemaのdigestを再照合する。未知の通常table、view、virtual tableや、抽出中に加わったindexも拒否して、部分的なバックアップを完成扱いしない。

[D1の公式SQL仕様](https://developers.cloudflare.com/d1/sql-api/sql-statements/)では`PRAGMA table_list`に通常table・view・virtual/shadow tableとシステムtableが含まれる。SQLiteの内部tableと、D1/Wranglerの`_cf_KV`・`_cf_METADATA`・`d1_migrations`だけを照合対象から除外する。`_cf_`で始まる任意のtableをまとめて除外しない。`d1_migrations`の内容は別途、期待する全migration名と照合する。FTS virtual/shadowの一覧は照合するが、内容はexportせずbase tableから再構築する。

## 検証と残る範囲

保存済みの実Wrangler世代と、0037/0038から作った固定条件の世代で、凍結を保つ復元、quota/FTS/Unicode・改行・backslash、R2 publication/download、改変拒否を検証する。captureには定義外table/view/virtual、限定した内部table例外、抽出中のschema変更の試験がある。最新の実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。

これはオフライン検証の互換性と抽出漏れの防止であり、元BLOBSの実在性、Time Travel/live restore、新epochと復旧監査、日次/世代保持管理、remoteの運用検証は別工程である。
