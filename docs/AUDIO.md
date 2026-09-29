# Audio一覧と再生位置

2026-09-29。Opusの情報抽出・原本配信に、曲一覧と利用者別の再生位置APIを接続する。所有者・内部共有・公開リンクの一覧画面と常駐player、自動保存・再開へ接続済み。

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

## 一覧画面と常駐player

所有者は `/audio` と `/audio/:folderId`、Filesの「このフォルダーをオーディオで開く」から開く。共有画面は「オーディオで表示」で現在のfolder/file rootを開く。直下の現在のOpus曲を200件ずつ読み、2,000曲上限と空一覧を表示する。原本の先行取得はしない。

共有可能なUI/controllerは `web/src/public-share/audio{,Player,Client}`、非公開wrapperは `features/audio/PrivateAudio`。公開bundleの境界を広げず、sharedのAudio型は型参照だけにする。1つのnative audio要素をルート一覧の外に保持し、前後の曲・再生/一時停止・音量・時間・閉じる・原本downloadを提供する。読み込んだ曲だけを再生順序に使い、最大2,000曲。原本URLをそのまま使い、fetch→BlobやlocalStorageへ音声・位置を保存しない。再生不可でも同じ認可のattachment downloadを提供する。

選択時に現在の原本/generator/利用者の位置を再取得する。再生中15秒ごとと一時停止・曲変更・閉じる時に保存する。pagehideでも送信を試みるが、browser終了・強制終了時の最終保存を保証しない。保存を直列化し、処理中の次の位置は最新値へまとめる。409や応答喪失では自動再送せず、「保存済みの位置から再開」で再取得する。曲終了は0を保存して次へ移る。匿名には保存処理自体を渡さない。

Content-Sessionは300秒を要求し、実際のCookie receipt期限に従う。再生中は15秒ごとに現在の閲覧権限と原本を照合し、残り30秒以内ならCookieだけ更新する。更新時にsrcを読み直さない。期限timerが到来するとバッファ済み原本も破棄する。browserのtimer停止・ページ終了時刻までは保証しない。個々のRangeはserver側でも現在の認可と配信期限を検査する。再開前も認可を照合する。共有解除・資格情報失効・原本変更、ログアウト・公開画面を閉じる時は要求と音声を破棄し、遅い応答で復活させない。

## 残件

MP3/FLAC/WAV/M4A等の追加parser、coverの抽出・変換、override編集・検索索引との同期も継続する。原本OpusのFiles経由再生は[TRACK_METADATA](TRACK_METADATA.md)で検証済み。

2,000曲は返却数の上限であり、D1の読取り行数上限を保証する値ではない。多数の非音声ファイルを含むフォルダーの実D1負荷と最大曲数でのbrowser負荷gateは未検証。実Cloudflareへの適用・他OS/browserの確認も後続。
