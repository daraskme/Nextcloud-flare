# Files UI とローカルブラウザー試験

更新: 2026-09-24。製品全体の完了宣言ではない。実環境への配備、Access設定、remote secret登録は未実施。

## 接続した画面

`packages/web/src` は React / TypeScript / Vite / Tailwind と shadcn/ui の構成を使う。Button/Dialog は Radix primitives と cva のローカル実装、Router/Query/Virtual は TanStack。外部フォント・CDNスクリプト・service workerは使わない。依存のexact版、公開日、peer、licenseは `toolchain.json` に記録している。Node用テスト型は `tsconfig.test.json` に分離する。

- マイドライブのbreadcrumb、200件単位の署名cursor一覧、リストの仮想スクロール、グリッド、読み込み済み項目の名前絞込み。検索APIではない。
- フォルダー作成、改名、移動、コピー、ごみ箱移動、復元先選択、確認checkbox付き完全削除。
- 単一・multipart upload、確認付き上書き、容量表示、進捗、中止、reload後の元ファイル再選択。上書きの詳細は[UPLOAD_OVERWRITE](UPLOAD_OVERWRITE.md)。
- content ticketをPOSTして別originのHttpOnly Cookieへ交換し、別タブでファイルを開く/保存。tokenをURLに置かない。
- desktop/mobile、keyboard dialog、文字列としてのファイル名、認証失効時の一覧非表示、複数タブlogout。

`/me` は既存の容量・identityに加えて設定済み `contentOrigin` を返す。childrenはcurrent blobを同owner/state条件付きでJOINしsize/mimeを返す。一覧ごとの追加R2取得はしない。logoutの空HTTPストリームはEOFだけを受け入れ、非空payloadはbufferせず拒否する。

## 操作結果とuploadの保持

namespace mutationは送信前にaccount/epoch/request/Idempotency-KeyをsessionStorageへ保存する。応答喪失・5xxは同じkeyで確認し、operation IDが分かる時はGETで照合する。未確認のまま別のnamespace操作で保存情報を上書きしない。確定/既知失敗後に削除する。

uploadのIndexedDBはID、capability、epoch、name/size/mtime、先頭・末尾各64 KiBまでのsample hash、create/complete key、part attempt、上書き時の元file名と対象node/revision/blobのみ保存し、ファイル本体は保存しない。sample hashは元ファイル再選択の補助であり、whole-file integrity/dedupeの証明ではない。File System Access handleはまだ使っていない。

- 95,000,000 bytes以下はsingle、それ以上はserver固定geometryのmultipart。1ファイル500 GiB上限、画面の待機上限32件。
- Web Locksで同一originの送信fileを直列化し、1 file内のpartは最大4並列。サーバーのaccount admission制限の代替ではない。
- singleはdispatch前に記録し、結果不明のPUTを無条件再送しない。GETで確定を確認できなければ停止・再確認/中止する。
- multipartは同revisionの全partページを読み、completedは送らず、in-flight/保存済みattemptには同じIDを使う。`not_started`だけ次の試行を許す。unknownは止める。
- 完了時とlogout時に記録を削除する。scope変更/認証失効では旧送信を止め、遅れて戻るCSRF/create結果で保存情報を復活させない。
- logoutはサーバー失効を先に確認し、BroadcastChannel→memory/Query/IndexedDB/sessionStorage削除→Access logoutへ進む。アプリ専用Cache Storageは現在作成していない。

## private assets

Viteのprivate entry graphから `scripts/generate-private-assets.mjs` がファイル名の完全一致allowlistを生成する。Workerは `/`、`/files`、`/files/:id`、`/trash` とそのallowlistだけをapp host・ControlDO admission・Access認証後に配信する。unknown/public/service/content hostにSPA fallbackを渡さない。`index.html`とVite manifestの直接配信も拒否する。

HTML/chunk/CSSはprivate, no-store。CSPのscriptはselfのみ、connect先はselfと設定済みhttps content originのみ。styleのinlineはReactの仮想行位置/Radix表示に必要。画像はself/data、object/frame-ancestor/baseは禁止。React側にHTML文字列の挿入はない。

## 検証方法と隔離

```sh
pnpm check
pnpm exec playwright install --with-deps chromium
pnpm test:browser
```

このPCではrepository rootから `.local-toolchain/run pnpm ...` を使う。PlaywrightはNixOSの既存Chromeを検出し、他の環境ではインストールしたChromiumを使う。CIはUbuntuのbrowser jobとUbuntu/Windowsの全check jobを別々に実行する。

同じworking treeで `pnpm check` と `pnpm test:browser` を並行実行しない。Web buildによるasset更新は開発サーバーを再読み込みし、ブラウザー試験のfixtureを初期化し直す。CIの別jobはcheckoutを分離している。

`test:browser` は `packages/worker/test/browser/entry.ts` を専用entryにして、実Worker/API/ControlDO/LockDO/UploadDO/D1/R2を動かす。JWT/JWKS・署名鍵・bootstrap userはテスト専用で起動時生成。新しい隔離DBで全監査→resumeAdmission→resumeGarbageCollection→bootstrapを行う。通常稼働中の復元前後にGCが再開していることを確認する。production entryにはこの認証注入をimportしない。

設定/状態は `.wrangler/browser-config.json` と `.wrangler/browser-tests/` のみ。起動時に後者だけを作り直し、開発DB・remote DBは変更しない。HTTPSのapp/content test hostをChromeのhost-resolverでloopbackへ向け、hosts/OS設定は変えない。port8879を専用に使い、他processが使用中なら失敗させる。

14件のbrowser scenarioは実操作・mobile keyboard/grid・mutation応答喪失/reload・復元完了応答喪失後の同一key再照会・filename injection/認証失効・asset認証/host/fallback・96 MiB multipart中断/reload/part省略・single中止/purge確認・app password発行と独立DAV request 8件の並行認証/取消し・実HTTPの本文なしDAV mutationとticket取消し・上書き確認/空file/確定応答喪失・確認中/PUT直前の上書き競合・分割上書きのreload/同attempt・複数タブlogout。filename/認証失効の応答fixtureと通信障害をPlaywrightで注入する。それ以外は実APIへ接続する。Node側の補助fetchはloopback接続にHostと同一originのFetch Metadataを引き継ぐ。応答を破棄する前に実APIの成功statusをassertし、拒否された呼出しをcommit応答喪失と扱わない。Node側にはCSRF失効競合とoperation再照合の4件を追加。workerdのnode read/account試験も拡張する。最新の成否・件数はIMPLEMENTATION_STATUSを参照。

## 残る制約

- restoreは[RESTORE_GC](RESTORE_GC.md)の永続pauseを取得し、既存削除の終了後に原子的に復元する。競合・回収待ちは同じkeyで再試行する。管理者のGC停止設定は保持し、単一hold・5分期限・1,000ノード上限がある。
- 公開/内部共有、検索API、Gallery/Bookshelf/Audio、詳細preview、offline cache、File System Access、operator画面は未実装。
- gridの大量ページ仮想化、pagination競合の専用browser scenario、大容量/低速網/実Access/実R2/実Cookie policy/各ブラウザーのstaging試験は残る。
- Browserの96 MiB成功は500 GiB・実R2 lifecycle・未知multipart ID閉鎖の証明ではない。既存の予約holdとrepair gateは変更していない。
