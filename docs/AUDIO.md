# Audio一覧と再生位置

2026-09-29。Opus・[MP3/FLAC/WAV](AUDIO_FORMATS.md)・[AAC/Vorbis](AAC_VORBIS.md)の情報抽出・原本配信に、曲一覧と利用者別の再生位置APIを接続する。所有者・内部共有・公開リンクの一覧画面と常駐player、自動保存・再開へ接続済み。

## 一覧

- `GET /api/v1/nodes/:nodeId/tracks`。所有者、または`shareId`/`shareVersion`で明示選択した内部共有の受信者。
- `GET /api/v1/public/shares/:shareId/tracks`。現在の共有Cookieと一致する`Share-Session`が必要。任意の`nodeId`は共有root以内に限る。
- 直下の曲を名前・ID順に最大200件ずつ返す。単一ファイルrootも扱う。1フォルダーにつき最大2,000曲で、上限による終了は`limitReached`で明示する。再帰一覧ではない。
- `cursor`は専用HMAC用途・audienceで、利用者・資格情報・space/owner・root・選択共有/version・epoch・tree generation・metadata generator・最後の名前/ID・返却済み曲数に束縛する。10分で失効し、Files/Gallery cursorは流用できない。
- 現在のblobと`track-metadata-v1`、解析済みcodec/MIMEが一致する`node_audio`だけを返す。Opus（Ogg/WebM/MP4）、MP3、FLAC、WAV、AAC（M4A/MP4）、Vorbis（Ogg）を対象とする。非表示・削除されたnode/祖先、失効した共有・資格情報を除外し、最終SELECTと同じbatchで再検査する。
- title/artist/albumはoverride、抽出値の順に使い、titleがなければファイル名を使う。[override編集API/UI](AUDIO_METADATA_EDIT.md)を所有者・選択した内部edit共有へ接続済み。`playback`は現在の利用者・node・blobの状態だけを返し、匿名共有では常にnull。

## タグ編集

[音声タグの編集](AUDIO_METADATA_EDIT.md)で曲名・アーティスト・アルバムの表示値を変更できる。空欄で抽出値へ戻す。現在の原本・revision・選択共有とDAV lockを確定batchで確認し、競合や保存結果不明時は現在のタグを読み直す。単一fileのtracks応答は編集可能な利用者だけに抽出値/override/revisionを返し、一覧にはcanEditのhintを付ける。タグの検索文字列への同期は後続。

## 再生位置

`PUT /api/v1/nodes/:nodeId/playback-state`はAccess認証とCSRFを必要とする。bodyは`blobId`、`generator`、整数`positionMs`、`previousUpdatedAt`（最初の保存はnull）、任意の内部共有`share:{id,version}`。利用者IDをbodyから受け取らない。

本人所有の原本、または明示選択したread共有の原本に対し、本人の位置だけを保存する。shareのedit権限や所有者metadataの変更権限は与えない。匿名共有・app password・service principalの位置保存は受け付けない。既知のdurationを超えた位置、古いgenerator・原本、負数・小数・安全整数を超える値は拒否する。

現在の値の`updatedAt`を次回の`previousUpdatedAt`へ渡す。別タブなどの先行保存があれば409となり、古い要求で上書きしない。保存時刻はserver時計と直前値から単調増加させる。clientは409を無条件に再試行せず、現在の状態を再取得する。

共有原本の所有spaceでControlDO mutation枠を取得し、元の認可・node/parent/blob・generator/duration・位置の期待値・epochを同じD1 batchで再検査する。状態更新、古いblobに属する本人の状態の整理、確定receiptと枠の返却は一括確定する。応答喪失では同じreceiptを読んで確定を確認する。原本差し替え後の一覧へ古い位置を引き継がない。原本bytes・quota・参照数は変更しない。

schema0073・通常79table・149 route。0073は表示可能な子を探索する索引だけを追加し、table・依存を追加しない。全応答はno-store。結果の検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。

## 候補の探索予算

0073の部分索引 `nodes_audio_candidates(parent_id,space_id,owner_id,name_ci,id) WHERE deleted_at IS NULL AND hidden=0` を使う。親・space・ownerを索引の等値条件へ含め、先頭ページと続行ページのSQLを分けて、後半のページでも(name_ci,id)の直後からseekする。metadataで絞る前に1,000候補と続行確認1件をSQLでmaterializeし、その窓の中だけで現在の原本・codec・generator・MIME・本人の位置を結合する。ファイル単体は従来どおり主キーで取得する。

201曲目があれば返却した200曲目を次の境界にし、曲が少なければ最後に調べた候補を使う。空のpageでもnextCursorがある場合は終端ではない。非表示項目は索引から除外するので、その名前をcursorへ入れない。namespaceの世代と認可は候補のSELECTと同じbatchで検査する。探索の累積件数に打切りは設けず、後方の曲も続行で取得できる。返却2,000曲へ達した後に未確認項目があればlimitReachedを返すが、未確認の中に追加の曲があることまでは意味しない。

画面は1操作で最大3つの空pageを読み進め、それでも続きがあれば「続けて曲を探す」を表示する。曲が見つかるか終端へ達した時点で自動続行を止める。scope/世代/generatorの変更、同じcursorの反復、中断後の応答では結果を採用しない。初回窓に曲がないだけで「曲がありません」とは表示しない。

