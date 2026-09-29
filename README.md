# Next-cloud-flare

Cloudflare上で動かすセルフホスト型ファイル管理アプリ。**開発中で、製品全体の完了条件・実環境のリリース判定は未達です。**

2026-09-29、コード基準 `81b351e`。migration `0001`〜`0077`、通常81テーブル、152経路の契約を定義しています。契約数は実装済みAPI数ではありません。

## 現在できていること

- Filesの一覧・検索・作成・改名・移動・コピー、単一／分割アップロード・上書き・再開、ごみ箱と同期復元・削除。
- 内部共有、公開リンクの閲覧・編集・アップロード、受け取り専用リンク、ZIPダウンロード。所有者間コピーの進捗・取消・再試行。
- WebDAVの読み書き・ロック・共有マウント。実クライアントの互換性確認は残っています。
- Galleryの画像一覧・ライトボックス・サムネイル、AVIF原本・AV1動画の閲覧。Audioの曲一覧・常駐プレーヤー・本人の再生位置・タグ編集と検索・埋め込み表紙。Opusにも対応します。
- 本棚一覧と個人のフォルダー登録、ZIP/CBZの画像リーダー・本人の読書位置。内部／公開共有での閲覧、同じ所有者内でコピーした書籍の索引引継ぎ。新しいZIP/CBZ/EPUBの索引を生成しますが、EPUB本文リーダーは未実装です。
- D1の原子的更新、認可・容量・参照会計、Queue/DLQ、GC、バックアップ生成／検証／オフライン復元、停止・監査・段階再開のローカル実装。

以上は実装・ローカル接続の範囲です。既存書籍の索引要求、PDF/EPUB本文・画像フォルダーのリーダー、大規模な非同期ごみ箱処理、未知の外部処理を含む完全な復旧、実環境の運用・配備などが残っています。

## 状態と資料

| 知りたいこと | 資料 |
|---|---|
| 完了範囲・未完了・検証済み・未検証の一覧 | [現在状態](docs/CURRENT_STATE.md) |
| 次の作業、環境、継続時の注意点 | [引き継ぎ](docs/HANDOFF.md) |
| 最近の変更とコミット | [進捗概要](docs/PROGRESS.md) |
| 試験件数・失敗と再実行・過去CIの証跡 | [検証履歴](docs/IMPLEMENTATION_STATUS.md) |
| 製品仕様と最終完了条件 | [設計書](docs/DESIGN.md)、[実装ブリーフ](docs/IMPLEMENTATION_BRIEF.md) |
| 必須のAVIF・AV1・Opus対応 | [メディア形式](docs/MEDIA_FORMATS.md) |

直近の書籍COPY変更では、複数回の実行・修正後の再試験を合わせて関連202件（Node37・workerd164・Chrome1）の成功を記録しています。単一実行の全体成功ではなく、最新コードでの全suite・全ブラウザー・復旧ドリル・GitHub CIの完了も意味しません。内訳と限界は[現在状態](docs/CURRENT_STATE.md)を参照してください。

## ローカル開発

Node `24.21.0` / pnpm `12.4.1`。依存はlockfileで固定しています。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

このNixOS workspaceでは、用意済みの `.local-toolchain/run pnpm ...` で同じコマンドを実行できます。`dev` はローカルbinding、`build` はWeb buildとWorkerのdry-runです。通常の起動だけでControlDOの受付停止を解除しません。全監査と正規の再開手順は[ControlDO受付](docs/CONTROL_ADMISSION.md)を参照してください。

```sh
pnpm check
pnpm test:browser
pnpm test:browser:single-host
```

`check` はlint・型・契約／設定・Node／workerd試験・buildを実行します。ブラウザー試験とバックアップドリルは別コマンドです。実環境のresource作成・migration・secret設定・配備は未実施です。
