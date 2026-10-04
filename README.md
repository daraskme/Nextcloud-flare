# Next-cloud-flare

Cloudflare上で動かす、個人向けのファイル管理アプリです。ブラウザーからファイルを保存・整理し、必要に応じて共有できます。保存先や認証をCloudflareの各サービスに分け、WorkerがAPIと認可を担当します。

## 構成

- **Webアプリ**: React/TypeScriptの画面。Files、メディア閲覧、暗号化設定などを提供します。
- **Worker**: Access認証後のAPI、所有者ごとの認可、アップロード、共有、配信を処理します。
- **D1**: アカウント、ファイル階層、共有、監査などのメタデータを保存します。
- **R2**: ファイル本体を保存します。暗号化対象はブラウザーで暗号化したコンテナを保存します。
- **Durable Objects / Queues**: 更新受付、配信予算、アップロード・バックアップ処理などの調整に使います。
- **Content origin**: 認可済みのファイルをRange対応で配信します。

環境ごとのリビジョンと検証状態は[環境状態表](docs/ENVIRONMENT_STATUS.md)を正本とします。現在のcheckout、staging、productionの状態を確認してから、環境向けの操作を行ってください。

## 現在の状態

| 環境 | 状態 |
|---|---|
| ローカル | 開発・隔離テスト用。ローカルの成功はCloudflare環境の動作を証明しません。 |
| staging | [環境状態表](docs/ENVIRONMENT_STATUS.md)記載のWorkerを配備済み。実ファイルの暗号化・復号確認と、暗号化バックアップからの復元確認を実施済みです。 |
| production | 未配備。stagingの検証結果をproductionの稼働確認として扱わないでください。 |

機能の実装状況、未完了項目、直近の作業順は[現在状態](docs/CURRENT_STATE.md)、[実装状況](docs/IMPLEMENTATION_STATUS.md)、[引き継ぎ資料](docs/HANDOFF.md)を参照してください。

## 主な機能

- ユーザーごとのFiles領域、フォルダー、アップロード、ダウンロード、WebDAV（暗号化必須環境での書き込み制限は後述）。
- 期限・パスワードを設定できる読み取り専用共有と、限定されたupload-only共有。
- 画像、音声、動画、EPUBの閲覧。AVIF、AV1、Opusの対応条件と試験範囲は[メディア形式](docs/MEDIA_FORMATS.md)を参照してください。
- 音声への利用者別チャプター保存と時刻への移動。サーバーで解析済みの音声が対象で、暗号化音声のチャプター保存にはまだ対応していません。
- 管理者による明示的な全利用者ファイルの読み取り・プレビュー・ダウンロードと閲覧監査。
- ブラウザー内暗号化、鍵登録、管理者公開鍵の確認、暗号化コピー作成。
- 週次暗号化バックアップ、オフライン復元検査、毎時ローカル監視。運用手順は[週次バックアップの導入](ops/backup/INSTALL_USER_AUTOMATION.md)と[監視](ops/monitoring/README.md)を参照してください。

## 暗号化と制約

暗号化アップロードでは、ファイル本文と元のファイル名をブラウザーで暗号化します。復旧JSONと秘密鍵は利用者の端末で管理し、Cloudflareや定期処理には保存しません。新しい暗号化コンテナは所有者署名・登録鍵・サーバー側マーカーで検証します。既存の署名なし形式は通常の暗号化ファイルとして自動判定・採用せず、画面上で内容を復号して確認した後、所有者が明示的に採用する必要があります。

暗号化は、信頼できる配信元から届いたブラウザーコードを前提とします。配信元がJavaScriptを改ざんすると、鍵や復号後の内容を取得される可能性があります。フォルダー名、階層、サイズ、アカウント情報、アクセス履歴もサーバーに残ります。

