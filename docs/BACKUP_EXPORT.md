# 値を保持する論理データ出力

更新: 2026-09-25。`capture`は凍結済みD1をWrangler queryで4行ずつ読み、data-only INSERTをローカルへ順次書き込む。通常67tableの列・primary keyは信頼済みmigrationから決定する。`_assert`はrowidで走査し、OFFSETや全件メモリ保持を使わない。

## dumpの変換に依存しない

固定版Miniflareのdumpは、実CR/LFをliteral backslash-r/nへ置換してSQLの`replace()`で戻す。この方法では元からあるbackslash-r/nも改行へ変わる。以前の検証は全行hashの相違を検出してバックアップを拒否したが、この値を含む世代を作れなかった。

現在はquery結果からSQLを生成する。WranglerのJSON表示はBLOB配列を文字列へ変えるため、各列を`typeof()`付きで取得し、BLOBだけをSQL側で`hex()`にする。BLOBに似たTEXTを推測でBLOBへ変換しない。普通のTEXTは引用符だけを二重化し、CR/LF・backslash・Unicodeを変更しない。SQL本文に置けないNULを含むTEXTだけ、UTF-8のhexを`CAST(X'hex' AS TEXT)`で表す。読み込みはこの正確な形をデータとして解析し、UTF-8を厳密に復号してbound parameterで挿入する。BOMもTEXTの一部として保持する。任意CASTや式を実行しない。

## 境界と一貫性

- NULL、有限number、TEXT、BLOBを扱う。整数はJavaScriptの安全な整数範囲だけを採用し、非有限値・未知型・単独surrogateを拒否する。SQLの型と応答値を照合し、BLOBはhex literalとする。
- 1文8MiB以内。書込みは各行で完了を待ち、部分書込みの残りも送る。新規ファイルだけを0600で作成する。既存ファイルは上書きしない。失敗時はハンドルを閉じ、captureが自分の一時generationを除去する。
- 抽出前後のbarrier・migration列・全table一覧・schema照合、元DBのfingerprint、隔離先の全行hash・FK・FTS・凍結状態の検証を維持する。直接queryで読むことを理由に、途中解除や欠落を許可しない。
- 既存のINSERT literalと限定CR/LF式を含む世代は引き続き読める。古いdumpで既に変化した値は推測で修正せず、元fingerprintと一致しなければ拒否する。

queryをページごとに実行するため、大規模DBの所要時間・費用・remoteの応答形式は別途実測が必要である。D1の書込み停止、元BLOBSの保護、日次/保持管理、live restoreの責務は変更しない。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。