一覧SELECTだけのgateは7bind・1query・rows_read≤10,000。1操作の自動続行は最大3queryで、認可取得の別queryはこの値に含めない。旧SQLは音声のない10,001項目で10,002行を読んだ。新SQLは可視50,051項目と非表示50,000項目のfixtureで、最初の1,000候補が5,005行、49,999番目以降の窓が262行だった。密集・古いmetadata・不適切なMIME・有効な曲が窓の後半にある場合も同予算を検査する。全folderを最後まで読む総行数の削減を保証する変更ではない。durationと実Cloudflareのgateは別途確認する。

0073は停止・backup/restore未凍結・未終了permit/operation/admission/R2/KDF/Imagesなしで適用する。既存行と参照会計を変更せず、rename/move/hidden変更に応じた索引更新はSQLiteが行う。旧Workerへ戻す場合も停止を維持し、schemaと対応版を整合させる。実環境への適用は未実施。

## 一覧画面と常駐player

所有者は `/audio` と `/audio/:folderId`、Filesの「このフォルダーをオーディオで開く」から開く。共有画面は「オーディオで表示」で現在のfolder/file rootを開く。直下の現在の対応音声を200件ずつ読み、2,000曲上限と空一覧を表示する。原本の先行取得はしない。

共有可能なUI/controllerは `web/src/public-share/audio{,Player,Client}`、非公開wrapperは `features/audio/PrivateAudio`。公開bundleの境界を広げず、sharedのAudio型は型参照だけにする。1つのnative audio要素をルート一覧の外に保持し、前後の曲・再生/一時停止・音量・時間・閉じる・原本downloadを提供する。読み込んだ曲だけを再生順序に使い、最大2,000曲。原本URLをそのまま使い、fetch→BlobやlocalStorageへ音声・位置を保存しない。再生不可でも同じ認可のattachment downloadを提供する。

選択時に現在の原本/generator/利用者の位置を再取得する。再生中15秒ごとと一時停止・曲変更・閉じる時に保存する。pagehideでも送信を試みるが、browser終了・強制終了時の最終保存を保証しない。保存を直列化し、処理中の次の位置は最新値へまとめる。409や応答喪失では自動再送せず、「保存済みの位置から再開」で再取得する。曲終了は0を保存して次へ移る。匿名には保存処理自体を渡さない。

一覧はscopeと選択曲IDだけの安定したsnapshotを購読し、再生時刻・音量・一時停止の更新で2,000行を再描画しない。playerの時刻や状態は通常のsnapshotで更新する。曲名・artist/album・ファイル名は1行の省略表示とし、全文はDOMとtitle属性へ残す。長いタグで曲の行や固定playerを縦に押し広げない。

Content-Sessionは300秒を要求し、実際のCookie receipt期限に従う。再生中は15秒ごとに現在の閲覧権限と原本を照合し、残り30秒以内ならCookieだけ更新する。更新時にsrcを読み直さない。期限timerが到来するとバッファ済み原本も破棄する。browserのtimer停止・ページ終了時刻までは保証しない。個々のRangeはserver側でも現在の認可と配信期限を検査する。再開前も認可を照合する。共有解除・資格情報失効・原本変更、ログアウト・公開画面を閉じる時は要求と音声を破棄し、遅い応答で復活させない。

## 2,000曲の描画検証

ローカルChromeのCPU 4倍制限で、所有者1440×1000と匿名公開390×844を検査する。実upload/Queueで作成した3原本をテスト専用D1 fixtureで2,001曲へ分け、各blobの参照上限を守る。曲名は1,024 UTF-8 bytes、artist/albumは各1,023 bytes。実際の認証・一覧APIから200曲ずつ2,000曲へ進み、上限表示・原本再生・前後移動・閉じた後のsrc/選択解除を確認する。テスト用endpointは本番Workerへ含めない。

実再生を確認してから一時停止し、45回のtimeupdateと各requestAnimationFrameで表示更新だけを測る。先頭5回を除く40回のframe待ちp95は所有者45.4→17.3ms、公開45.1→17.2ms、45回全体のScriptDurationは1,336→44ms・1,403→39msとなった。player高は295→77px・357→170px。改善後の200曲追加の最大待ち時間は所有者1,252ms、公開1,129ms。heapの観測値は55.5/63.7MiBで、GC条件を固定したpeak測定ではない。

回帰gateはpage追加5秒未満、frame待ちp95 100ms未満、45回のscript処理750ms未満、player高は所有者200px/公開260px未満、横方向のはみ出しなし。実APIと原本配信は模擬しないが、表示測定ではnative時刻イベントを合成している。これはローカルの回帰検知であり、実Cloudflareや実モバイル機器の性能保証ではない。

## 残件

[override編集](AUDIO_METADATA_EDIT.md)と[タグの検索同期・既存曲再索引](AUDIO_SEARCH.md)は接続済み。[埋め込み表紙](AUDIO_COVERS.md)も新しいMP3/FLAC/MP4/Oggから抽出・変換し、一覧と常駐playerへ表示する。既存音声・所有者間COPY先の表紙もplayerから要求できる。[既存原本の情報抽出](MEDIA_EXTRACTION.md)もFilesから要求できる。自動一括処理とWAV/WebM表紙は継続する。原本OpusのFiles経由再生は[TRACK_METADATA](TRACK_METADATA.md)、追加形式の範囲と限界は[MP3/FLAC/WAV](AUDIO_FORMATS.md)と[AAC/Vorbis](AAC_VORBIS.md)を参照。

ローカルD1の候補探索gateと2,000曲のChrome描画gateは上記で検証済み。実Cloudflareの負荷・適用と、他OS/browser・実モバイル機器の確認は後続。
