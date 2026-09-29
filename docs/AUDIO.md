# Audio一覧と再生位置

2026-09-29。Opusの情報抽出・原本配信に、曲一覧と利用者別の再生位置APIを接続する。専用一覧画面・常駐player・状態の自動保存は後続。

## 一覧

- `GET /api/v1/nodes/:nodeId/tracks`。所有者、または`shareId`/`shareVersion`で明示選択した内部共有の受信者。
- `GET /api/v1/public/shares/:shareId/tracks`。現在の共有Cookieと一致する`Share-Session`が必要。任意の`nodeId`は共有root以内に限る。
- 直下の曲を名前・ID順に200件ずつ返す。単一ファイルrootも扱う。1フォルダーにつき最大2,000曲で、上限による終了は`limitReached`で明示する。再帰一覧ではない。
- `cursor`は専用HMAC用途・audienceで、利用者・資格情報・space/owner・root・選択共有/version・epoch・tree generation・metadata generator・最後の名前/ID・返却済み曲数に束縛する。10分で失効し、Files/Gallery cursorは流用できない。
- 現在のblobと`track-metadata-v1`、解析済みOpusのMIMEが一致する`node_audio`だけを返す。非表示・削除されたnode/祖先、失効した共有・資格情報を除外し、最終SELECTと同じbatchで再検査する。
- title/artist/albumはoverride、抽出値の順に使い、titleがなければファイル名を使う。override編集API/UIは未接続。`playback`は現在の利用者・node・blobの状態だけを返し、匿名共有では常にnull。

## 再生位置

`PUT /api/v1/nodes/:nodeId/playback-state`はAccess認証とCSRFを必要とする。bodyは`blobId`、`generator`、整数`positionMs`、`previousUpdatedAt`（最初の保存はnull）、任意の内部共有`share:{id,version}`。利用者IDをbodyから受け取らない。

本人所有の原本、または明示選択したread共有の原本に対し、本人の位置だけを保存する。shareのedit権限や所有者metadataの変更権限は与えない。匿名共有・app password・service principalの位置保存は受け付けない。既知のdurationを超えた位置、古いgenerator・原本、負数・小数・安全整数を超える値は拒否する。

現在の値の`updatedAt`を次回の`previousUpdatedAt`へ渡す。別タブなどの先行保存があれば409となり、古い要求で上書きしない。保存時刻はserver時計と直前値から単調増加させる。clientは409を無条件に再試行せず、現在の状態を再取得する。

共有原本の所有spaceでControlDO mutation枠を取得し、元の認可・node/parent/blob・generator/duration・位置の期待値・epochを同じD1 batchで再検査する。状態更新、古いblobに属する本人の状態の整理、確定receiptと枠の返却は一括確定する。応答喪失では同じreceiptを読んで確定を確認する。原本差し替え後の一覧へ古い位置を引き継がない。原本bytes・quota・参照数は変更しない。

schema0072・通常79table・149 routeの既存契約を利用し、migration・依存を追加しない。全応答はno-store。結果の検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。

## 残件

Audio専用一覧・常駐player、SPA遷移中の再生、Content-Session更新、位置の自動保存と再開、共有画面への接続は次の実装対象。MP3/FLAC/WAV/M4A等の追加parser、coverの抽出・変換、override編集・検索索引との同期も継続する。原本OpusのFiles経由再生は[TRACK_METADATA](TRACK_METADATA.md)で検証済み。

2,000曲は返却数の上限であり、D1の読取り行数上限を保証する値ではない。多数の非音声ファイルを含むフォルダーの実D1負荷とbrowser全体のgateは未検証。実Cloudflareへの適用・他OS/browserの確認も後続。