暗号化必須環境では、通常のWebDAV・公開アップロード・直接APIによる平文の書き込みをサーバー側で拒否します。外部クライアントによる暗号化アップロードには、署名付きコンテナとアップロード契約への対応が必要です。既存ファイルの移行・鍵設定・削除後の保持期間は[暗号化設定ガイド](docs/CLIENT_ENCRYPTION_SETUP.md)と[暗号化の範囲](docs/CLIENT_ENCRYPTION.md)を確認してください。

バックアップ復元の検査は、対象世代のDBとオブジェクトを復元・照合した結果です。アプリの削除とR2上の原本回収は同時ではなく、参照のない原本は少なくとも35日間保持されます。Cloudflareの請求はアカウント全体で、staging分だけを正確に分けられず、自動停止するhard capもありません。

## ローカル開発

Node **24.21.0** と pnpm **12.4.1** を使います。バージョン定義は`.node-version`と`package.json`にあります。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev`はWebアセットをビルドしてWranglerのローカル環境を起動します。認証付きの画面・操作を検証する場合は、固定のテスト利用者と隔離DBを用意する`pnpm test:browser`を使います。通常の開発起動はローカルbindingを使い、Cloudflareのstagingやproductionへ接続・配備しません。実値のsecretをREADMEやGitへ記録しないでください。

## 検査コマンド

| コマンド | 内容 |
|---|---|
| `pnpm lint` | Biomeによる静的検査 |
| `pnpm typecheck` | WorkerとWebの型検査 |
| `pnpm test:unit` | 単体テスト |
| `pnpm test:integration` | Web build後、workerd上でD1/R2/DO等を使う統合テスト |
| `pnpm test:browser` | 隔離したローカル環境でPlaywright/Chromiumのブラウザーテスト |
| `pnpm verify:contracts` / `pnpm verify:config` | 契約とCloudflare設定の検査 |
| `pnpm build` | Web buildとWorker deploy dry-run |
| `pnpm check` | lint、型、契約、設定、unit、integration、buildを実行 |
| `pnpm release:gate` | ローカル検査・バックアップ復元・ブラウザー試験の実行結果を保存（[実行条件](docs/RELEASE_EVIDENCE.md)） |

非公開の実ファイルを使う追加ブラウザーテストは`NCF_USER_MEDIA_MANIFEST`で別途指定できます。ファイル、manifest、traceなどの私有データをGitへ追加しないでください。ブラウザーテストの手順は[ローカル browser E2E](.agents/skills/ncf-local-browser-e2e/SKILL.md)を参照してください。

## 参照先

| 読む人・目的 | 資料 |
|---|---|
| 利用者: 鍵の初期設定・復旧・ファイル移行 | [暗号化設定ガイド](docs/CLIENT_ENCRYPTION_SETUP.md) |
| 利用者: 共有の動作と制約 | [公開共有](docs/PUBLIC_SHARES.md) |
| 開発者: 全体設計・受入条件 | [設計書](docs/DESIGN.md)、[実装ブリーフ](docs/IMPLEMENTATION_BRIEF.md) |
| 開発者: API/DBと主要契約 | [Foundation](docs/FOUNDATION.md)、[現在状態](docs/CURRENT_STATE.md) |
| 開発者: Files画面とHTTPアップロード | [Files UI](docs/FILES_UI.md)、[Upload HTTP](docs/UPLOAD_HTTP.md) |
| 運用者: 環境ごとのリビジョン・検証 | [環境状態表](docs/ENVIRONMENT_STATUS.md) |
| 運用者: staging設定・配備 | [staging運用](ops/staging/README.md) |
| 運用者: 集計ヘルスチェックとリリース検証 | [Ops health](docs/OPS_HEALTH.md)、[Release evidence](docs/RELEASE_EVIDENCE.md) |
| 運用者: バックアップと復元 | [週次バックアップの導入](ops/backup/INSTALL_USER_AUTOMATION.md)、[バックアップ世代と復元](docs/BACKUP_GENERATIONS.md)、[週次バックアップ状態](ops/monitoring/README.md) |
| 作業再開 | [引き継ぎ資料](docs/HANDOFF.md)、[実装状況](docs/IMPLEMENTATION_STATUS.md) |
