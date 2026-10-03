# 元BLOBSの隔離コピー検証

`pnpm backup audit-blobs`は、正規バックアップ世代から作った`restore-offline`のSQLiteを再検証し、そこに記録された`committed`/`gc_candidate`原本blobを元のprivate `BLOBS` bucketから読み取る。新しい0700ディレクトリに0600のbyte copyと対応表`manifest.json`を作り、D1のkey/size/ETag、R2 GETのETagとbyte数、可能な場合はD1の`sha256_verified`を照合する。保存したファイルも再読込してSHA-256を検証する。標準出力には件数、総byte数、集計SHA-256などだけを出す。

先に完成したD1 receiptのmanifest hashを指定して`backup download --remote --manifest-sha256`を実行し、`restore-offline`で新しいSQLiteを作る。`audit-blobs`自身はreceiptを取得しないため、このhash照合を省略しない。

```sh
pnpm backup audit-blobs \
  --generation <ダウンロード済み世代ディレクトリ> \
  --database <restore-offlineで作ったSQLite> \
  --directory <存在しない隔離先ディレクトリ> \
  --max-objects <許可する最大件数> \
  --max-bytes <許可する最大総byte数>
```

CLI実行環境には、対象`BLOBS` bucketだけに限定したObject Read only S3資格情報を`R2_INVENTORY_ACCOUNT_ID`、`R2_INVENTORY_BUCKET`、`R2_INVENTORY_ACCESS_KEY_ID`、`R2_INVENTORY_SECRET_ACCESS_KEY`で渡す。必要なら`R2_INVENTORY_JURISDICTION`も指定する。秘密値を引数、ログ、追跡ファイルに入れない。SQLite、世代、コピー先はリポジトリ外の保護された保存先に置く。コピー先が既に存在する場合は拒否し、途中失敗時はこのコマンドが作成した未完成ディレクトリを削除する。

`manifest.json`には復元に必要なR2 keyと個別SHA-256が含まれるため、コピー先全体をprivateとして扱う。この検証は**元BLOBSが利用可能な間に原本を取り出せる**ことを示す。`BACKUPS`世代にBLOBS本体は含まれず、元bucket喪失後の独立した災害復元、派生物、未完成upload、live D1復元の証明にはならない。
