# 音声タグの編集

2026-09-29。所有者と明示選択した内部edit共有の利用者が、Audio画面から曲名・アーティスト・アルバムの表示値を変更する。抽出値とoverrideを分け、空欄/nullで抽出値へ戻す。原本bytes、再生位置、track/disc番号は変更しない。

## APIと確定条件

既存の`PATCH /api/v1/nodes/:nodeId/audio`を接続する。Access利用者・同一Origin・CSRF・Idempotency-Keyが必要。bodyは`blobId`、`generator`、`revision`、`title`/`artist`/`album`（stringまたはnull）と、任意の`share:{id,version}`。各fieldはNFC後のUTF-8で1KiB以内。制御文字・不正surrogateを拒否し、前後の空白を除く。任意field、申告user/owner、duration、抽出値の変更は受け付けない。

現在のnode/blob・track-metadata-v1・codec/MIME・node revisionを確認する。専用`audio.metadata.write`はlibrary:write/editの認可を使い、匿名・app password・service、read共有、暗黙の別共有、非表示・削除された祖先、失効した資格情報を拒否する。共有rootが音声fileでも編集できるが、名前や原本の変更権限は拡張しない。

LockDOのnode write permit、ControlDOのmutation枠、operation claimを利用する。最終D1 batchで元credential/選択共有・node/parent/blob/revision/tree generation・metadataの抽出値とoverride・現行MIME・DAV lock・epoch/permit/claimを再照合する。override、node revision、tree generation、FTSと検索行、activity、7つのstep marker、operation terminalを同時確定する。migration0074以降は実効タグの[検索用cache](AUDIO_SEARCH.md)も同じ更新で保存する。同じbatchで現在の名前と実効タグをFTSへ同期する。以前の5段階で終端した同一intentの再送は、その確定結果を返す。DB-only処理なので新しいOutboxやR2書込みは発行しない。

同じkey/入力は元の確定receiptを返し、異なる入力は409。古いrevision/blob/generatorや先行編集を上書きしない。commit ACK喪失時は既存operation照会で確定を確認し、判定不能ならOperation-Id付き503とする。未知の結果のpermitを早期解放しない。operation照会も元のcredential/選択共有と現在の原本へのedit権限を必要とする。

## 画面

編集可能なAudio一覧に「タグを編集」を出す。開くたびに単一fileのtracks APIで現在のrevision、抽出値、overrideを取得する。フォルダー一覧や匿名/閲覧専用共有へ編集用snapshotを返さない。表示上の編集可否はhintであり、PATCHと確定batchで別途認可する。

競合・ロック・応答喪失時は再送せず「現在のタグを読み直す」で確認する。scope変更・閉じる・logoutで要求を中止し、遅い応答を採用しない。編集画面とPATCHクライアントはprivate bundleに置く。保存後は一覧を更新し、同じ原本を再生中ならplayerの表示を更新してnative src/位置を保持する。

## 継続する作業

編集はAudioの表示overrideとFilesの検索文字列へ反映する。[検索同期](AUDIO_SEARCH.md)は抽出・編集・改名・MOVE・原本上書き・同一所有者COPY・ごみ箱復元へ接続した。既存曲の一括再索引と所有者間COPYの音声引継ぎは継続する。原本のID3等への書戻しは行わない。

schema0074・通常79table・149 API route。検索用データのcolumnは先行migration0074で追加し、検索接続ではmigrationと依存を追加しない。現在のテスト結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。
