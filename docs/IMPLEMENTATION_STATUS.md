# 実装進捗

## Audio専用画面・常駐プレーヤー（今回）

[Audio](AUDIO.md)を所有者の専用route、選択した内部共有、公開リンクへ接続した。直下の現在のOpus曲を200件ずつ読み、最大2,000曲。共通playerは一覧の外に1つのnative audioを保持し、SPA遷移でも同じ原本URLの再生を続ける。前後移動・再生/一時停止・音量・現在時間・閉じる・原本downloadを提供する。追加の依存や公開bundle境界の拡張はない。

選択時に元blob/generatorと本人の位置を再取得する。保存は15秒ごと・一時停止・曲変更・閉じる時に直列化し、待機中の位置を最新へまとめる。409や応答喪失では自動再送せず、明示的な再読を案内する。匿名には保存処理を渡さない。Content-Sessionは実Cookie receipt期限を使い、再生中に残り30秒以内ならCookieだけ更新しsrcを維持する。15秒ごとに現在の認可/原本も再検査し、拒否・logout・共有を閉じる・期限到来でbufferとpending要求を破棄する。pagehideは保存を試みるが、browser終了時の最終保存を保証しない。

- Node新規16件成功（2file、208ms、/tmp/ncf-audio-ui-unit-2.log）。再開・直列化・保存競合・ACK喪失・前後移動・終了時0保存・遅い選択/配信応答・logout・公開共有失効・更新時src維持・応答のない更新中の期限停止・decoder不可・元URL/期限/認可receiptを確認した。
- 通常browserの新規4件とGallery既存2件成功。位置保存・SPA継続・再読・他tabの保存競合・音量・logout、read共有の本人位置・匿名の保存なし・共有close/解除・decoder不可downloadの3件は1.9分（/tmp/ncf-audio-ui-browser-2.log）。Ogg/WebM/MP4全3コンテナの実native再生と206/Rangeの1件、Gallery grid/list/recursive/lightbox/共有の2件は1.5分（/tmp/ncf-audio-ui-browser-formats.log）。390pxの所有者/匿名画面も確認した。初回3件は2成功・1件がAccess logout先へ移動した後のDOM待機でtimeoutした。試験内でlogout遷移に204を返し、元documentでsrc解除を検査するよう修正した。
- 単一host browser新規1件成功（34.8秒、/tmp/ncf-audio-ui-single-host.log）。同じhostの原本URL、保存・reload再開・閉じる時のsrc解除を実HTTPで確認した。
- Native既存29件成功（Audio24 + public assets5、9.61秒、/tmp/ncf-audio-ui-native.log）。現在の認可・状態CAS・cursor・共有/匿名APIと公開assetのSRI/境界を再確認した。重複を除く関連検証は52件成功。
- 最終型検査・lint737file・契約/設定検査成功（/tmp/ncf-audio-ui-types-complete.log、/tmp/ncf-audio-ui-lint-complete.log、/tmp/ncf-audio-ui-contracts.log、/tmp/ncf-audio-ui-config.log）。最終Web buildとWorker dry-runも成功（/tmp/ncf-audio-ui-build-final.log）。

schema0072・79通常table・149 API routeを維持。新しいprivate SPA routeだけを明示allowlistへ追加した。MP3/FLAC/WAV/M4A等の追加parser、cover、override編集/検索同期、2,000曲と非音声混在folderの実D1/描画負荷gate、Bookshelf、既存media再抽出/copy引継ぎ、運用修復と実環境確認は継続する。全suite・実Cloudflareへの適用は未実施。pushは以前の自動承認審査拒否後の承認待ちのまま、ローカルcommitへ保持する。

## Audio一覧と利用者別再生位置API

[Audio](AUDIO.md)の既存tracks routeを所有者・内部共有・匿名リンクへ接続した。現在のOpus原本・generatorと一致する曲だけを直下200件ずつ、最大2,000曲返す。専用cursorは閲覧者・資格情報・root・共有version・epoch・tree generation・generator・返却済み件数を保持する。匿名一覧は利用者の再生位置を含まない。

既存playback-state PUTをAccess/CSRF付きで接続した。read共有でも本人の位置を保存でき、所有者の状態は変えない。user/node/blobで保存し、最終batchで現在の認可・parent/blob・metadata・期待した更新時刻を照合する。ControlDOの共有枠は原本所有spaceで取得し、状態更新とreceipt・枠返却を一括確定する。先行保存は409で拒否し、古いblobの本人の位置は次回保存で整理する。

- 新規native24件と既存認可/Galleryを合わせ3file/80件成功（16.24秒、/tmp/ncf-audio-api-native-2.log）。2,000曲上限、cursor改変・用途転用・tree変更、override表示、利用者別状態、read共有、同時保存、原本差し替え、最終batchの資格情報/非表示祖先/parent/blob/generator/epoch/共有失効、ACK喪失、invalid position、CSRFと匿名sessionを確認した。初回は23件成功・1件がテストのCSRF発行method指定で失敗し、POSTへ修正して解消した。
- Browser1件成功（28.9秒、/tmp/ncf-audio-api-browser.log）。実upload/Queueから抽出したOpusをtracks APIで読み、所有者の保存と再読、古いタブの409、read共有の受信者だけの保存、共有解除後のread/write404を確認した。ローカルHTTPのAccess/CSRF/private router/ControlDOを通る。Audio画面のE2Eではない。
- Node5件成功（136ms、/tmp/ncf-audio-api-unit.log）。専用audienceと用途、10分の失効、署名改変、署名済みでも無効なaudience/generator/count/追加fieldを拒否する。audience追加後のnative24件も再確認して成功（7.23秒、/tmp/ncf-audio-api-native-final.log）。重複を除く関連検証は86件成功。
- 契約/設定検査成功（/tmp/ncf-audio-api-contracts.log、/tmp/ncf-audio-api-config.log）。
- 最終の型・lint729file・Web build/Worker dry-run成功（/tmp/ncf-audio-api-types-complete.log、/tmp/ncf-audio-api-lint-complete.log、/tmp/ncf-audio-api-build-final.log）。

schema0072・79通常table・149 routeを維持。Audio専用画面・常駐player、SPA遷移とsession更新、自動保存/再開、追加音声形式・cover・override編集、Bookshelf、運用修復と実環境検証は継続する。全suiteと実Cloudflareへの適用は未実施。pushは前回の自動承認審査拒否後の承認待ち。

## AV1・Opusの情報抽出と動画再生

[動画・音声情報](TRACK_METADATA.md)のbounded parserをMP4/WebM/Oggへ追加し、元upload/PUTの現在の認可・node/parent/blob・claim・epochを検査するQueueへ接続した。AV1の実profile/level/tier/8/10/12-bitとOpus構成から正規形のcodecs付きMIMEを保存し、既存node_media/node_audioへ寸法・時間・限定タグを確定する。1MiBのOpus header packetを分割ページから一度だけ組み立て、音声payloadのlacingはメタデータ構造数へ算入しない。MP4のmdatはoffsetで飛ばす。schema0072・79通常table・149 route、migration・依存追加なし。

GalleryにAV1動画を追加し、共有に束縛した原本URLを直接videoへ渡す。native controlsで再生・一時停止・シーク・音量を扱い、canPlayTypeと実errorの両方で原本ダウンロードへ案内する。詳細の終了やerrorでpause/src解除/loadを行う。contentのdownload=1は同じ認可・Range・budgetの後にattachmentへ切り替える。public bundleのmodule allowlistを広げず、CSP media-srcは固定content originとselfだけへ限定した。

- Node4file/117件成功（495ms、/tmp/ncf-tracks-unit-final-2.log）。新規parser37件に、9実エンコード形式、90秒のOpus、codec正規形、偽装/truncated/CRC破損、360回のheader変異、R2障害、1GBの疎なmdatを飛ばしたmoov読取りを含む。既存画像・条件付きRange・media契約も成功。
- native初回は既存画像/Galleryの37件が成功し、新規14件中10件が失敗した（/tmp/ncf-tracks-native-1.log）。9件は配信planの旧MIME検査がcodecs parameterを拒否したため、正規形だけを許可した。残る1件は最終batchのfixtureを、書込み認可が許容するhidden親から元parentを変える競合へ修正した。Galleryは従来どおりhidden祖先を除外する。
- 修正後native3file/22件成功（15.73秒、/tmp/ncf-tracks-native-2.log）。新規14件、content token/attachment HEAD、public asset境界を含む。9形式のD1/R2確定・Range実bytes、Images不使用、容量不変、現在の資格情報/parent/blob競合、ACK喪失と重複消費、共有の読取りcounterを確認した。
- 最終parserでnative3file/22件成功（63.09秒、/tmp/ncf-tracks-native-final.log）。新規14件の再確認と既存content lease/budget8件を含む。ここまでのnativeは重複を除き67件成功。
- Browser7件成功（2.6分、/tmp/ncf-tracks-browser-1.log）。6種類のAV1原本（MP4/WebM、8/10-bit、Opus有無）の実decode/再生/シーク、Range bytes照合、native errorと事前非対応からの実download、終了時の停止・src解除、内部共有/匿名リンクと停止後の404、既存画像Galleryとlgを検証した。mobile/publicのスクリーンショットも確認済み。
- FilesからのOpus原本再生1件成功（36.3秒、/tmp/ncf-tracks-audio-browser-3.log）。Ogg/WebM/MP4の実再生・シークを確認した。初回は原本CSPのdefault-srcがmediaを禁止し、media-srcだけの修正ではsandboxのopaque originがCORSで拒否された。解析済みAV1/Opusだけmedia-src selfとsandbox allow-same-originを設定し、スクリプト禁止は維持した。sandbox内Promise callbackを待つ中間テストは中断し、Playwrightからnative stateをpollする検証へ修正した。
- 単一host browser6件成功。初回は既存AVIF/lg、Opus原本再生とスクリプト禁止、HTML/SVGの添付限定の5件が成功（1.9分、/tmp/ncf-tracks-single-host.log）。AV1のdecode/再生/シーク後のHTTP検証がNode側のテスト用host解決で失敗したため、同じbrowserからのfetchへ修正。AV1とRange attachment・不正query拒否の1件も成功（28.9秒、/tmp/ncf-tracks-single-host-final.log）。今回のbrowserは重複を除き14件成功。
- CSP修正後のnative2file/17件成功（13.77秒、/tmp/ncf-tracks-native-csp-final.log）。新規14件に既存blob-read3件を加え、認識済みメディアのCSP、未対応原本の従来CSP/attachmentと実bytes、Range/HEAD/条件付き配信を確認した。今回のnativeは重複を除き70件、Node117件・browser14件と合わせ関連201件成功。全suiteは実行していない。
- 最終の型・lint722file成功（/tmp/ncf-tracks-types-complete-2.log、/tmp/ncf-tracks-lint-complete-2.log）。契約/設定検査も成功（/tmp/ncf-tracks-contracts.log、/tmp/ncf-tracks-config.log）。
- 最終Web build/Worker dry-run成功（/tmp/ncf-tracks-build-complete.log）。schema0072・79通常table・149 routeを維持し、remote適用は行っていない。

Audio専用一覧/playerと位置保存、その他の音声形式、Bookshelf、既存データ再抽出/copy引継ぎ、未知nativeと失効要求の運用修復は継続する。ローカルChrome以外のbrowser/OSと実Cloudflareの確認は未実施。remote resource/secret/migration/deploy変更なし。pushは前回の自動承認審査拒否後の承認待ち。

## 大きいプレビューの要求時生成

[lg1600の要求時生成](LARGE_THUMBNAILS.md)を所有者・内部共有・公開リンクへ接続した。画像を開いたときのPOSTは現在の閲覧者・元node/parent/blob・共有versionを保存し、同じ原本/variant/generatorのOutboxへ集約する。短い受付permitを返してからQueueへ送る。Queueで現在の認可を原本読取り・有料変換・保存・公開・完了にも照合し、既存の費用記録と公開再開、invocationの2有料試行・25秒上限を共有する。

Galleryは生成済みWebPのプレビューと原本URLを切り替えられる。生成中・非対応・失敗時は原本を表示し、開き直しまたは明示操作でプレビューを確認する。自動ポーリングはしない。中断とobject URL解放、WebP実bytesの12MiB上限を維持する。schema0072・通常79table・149 route。依存追加と公開bundle allowlistの拡張なし。

- 新規native1file/14件成功（33.61秒、/tmp/ncf-large-native-2.log）。1920×1080原本から1600×900 WebPを生成し、元upload資格情報の失効後も現在の閲覧者で受付、COW別名と同時consumerの重複防止、受付ACK喪失、内部共有/匿名リンク、CSRF・範囲外・クライアント画像拒否、最終batchや生成前の失効、保存後の公開再開、既知の失敗、共有有料予算を検証した。初回は失効fixtureのテーブル名が誤っていたためsessionsへ修正した。
- native回帰7file/178件成功（165.17秒、/tmp/ncf-large-native-regression.log）。画像Queue・費用・公開再開・operation・Outbox・DLQ再送・thumb配信を含む。
- Node3file/91件成功（31.94秒、/tmp/ncf-large-unit.log）。migration/schema、Galleryのbounded WebPと受付結果検証、既存APIを確認した。
- Browser4件成功（1.8分、/tmp/ncf-large-browser.log）。所有者・匿名リンクの1920×1080原本→1600×900 WebP→原本切り替え、object URL解放、390px表示と既存Galleryの内部共有・公開停止を検証した。/tmp/ncf-large-browserのmobile/publicスクリーンショットも確認した。
- 単一host browser2件成功（1.6分、/tmp/ncf-large-single-host.log）。所有者・匿名のAVIF原本表示と、lg生成後のプレビュー→同一origin原本切り替えを確認した。上記と合わせ、今回の関連testは重複を除いて289件成功。全suiteは実行していない。
- 型・lint713file・契約/設定検査成功（/tmp/ncf-large-types-final.log、/tmp/ncf-large-lint.log、/tmp/ncf-large-contracts-final.log、/tmp/ncf-large-config.log）。Web build/Worker dry-run成功（/tmp/ncf-large-build.log）。

- backup:operator-drill成功（/tmp/ncf-large-operator-drill.log）。0072を含む79tableのschema・全table snapshot・SQL/FK/FTS検証、epoch採用と段階再開まで確認した。reportは.wrangler/operator-drill-20qvHC/report.json。ローカルservice bindingの検証で、Time Travel/S3のprovider応答は模擬。実Cloudflareへの適用試験ではない。

保存された閲覧者の失効した要求を別閲覧者へ付け替える処理、未知nativeの運用修復・明示的な有料再試行は未実装で、保留時は原本を使う。動画情報/player・Bookshelf/Audioと既存の運用残件は継続する。リモート作成・secret投入・migration適用・deploy/pushは行っていない。pushは前回の自動承認審査拒否後の承認待ち。

## Galleryの画像一覧・共有閲覧

[Gallery](GALLERY.md)の画像APIを所有者・内部共有・公開リンクへ接続した。現在の原本とmetadata generatorを固定し、撮影日時（なければ更新日時）降順・ID昇順の200件ページを返す。専用HMACカーソルはcredential・共有version・root・epoch・tree generation・generator・再帰指定・候補上限も照合する。全祖先の非表示／削除状態と現在の認可を一覧SELECTと同じbatchで再検査する。

UIはグリッド／リスト、直下／再帰、前後ページ、原本ライトボックス・前後移動・矢印キー・Escapeに対応する。画面付近の公開済みsmを同時4件以下で取得し、非表示・ページ移動・scope変更・logoutで中断してobject URLを解放する。原本はcontent-host URLを直接表示する。共有停止後の再読では古い一覧を消す。schema0071・通常79table・147 route、migration/依存追加なし。公開bundleのmodule allowlistを拡張しない。

- native6file/93件成功（40.13秒、/tmp/ncf-gallery-native-regression.log）。Gallery12件に認可・node/shared read・thumb配信・public asset境界の回帰を含む。ページ順序・カーソル改変/転用・現在の原本/生成version・非表示/削除枝・最終batchの失効/世代変更・内部共有scope・公開link root範囲を検証した。
- 最後にmetadata generatorのカーソル束縛を追加し、Gallery12件を再検証して成功（6.06秒、/tmp/ncf-gallery-native-final.log）。同じ12件なので加算しない。初期fixtureの存在しない削除列と1blobに50,050別名を与えるrefcount違反は、実trash operationと独立した画像blobへ修正した。
- 50,050画像fixtureで候補50,000を測定すると、一覧SELECTはrows_read=550,203・154msとなり、設計§15.1の60,000行gateに失敗した（/tmp/ncf-gallery-gate.log）。設計の縮小条件に従い通常上限を10,000に設定。同じfixtureでは110,203行・34msだった。最終試験はgate判定に応じた上限とtruncatedを検証する。全認可込みや実Cloudflareのp95測定ではなく、50,000 gate合格とは扱わない。
- Node3file/39件成功（247ms、/tmp/ncf-gallery-unit-final.log）。WebP MIME・実bytes・宣言長・12MiB上限・分割転送・中断・古いclientのlogout後利用拒否と既存API/ZIPを検証した。
- 最初のbrowser試験で実HTTPのサムネイルがContent-Lengthなしの分割転送となることを確認した。宣言長があれば照合し、常に実bytesを上限内で数える読取りへ修正した。既存image metadata/thumbnailのbrowser3件は同runで成功（/tmp/ncf-gallery-browser-1.log）。
- 修正後の所有者Gallery browser1件成功（/tmp/ncf-gallery-browser-final.log）。グリッド／リストの保持、再帰切替、実PNG/JPEG/AVIF原本decode、キーボード、390px横幅を確認した。同runの共有停止fixtureはDELETEに必須のContent-Typeがなく403となり、既存API契約に合わせた。修正後の共有browser1件成功（1.4分、/tmp/ncf-gallery-browser-revocation.log）。内部共有と匿名リンクでサムネイル・原本を表示し、共有停止後の一覧消去まで確認した。
- 型・lint706file・契約/設定検査成功（/tmp/ncf-gallery-{types-final-2,lint-final-2,contracts-final,config-final}.log）。Web build/Worker dry-run成功（/tmp/ncf-gallery-build-final.log）。
- 単一host構成のbrowser1件成功（1.4分、/tmp/ncf-gallery-single-host.log）。所有者と匿名の単一ファイル共有で、sm表示・同じoriginの原本URL・AVIFの16×12 decodeを確認した。関連検証はNode39 + native93 + browser6 = 重複を除き138件成功。
- 公開画面の切替ボタンを既存の表示へ統一し、最終Gallery browser2件成功（1.4分、/tmp/ncf-gallery-browser-polish.log）。390pxの一覧と内部共有・匿名共有の画面を/tmp/ncf-gallery-browser-polish配下のPNGで目視確認した。最終の型・lint706file・Web build/Worker dry-runも成功（/tmp/ncf-gallery-{types-polish,lint-polish,build-polish}.log）。ローカルTLSの接続警告は出たが、assertionとプロセス終了は成功した。

lg要求時生成、既存画像の再抽出/copy引継ぎ、動画metadata/player、Bookshelf/Audioと復旧・運用の残件は未完了。全test suiteと実Cloudflareでの検証は行っていない。remote resource/secret/migration/deploy変更なし。pushは前回の自動承認審査拒否後の承認待ち。

## サムネイル配信と世代固定チケット（先行7728954）

[サムネイル配信](THUMBNAIL_DELIVERY.md)を既存のprivate/public thumb routeとcontent hostへ接続した。manifest v3で原本blob・公開済みimageId・variant・generator・実出力bytesを固定する。app方式は元Access/共有credentialに束縛したContent-Sessionを返す。原本用Cookieと共存し、thumbチケットを原本へ流用しない。BudgetDOは生成世代で重複排除し、COW別名・別manifest・再発行でもallowanceを増やさない。

発行最終batchは現在の認可と公開世代を再検査する。配信はbudget待機後、R2 HEAD後とGET後にも認可・原本・公開状態を確認する。HEAD/Range/304/416と有限leaseの既存会計を使用する。schema0071・通常79table・147 route、migration/依存追加なし。lgは保存済みの場合だけ配信可能で、lazy生成、Gallery API/UI、1,000件の性能測定と実環境検証は未完了。

- 新規nativeの初期試験でD1の式の深さ100の上限を確認した。WHERE条件を括弧で分割し、最終batchは32件ずつJSON入力からCOUNT/HAVINGで照合する形へ修正した。nested NOT EXISTS方式でも上限を超えるため使用しない。公開済み世代・pin・native終了の条件は維持した。
- fixtureの重複Content-Sessionヘッダーと、trash操作に未受付のLockDOを渡していた点を修正後、新規native15件成功（20.87秒、/tmp/ncf-thumb-native-6.log）。R2待機中の失効、最終公開競合、34件のCOW別名を含む。
- 内部共有の異なる受信者とgrant停止を追加し、配信・ticket・budget・session・lease・manifest・原本・公開共有のnative8fileを検証。初回は58/59件成功（/tmp/ncf-thumb-native-final.log）。既存の用途違い試験が旧thumb発行を使っていたため、汎用の別用途pageへ変更し、本物のthumbチケットで公開原本を取得できない検査を新規試験へ追加した。修正後の2file/35件成功（36.46秒、/tmp/ncf-thumb-native-final-2.log）。この組合せで8file/59件成功。
- 既存BudgetDO・ZIP HTTP・公開共有read・content mutation admissionのnative4file/115件も成功（77.91秒、/tmp/ncf-thumb-native-compat.log）。関連nativeは重複を除く12file/174件。
- manifestのNode4file/55件成功（562ms、/tmp/ncf-thumb-unit-2.log）。v1/v2維持、v3の厳密な項目・世代・variant・size・総量・順序固定・COW重複排除を検証した。
- 型検査、lint694file、契約/設定検査、Web build/Worker dry-run成功（/tmp/ncf-thumb-{types-final-3,lint-final-2,contracts-final,config,build}.log）。
- browser3件成功（1.4分、/tmp/ncf-thumb-browser.log）。実upload→Queue→本人用app/content hostのWebP decode、匿名AVIFのWebP thumbnailと原本Cookieの共存、6形式の原本decodeを確認した。ローカルTLS証明書の接続警告は出たが、assertionと終了は成功した。Node55 + native174 + browser3 = 重複を除く関連232件成功。全test suiteや実Cloudflareでの検証ではない。

remote resource/secret/migration/deploy変更なし。pushは前回の自動承認審査拒否後の承認待ち。

## Queueからのサムネイル自動生成（先行4a9ceb1）

[画像Queue](IMAGE_QUEUE.md)をupload/DAV完了通知へ接続した。検査済みmetadataからsm/mdを計画し、元のactor/credential・親・原本・claimで再認可しながら条件付きR2入力を読む。費用記録と独立DOで重複変換を防ぎ、成功済みは公開再開へ渡す。variantの公開/既知失敗を最終batchで照合し、metadata・MIME・Outbox terminalを一括確定する。

Queue invocation全体で有料試行2回・25秒、metadata 2MiB/64 GETを共有する。原本全量入力は合計40MB以下。非対応はattempts=0、native既知失敗はattempts=1として原本を保持し、再配信で再課金しない。未知nativeと保存証拠不足は保留する。lg lazy、thumb配信とGalleryは未完了。schema0071・通常79table・147 route、移行/依存追加なし。

- 初期の既存metadata native25件成功（21.49秒、/tmp/ncf-image-queue-native-smoke.log）。通常/匿名upload・DAVの原本/認可/atomic metadata回帰を含む。
- 新規Queue native15件成功（24.30秒、/tmp/ncf-image-queue-native-1.log）。実sm/md寸法・原本不変・物理/論理会計、stored/published中断からの再開、ACK喪失、複数配信の共通費用上限、同時claim、animation/dimension非対応、PNG/AVIF明示拒否、未知Images、最終認可変更、実ControlDO RPCとeviction後の再開を検証した。
- 型検査成功（/tmp/ncf-image-queue-types-2.log）。初回はEventRowに存在しない通知IDを参照したため、明示的なoutboxIdを渡すよう修正した。
- PUT結果不明・元GET中の失効を追加し、新規17件と既存Outbox/コピー/費用/保存のnative7file/172件が成功（123.69秒、/tmp/ncf-image-queue-native-regression.log）。先行metadata25件を含め、重複を除くnativeは8file/197件。
- 画像のNode3file/155件成功（481ms、/tmp/ncf-image-queue-unit.log）。最終型検査、lint689file、契約/設定検査、Web build/Worker dry-run成功（/tmp/ncf-image-queue-{types-final,lint,contracts,config,build}.log）。
- browser2件成功（1.4分、/tmp/ncf-image-queue-browser.log）。実upload→Queue→6形式の原本decodeと匿名AVIF共有閲覧を確認した。ローカルTLS証明書の接続警告は出たが、assertionと終了は成功した。
- 追加の元GET中失効試験から、Imagesを呼ぶ前のGET失敗もpendingを残すことを確認した。入力取得をtracked wrapperの送信前callbackへ移し、同じabort signalと5秒送信期限を使ってnot_startedを記録するよう修正した。途中のstream失敗は引き続き未知結果として保持する。GET一時障害後に新claimで成功する試験を追加し、最終native3file/77件成功（74.97秒、/tmp/ncf-image-queue-native-final.log）。Queue18・費用34・metadata25件。上記の既存回帰と合わせnativeは重複を除き8file/198件。
- 修正後の型検査とlintも成功。修正版のWeb build/Worker dry-runとbrowser2件も成功（/tmp/ncf-image-queue-build-final.log、/tmp/ncf-image-queue-browser-final.log、1.4分）。関連検証はNode155 + native198 + browser2 = 重複を除き355件成功。全test suiteや実Cloudflareを検証したものではない。

remoteへのresource/secret/migration/deploy変更なし。pushは前回の自動承認審査拒否後の承認待ち。

## 保存済みサムネイルの公開再開（先行72a8d69）

[公開再開](IMAGE_DERIVATIVES.md)を追加した。同じOutbox通知の新claim、現在の保存時actor/credential、原本/親/epochを照合し、元grantの期限後もstored出力の公開を完了する。result claim・blob/result/publication・物理予約の解放を一括確定する。費用/native記録・元予約期限と実容量を変更しない。公開済みの応答も現在の認可を再確認し、receiptを更新せず返す。

private ControlDOの証拠照会は、独立Images成功identity/outputとR2全tupleの終了履歴を検査し、独立pending・seal・履歴欠落を拒否する。D1の退役記録だけが失われても再公開しない。最後のD1 batchにもexact native ID/token、元の保存事実と未退役状態を固定する。native再送も追加R2 HEADも行わない。schema0071・通常79table・147 route、依存/移行追加なし。

- 公開再開のnative28件成功（53.51秒、/tmp/ncf-image-publication-native-3.log）。D1の実時計で元の25秒期限を満了させた後の成功、新claimでの認可、回収が先行した結果の拒否、native履歴と容量の不変性、current credential/parent/source/claim/epoch/maintenance/freezeの最終batch競合、ACK喪失とrollback、unknown PUT・prepared・保存証拠不一致、同時再開、独立Images/R2履歴欠落・seal・DO pending、実ControlDO RPC・eviction後の再開、入力identityの固定を検証した。実際の期限満了を待つ1ケースだけrunner上限45秒を明示し、製品の25秒期限を維持した。
- 保存・回収・復元画像修復のnative3file/47件も成功（/tmp/ncf-image-publication-native-2.log）。D1が成功のままnative tokenだけが変わる試験も追加し、最終の公開再開29件が成功（55.26秒、/tmp/ncf-image-publication-native-final.log）。独立したhashとの不一致を拒否した。重複を除く今回の関連nativeは4file/76件成功。
- 型検査、lint687file、契約/設定検査成功（/tmp/ncf-image-publication-{types-final,lint,contracts,config}.log）。Web build・Worker dry-runも成功（/tmp/ncf-image-publication-build.log）。
- 初期nativeは60/61件成功し、1件はテスト用の保存記録改変自体が既存のphysical_removal_requires_deleted_blobで拒否された。不正fixtureを除き、製品の検査は維持した。その後の期待したRPC拒否をVitestへ直接渡すケースでunhandled rejectionと次ケースのhook timeout/table欠落が発生した。成功系は実RPC、期待する拒否はrunInDurableObject内で受け取る形へ直し、同じ製品コードで28件完走と正常終了を確認した。

自動Queue生成、prepared/観測欠落/未知nativeの修復、失われたbytesの明示的有料再試行、thumb配信・Gallery API/UIは未完了。独立native履歴の削除後の証明不足は保留を維持する。remote変更は行っておらず、pushも前回の自動承認審査拒否後の承認待ち。

## 復元CLIからの画像回収（先行198bb12）

[領域修復](DATABASE_RESTORE_DOMAINS.md)へ `repair-restored --kind images` を追加した。通常の画像回収を同じControlDOの共通受付・seal処理へ直接接続し、自己RPCを使わない。復旧epoch/revision/tokenと未凍結条件をclaim・退役・HEAD予算・精算・lease返却の各batchへ加える。最大8件/25秒、元の物理会計・35日GC猶予・累計64回のHEAD予算を維持する。

未公開・退役済み・原本削除済みの未精算出力は、backoffや有効leaseで今回は選ばれなくてもpendingとなる。原本が有効な公開済み画像は保持し、回収の保留に含めない。CLIは件数と状態だけを返し、矛盾した件数や過大な結果を拒否する。一般のreservations修復から画像用予約を解放しない。schema0071・通常79table・147 route、依存追加なし。

- 新規native10件成功（29.33秒、/tmp/ncf-image-restore-native-3.log）。実ControlDO/共通受付・不在精算後の全復元監査・eviction後の再実行、保存済み未観測出力の容量計上/35日猶予、公開済み保持、候補のbackoffと件数制限、精算ACK喪失、HEAD前後の停止変更、D1停止revision変更、独立Images履歴欠落の保持を検証した。
- CLIのNode3file/148件成功（62.16秒、/tmp/ncf-image-restore-node.log）。新しいkind、内部key/tokenの除去、不正件数拒否、未精算候補の保留、観測済み出力のHEAD不要精算を含む。
- 初期の既存native2file/46件成功。追加したテストでは通知fixtureのdispatch証拠欠落とケース間のsent残存を検出し、実通知形式と明示的なfixture終了処理へ修正した。最初の監査失敗後にhook timeout/table欠落も発生したが、修正後は同じ期限で10件完走した。
- 最終回帰native5file/124件成功（183.78秒、/tmp/ncf-image-restore-regression.log）。復元domain/GC/inventory・画像保存/回収を検証した。domainのD1/KDF/R2保留時にimagesも拒否することを追加確認した。上記の新規10件と合わせてnative6file/134件、Nodeとの合計282件成功。実行中にworkerdのpump canceled警告は出たが、全assertionとプロセス終了は成功した。
- 型検査成功（/tmp/ncf-image-restore-types-final.log）。lint686file・契約/設定検査成功（/tmp/ncf-image-restore-{lint,contracts,config}.log）。backup:operator-drill成功（/tmp/ncf-image-restore-operator.log）。79table snapshot、epoch採用、画像を含む8種類のdomain修復、12ページ監査、受付・GC再開まで確認した。画像対象は空のservice-binding経路で、生成物を持つ場合は上記native10件で検証した。provider応答は模擬で、実Cloudflare検証ではない。演習の固定説明文も8種類へ更新した。Web build/Worker dry-runも成功（/tmp/ncf-image-restore-build.log）。

Queue自動生成、新claimでの公開、thumb配信、Gallery API/UI、未知nativeの運用修復・予算再承認・通知・履歴整理は未完了。remote resource/secret/migration/deployは行っていない。pushは前回の自動承認審査による拒否後の承認待ちで、再送していない。

## サムネイル生成物の回収（先行2b31ebc）

[生成物の回収](IMAGE_DERIVATIVE_CLEANUP.md)を実装した。未公開の期限/epoch切れ、または公開済み原本の不可逆な削除開始を同じbatchで検査して公開を停止する。ControlDOの独立Images成功identityとR2 pendingを照合し、generationごとの不変な書込み停止tokenを保存する。D1の退役記録が失われても、新しいimage.putを拒否する。未知native・独立履歴欠落では保持を続ける。

停止後は既存の実容量記録を使うか、直接ACKで予算を確保したHEADで観測する。物理予約とpinを一括精算し、存在する出力は35日以上の猶予付きで既存GCへ渡す。physical bytesは実削除確認まで減算しない。専用Cron、8件/25秒、1leaseでHEAD1回・1生成物で累計64回、索引順の待機に対応する。公開中の原本が有効な行は休止し、原本の削除開始時に同じtransactionで起こす。

schema0071・通常79table・147 route、依存追加なし。旧0070の全行を保持し、準備/保存/公開済みの回収行を補う。停止・未凍結・未終了permit/operation/admission/KDF/R2/Imagesなしで移行する。DO停止履歴は削除しない。100万件のImages費用上限に対応するが、大量履歴の容量と時間は未測定。

- 新規native19件成功（22.39秒、/tmp/ncf-image-cleanup-native-2.log）。未送信出力の不在精算、失効後の実容量保持、観測欠落の回収、未知PUT・D1 native行喪失・独立Images履歴喪失の保持、seal/HEAD/精算のACK喪失、参照解除だけでは公開物を回収しないこと、原本の削除開始、64回の上限、evictionとD1退役記録喪失後の再送拒否、専用Cron、遅いHEADのclaim差替え、同時回収、restore freeze、実ControlDO RPC、後続への進行を検証した。GC猶予をassertした後、テスト用に満了を模擬して実R2削除とphysical減算まで確認する。
- 新規Node4件成功（1.88秒、/tmp/ncf-image-cleanup-migration.log）。旧0070の準備済み/公開済み生成物を含む全旧table値の保存、回収部分索引と一時sort不使用、偽seal/精算の拒否、稼働中移行の拒否を検証した。
- 最終全Node102file/1,885件成功（211.96秒、/tmp/ncf-image-cleanup-unit-all.log）。新規4件とschema/restore freeze・backup/restore CLIの回帰を含む。
- 既存R2台帳・GC・copy回収・画像保存・backup barrier/restore snapshotのnative6file/161件成功（167.75秒、/tmp/ncf-image-cleanup-regression.log）。初期native3file/65件も成功し、そのうちimage-costsの34件を含め、今回のnativeは重複を除く8file/214件。Nodeと合計2,099件成功。
- 初期schema/restore freezeのNode2file/86件も成功（/tmp/ncf-image-cleanup-schema-1.log）。D1用に分割したmigration全体の適用も成功した。backup:operator-drillも成功（/tmp/ncf-image-cleanup-operator-drill.log）。79tableのsnapshot照合、epoch採用、native/domain/inventory修復、監査、受付・GC再開まで確認した。provider応答は模擬で、未知画像PUTの終了証明や専用domain repairの接続を証明するものではない。Web build/Worker dry-runも成功（/tmp/ncf-image-cleanup-build.log）。
- 型検査成功（/tmp/ncf-image-cleanup-types-final.log）。lint685file・契約/設定検査成功（/tmp/ncf-image-cleanup-{lint,contracts,config}.log）。

Queueのsm/md・lg生成、thumb配信、Gallery API/UI、新claimでの再公開、未知nativeの運用証明・追加予算・通知、復元CLIの専用domain repair、履歴整理は後続。remote resource/secret/migration/deployは行っていない。pushは前回の自動承認審査による拒否後の承認待ちで、再送していない。

## サムネイルの保存・公開記録（先行323176c）

[生成物の保存](IMAGE_DERIVATIVES.md)を内部処理として追加した。成功済みImages receiptのWebP bytes/dimensions/SHA-256を確認し、不変keyへ条件付きPUTする。元のactor/credential・現在node/blob/parent・Outbox claim・epochを準備、native grant、公開batchで再検査する。実保存の観測は失効後もphysicalへ計上し、size/checksum不一致なら公開しない。result ready、blob committed、予約解放は一括確定し、公開ACK喪失はexact receiptで回収する。

画像の予約はphysical_only=1としてimage_reserved_bytesへ分離し、通常upload/copyの論理reserved_bytesを増やさない。全予約でphysical + reserved + image_reservedの物理予算を検査する。生成物pinとR2成功記録を保持し、一般の旧epoch reservation修復から画像を除外する。専用の修復・回収とpin解放は未接続で、自動生成は有効化していない。

migration0070は78tableへ追加し、既存R2 writeの全値、全既存trigger（予約会計の2個を除く）、通常reservationのcounterを保持する。停止・未凍結・未終了処理なしを要求する。D1のSQL分割に適合する算術式を使い、参照triggerの再作成後にfreeze guardを再設定する。依存追加なし、147 routeを維持する。

- 最終全Node101file/1,881件成功（210.85秒、/tmp/ncf-image-store-unit-complete.log）。新規11件はR2 proof拒否7件、既存receipt・全既存triggerの保存、通常予約counter保存、稼働中/pending移行拒否4件。最初の全Nodeでは復元freezeの拒否理由がdomain guardへ変わる1件が失敗し、freeze guard再設定後に解消した。
- 新規native18件成功（16.22秒、/tmp/ncf-image-store-native-corrected.log）。実WebP保存・一度だけのPUT、bytes改変、quota、失効/parent/claim/epoch変更、prepare/native/publicationのACK喪失、key衝突、偽公開・予約/pin/native証拠削除拒否、競合、grant直前失効、論理満杯/物理余裕、通常予約との競合、実R2のsize/checksum不一致を検証した。
- 既存copy-put/recovery-audit/control-r2-writesの3file/70件も成功（/tmp/ncf-image-store-native-final.log）。同runの画像fixture2件はControlDO未初期化と続くhook timeoutで失敗したため、通常DAV用の既存admission fixtureへ修正して上記18件を再検証した。画像保存用fixtureは即時admissionを使い、Queue製品経路の証明ではない。
- backup barrier/restore snapshotの2file/68件成功（90.49秒、/tmp/ncf-image-store-recovery.log）。重複を除くnativeは6file/156件、Nodeと合わせて2,037件成功。D1 migration初回のSQL分割失敗は、trigger内のsimple CASEを同値の算術式へ修正して解消した。
- backup:operator-drill成功（/tmp/ncf-image-store-operator-drill.log）。0070の78tableでsnapshot照合、epoch採用、native/domain/inventory修復、監査、受付・GC再開を確認。Time Travel/S3 provider応答は模擬で、画像未確定出力の専用修復や実Cloudflare復元を証明するものではない。
- 最終型検査成功（/tmp/ncf-image-store-types-complete.log）。途中のテスト用R2 overloadとSQLite列型のエラーはfixtureの型を修正した。lint680file・契約/設定検査も成功（/tmp/ncf-image-store-lint-final.log、/tmp/ncf-image-store-contracts.log、/tmp/ncf-image-store-config.log）。Web build/Worker dry-runも成功（/tmp/ncf-image-store-build.log）。

全workerd/browser再実行とremote resource/secret/migration/deployは未実施。pushは自動承認審査による前回拒否後の承認待ちで、再送していない。

## 画像変換失敗の終了証拠（先行f8fc7ef）

[画像変換の費用・終了記録](IMAGE_COSTS.md)にfailed状態を追加した。native .output()の明示拒否と、入出力EOF後の出力検査失敗だけを終了として記録する。入力から伝播した例外、内部/接続/timeout、EOF前の中断は未確定を維持する。callbackでcaller期限後の実拒否も観測し、DOへの終了保存とD1の完全なidentity/failure照合を行う。nativeのエラー本文は記録しない。failedも費用キーを保持するため、同じ変換の再実行を許可しない。

migration0069は停止・未凍結・未終了処理なしを要求し、0068の全列が一致することを照合して77tableを維持する。DOの旧台帳も同期transactionで移行し、pending/succeeded/not_startedのgrant・identity・費用・mirror・件数を保持する。大量履歴の移行時間は未測定。

- Node4file/180件成功（29.09秒、/tmp/ncf-image-failure-unit.log）。新規16件は明示拒否6code、曖昧5code、偽装した入力例外、EOF検査、不完全出力、遅い拒否、mirror障害。新規9件はterminal組合せと安全なfailure JSON、新規3件は旧schema履歴保存・pending拒否・停止条件。既存schema/image/費用も含む。
- native2file/46件成功（28.89秒、/tmp/ncf-image-failure-native.log）。既存38件に、失敗の費用保持/不変性、巻戻し、D1障害、偽終了拒否、実Images拒否、ACK喪失、timeout後の拒否、旧DO移行の8件を追加した。実Images拒否はoffline serviceへ未対応GIF出力を要求して9520を観測し、callbackからD1 terminalまで確認した。productionのAVIF拒否を実証する試験ではない。
- 初回型検査は移行テストのWorker/Node URL型衝突と汎用BindValue型で失敗した。node:urlのURLとfixtureの値型を指定して最終型検査成功（/tmp/ncf-image-failure-types-final.log）。修正後の移行3件も成功（1.30秒、/tmp/ncf-image-failure-migration-final.log）。
- 既存backup barrier/restore snapshotの2file/68件成功（117.93秒、/tmp/ncf-image-failure-recovery.log）。Node180 + native114 = 重複を除き294件成功。
- backup:operator-drill成功（/tmp/ncf-image-failure-operator-drill.log）。0069の77tableでsnapshot照合、epoch採用、native/domain/inventory修復、監査、受付・GC再開まで成功。Time Travel/S3 provider応答は模擬で、実Cloudflareの復元試験ではない。
- lint675file・契約/設定・Web build/Worker dry-run成功（/tmp/ncf-image-failure-{lint,contracts,config,build}.log）。

schema0069・通常77table・147 route、依存追加なし。Queue/R2生成物保存・thumb配信/Gallery、unknownの運用修復、失敗後の明示的再試行予算は後続。全Node/workerd/browser再実行とremote resource/secret/migration/deployは行っていない。pushは自動承認審査による前回拒否後の承認待ちで、再送していない。

## 画像変換の費用・終了記録（先行9793368）

[画像変換の費用・終了記録](IMAGE_COSTS.md)を追加した。元upload/DAV PUTのactor・credential・parent・blob・Outbox claimをaccount mutationと同じbatchで照合し、ControlDOの独立台帳でblob×variant×generatorの重複変換を防ぐ。成功/not_startedの実終了だけを精算し、ACK喪失・遅い結果・D1復元後も再変換せずに照合する。未確定8件・履歴100万件で受付を制限する。停止後の精算、backup/restore freeze・受付再開・原本GC・復旧監査の保留、復旧CLIのimages件数を接続した。

- 新規Node26件を含む関連7file/300件成功（66.02秒、/tmp/ncf-image-ledger-unit.log）。変換入力/出力、schema、backup生成/restore snapshot/database restore CLIを含む。
- 新規native26件成功（22.27秒、/tmp/ncf-image-ledger-native-4.log）。重複変換、3サイズ別claim、実R2/Images、grant/終了のACK喪失、最後の認可失効、トランザクション中のcredential失効、eviction/D1巻戻し、identity差替え、停止、backup/監査、8件/100万件の上限、timeout後の実結果を確認した。実ControlDOの受付/終了RPCも通過する。
- 既存native5file/144件も成功。/tmp/ncf-image-ledger-native-2.logのbackup barrier/R2記録64件、/tmp/ncf-image-ledger-native-3.logのrestore snapshot/復旧受付/domain80件。重複を除くnativeは6file/170件。
- 初回nativeではfixtureのcredential失効先を存在しない列へ指定し、RPC例外の検証がunhandledを起こしたため修正。追加の実ControlDO試験はfixtureのD1/DO GC policy不一致で拒否されたため、全GC設定を一致させて26件の再検証に成功した。製品の認可・mirror確認は緩和していない。
- backup:operator-drill成功（/tmp/ncf-image-ledger-operator-drill.log）。77tableのcapture/export/snapshot、epoch採用、native/domain/inventory修復、監査、受付とGCの段階再開を確認し、imagesを含む全pendingが0となった。ローカルD1/R2/DOの演習で、Time TravelとS3 provider応答は模擬。実Cloudflare復元の証明ではない。
- 最終の全Node98file/1,842件成功（190.70秒、/tmp/ncf-image-ledger-unit-all.log）。migrationの未終了KDF/R2 guard追加後のschemaと全CLIも含む。関連native170件と合わせ、重複を除き2,012件成功。
- lint673file・型・契約/設定・Web build/Worker dry-run成功（/tmp/ncf-image-ledger-{lint,typecheck,contracts,config,build}.log）。

schema0068・通常77table・147 route、依存追加なし。migrationは停止・未凍結・未終了KDF/R2等なしを要求する。Queue/R2保存・thumb配信/Galleryは未接続。既知のImages失敗の終了証明、unknownの運用修復、保持期限を照合した費用履歴整理は後続。全workerd/browser再実行とremote resource/secret/migration/deployは行っていない。Git pushは先行5854920への宛先明示の承認待ちを継続し、再送していない。

## Images変換の内部実行部（先行36a9045）

[サムネイル変換](IMAGE_TRANSFORMS.md)の入力計画・条件付きR2ストリーム・Images WebP出力と検査を追加した。原本20MB/12,000px/40MP・静止画制限、非拡大sm256/md768/lg1600、各chunk認可・入力実長、出力12MiB/4,096chunk・metadata非保持・寸法・SHA-256、取消しと遅い応答を扱う。native変換を再送せず、timeoutを終了証明として扱わない。製品のQueue・費用/claim・native ledger・R2生成物保存/配信には未接続。

- Node3file/123件成功（383ms、/tmp/ncf-image-transform-unit-2.log）。新規51件と既存画像53・Range/Images19。variant/入力制限、EXIF8方向の表示寸法、native1回・失敗/未読/遅延、R2条件と変更/実長/現在認可/取消し、output metadata/寸法/size/chunkを検証。
- 実R2/Imagesの12件成功（1.33秒、/tmp/ncf-image-transform-native-final.log）。JPEG/PNG/WebP/AVIF静止画・10-bit、1920×1080の3サイズ、半透明alpha、private camera EXIF除去、原本不変・差替え拒否を検証。生成WebPを別のImages.infoで読み戻した。
- /tmp/ncf-image-transform-native-3.logは画像変換12件と既存metadata25件の計37件成功（16.56秒）。/tmp/ncf-image-transform-native.logの既存binding11件も成功。nativeの重複を除く合計は3file/48件、Nodeと合わせ171件。
- 最初のnative変換9件は、全量R2 GETもoffset=0/length=元sizeを返すため、range属性なしだけを要求する実装が拒否した。省略または完全な元範囲のみを許可して上記再検証に成功。部分範囲・不一致は引き続き拒否する。型検査のUint8Array型指定1件も修正し、最終型検査成功（/tmp/ncf-image-transform-types-final.log）。
- lint668file・契約/設定・Web build/Worker dry-run成功（/tmp/ncf-image-transform-{lint,contracts,config,build}.log）。8つのbase64 fixtureがbinary原本と完全一致することも検査した。
- offline Imagesは実Cloudflareの全機能と同一ではない。自動EXIF回転・色・品質・Enterprise AVIF条件の実環境確認は未実施。全Node/workerd/browser・backup drillの再実行もしていない。

schema0067・通常76table・147 route、migration/依存追加なし。5854920のpushは自動承認審査による拒否後、宛先明示の承認待ちで再送していない。remote resource/secret/migration/deployなし。

## 画像メタデータ・原本MIMEと受け取り専用Outbox（先行5854920）

[画像メタデータ](IMAGE_METADATA.md)を通常/匿名upload・WebDAV PUTの完了Outboxへ接続した。JPEG/PNG/WebP/AVIFのheaderと許可したEXIFだけを抽出し、元blob・parent・現在のactor/credential・claim/epochを各Range前後と確定batchで検査する。R2はetag条件付き、元size/range/実bytesも照合し、画像/Queue invocationごと2MiB・64 GETに制限する。node_media・判別済みMIME・Outbox completedを一括確定し、原本や参照会計を変えない。WebDAVの利用者申告MIMEはinline許可にせず、判別前は添付として扱う。schema0067・通常76table・147 route、migration/依存追加なし。

- Node3file/92件成功（/tmp/ncf-images-unit-final.log）。画像53件、既存media20件、Range/Images上限19件。FFmpegによる実JPEG/PNG/WebP/AVIF静止画・10-bit・sequence、AVIF主画像/grid参照/向き、EXIF whitelist/UTC offset、偽装/truncation/CRC/構造・読取り上限、巨大payloadのoffset skip、R2範囲/長さ/etag・取消・遅い応答を検証した。BMFF boxのsize=0は終端までを表すため、初回の不正長fixtureをsize=7へ修正した。
- 実D1/R2/DOの新規画像25件と既存Outbox・upload・公開/受け取り専用共有・DAV保存/認証・blob readを検証。/tmp/ncf-images-native.logの既存4file/112件、/tmp/ncf-images-native-2.logの公開upload25件、/tmp/ncf-images-native-3.logの新規23件+既存3file/44件、/tmp/ncf-images-native-5.logの5file/137件が成功。重複を除く関連nativeは10file/216件。新規25件にはprivate/匿名edit/upload-onlyの実保存、現在認可・元parent/claim/epoch/停止の変更、原子的rollback・ACK喪失、古いblobイベントの非採用、元画像のRangeとMIME、偽装DAV MIME6種の添付配信を含む。
- native初回の8件はfixtureが同じlast_op_idを持つ親folderをfileと誤認したため失敗し、kind=fileへ限定した。続く1件はfixtureが不変physical receiptの変更を試みてDBに拒否され、native条件不一致の応答を使う検証へ修正した。追加のupload-only試験では既存Outboxが一般create権限を要求して完了できないことを確認した。元のcompleted upload/operation/credential/share/予約履歴を照合してupload用途だけを認可するよう修正し、上記5file/137件で成功した。一般create/read権限は広げていない。
- browser1file/2件成功（1.4分、/tmp/ncf-images-browser.log）。所有者の実upload→Outbox→content ticket/session→原本GETで6形式をChromeが16×12として実decodeし、匿名readリンクからのAVIFも成功した。image MIME/inline/no-store、元画像の表示を検証。Gallery UIや他のブラウザーの対応証明ではない。
- 最後にproducerからの実配信と、別upload/credential versionへの差替え拒否を追加し、新規native25件成功（15.41秒、/tmp/ncf-images-native-final.log）。同じ25件なので加算しない。
- 型・lint663file・契約/設定・Web build/Worker dry-run成功。最終検証ログは/tmp/ncf-images-types-final-3.log、/tmp/ncf-images-lint-final.log、/tmp/ncf-images-contracts.log、/tmp/ncf-images-config.log、/tmp/ncf-images-build-final.log。
- 先行472e682の[CI36473189569](https://github.com/daraskme/Nextcloud-flare/actions/runs/36473189569)は公開編集再開後の全10job成功。

**関連Node92 + native216 + browser2 = 重複を除き310件成功**。Images変換と費用/physical/終了記録、thumb配信、Gallery UI、既存データ再抽出/copy・move引継ぎ、AV1/Opus track/tag・Bookshelf/Audioは後続。全Node・全workerd・全browser・backup drillは今回ローカルで再実行していない。remote resource/secret/migration/deployなし。

## 公開編集の永続追跡と再読み込み後の確認（先行472e682）

[公開編集の再開](PUBLIC_EDIT_RECOVERY.md)を追加した。作成・改名・削除の元intentを送信前にIndexedDBへ保存し、再読み込み後も同じ共有session・key・対象・bodyで明示確認する。既知のoperation IDは照会だけを行う。共有/session単位のWeb Lock、保存済みintentとの照合、別タブ通知、ログアウト時のclosed markerで重複実行・記録の差替え・遅い応答による再保存を拒否する。別sessionの操作は引き継がず、古いタブから新sessionの記録も消さない。サーバーAPI・schema0067・通常76table・147 route・依存は変更していない。

- 関連Node4file/94件成功（328ms、/tmp/ncf-public-edit-unit-2.log）。編集37件、既存公開upload30件、ZIP24件、public asset境界3件。削除後等の対象情報を隠したreceiptを3件追加し、編集40件成功（147ms、/tmp/ncf-public-edit-unit-3.log）。重複を除くNodeは97件。
- 編集・再開browser2file/11件成功（2.3分、/tmp/ncf-public-edit-browser-3.log）。実POST/PATCH/DELETEの成功応答だけを失わせ、reload後の同じkey/body/session・原親/対象・一度だけの反映を検査した。既知IDのGET専用確認、IDB保存失敗時の非送信、別タブ競合、logout後の遅いACK、新sessionへの非引継ぎと旧タブからの記録保護も成功。
- 既存削除browser4件成功（/tmp/ncf-public-edit-browser-2.log）。初回の削除3件は新しいreceipt検査が非開示nodeIdを必須にしたため失敗し、別タブの完了通知が未送信の確認フォームを閉じる問題も確認して実行を中止した。非開示receiptと未送信フォームの保持を修正した。続く再開POST試験は確認ボタンが処理中表示へ変わるだけで完了と判断していたため、永続記録の削除を待つ観測へ修正し、上記11件で成功した。初回の公開認証browser2件も成功（/tmp/ncf-public-edit-browser.log）。
- 390pxの作成・改名・削除復元画面は横幅の検査と/tmp/ncf-public-edit-recovery-{post,patch,delete}.pngの目視確認を行った。元の名前・対象、確認ボタンと記録削除の説明を表示している。
- 既存公開upload・ZIPのbrowser2file/11件成功（2.6分、/tmp/ncf-public-edit-browser-regression.log）。単一/分割upload・上書き、予約/確定応答喪失後のreload、完了済みpartの非再送、中止・logout、read-only制限、所有者/internal/publicの実ZIP downloadを検証した。今回の関連browserは6file/28件。
- 型、lint653file、契約/設定、Web/private/public build・SRI/境界検査とWorker dry-run成功（/tmp/ncf-public-edit-types-final.log、/tmp/ncf-public-edit-lint-final.log、/tmp/ncf-public-edit-contracts.log、/tmp/ncf-public-edit-config.log、/tmp/ncf-public-edit-build-2.log）。
- 先行ebcc9faの[CI36469054574](https://github.com/daraskme/Nextcloud-flare/actions/runs/36469054574)はUbuntu/Windows Node、全native shard、通常/単一host browser、backup bindings/cliの全10job成功。

**関連Node97 + browser28 = 重複を除き125件成功**。全Node・全workerd・全browser・backup drillは今回ローカルで再実行していない。thumb/page/track・media、復旧・運用、実環境検証は未完了。remote resource/secret/migration/deployなし。

## ZIP発行・配信APIと所有者/共有画面（先行ebcc9fa）

[ZIPダウンロード](ZIP_DOWNLOADS.md)を所有者・内部共有の受信者・匿名readリンクへ接続した。固定snapshot/pin→tracked manifest→共通ticket公開→サーバー内session交換を経て、元credentialに限定したapp GETでSTOREを配信する。毎GETの現行認可・snapshot・pin検査、同一archive再発行時の共通予算、Range拒否のrequest課金、R2 etag/size確認、lease/中断/保持期限を接続した。画面は安全な同じappのselectorへnavigateし、archiveをbufferしない。公開buildへ追加した共有コードは副作用・importのないZIP receipt/説明文utilityの1fileだけを明示許可し、既存のsource/module検査を適用した。schema0067・通常76table・147 route、migration/依存追加なし。

- 全Node94file/1,666件成功（186.61秒、/tmp/ncf-zip-delivery-unit.log）。URLの厳密な検証、CSRF・選択share・元public session、ログアウト中の遅い応答拒否、失敗時のpopup閉鎖と非再送を含む。
- 公開buildは初回、共通utilityが既存のsource allowlist外として停止した（/tmp/ncf-zip-delivery-build.log）。1fileだけを明示許可してsource検査も適用し、ZIP clientとpublic境界のNode2file/27件成功（233ms、/tmp/ncf-zip-delivery-unit-boundary.log）。全Nodeとの差分は境界検査1件で、重複を除くNodeは1,667件。
- 実D1/R2/DO4file/113件成功（66.94秒、/tmp/ncf-zip-delivery-native.log）。ZIP HTTP22件、snapshot/pin13件、既存content ticket/admission78件。private/publicの実bytes・Unicode/空folder、実Access/CSRF、元credential、internal read shareと期限、upload-only拒否、共有/内容/pin/manifest変更、Range/再発行budget、切断、取消し後の進行中配信、R2欠落/改変によるbody失敗と課金を検証した。先行API検査3file/97件（/tmp/ncf-zip-api-native.log）はこの113件と重複するため加算しない。
- 型、Web/private/public build・SRI/境界検査、Worker dry-run成功（/tmp/ncf-zip-delivery-types-final.log、/tmp/ncf-zip-delivery-build-final.log）。
- browser5file/8件成功（2.0分、/tmp/ncf-zip-delivery-browser.log）。ZIPの所有者・匿名read・internal readの3件で実downloadを解析し、日本語名・内容・空folderを確認した。internalは選択shareの送信と停止後の非表示、匿名はcontent host/private bundle/secret URL不使用、各390px画面の横幅も検査した。既存Files操作/mobile、匿名複数tab、internal停止、upload-only非開示の5件も成功。/tmp/ncf-zip-owner-mobile.png、/tmp/ncf-zip-public-mobile.png、/tmp/ncf-zip-recipient-mobile.pngを目視確認した。
- 先行c886e85の[CI36465246546](https://github.com/daraskme/Nextcloud-flare/actions/runs/36465246546)はUbuntu/Windows Node、全native shard、通常/単一host browser、backup bindings/cliの全10job成功。先行のD1 projection上限修正とNode同時実行制限後の結果である。過去のWindows native失敗の原因特定とは区別する。

**Node1,667 + 関連native113 + browser8 = 重複を除き1,788件成功**。全workerd・全browserとbackup drillは今回ローカルで再実行していない。実環境・最大規模ZIP、thumb/page/track/media、復旧/運用の残件は維持する。remote resource/secret/migration/deployなし。

## ZIP manifest・予算・保持の内部基盤とバックアップ列上限修正（先行c886e85・7fa5a09）

[ZIPダウンロード](ZIP_DOWNLOADS.md)の内部基盤を追加しました。空フォルダー、固定manifest、正確な出力サイズ、共通予算、期限付きblob保持と定期解放に対応します。ZIPのticket発行・API・画面への接続は次工程です。schema0067は索引のみを追加し、通常76table・147 routeを維持します。[ファイル受け取りリンク](UPLOAD_ONLY_SHARES.md)、単一ドメイン、公開原本配信・編集/削除は接続済みです。thumb/page/track・media、実環境検証、復旧側の残件も未完了です。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。

先行f2c6c33の[CI36460457472](https://github.com/daraskme/Nextcloud-flare/actions/runs/36460457472)はWindows全Node/4分割・通常/単一host browserの7job成功、backup bindings/cliとUbuntu Nodeの3job失敗で終了しました。バックアップはローカル実D1でも再現し、uploadsが51列になったことで型と値の102列SELECTがD1の結果列上限100を超えると特定しました。今回、同じ凍結keyset pageを100列以内のprojectionへ分割し、各pageのkey/順序/件数を照合するよう修正しています。Ubuntuはbackup-operator試験の5秒timeoutで、Nodeの同時実行を全OSで2に制限しました。製品の期限やUbuntuの試験timeoutは変更していません。CLI jobの保存ログはbackup_run_drill_command_failedのみで、詳細artifactは取得できなかったため、その失敗の同一原因までは確定せず修正後CIで確認します。修正後の検証は上記実装記録を参照してください。

- 全Node93file/1,642件成功（186.75秒、/tmp/ncf-zip-all-unit-2.log）。v2 manifestの正確なサイズ・改変拒否・再発行の予算同一性、51/100列のbackup exportとscalar精度・変更page拒否を含む。初回はsandbox内でCLI子プロセスの出力が失われ、local HTTPも拒否されたため39件失敗した。同じ無効引数CLIを制約内外で比較し、許可されたローカル実行環境で全件を再検証した。
- ZIP関連の実D1/R2/DO・serializer4file/52件成功（39.15秒、/tmp/ncf-zip-native-2.log）。初回は2件のfixture準備誤りと、3件の期待したRPC例外がtest poolで未処理になる問題があり、準備を修正してDO内で期待例外を検査した。製品の認可や上限は緩めていない。
- pin解放の最終修正と既存content ticket/budget/session/admission/public配信/lease/accounting/recoveryの回帰9file/141件成功（125.62秒、/tmp/ncf-zip-native-regression.log）。zip-snapshot13件が重複するため、関連nativeは12file/180件。
- 実Wrangler backup:drill成功（/tmp/ncf-zip-backup-drill-fixed.log、.wrangler/backup-drill-qgsKAu/report.json）。76table・SQL9,955bytesの取得、BACKUPS保存/読戻し/競合拒否、download、offline restore、FTS・会計・FK・schema・元DBのfreeze保持を検証した。元BLOBSの内容復旧、live restore、remote設定の証明には含めない。
- Web build/Worker dry-run成功（/tmp/ncf-zip-build.log）。
- 型、lint642file、契約/設定が成功（/tmp/ncf-zip-types-final.log、/tmp/ncf-zip-lint.log、/tmp/ncf-zip-contracts.log、/tmp/ncf-zip-config.log）。

**全Node1,642 + 関連native180 = 重複を除き1,822件成功**。ZIPのticket/API/配信stream/画面は次工程。全workerd、browser、backup:run-drillは今回ローカル再実行していない。schema0067・通常76table・147 route、依存追加なし。remote resource/secret/migration/deployなし。

## ファイル受け取りリンクの管理・匿名送信・再開（先行f2c6c33）

folder/rootを対象にupload-onlyの管理APIとフォルダー操作からの管理画面、匿名の単一/分割送信・受付番号・再開画面を接続した。create/uploadだけを認可し、owner/shareの予約を同じbatchで取得する。保存時の同名は公開batch内で自動改名し、最終名や既存fileを開示しない。作成/受信/確定は同じ201 receipt、statusは元session+capabilityに固定してprivate operation/errorを隠す。失敗・中止・cleanup・復旧監査も同じidentity/予約へ接続する。[UPLOAD_ONLY_SHARES](UPLOAD_ONLY_SHARES.md)参照。migration0066・通常76table・147 route、依存追加なし。

- 所有者管理の実D14file/66件成功（18.61秒、/tmp/ncf-upload-only-owner-native.log）。upload-only12件、既存link/internal共有・予約会計を検査した。
- core/復元の実D1/R2/DO5file/87件成功（70.28秒、/tmp/ncf-upload-only-core-native-2.log）。初回は42/43件成功、既存分割中止の歴史的principal proofがD1の式深度100を超えた。条件のグループ化で同じ認可を維持して修正し、再実行で成功した。
- 追加の同時同名送信・単一/分割の確定失敗精算・native中止後の二重予約解放と、旧schemaからのデータ保持・maintenanceなしの移行拒否・原子的な復旧最終fenceを3file/12件で検証（24.01秒、/tmp/ncf-upload-only-native-3.log）。失敗精算のreservation照合もshare予約に対応した。この段階の関連nativeは重複を除く10file/147件。
- Node4file/72件成功（232ms、/tmp/ncf-upload-only-unit-final.log）。strict管理入力、password、移植可能なUnicode/長い自動名、元capabilityの保存順、任意status URL拒否、単一/分割receipt・ACK喪失再開を検査。最初の名前上限試験では既存規則が禁止する255 scalarのfixtureを与えて失敗したため、許容最大の254 scalarへ修正した。
- 初回browser3file/16件中15件成功（3.2分、/tmp/ncf-upload-only-browser.log）。既存公開11件と、新規のACK喪失・96 MiB再開・所有者管理・空file/容量不足を確認。同名送信の内容保持まで成功後、390px画面で64桁受付番号が横にはみ出すassertionが失敗した。noticeに折り返しを追加し、最終browser2file/8件成功（2.2分、/tmp/ncf-upload-only-browser-final.log）。新規5件と既存owner link3件が成功し、重複を除くbrowser全4file/19件成功。修正後の実画面/tmp/ncf-upload-only-mobile.pngも確認した。
- 型、lint637file、契約/設定、Web build/Worker dry-run成功。/tmp/ncf-upload-only-types-final.log、/tmp/ncf-upload-only-lint.log、/tmp/ncf-upload-only-contracts.log、/tmp/ncf-upload-only-config.log、/tmp/ncf-upload-only-build-final.log。最終の説明文/テスト準備修正後も型・lint・Web build/Worker dry-run成功（/tmp/ncf-upload-only-types-verified.log、/tmp/ncf-upload-only-lint-verified.log、/tmp/ncf-upload-only-build-verified.log）。
- 共通認可・R2許可・失敗精算が影響する既存native8file/184件成功（87.67秒、/tmp/ncf-upload-only-regression-native.log）。単一/分割upload、DAV、内部共有、公開unlock、ControlDO/共通受付での精算を検証。関連nativeは重複を除く18file/331件。
- schema/backupのNode追加検査では2file/80件成功、旧link移行fixtureの7件が新しいupload_only列を持たず監査を呼んで失敗した。link/trashの旧データfixtureを保ったまま現行migrationまで進めるよう修正し、2file/29件成功（6.49秒、/tmp/ncf-upload-only-schema-unit-final.log）。旧schema準備の失敗ログは/tmp/ncf-upload-only-schema-unit.log。重複を除くNode全8file/181件。
- 先行dad1f95の[CI36455427980](https://github.com/daraskme/Nextcloud-flare/actions/runs/36455427980)は全10job成功。過去のWindows nativeエラーの原因特定とは区別する。

**関連native331 + Node181 + browser19 = 531件成功**。thumb/page/track、ZIP/media、公開create/rename/deleteのreload追跡、復旧/運用・最大規模・実環境検証は後続。全Node/全workerd/全browser・backup drillは今回ローカル再実行していない。remote resource/secret/migration/deployなし。

## 単一ドメインのapp・公開共有・原本配信（前回）

APP_ORIGINとCONTENT_ORIGINが同じときに全app pathがcontent handlerへ渡っていた不具合を修正した。単一hostでは/sessionと/cの名前空間だけを配信へ渡し、既知app pathは既存のAccess・共有・DAV・assets認可へ接続する。別originのcontent hostは配信専用のまま、未知host/path/methodはSPAへfallbackしない。Cookie、CSRF/Origin、CSP/attachment、D1/ControlDO・BudgetDOの既存検査を維持する。[SINGLE_HOST](SINGLE_HOST.md)に経路と未検証範囲を記録した。schema0065・通常76table・147 route、migration/依存追加なし。

- 関連workerd6file/68件成功（51.58秒、/tmp/ncf-single-host-native-final.log）。新規host-routing5件とpublic-assetsの2構成化を含め、API/private assets/DAV認証、配信hostでのapp拒否、未知path/method、公開assets、CSRF/Origin/CORS、host-only Cookie、Range/HEAD・取消し・maintenanceを検査。既存公開配信19件、ticket、実ControlDO bootstrap、multipart-upload27件も成功。初回2file/10件成功（/tmp/ncf-single-host-native.log）は重複加算しない。
- 単一host専用browser3件成功（1.5分、/tmp/ncf-single-host-browser-final.log）。実Files upload/download、390pxの匿名共有、Unicode名、Cookie/認証境界・HEAD/Range/304・logout後の拒否、HTML/SVGの実添付downloadを検証。初回はHTML/SVGの2件成功、共有1件は本来の60秒待機ボタンを試験が待たず失敗した。既存public試験と同じ待機手順へ修正した。またPlaywrightの設定合成がwebServerを追加結合するため、専用設定は明示的に上書きして8879を重複起動しないようにした。
- 別hostの既存browser3件成功（1.5分、/tmp/ncf-single-host-split-browser.log）。Filesの作成/rename/upload/保存/trash/restore/copy/move、匿名2tab/共通budget/保存、app経由のHEAD/Range/304/ticket取消しを再確認。
- 型、lint629file、契約/設定、Web build/Worker dry-run成功。/tmp/ncf-single-host-types-final.log、/tmp/ncf-single-host-lint-final.log、/tmp/ncf-single-host-contracts.log、/tmp/ncf-single-host-config.log、/tmp/ncf-single-host-build-final.log。
- CIへ単一host browserを独立jobとして追加。従来のbrowser全試験・Windows4分割・全Node・backup両drillと時間上限を維持する。専用ローカル8880のbinding状態は通常の8879や開発DBと分離する。
- 先行937b434の[CI36450383559](https://github.com/daraskme/Nextcloud-flare/actions/runs/36450383559)は8job成功、Windows4/4の1件失敗（867/868件成功）。64 MiB + 3 bytesのmultipart確定時にupload_complete_pendingとなった。今回ローカルで該当file全27件が成功したが、保存ログだけで受付・native complete・HEAD観測の原因は確定できず、Windowsの解決済みとは扱わない。/tmp/ncf-public-delete-ci-windows4.log。

**関連workerd68 + browser6 = 74件成功**。upload-only、thumb/page/track、ZIP/media、復旧/運用・最大規模・実環境検証は後続。全Node/全workerd/全browser・backup drillは今回ローカル再実行していない。remote resource/secret/migration/deployなし。

## 公開原本のGET/HEADと共通の配信会計（前回）

`GET/HEAD /api/v1/public/shares/:id/content/:nodeId`を既存のcontent-session・target manifest・BudgetDO・期限付きストリームへ接続した。`POST .../content-session`の追加指定`delivery:"app"`で元のShare-Session/public CSRFを検査してD1セッションを発行し、署名ticket/Cookieを返さずselector IDを返す。GET/HEADは現在の共有Cookieと元Share-Session/Content-Sessionを両方要求し、別credential/purpose、manifest外node/blob、失効・期限・範囲外を拒否する。既存のcontent host配信と同じbyte/request/parallel枠を使い、HEAD/304/416も計上する。公開画面は既存のcontent host保存経路を継続する。共通原本応答へCSPとASCII fallback filenameを追加し、公開APIの拒否時もprivate/no-store・nosniff・no-referrerとHEAD本文なしを維持する。schema0065・通常76table・147 route、migration/依存追加なし。

- 初回workerdは公開原本配信・公開閲覧・blob配信の3file/28件成功（21.97秒、/tmp/ncf-public-content-native.log）。新規17件でGET/HEAD/Range/304/416、範囲・元session・purpose・CSRF/Origin・ticket取消し・失効・親移動・snapshot直前owner変更、content hostとの共通会計、枠更新/parallel/request制限、取消し・R2不整合、HTML/SVG添付を検証した。
- 期限切れと上書き後の旧manifest拒否も追加し、公開配信・既存content session/ticket/budget/lease/共通受付・unlock・公開編集/削除の10file/177件成功（154.53秒、/tmp/ncf-public-content-native-final.log）。新規公開配信は19件。初回の公開閲覧/blob配信11件と合わせ、重複を除く関連workerdは12file/188件成功。
- 配信leaseのNode20件成功（334ms、/tmp/ncf-public-content-unit.log）。最終型、lint626file、契約/設定、Web build/Worker dry-runも成功（/tmp/ncf-public-content-types-final.log、/tmp/ncf-public-content-lint-final.log、/tmp/ncf-public-content-contracts.log、/tmp/ncf-public-content-config.log、/tmp/ncf-public-content-build-final.log）。
- 関連browser9file/27件成功（4.1分、/tmp/ncf-public-content-browser.log）。新規1件はAccessなしのbrowserからapp配信セッションを発行し、実HTTPのHEAD/Range/304・元share-session不一致・ticket取消し後の拒否とprivate/no-store・no-referrerを検証。公開unlock/編集/削除/upload/所有者管理、Filesと内部共有の保存、Unicode filenameを含む既存動作も成功した。最終確認で共通problemにもno-referrerを追加し、handler到達前の設定不備・停止応答へ適用した。変更後の型/lint/buildも成功。
- 先行937b434の[CI36450383559](https://github.com/daraskme/Nextcloud-flare/actions/runs/36450383559)は、2026-09-29 01:43 JSTの確認でUbuntu・Windows1/4〜3/4・Windows全Node・browser・backup bindingsの7job成功、Windows4/4とbackup CLIが実行中。前回失敗したbrowserとWindows1/4の完走は確認できたが、全CI成功とは扱わない。

**Node20 + 関連workerd188 + 関連browser27 = 235件成功**。全Node/全workerd/全browserとbackup drillは今回ローカル再実行していない。この時点では単一host構成のルーティングとupload-onlyが次工程だった。単一hostは上記の今回変更で接続した。thumb/page/track、ZIP/media、復旧/運用・最大規模・実環境検証も後続。remote resource/secret/migration/deployなし。

## 公開共有からのごみ箱移動と所有者復元（前回）

公開DELETEと確認画面を既存13段階のtrash mutationへ接続した。確認時のrevision、元share/session/epoch/keyを固定し、共有root・範囲外・read権限・DAV lock・1,000件超を拒否する。匿名activityとtrashのactorはnullで、元のoperation/credentialへ帰属を保存する。所有者の既存ごみ箱から一覧・復元・完全削除できる。応答不明時は自動再送せず、Operation-IdがあればGET、なければ元の要求を明示的に再送する。編集操作の追跡は画面内だけで、reload後の復元は未実装。migration0065で既存trashのデータ・参照・凍結guardを保持してactorをnullableにした。通常76table・147 route、依存追加なし。

- populated D1の移行と凍結・復旧snapshotの3file/80件成功（132.22秒、/tmp/ncf-public-delete-native-freeze.log）。新たな履歴検査を既存の凍結assertionへ包んだ際、D1式深度100を超えることを実queryで再現し、条件を括弧で分けて修正した。検査条件は維持し、移行テストにも実際のassertExists wrapperを含めた。初回の関連13file試験は共通凍結準備の失敗後に停止したため成功数へ加算しない。
- 公開削除の13件は成功（/tmp/ncf-public-delete-native-diagnose2.log）。匿名帰属・同一key・元session限定receipt・read/CSRF/body・revision・root/範囲・権限取消し・競合・D1 ACK喪失・DAV lock・1,000件制限・所有者の復元/完全削除を検証。初回の所有者復元失敗は、fixtureにControlDOのrestore pauseとsearch_index/FTSが不足していたため修正した。製品の復元条件は維持している。
- 認可・公開編集・削除・既存共有書込み・operation・outbox・復旧監査・公開assetの10file/179件成功（105.55秒、/tmp/ncf-public-delete-native-verified.log）。上記の移行/凍結/snapshotを合わせ、重複を除く関連workerdは13file/259件成功。
- 全Node90fileは1,581/1,585件成功（132.65秒、/tmp/ncf-public-delete-unit-final.log）。browserと同時実行した際、既存backup generation/health/operator/publicationの4件が時間切れになった。検査内容と期限を変えず1 workerで対象4件を再実行し、すべて成功（20.11秒、/tmp/ncf-public-delete-unit-timeouts.log）。この確認で重複を除く1,585件が成功したが、全suiteの単一実行成功とは扱わない。先行のsandbox内実行ではlocalhostのlisten EPERM等で39件が失敗したため、通常のローカル実行環境へ切り替えた（/tmp/ncf-public-delete-unit-verified.log）。
- 型、lint624file、契約/設定、Web build/Worker dry-run成功。/tmp/ncf-public-delete-types-final.log、/tmp/ncf-public-delete-lint-final.log、/tmp/ncf-public-delete-contracts.log、/tmp/ncf-public-delete-config.log、/tmp/ncf-public-delete-build-final.log。
- 全browser11file/59件成功（9.7分、/tmp/ncf-public-delete-browser-full.log）。新規4件は390pxの確認/取消し/削除と所有者復元、応答喪失後の同一key/session/revision再送、既知Operation-IdのGET限定照会、確認後の子追加に対する412を検証。前回CIの内部共有3件と所有者復元1件も成功した。初回の関連18件では共通helper抽出時のopen import漏れが1件失敗し、修正後の全体実行で再確認した。390pxの削除確認画像を目視し、横のはみ出しなし。
- 先行837cfedの[CI36444362854](https://github.com/daraskme/Nextcloud-flare/actions/runs/36444362854)はUbuntu・Windows2/4〜4/4・backup bindings/cliの6job成功、browser失敗、Windows1/4が30分上限でcancelled。browserは4件の操作対象が仮想スクロールの表示範囲外にあった。APIでは44件中20番目の作成済みfolderを確認し、検索してから操作する試験へ修正した。Windows全Nodeは1,573件成功したが8分46秒を使ったため、全Nodeを独立したWindows jobへ分け、全4integration shardと30分上限を維持した。先行の別のWindows失敗の原因解消を意味しない。

**Node1,585 + 関連workerd259 + 全browser59 = 重複を除き1,903件成功**。Nodeの4件は上記の個別再確認を含む。全workerdとbackup drillは今回ローカル再実行していない。upload-only、専用配信、ZIP/media、未知native/partの全体閉鎖、最大規模と実環境検証は後続。remote resource/secret/migration/deployなし。

## 公開アップロード画面・上書き確認・再読み込み後の再開（前回）

公開画面へ単一/分割upload、確認付き上書き、確認済みbyte進捗、一時停止/中止/結果確認を追加した。元share/session・受付/確定key・capability・part attempt・上書きrevision/blobとファイル照合情報を専用IndexedDBへ保存する。秘密URL・password・file本体は保存しない。名前/サイズ/mtimeと先頭/末尾各64 KiBのSHA-256で元ファイルを照合し、単一PUTの結果不明時は再送しない。分割は整合するpart一覧の完了分を除き最大4並列で送る。root permissionsでupload actionも反映する。logout時の記録削除とclosed session保存を同一transactionで行い、通知が遅れた別タブからの再保存を拒否する。schema0064・通常76table・147 route、依存追加なし。

- 全Node89file/1,573件成功（100.24秒、/tmp/ncf-public-upload-ui-unit-full.log）。新規25件は0byte/単一/分割、受付/転送/確定のACK喪失、Operation-Id照会、同じファイル情報でも異なる内容の拒否、保存失敗時の未送信、CSRF中のlogout、別session/同時tab/期限、multipart geometry/cursor/unknown、HTTP拒否後の元intent維持と進捗再取得を含む。
- 関連workerd5file/80件成功（60.06秒、/tmp/ncf-public-upload-ui-native-final.log）。公開unlock/read/edit/upload/assetsを検証。upload actionだけを取り消す追加1件で、フォルダー作成/renameを維持しつつupload/overwrite両操作を隠すことを確認した。
- 関連browser4file/14件成功（3.2分、/tmp/ncf-public-upload-ui-browser-final.log）。新規8件でmobile新規/上書き・直接共有file・受付/確定ACK喪失後のreload・96 MiBのmultipart中断/元ファイル再選択/完了partの非再送・中止/logout・read-only・logout通知が届かない別タブの遅延応答を検証し、所有者側でも実byteを読み戻した。初回は12/13件成功で、中止ボタンが送信中に消える時点を終了と誤認した試験を、終了通知を待つ形へ修正した（/tmp/ncf-public-upload-ui-browser.log）。
- 最終確認で「記録を削除」も転送と同じWeb Lockへ接続した。別タブが送信中なら削除を拒否し、遅れた保存で記録が復活する競合を防ぐ。該当browser1件を拡張して再実行成功（1.4分、/tmp/ncf-public-upload-ui-browser-lock.log）。再build後のpublic-assets4件も成功（2.80秒、/tmp/ncf-public-upload-ui-assets-final.log）。上記との重複は合計に加算しない。
- 型、lint616file、契約/設定、Web build/Worker dry-run成功。/tmp/ncf-public-upload-ui-types-final.log、/tmp/ncf-public-upload-ui-lint.log、/tmp/ncf-public-upload-ui-contracts.log、/tmp/ncf-public-upload-ui-config.log、/tmp/ncf-public-upload-ui-build-final.log。390pxの上書き確認画面を画像でも確認し、横のはみ出しなし。
- 先行2d34118の[CI36440037128](https://github.com/daraskme/Nextcloud-flare/actions/runs/36440037128)は、Ubuntu・Windows4分割・browser・backup bindings/cliの全8job成功で終了しました。下記の先行Windows失敗の根本原因が特定されたことを意味しません。
- **全Node1,573 + 関連workerd80 + 関連browser14 = 1,667件成功**。公開削除、upload-only、ZIP/media、最大規模と実環境の検証は未完了。全workerd/全browserとbackup drillは今回ローカルで再実行していない。remote resource/secret/migration/deployなし。

## 公開リンクの単一・分割uploadと上書きAPI（前回）

公開uploadの受付・binary転送・確定・status・中止を既存のUploadDO/R2/予約/operationへ接続した。migration0064でuploadsに変更不可のlink_share_id/versionを追加し、元share/session/epochとHMACを照合する。現在のcreate/editに加えてupload actionを受付・R2実行・確定・receipt照会で検査する。編集linkは所有者予約を使用し、匿名activityのactorはnull。直接共有されたfileの親を返さず上書きできる。通常76table・147 route、依存追加なし。

- 全Node88file/1,548件成功（100.48秒、/tmp/ncf-public-upload-unit-full.log）。新規schema17件で既存private行の移行、停止条件、元session/version、変更・不正復旧の拒否を確認。capabilityの共有/credential差替え拒否と既存private入力の互換性も検証した。
- 公開uploadの新規workerd25件を確認。単一/0byte/分割、新規/直接共有file上書き、CSRF/session/key/capability、所有者quota、共有範囲・失効、upload actionだけの取消し、受付/確定直前の競合、同一key再送とD1 ACK喪失、operation照会、中止、失敗後の容量精算を含む。
- 初回workerd4file/123件は120件成功（/tmp/ncf-public-upload-native.log）。中止2件は追加した共有identity証明でD1の式深度100を超えたため、履歴証明の一度の評価と同一batch内の停止/publication別assertionへ変更。ancestor試験はdeleted_atだけを変える不正fixtureを実trash操作へ変更した。その後のcleanup関連4file/95件は93件成功（47.27秒、/tmp/ncf-public-upload-native-cleanup.log）。追加fixtureのcreateFolder引数を既存のidempotencyKeyへ修正し、失敗精算2件が成功（7.47秒、/tmp/ncf-public-upload-failed-completion.log）。製品の認可・終了証明・容量保持条件は緩めていない。
- 関連workerd13file/336件は335件成功（211.80秒、/tmp/ncf-public-upload-native-final.log）。復旧監査を凍結batchへ包む1件も式深度100に達したため、同じcredential/share/reservation条件を括弧で分けて深さを抑えた。修正後のrecovery-audit/control-recovery-audit/control-restore-freezeの3file/57件すべて成功（42.43秒、/tmp/ncf-public-upload-recovery-final.log）。不正復旧データを扱うNode23件も再確認して成功（6.72秒、/tmp/ncf-public-upload-recovery-unit-final.log）。既存単一/分割/内部共有、認可、operation、R2 write、失敗精算、multipart inventory、復旧監査と書込み凍結を含む。cleanup関連70件を合わせ、重複を除くworkerdは17file/439件成功。
- 関連browser2file/4件成功（2.1分、/tmp/ncf-public-upload-browser.log）。新規1件でAccessなしのCookieから実HTTP・ControlDO/D1/R2を通じた単一/分割upload、同一keyの受付/確定receipt、匿名operation照会、所有者側の実byte読取りを確認。既存公開create/renameの3件も成功した。公開アップロード画面の検証ではない。
- 型、lint611file、契約/設定、Web build/Worker dry-run成功。/tmp/ncf-public-upload-types-final.log、/tmp/ncf-public-upload-lint-final.log、/tmp/ncf-public-upload-contracts.log、/tmp/ncf-public-upload-config.log、/tmp/ncf-public-upload-build.log。公開upload/overwrite画面、削除、upload-only、ZIP/media、実環境検証は後続。remote resource/secret/migration/deployなし。
- 先行4cf6153の[CI36435508999](https://github.com/daraskme/Nextcloud-flare/actions/runs/36435508999)は7job成功、Windows3/4失敗で終了。multipart-bucket-control-admissionのscan-page試験がr2_binding_verification_failedとなり773/774件成功。保存ログでは根本原因は未確定。
- **全Node1,548 + 関連workerd439 + 関連browser4 = 1,991件成功**。先行Windows失敗のmultipart-bucket-control-admissionも今回ローカルでは成功したが、原因解消とは扱わない。全workerd/全browserとbackup drillは今回ローカルで再実行していない。

## 公開リンクのフォルダー作成・名前変更（前回）

public POST nodes/PATCH nodeを既存のnamespace mutation/LockDOへ接続し、公開画面へフォルダー作成・名前変更を追加した。所有者UIから閲覧/編集リンクの作成と権限切替も行える。root GETの非秘密sessionIdをShare-Sessionへ指定し、応答喪失後も元のcredential/keyへ固定する。既存GET operationsはX-Share-Id指定時に共有認証で処理し、同じcredentialと現在の元operandへの権限がある場合だけreceiptを返す。画面は結果不明時に自動再送せず、Operation-IdがあればGET、未受信なら同じ要求の明示的再送を行う。schema0063・通常76table・147 route、依存追加なし。

- 全Node87file/1,530件成功（83.75秒、/tmp/ncf-public-edit-unit.log）。
- 関連workerd5file/76件を確認。初回は75/76件成功（28.05秒、/tmp/ncf-public-edit-native.log）。新規試験で既存receiptのrevisionを期待値に含めていなかったため修正し、対象public-share-editの10件が成功（12.31秒、/tmp/ncf-public-edit-native-recheck.log）。新規10件でcreate/renameの再送・別payload拒否、現在の範囲/権限、CSRF/Origin/session/key、root改名禁止、credential別receipt非公開、Cookie差替え拒否、保存直前のshare/session/祖先/owner失効、D1 ACK喪失、DAV lockを検証。share-unlock/link-shares/public-share-read/public-assetsの66件は初回成功。
- 関連browser3file/8件成功（2.1分、/tmp/ncf-public-edit-browser.log）。新規3件で所有者の編集リンク作成、390px幅の匿名create/rename/下位folder、閲覧権限への変更と旧editor拒否、POST応答喪失後の同一key再送、Operation-Id受信時のGET照会を確認。既存公開閲覧/保存と所有者管理5件も成功。/tmp/ncf-public-edit-mobile.pngを目視確認。
- 単体file rootでは編集操作を表示しないことに合わせて画面の説明も調整し、最終アセットでpublic-edit/public-shareのbrowser5件（1.8分、/tmp/ncf-public-edit-browser-final.log）とpublic-assetsのworkerd4件（2.42秒、/tmp/ncf-public-edit-assets-final.log）を再確認した。
- lint607file、型、契約/設定、Web build、Worker dry-run成功。ログは/tmp/ncf-public-edit-lint-final.log、/tmp/ncf-public-edit-types-final.log、/tmp/ncf-public-edit-contracts.log、/tmp/ncf-public-edit-config.log、/tmp/ncf-public-edit-build-final.log、/tmp/ncf-public-edit-worker-build-final.log。
- **全Node1,530 + 関連workerd76 + 関連browser8 = 1,614件成功**。全workerd/全browser、backup drill、remote設定は今回ローカル再実行していない。公開upload/overwrite/delete、upload-only・ZIP/media、操作追跡のreload復元、実環境検証は後続。remote resource/secret/migration/deployなし。
- 先行1cee05dの[CI36430025491](https://github.com/daraskme/Nextcloud-flare/actions/runs/36430025491)はUbuntu・Windows4分割・browser・backup bindings/cliの全8job成功で終了した。Windows全Nodeを1/4へ集約後の全shard完走を確認した。

## 公開リンクの所有者管理画面（前回）

Filesの操作メニューへ公開リンク管理を追加。新規閲覧リンク、1回だけ表示するURLのコピー/公開画面への導線、期限、passwordの維持/変更/解除、確認付き再発行・停止に対応する。秘密値はcomponent内だけに保持し、storage/query cacheへ保存しない。応答不明とversion競合では更新を止め、一覧確認と現行versionの再発行を案内する。既存edit linkの設定更新はroleを維持する。公開編集・権限切替は後続で、schema0063・通常76table・147 route、依存追加なし。

同じdocument内のfragment変更でも旧clientを中止して公開画面を作り直す。秘密値をhistoryから消去し、古いpassword/root/一覧を引き継がない。失効済み共有Cookieと同じnonceのchallengeだけを新しくし、すでに別nonceへ進んだchallengeは、古い共有Cookieが残っていても保持する。新しいunlock応答が失われてもcredentialを重複作成せず、旧credentialを復活させない。

- Web Node2file/18件成功（/tmp/ncf-owner-link-web-unit.log）。型検査、lint603file、契約/設定、Web build、Worker dry-runも成功（/tmp/ncf-owner-link-types-final.log、/tmp/ncf-owner-link-lint-final.log、/tmp/ncf-owner-link-contracts-final.log、/tmp/ncf-owner-link-config-final.log、/tmp/ncf-owner-link-build-final.log、/tmp/ncf-owner-link-worker-build-final.log）。
- 関連workerd3file/62件成功（20.80秒、/tmp/ncf-owner-link-native-final.log）。新規1件で失効Cookieのchallenge更新、新challenge保持、unlock応答喪失後のcredential再利用と旧sessionの失効維持を検証。share-unlock/public-share-read/link-sharesの既存ケースも回帰確認。
- 関連browser4file/10件成功（2.1分、/tmp/ncf-owner-link-browser-verified.log）。新規3件で390px幅の所有者管理、実clipboard、秘密値のstorage非保存、期限/passwordの維持・変更・解除、再発行前後のURLと匿名再認証、同じdocument内のfragment除去、停止、閉じた後のURL非再表示、POST/PATCH応答喪失後の一覧確認、version競合を検証。既存internal shares/public-auth/public-shareも成功。/tmp/ncf-owner-link-mobile.pngを目視確認。
- 初回と再確認のbrowserはそれぞれ7/8件成功（/tmp/ncf-owner-link-browser.log、/tmp/ncf-owner-link-browser-final.log）。同じpathnameでfragmentだけを変更したときにdocumentが再読込みされず、古い公開表示が残る問題を検出し、hashchangeの処理を追加した。調査中に、設定変更後の失効challengeを再利用する経路も修正した。認証・rate上限・失効条件は緩めていない。
- **Web Node18 + 関連workerd62 + 関連browser10 = 90件成功**。全Node/全workerd/全browser、backup drill、remote Access/CORSは今回ローカル再実行していない。リモートresource・secret・migration・deployなし。

## 公開リンクの閲覧・保存画面（前回）

独立したpublic buildとSRI付き`/s/:id`、匿名root/children、public ticket/content-session/取消しを接続した。fragmentはメモリーへ取り込み直ちにhistoryから除去し、認証成功後に破棄する。初回タブはWeb Locksで直列化し、同じCookie・unlock credentialを再利用する。画面はpassword・Retry-After・folder移動・追加ページ・保存・reload・logoutを扱い、公開配信は既存のcontent hostとBudgetDOを使う。共有の現在の認可をmetadata batchと配信時に検証する。schema0063・通常76table・147 route、依存追加なし。所有者UI、公開編集/upload-only・直接content/thumb・ZIP・media、stagingは未完了。

- 全Node87file/1,530件成功（85.23秒、/tmp/ncf-public-read-unit.log）。新規2件でprivate/auth/test/server module・環境変数・危険な描画のpublic build混入を拒否する。
- 関連workerd6file/70件成功（28.71秒、/tmp/ncf-public-read-native-final.log）。新規12件で公開root/file/folder範囲、201件pagination、別credential/private cursor拒否、version/logout/祖先/owner競合、ticket再発行時の同じ予算、HEAD/Rangeの会計、取消し・logout後の配信拒否、SRI付きexact assetsと欠損/同じ長さの改変/超過を検証した。既存node-read/shared-node-read/share-unlock/content-ticketも回帰確認。
- 新規browser2件成功（1.5分、/tmp/ncf-public-read-browser-final-pass.log）。390px幅、秘密値をURL/referer/storageに残さないこと、private bundle非読込み、実ControlDOの初回60秒待機、初回2タブでsession1件、folder移動、R2実体の保存、別tabで再保存、password付きfile root、reload、logoutの別tab反映、所有者停止後の非表示を確認。既存public-auth2件も成功（/tmp/ncf-public-read-browser-verified.log）。同ログの新規1件失敗は所有者DELETEを204とした誤った期待値で、既存契約200へ直して再検証した。
- 初回workerdは68/70成功。テストのHTTP content originとDELETEのContent-Type不足を修正した。browserの準備selector不一致を直し、匿名test用ヘッダーが本番CORSに拒否されたため、test専用Cookieで匿名fixtureを指定する方式へ変更した。製品CORSは緩めていない。初回ログは/tmp/ncf-public-read-native.log、/tmp/ncf-public-read-browser.log、/tmp/ncf-public-read-browser-final.log。
- lint601file、型検査、契約/設定検査、Web build、Worker dry-run成功。/tmp/ncf-public-read-lint-final.log、/tmp/ncf-public-read-types-final.log、/tmp/ncf-public-read-contracts.log、/tmp/ncf-public-read-config.log、/tmp/ncf-public-read-build.log、/tmp/ncf-public-read-worker-build.log。スマホ画面を/tmp/ncf-public-share-mobile.pngで目視確認。
- **全Node1,530 + 関連workerd70 + 関連browser4 = 1,604件成功**。全workerd・全browser・remote Access/CORS/drillは今回ローカル再実行していない。リモートresource・secret・migration・deployは変更していない。
- 先行67be478の[CI36425378826](https://github.com/daraskme/Nextcloud-flare/actions/runs/36425378826)は7job成功、Windows4/4のみ30分上限で中断（annotation確認）。同じWindows全Nodeを各shardで繰り返し、4/4では6分44秒を使用したため、Windows全Nodeを1/4だけで実行するように整理する。全4integration shard、各shardのlint/types/contracts/config/build、Ubuntu全check、browser/backup、製品deadlineとjob上限は維持する。次のCIで完走を確認する。

## 公開リンクの匿名認証（前回）

[公開認証](PUBLIC_SHARES.md)のchallenge・秘密値/password検証・共有Cookie・public CSRF・logoutをWorkerへ接続。Access設定なしで動作し、同じchallengeの並行送信/応答喪失は同じsessionへ収束させる。期限は最長7日かつshare期限以内。D1確定時にowner・share設定・祖先・epoch・停止を再検査し、logoutは当該credentialの派生配信認証まで一括失効させる。ControlDOへ共有10/IP30回のrolling 60秒制限を追加し、eviction時の保持、初回/喪失後60秒待機、4,096keyの上限、時計逆行・停止時の拒否を実装。schema0063・通常76table・147 route、依存追加なし。公開一覧/content・landing・所有者UIは後続。

- 全Node86file/1,528件成功（83.68秒、/tmp/ncf-unlock-node-fixed.log）。新規share-tokens13件で署名用途・share/epoch/origin・期限・鍵切替・重複Cookie拒否・IPv6正規化を確認。backup修正前の全Nodeも1,528件成功（84.82秒、/tmp/ncf-unlock-node-full.log）。
- 初回workerd4file/73件は72件成功・実RPC fixtureの復旧初期状態で1件失敗（17.87秒、/tmp/ncf-unlock-native.log）。部分bootstrapを作らない空DBの監査へ修正。次の4file/102件はassertionが全成功したが、期待するControlDO停止例外がVitestへ漏れてexit1（69.94秒、/tmp/ncf-unlock-native-final.log）。拒否の確認を同じ実DO内でawaitする試験へ修正し、rate/backupの2file/28件はexit0で成功（26.00秒、/tmp/ncf-unlock-rate-backup-final.log）。製品の停止・期限条件は変更していない。
- 実browserは新規public-auth2件と既存shares3件の計5件成功（1.6分、/tmp/ncf-unlock-browser.log）。Accessなしの実HTTP、実global KDF/ControlDO/D1、初回rate待機、誤password、Secure/HttpOnly/Lax Cookie、別tabのsession再利用、CSRF/logout、unlock応答喪失後の同一credential、所有者変更による失効を検証。公開landing/UIの検証ではない。
- 型検査・lint586file・契約/設定・Web build/Worker dry-run成功。/tmp/ncf-unlock-types-browser.log、/tmp/ncf-unlock-lint-final.log、/tmp/ncf-unlock-contracts-final.log、/tmp/ncf-unlock-config-final.log、/tmp/ncf-unlock-build.log。remote secret設定・migration/deployなし。
- 最終workerdはunlock/rate・link-shares・CSRF・global KDF・control admission・backup barrierの7file/160件すべてexit0で成功（89.55秒、/tmp/ncf-unlock-native-all-final.log）。**全Node1,528 + 関連workerd160 + 関連browser5 = 1,693件成功**。全workerd・全browser・実Wrangler backup drillは今回ローカルで再実行していない。
- 先行c0ed70aのCI Ubuntu失敗（Node1,514/1,515件成功）は、不正backup SQLのparser中断後の二重closeで元エラーがEBADFに置き換わる競合だった。一時ファイルの最小再現100回中1回で確認。scripts/backup/generation.mjsを64KiBのFileHandle.readへ変更し、finallyだけでcloseする。既存の不正SQL拒否・hash/内容照合・restoreを含む修正後全Node1,528件が成功。Windows4分割・browser・backup bindings/cliは先行CIでも成功。CIでの修正確認はpush後。

## 公開リンクの所有者管理API（前回）

[公開リンク](PUBLIC_SHARES.md)の所有者CRUD・一覧を既存のprivate HTTPへ接続。期限/権限/パスワードの変更、秘密値の更新、停止に対応する。現行所有者・root/祖先・version・epoch・maintenanceを確定時にも検査し、変更とshare/content session・ticket失効を同じbatchへ入れる。32-byte秘密値は発行時だけ返す。専用鍵によるpassword保存は既存isolate/global KDFへ接続。schema0063・通常76table・147 route、依存追加なし。匿名unlock・公開bundle・両側のリンクUIは未接続。

- 全Node85file/1,515件成功（84.68秒、/tmp/ncf-link-owner-node-full.log）。新規share-secrets14件で実PBKDF2、shareへの束縛、Unicodeのbyte上限、旧kid読取り/新kid書込み、KDF停止を検証。
- 関連workerd4file/83件成功（33.61秒、/tmp/ncf-link-owner-native-final.log）。新規link-shares22件に加えてinternal-shares・shared-node-read・selected-share-writesを実行。権限喪失、祖先trash、競合、秘密情報を返さない一覧/詳細、cursor分離、HTTPのversion条件、session/ticket失効とbudget保持を確認。
- 初回workerd2file/39件は38件成功・1件失敗（10.87秒、/tmp/ncf-link-owner-native.log）。receipt照会も失敗したケースを成功と期待していた試験を修正した。503後に所有者一覧から確定済みの1件を確認し、現行versionで秘密値を更新する経路を検証。POST自動再送は追加していない。最終83件には作成/更新それぞれのACK喪失・rollback・receipt照会失敗を含む。
- 型検査・lint577file・契約/設定・Web build/Worker dry-run成功。/tmp/ncf-link-owner-types-final.log、/tmp/ncf-link-owner-lint.log、/tmp/ncf-link-owner-contracts.log、/tmp/ncf-link-owner-config.log、/tmp/ncf-link-owner-build.log。remote secret設定・migration/deployなし。
- 既存共有のbrowser13件成功（2.5分、/tmp/ncf-link-owner-browser.log）。sharesとshared-workspaceの実Access/CSRF・D1・HTTPによる管理、受信閲覧/書込み、失効、応答喪失/reload、所有者間コピーを検証。公開リンクUIの検証ではない。
- **全Node1,515 + 関連workerd83 + 関連browser13 = 1,611件成功**。全workerd・全browser・実Wrangler backup drillは今回ローカルで再実行していない。

## 管理者によるDLQ再投入（前回）

[DLQ](DEAD_LETTERS.md)の再投入APIと画面を接続。migration0063、通常76table・147 route。管理者の現行権限と元operationの認可を確定時にも検査し、同じOutboxの再配信待ち・監査・受付を一括保存する。元copyのcheckpoint・予算・容量保持を変更しない。受付応答の喪失は同一actor/credential/keyで照合する。

- 全Node84file/1,501件を実行し、1,500件成功・新規role fixtureの1件がlast_admin制約で失敗（83.44秒、/tmp/ncf-dlq-requeue-node.log）。別管理者を追加して対象12件成功。最終SQL変更後も12件成功（4.00秒、/tmp/ncf-dlq-requeue-node-final.log）。重複を除くNode1,501件成功。再投入受付・監査を含むSQL backup/importも全Node実行に含む。
- 初回workerd12file/325件は312件成功・13件失敗（230.49秒、/tmp/ncf-dlq-requeue-native.log）。複合条件をassert内へ入れるとD1の式深度100を超えたため、同じ条件をmaterialized CTEへ分けた。step欠落は事前拒否し、世代変更fixtureはセッション更新ではなく新規発行に修正。再投入36件すべて成功（22.73秒、/tmp/ncf-dlq-requeue-native-fix.log）。
- 結果不明の単一PUT/multipart partを保留したまま拒否する2件を追加。再投入38件とcontrol-restore-inventory42件の計80件成功（104.05秒、/tmp/ncf-dlq-requeue-native-final.log）。関連workerdは重複を除き13file/369件成功。既存Queue・選択共有・DAV・コピー・budgetを含む。先行Windows CIの失敗はbudgetとrestore inventoryともローカルでは再現していないが、原因解消とは扱わない。
- 型検査・lint571file・契約/設定・schema generator76table/FK索引・Web build/Worker dry-run成功。/tmp/ncf-dlq-requeue-types-final.log、/tmp/ncf-dlq-requeue-lint-final.log、/tmp/ncf-dlq-requeue-contracts-final.log、/tmp/ncf-dlq-requeue-config-final.log、/tmp/ncf-dlq-requeue-build-final.log。
- DLQのbrowser4件は成功。実Access/CSRF・ControlDO・D1・HTTPを使い、送信前の切断と受付後の応答喪失からreloadし、受付/監査1件・同じkey・通常producer/consumerでの完了を検証。390px幅の再投入受付/完了画像も目視確認済み。全browser36件成功（6.1分、/tmp/ncf-dlq-requeue-browser.log）。

- **全Node1,501 + 関連workerd369 + 全browser36 = 1,906件成功**。更新資料8fileのlocal link287件とgit diff --checkも成功。全workerd・実Wrangler backup drillは今回ローカルで再実行していない。remote migration/deployなし。

## DLQ記録と管理者一覧（前回）

[DLQ](DEAD_LETTERS.md)の観測保存・管理者限定API・画面を追加。migration0062で通常76table、147 route。元outbox/jobを変更しない。再投入・保持期限管理・外部通知・実Queue試験は残る。

- 全Node83file/1,489件成功（79.50秒、/tmp/ncf-dlq-node-full.log）。新schemaの移行条件・不変性・freeze・索引と、DLQ行を含むSQL backup/importを確認。
- 型検査・lint565file・契約/設定・schema generator76table/FK索引・Web build/Worker dry-run成功。/tmp/ncf-dlq-types.log、/tmp/ncf-dlq-lint.log、/tmp/ncf-dlq-contracts.log、/tmp/ncf-dlq-config.log、/tmp/ncf-dlq-build.log。
- workerd7file/188件の初回は187件成功・1件失敗（118.08秒、/tmp/ncf-dlq-native.log）。既存Queue fixtureの省略されていたqueue名を設定に合わせ、同時重複配信を追加。対象2file/61件が成功（14.67秒、/tmp/ncf-dlq-native-final.log）。重複を除く関連workerdは189件成功。
- 全browser34件成功（6.0分、/tmp/ncf-dlq-browser-full.log）。新管理者画面では実ControlDO/D1/HTTPで52観測の記録・50件ページ送り、mobile幅、非管理者拒否、再取得失敗後の古い情報非表示を確認。mobile screenshotも目視確認済み。
- **全Node1,489 + 関連workerd189 + 全browser34 = 1,712件成功**。最終型・lint565file成功（/tmp/ncf-dlq-types-final.log、/tmp/ncf-dlq-lint-final.log）。資料8fileのlocal link285件、git diff --checkも成功。全workerd・実Wrangler backup drillは今回ローカルで再実行していない。remote migration/deployなし。

更新: 2026-09-28。設計 v0.6 + IMPLEMENTATION_BRIEF §8 を実装契約とする。
セッションの再開手順は [`HANDOFF.md`](HANDOFF.md)。本書を実装状況・テスト件数の正本とする。

先行19622b8の[CI36415056432](https://github.com/daraskme/Nextcloud-flare/actions/runs/36415056432)は、Ubuntu・Windows1/4と2/4・browser・backup bindings/cliの6job成功、Windows3/4と4/4失敗で終了しました。3/4はbudget.test.tsの準備中にR2 grantのD1 triggerがr2_write_unavailableで拒否し、729/730件成功。4/4はcontrol-restore-inventoryのsame_round試験でdatabase_restore_inventory_unconfirmedとなり、839/840件成功。保存ログでは詳細原因を特定できず、解決済みとは扱いません。今回の再投入変更のCIはpush後に確認します。

先行f2e4788の[CI36411992220](https://github.com/daraskme/Nextcloud-flare/actions/runs/36411992220)は、Ubuntu・Windows4分割・browser・backup bindings/cliの全8jobが成功して終了しました。

先行45a72d2の[CI36405509625](https://github.com/daraskme/Nextcloud-flare/actions/runs/36405509625)は、Ubuntu・Windows分割2/4と3/4・browser・backup bindings/cliの6job成功、Windows1/4失敗、4/4はcancelledで終了しました。Windows1/4はNode1,464/1,466件成功で、backup-operatorとdatabase-restoreのbeforeEachが60秒でタイムアウトしました。準備処理のボトルネックは未確定です。先行810ea19の[CI36402990343](https://github.com/daraskme/Nextcloud-flare/actions/runs/36402990343)はWindows4分割を含む7job成功、browserのみ27/28件成功で終了しました。上書き応答喪失試験の待機順序は45a72d2で修正し、同コミットのbrowser CI成功を確認済みです。

先行0b85355の[CI36400478502](https://github.com/daraskme/Nextcloud-flare/actions/runs/36400478502)は終了しました。Ubuntu・Windows分割1/4〜3/4・browser・backup bindings/cliの7job成功、Windows4/4はcopy-executorの2件で書込み許可取得に失敗しました（workerd813/815件成功）。以前の固定件数assertionとは異なります。残り3秒で次転送へ進む経路をローカルで再現し、6秒の事前余裕を追加しましたが、CIの元例外が隠れていたため、2件の根本原因を確定したとは扱いません。内部causeを保持して次回CIで確認します。

先行8dd74ecの[CI36394122457](https://github.com/daraskme/Nextcloud-flare/actions/runs/36394122457)は終了し、Ubuntu・Windows4分割・browser・backup bindings/cliの全8jobが成功しました。UbuntuのNode1,436件と全workerd137file/3,093件の成功もログで確認済みです。直前81e9f01の[CI36396573483](https://github.com/daraskme/Nextcloud-flare/actions/runs/36396573483)は終了し、Ubuntu・Windows分割1/4と3/4・browser・backup bindings/cliが成功しました。Windows2/4はQueue再開1件（796/797件成功）、4/4はexecutor3件（811/814件成功）が失敗しました。25秒で正常にyieldしても固定件数を要求していたため、0b85355で時間による中断後の再開と重複PUT防止を検証する形へ修正し、D1/R2予算境界は少量の実転送で独立に再現しています。製品の期限・上限は維持しています。今回の変更のCIはpush後に確認します。

CI分割変更ae79ecaの[CI36387497530](https://github.com/daraskme/Nextcloud-flare/actions/runs/36387497530)は終了しました。Ubuntu・Windows分割2/4・4/4・browser・backupのbindings/cliは成功、Windows分割1/4は30分のjob上限でcancelled（annotation確認）、3/4はcopy-executionのepoch変更試験の準備中にfixture_copy_failedで失敗しました（Node1,431件成功、integration717/718件成功）。SQLエラーと受付outcomeの診断はef5ee58へ追加済みですが、原因解消とは扱いません。コピー実行処理b7a32abの[CI36387145263](https://github.com/daraskme/Nextcloud-flare/actions/runs/36387145263)はUbuntu・Windows3分割・browser・backupの全6job成功です。ef5ee58の[CI36389252207](https://github.com/daraskme/Nextcloud-flare/actions/runs/36389252207)は終了し、Windows4分割・browser・backupのbindings/cliが成功しました。Ubuntuは全Node1,431件成功、integration3,046/3,047件成功で、control-restore-domainのfixtureがdispatch_before<=started_at+5000制約に違反しました。開始と期限でDate.now()を別々に取得していたため、8dd74ecで同じ開始値へ統一しました。製品の期限・assertionは維持しています。fdc7abaの[CI36390929822](https://github.com/daraskme/Nextcloud-flare/actions/runs/36390929822)は終了し、Windows4分割・browser・backupのbindings/cli成功、Ubuntu失敗です。UbuntuはNode1,431件成功、integration3,066/3,067件成功で、control-restore-gcの同じ時刻fixture問題でした。8dd74ecでこちらも同じ開始値へ統一しました。

先行5787368の[CI36385410210](https://github.com/daraskme/Nextcloud-flare/actions/runs/36385410210)はUbuntu・Windows分割2/3・3/3・browser・backup成功、Windows分割1/3は30分のjob上限でcancelledです（GitHub annotationで確認）。上記4分割化後のCIで完走を確認します。

先行de13fc6の[CI36384106965](https://github.com/daraskme/Nextcloud-flare/actions/runs/36384106965)はUbuntu・Windows分割1/3・3/3・browser成功、Windows分割2/3とbackupは30分のjob上限でcancelledとなりました（GitHub annotationで確認）。backup:run-drillは上限直前に全assertion成功とSQL 9,233bytesのPASSを出していますが、jobの正常終了は確認できません。Windows分割2/3も打切り直前まで試験が進行しており、上記のCI実行単位へ分割します。以前のbackup_wrangler_failedや検索個別timeoutの原因が解決したことは意味しません。

先行2f9b8bdの[CI36381492636](https://github.com/daraskme/Nextcloud-flare/actions/runs/36381492636)はbrowser・Windows分割1/2が成功、Ubuntu・Windows分割3は復旧snapshot試験の旧table数74という期待値で失敗しました。通常75tableとexport対象名の完全一致へ今回修正し、対象46件は成功しています。backupは通常drill・operator drill成功後、run-drill中に30分のjob上限で打ち切られました（GitHub annotationで確認）。保存ログだけでは遅延箇所を確定できず、調査を継続します。

送信先は承認済みGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。先行b1fedc7の[CI36377836985](https://github.com/daraskme/Nextcloud-flare/actions/runs/36377836985)はUbuntu・Windows2分割・browser・backupが成功、Windows分割1はsearch.test.tsの1万件検索が90秒timeoutで失敗しました（965/966件成功）。検索試験の遅延原因は未解決で、上限や検査を緩めていません。先行0604da2の[CI36374767844](https://github.com/daraskme/Nextcloud-flare/actions/runs/36374767844)はUbuntu・Windows3分割・browser・backupの全6job成功です。先行af30646の[CI36367826306](https://github.com/daraskme/Nextcloud-flare/actions/runs/36367826306)は全6job成功です。先行7e933b1の[CI36369537337](https://github.com/daraskme/Nextcloud-flare/actions/runs/36369537337)は全6job成功です。先行a52b815の[CI36371093589](https://github.com/daraskme/Nextcloud-flare/actions/runs/36371093589)はUbuntu・Windows3分割・browser成功、backup:run-drillのsource fingerprints中にbackup_wrangler_failedで失敗。保存ログだけでは子プロセスの原因を特定できません。先行33a8a80の[CI36365491865](https://github.com/daraskme/Nextcloud-flare/actions/runs/36365491865)はUbuntu・Windows3分割・browser・backupの全6job成功。先行f953d43の[CI36361608147](https://github.com/daraskme/Nextcloud-flare/actions/runs/36361608147)はUbuntu・Windows3分割・browser・backupの全6job成功。先行a9af702の[CI36359614104](https://github.com/daraskme/Nextcloud-flare/actions/runs/36359614104)も失敗job再実行後に全6job成功。初回Windowsのorphan-admission受付回数不一致と、21cd396の[CI36354864354](https://github.com/daraskme/Nextcloud-flare/actions/runs/36354864354)でのR2保存先照合失敗の原因は未確定です。productionの期限や検査は緩めていません。今回のpush/CIはgit statusとgh run listで確認します。

先行3f2217bの[CI36327086181](https://github.com/daraskme/Nextcloud-flare/actions/runs/36327086181)はUbuntu・Windows2分割・backup・browserの全5job成功。0dbb5a5の[CI36326186367](https://github.com/daraskme/Nextcloud-flare/actions/runs/36326186367)は4job成功・Windows分割1のNode 1,000/1,001件成功・1件失敗で終了し、そのintegrationは未実行。失敗fixtureは3f2217bで修正済み。先行8a093f7の[CI36325641559](https://github.com/daraskme/Nextcloud-flare/actions/runs/36325641559)は全5job成功。今回の全体check/CIとは分けて扱う。

先行fa8f105の[CI36323261376](https://github.com/daraskme/Nextcloud-flare/actions/runs/36323261376)はUbuntu・Windows2分割・backup・browserの全5jobが成功しました。

先行`3ffbba0`の[CI36320613487](https://github.com/daraskme/Nextcloud-flare/actions/runs/36320613487)はUbuntu・Windows2分割・backup・browserの全5jobが成功。先行`43597a6`の[CI36317210449](https://github.com/daraskme/Nextcloud-flare/actions/runs/36317210449)ではUbuntuが15分枠で打ち切られたため、3ffbba0でjob枠を30分に変更した。productionと個別テストの期限は変更していない。

## 今回の検証記録

- 停止済みコピーの明示的retryを既存REST routeと画面へ接続。migration0061、通常75table・147 route。元のactor/credential/両側share選択/operandを維持し、現在の内容から新jobを受付。operationsの一意索引と確定triggerで元jobの全精算と後継1件を検査し、manifest読戻し・operation照会・復旧監査でも証拠を再確認する。
- タブへretry keyを送信前に保存し、後継記録と未確認印の解除を単一保存にした。GETのretryJobIdからreload後に同じ後継を発見する。旧jobの予算・保持・native記録は変更せず、未精算時の自動retryを行わない。
- 対象Node3file/22件成功（1.36秒、/tmp/ncf-copy-retry-focused-unit.log）、コピーHTTP38件成功（32.07秒、/tmp/ncf-copy-retry-http.log）。その後、予算停止からのretry chainとquota回復後の新keyを2件追加し、HTTP・受付・精算・復旧監査のworkerd4file/111件が全成功（85.75秒、/tmp/ncf-copy-retry-native-final.log）。
- 再試行browser1件成功（36.3秒、/tmp/ncf-copy-retry-browser.log）。edit共有へのcopy、cancel応答喪失、精算待ち、retry受付の応答喪失とGET障害、reload後の後継追跡、追加POSTなし、実consumerでの公開、共有保存先表示を確認。コピー2件の画面画像を確認済み。

- 全Node82file/1,483件成功（78.60秒、/tmp/ncf-copy-retry-node-full.log）。schema generatorは75table・FK index・operation catalogueの検査に成功し、生成contractに差分なし（/tmp/ncf-copy-retry-schema.log）。

- 全browser32件成功（5.8分、/tmp/ncf-copy-retry-browser-full.log）。その後、追跡情報の保存失敗から設定復旧後の再保存ケースを追加し、修正前は進捗GETに成功しても後継が表示されず失敗した（/tmp/ncf-copy-retry-storage-baseline.log）。同じretryJobIdでもGETの成功時刻を使って再保存し、保存復旧後の「進捗を更新」で回復するよう修正した。

- 修正後の同じbrowserケース1件は成功（36.8秒、/tmp/ncf-copy-retry-browser-release.log）。保存設定の復旧→同じGET結果→後継保存→実公開まで追加POSTなしで確認し、再撮影も確認済み。重複を除いて**全Node1,483 + 関連workerd111 + browser32 = 1,626件成功**。
- 最終型・lint557file・契約/設定・Web build/Worker dry-run成功。ログは/tmp/ncf-copy-retry-types-release.log、/tmp/ncf-copy-retry-lint-release.log、/tmp/ncf-copy-retry-contracts.log、/tmp/ncf-copy-retry-config.log、/tmp/ncf-copy-retry-build-release.log。更新資料9fileのlocal link281件とgit diff --check成功。全workerd・実Wrangler backupドリルは今回ローカルでは再実行していない。remote migration/deployなし。

### 先行するコピー画面の接続

- コピー元の共有選択と保存先を分離し、My Drive/受信edit共有フォルダーを選択可能にした。read共有・直接file共有・共有rootのcopyを接続。同一spaceの同期COWは既存経路を使う。REST schema0060/75table/147 route、依存は変更なし。
- 202 receiptからjob IDとaccount/epoch/保存先をタブのsessionStorageへ保存してからpending操作を消す。保存失敗でも同じkeyの操作確認を残し、復旧成功時は古いエラーを消す。ジョブ照会/取消は固定IDだけで行い、現在の認可エラー時に古い公開先/取消を隠す。別jobの自動作成はしない。最大100件保存、5件ずつ表示・照会。logoutで全タブの追跡情報を消す。
- 実ブラウザの新規3件の初回は2件成功、1件はfixtureの作成receiptに含まれないnameをPlaywrightへ渡したため失敗（52.3秒、/tmp/ncf-copy-ui-browser-new.log）。既知の作成名へ修正。成功した試験では受付応答喪失・保存失敗・同じkey/jobの再確認、部分転送、reload、全件公開、実bytes、read共有/共有root、共有失効後の照会拒否と新規enqueueなしを検証。
- 全Node81file/1,475件成功（82.91秒、/tmp/ncf-copy-ui-node-full.log）。コピーHTTPのworkerd27件成功（31.39秒、/tmp/ncf-copy-ui-native-http.log）。全browser初回は29/31件成功（5.9分、/tmp/ncf-copy-ui-browser-full.log）。追加したcopyボタンが既存閲覧テスト2件の曖昧な名前selectorに一致したため、開く・保存の操作を明示した。ログイン変更ケースを追加し、共有画面の10件を再実行して全成功（2.2分、/tmp/ncf-copy-ui-browser-shared.log）。他のFiles19件とShares3件は初回全体実行で成功済み。重複を除いたbrowser32件と合わせて**1,534件成功**。

- 実行中のmobile390pxと保存先選択のdesktop画像を確認。回復成功後の古いエラーと共有rootボタンの余白を修正し、再撮影で確認した。保存先一覧の読込みを待ってread共有が選択肢に含まれないことも検証。取消応答喪失後は同じjobの停止状態を照会し、容量保持の精算を待つ。テスト用手動consumerはbrowser専用entryに限定し、実ControlDO/D1/R2/Queue consumerを通す。
- 最終の型・lint554file・契約/設定検査、Web build/Worker dry-run成功。ログは/tmp/ncf-copy-ui-types-release.log、/tmp/ncf-copy-ui-lint-release.log、/tmp/ncf-copy-ui-contracts-release.log、/tmp/ncf-copy-ui-config-release.log、/tmp/ncf-copy-ui-build-release.log。資料8fileのlocal link275件とgit diff --checkも成功。全workerd・実Wrangler backupドリルは今回ローカルでは再実行していない。remote migration/deployなし。

### 先行するコピーの期限前中断と診断

- copy-executorは次の段階を始める前と段階照会後に6秒の余裕を確認する。5秒の書込み許可窓とcheckpoint/lease解放のためで、25秒の実行期限、200 invocation、20,000 R2 call、900 D1 callは維持する。入口ですでに時間不足ならclaimを消費しない。全blob保存後の最終公開は既存どおり同じclaimで試みる。
- 遅いcheckpoint ACKにより残り3秒になる試験を実時計/D1で実行したところ、修正前は次のblobまで転送してcompletedとなった（期待yieldedに失敗、/tmp/ncf-copy-wall-baseline.log）。修正後は次blobのtransfer_attemptが空のpendingのまま中断し、次回の1回のPUTで完了する。CIの2件のgrant取得失敗と同一原因かは未確定。元エラーを消していた共通R2処理にError.causeを追加し、grant/native/settlementの診断と公開エラー維持を検証した。最初の単体fixtureではmanifest keyのUUIDが不足して2/3件失敗したため、有効UUIDへ修正した。
- 810ea19のブラウザCIは上書き応答喪失試験1件が失敗（27/28成功）。traceではlocatorの5秒待機終了約0.4秒前にcomplete要求が始まり、失敗時も画面は確定中だった。サーバー確定とroute.abortによる応答喪失を待ってから、既存5秒のUI assertionを開始する。製品・locator・全体testのtimeoutは変えない。
- 全Node80file/1,466件成功（87.87秒、/tmp/ncf-copy-wall-unit-full.log）。関連workerd6file/151件成功（254.15秒、/tmp/ncf-copy-wall-native.log）：copy-executor/queue/put/multipart、control-r2-writes、upload-r2-writes。後から追加した短い呼出し元期限の入口試験1件も成功（5.32秒、/tmp/ncf-copy-wall-entry.log）。workerdは重複なしで152件、Nodeと合わせて1,618件成功。全browser28件成功（5.3分、/tmp/ncf-copy-wall-browser.log）。**全Node1,466 + 関連workerd152 + browser28 = 1,646件成功**。

- 最終型・lint550file・契約/設定・Web build/Worker dry-run成功。ログは/tmp/ncf-copy-wall-types-final.log、/tmp/ncf-copy-wall-lint-final.log、/tmp/ncf-copy-wall-contracts.log、/tmp/ncf-copy-wall-config.log、/tmp/ncf-copy-wall-build.log。更新資料6fileのlocal link264件とgit diff --checkも成功。schema0060/75table/147 route・依存は変更なし。全workerd・実Wrangler backupドリルは今回ローカルでは再実行していない。remote migration/deployなし。

### 先行する所有者間コピーHTTP接続

- 所有者間コピーのREST受付・read/cancelを既存147 routeへ接続。POST copyのdestinationで両側のshare選択を区別し、別spaceはcopy.enqueueの202/Location/Operation-Id、同一spaceは同期COWを返す。8 KiBのJSON、Access/CSRF、idempotency intent、元actor/credential、現在の両側権限を維持する。schema0060・75table・依存は変更しない。
- GET jobは固定manifest/checkpointからcompletedBlobs/completedBytes/totalBytesを返す。停止後の精算待ちと保持容量、公開先IDを区別する。公開済みoverwriteの旧targetをliveとして要求せず、成功receiptと公開nodeの現行認可を検査する。認可snapshotとstatusの同時検査で公開競合を拒否し、取消より公開が先なら409を返す。取消の再送やACK喪失でも未証明の保持は返さない。
- 新規workerdの初回は20/25件成功（23.00秒、/tmp/ncf-copy-http-native-initial.log）。COWの検索行、overwriteの物理観測がfixtureに不足し、共有選択へ更新結果の余分なfieldを渡し、別keyを設定するfixtureが大小文字違いのIdempotency-Keyを重複させていた。検索/観測を準備し、id/versionだけを渡し、Headers.setで上書きするよう修正。2回目26/27件（19.17秒）の残り1件も重複headerの修正で解消した。製品の制約は緩めていない。
- 最終の新規workerd27件成功（18.56秒、/tmp/ncf-copy-http-native-complete.log）。受付→Outbox/Queue→公開、同期COW、両側の共有選択/失効、別actor/credential、CSRF/不正JSON/8 KiB制限、取消再送と精算待ち、受付/取消ACK喪失、503 Operation-Idと再照会、multipart進捗、overwrite後照会、公開競合、公開先の共有範囲外移動、未知native保持、実Access JWT/CSRF入口を検証。
- 全Node79file/1,463件成功（78.63秒、/tmp/ncf-copy-http-node-full.log）。既存workerd9file/237件成功（188.49秒、/tmp/ncf-copy-http-native-regression.log）：copy-lifecycle/jobs/queue/publication、rename-node/fs-mutation/selected-share-writes/content-ticket/multipart-httpを検証。新規27件を合わせてworkerd10file/264件、**全Node1,463 + 関連workerd264 = 1,727件成功**。
- 最終型・lint549file・契約/設定・Web build/Worker dry-run成功。/tmp/ncf-copy-http-types-verified.log、/tmp/ncf-copy-http-lint-final.log、/tmp/ncf-copy-http-contracts.log、/tmp/ncf-copy-http-config.log、/tmp/ncf-copy-http-build.log。更新資料のlocal link197件とgit diff --checkも成功。全workerd/browser/実Wranglerドリルは今回ローカルでは再実行していない。UIの宛先選択/ジョブ表示、retry/DLQ、未知nativeの修復、最大規模/実環境検証は未完了。remote migration/deployなし。

### 先行する残り予算の下限判定

- [コピーの残り予算](COPY_JOBS.md)を下限で判定するSQLを追加。BRIEF §8の200 invocation / 20,000 R2 callを維持し、未着手blobは最大90 MiB part、既存multipartは固定geometryで計算する。未prepare partにはGET/書込み、未着手/未completeには必須の段階を数えるが、prepare済みnativeの遅延観測を新規call必須とは扱わない。
- 残りR2、残りinvocation×112 call、残りinvocation×64段階のいずれにも入らないjobを追加転送前に停止する。生きたleaseは停止しない。migration0060の停止triggerとexecutor/Cronが同じ述語を使い、競合を確定batchで再検査する。全storedのjobは20,000 callでも残りinvocationでDB-onlyのcheckpoint/公開を続行できる。75table、既存row/column、保持/終了証明、25秒/10回の無進捗制限は維持する。
- 最初のschema generatorで0060 triggerの閉じ括弧過剰を検出し修正。修正後は75table・FK index・operation catalogueの生成検査成功、schemaContract.tsに差分なし。新規Node17件と既存maintenance schema5件の22件が成功（1.75秒、/tmp/ncf-copy-remaining-node-initial.log）。同じSQLによる10,000小blob/5,000 multipart/500 GiB単一fileの必要回数境界、既存geometry、遅延可能なprepare、live lease、exact limitとmigration保全を検証する。これらの算術試験を最大規模の実転送の証明にはしない。
- 新規workerd10件成功（15.65秒、/tmp/ncf-copy-remaining-worker-initial.log）。単一/分割の早期停止、残4 callの正確な完了、既知part geometryによる停止後の実abort/精算、最後のinvocationに収まらない57fileの非転送/段階的Queue ACK、最終PUT/遅延観測/失ったcheckpointからのDB-only公開、live claim競合と未証明stopの拒否を検証した。
- 最初の全Node79file/1,461件成功（80.99秒、/tmp/ncf-copy-remaining-node-full.log）。関連workerd8file/221件も成功（326.40秒、/tmp/ncf-copy-remaining-worker-regression.log）。copy-budget/executor/execution/maintenance/lifecycle/queue/publication/multipartを実行し、既存の失効・応答喪失・native未知・一括公開・回収と新しい予算境界を確認した。想定されたstream cancellation診断は出たが、全assertionと終了codeは成功。
- 直前81e9f01のWindows CIでは、Queueが56個でなく50個、executorの56/57個試験が43/34個、大きなmanifestが51個以上でなく40個で25秒の正常yieldとなった。固定件数を必須としていた4件を修正。56/57個は最大4 invocationでcheckpoint・900 D1 call/4,200 SQL文・全件完了・PUT重複なし・精算を要求する。Queueと最終公開のnative上限はclaim確定直後のcounter fixtureと少量の実GET/PUTで再現し、25秒を延ばさない。/tmp/ncf-copy-remaining-prior-win2.log、/tmp/ncf-copy-remaining-prior-win4.log。
- D1予算を付けたbindingは同じscopeを再利用し、消費を戻さず、上限は縮小だけ許可する。executorは有効上限から60回を確保し、入口で余裕がなければclaimを消費しない。既定900/840は維持。大きいmanifestの試験は128回の共有scopeでD1 yieldを独立に検証し、通常scopeで全57個を再開・完了する。重ねたscopeの上限/消費維持2件と、claim前yield1件を追加した。
- 最終の全Node79file/1,463件成功（80.78秒、/tmp/ncf-copy-remaining-final-node.log）。executor/budget/Queueのworkerd3file/57件成功（137.10秒、/tmp/ncf-copy-remaining-final-native.log）。先の関連8fileと重複を除きworkerd222件、**全Node1,463 + 関連workerd222 = 1,685件成功**。
- 型・lint545file・契約/設定検査成功。/tmp/ncf-copy-remaining-final-types.log、/tmp/ncf-copy-remaining-final-lint.log、/tmp/ncf-copy-remaining-final-contracts.log、/tmp/ncf-copy-remaining-final-config.log。最終Web build/Worker dry-runも成功（/tmp/ncf-copy-remaining-final-build.log）。更新資料のlocal link197件とgit diff --checkも成功。全workerd/browser/実Wranglerドリルは今回ローカルでは再実行していない。remote migration/deployなし。次はHTTP/API・画面接続を進め、上限内の最大規模・実環境と未知nativeの運用収束も継続する。

### 先行するD1実測とコピー処理量の改善

- コピーexecutorのD1 binding呼出しをdispatch前に計測し、次の転送に入る前のyieldと900回のhard上限を追加。失敗/ACK喪失分を戻さず、準備済みstatementだけをbatchへ通す。共通R2 invocation上限を112回へ揃え、最大64転送段階とし、最後のcheckpoint後は段階/native上限でも同じclaimで公開する。schema0059・通常75table・依存は維持。
- 初回executor24件成功（44.27秒、/tmp/ncf-copy-throughput-executor.log）。57個の3-byte blobを1回目56個・2回目1個で実保存/公開し、900 D1 binding call・4,200 SQL文以内、各destinationのPUTが1回だけ、正確なquota/physical精算を確認。8個の従来回帰予算も維持する。
- 全Node77file/1,444件成功（79.90秒、/tmp/ncf-copy-throughput-node.log）。新規8件はD1のbind/first/all/run/raw/batch計測、上限での送信拒否、応答喪失の消費維持、未計測API/statement拒否と無効上限を検証。
- 最初の7file回帰は192成功・1失敗（303.79秒、/tmp/ncf-copy-throughput-worker.log）。約6 MiBのmanifestでも56個まで進み、D1境界の試験がR2境界と重なっていた。D1の余裕を50→60回（yield閾値850→840）へ広げ、通常56個と大きいmanifestでの早期yieldの両方を検証した。
- 最終executor26件とQueue20件の46件が成功（122.16秒、/tmp/ncf-copy-throughput-final.log）。56個目でR2枠を使い切った同じclaimで公開するケース、約6 MiB manifestのD1による早期yield/解放/再開/精算、通常57個の2 invocation完走、Queue再配信を確認。先の成功済みcopy-put・copy-execution・copy-multipart・copy-reconcile・copy-publicationの5file/148件と合わせ、重複を除くworkerd194件が成功。**全Node1,444 + 関連workerd194 = 1,638件成功**。
- D1 dispatch前のhard上限、native grant直前にR2上限が埋まった場合のPUT拒否、最後の転送がmaxSteps/global R2上限に一致する場合の公開、各既存の失効/応答喪失/native未知の保持を維持する。25秒/200 invocation/20,000 R2 callは変更しない。
- 型・lint540file・契約/設定検査成功。/tmp/ncf-copy-throughput-types-complete.log、/tmp/ncf-copy-throughput-lint-complete.log、/tmp/ncf-copy-throughput-contracts.log、/tmp/ncf-copy-throughput-config.log。Web build/Worker dry-runも成功（/tmp/ncf-copy-throughput-build.log）。全workerd/browser/実Wranglerドリルは今回ローカルでは再実行せず、push後CIで確認する。remote migration/deployなし。最大規模・多数multipartの完走、HTTP/UIと未解決nativeの運用収束は未完了。

### 先行する停止後のコピー自動回収

- [停止後のコピー自動回収](COPY_JOBS.md)を専用2分Cronへ接続。migration0059でbulk_jobsへ7columnを追加し、通常75tableを維持。1回1job・25秒・8修復候補/8精算・8 R2 call、保存token/epoch/lease、60秒の待ち時間、外部処理前のcursor保存と終端wrap、累積call保持を実装。元jobの転送checkpoint・実行予算・native終了証明は維持する。
- Queue配信がない停止job、旧epoch・期限/予算超過を拾い、既知multipartの実中止とnative成功後の観測修復を既存の証明済み精算/35日GCへ渡す。HEAD/abortの直接ACK喪失は消費済みのまま再送しない。DB-onlyのclaim/cursor/精算/解放はexact receiptで照合する。未知native・記録のないprepare・part/handle観測不足・中止attempt再試行、最大コピーの完走とHTTP/UI・DLQ運用は未完了。
- 初回の新規workerd19件成功（21.59秒、/tmp/ncf-copy-maintenance-worker-initial.log）、schema関連Node3file/84件成功（23.29秒、/tmp/ncf-copy-maintenance-node-initial.log）。Node URLの型importを既存fixtureと同じnode:urlへ修正した。
- 全Node76file/1,435件成功（79.86秒、/tmp/ncf-copy-maintenance-node-full.log）。0059の旧全column/行・既存R2記録保持、FK、移行前提と、現行75tableのbackup/export/import/freezeを確認した。schema契約生成も75table/索引/operation catalogueで成功。
- 関連workerd10file/285件成功（382.07秒、/tmp/ncf-copy-maintenance-worker-regression.log）。停止処理でもclaim内の検証済みmanifestを再利用し、Cron入口の時間を含む期限を追加検証。修正後の回収/停止/復旧GCの3file/79件成功（90.01秒、/tmp/ncf-copy-maintenance-worker-final.log）。入口期限fixtureは1ms差への依存をなくし、対象1件成功（3.80秒、/tmp/ncf-copy-maintenance-entry-deadline.log）。新規回収26件を含む関連workerdは重複を除き11file/304件、後続の索引1件も含めNodeは1,436件、合計 **1,740件成功**。
- ef5ee58のUbuntu CIはcontrol-restore-domain、fdc7abaのUbuntu CIはcontrol-restore-gcのfixtureで、開始時刻/期限の別々のDate.now()取得によりdispatch_before<=started_at+5000を破った。同じ開始値から正確に5秒後を作るよう両fileの該当fixtureを修正し、26件+18件を上記回帰で確認。製品の上限やassertionは変更しない。/tmp/ncf-copy-maintenance-prior-ubuntu.log、/tmp/ncf-copy-maintenance-queue-ubuntu.log。
- 最後に実SQL計画を確認し、従来kind索引と一時ソートが選ばれていたため、専用索引の先頭へkindを追加し、候補SQLの状態集合を明示した。最終schema5件成功（1.77秒、/tmp/ncf-copy-maintenance-index-final.log）で専用索引の範囲検索・一時ソートなしを確認し、回収26件も成功（29.66秒、/tmp/ncf-copy-maintenance-complete.log）。初回の索引assertion失敗はこの変更で解消し、全体テストへ重複加算しない。
- 型・lint538file・契約/設定・git diff --check成功。/tmp/ncf-copy-maintenance-types-complete2.log。Web build/Worker dry-run成功（/tmp/ncf-copy-maintenance-build-final.log）。更新資料のlocal link196件も確認。browser・全workerd・実Wrangler運用ドリルは今回ローカルで再実行せず、push後CIで確認する。remote migration/deployなし。

### 先行するコピーQueue接続

- [コピーQueue consumer](COPY_JOBS.md)を接続。保存済みmanifest/checkpointから転送・再開し、公開receiptでACKする。停止済みは32blobの証拠付き精算と全保持0を確認するまでretryする。通常eventのfailed判定からcopyを分離し、失敗OutboxだけでACKしない。未知attemptを飛ばして後続の精算を進める。停止・精算へbatch共通25秒期限を伝播する。
- 1 invocationでcopyを単独実行し、通常eventや別copyとD1/R2予算を重ねない。Queue本文でなくD1の不変kindから判定する。後続はretryし、稼働jobは従来のsent Outbox再送も利用する。停止後のabort/観測修復・巡回、未配信停止job、DLQ運用、最大規模の完走とHTTP/UIは後続。schema0058・75table、依存を維持。
- 初回workerd7file/182件成功（121.94秒、/tmp/ncf-copy-queue-worker.log）。batch予算分離を追加し、最終Queue/既存Outbox経路5file/126件成功（65.04秒、/tmp/ncf-copy-queue-worker-final.log）。新規copy-queue20件は単一/分割/空bytes、yield→Outbox再送、同時claim、取消し/予算停止、multipart保留、先頭未知+後続33blobの32+1件精算、ACK喪失、失効、binding不足、期限入力、batch予算分離、取消し直後の実保存を検証。
- 全Node75file/1,431件成功（72.24秒、/tmp/ncf-copy-queue-node.log）。関連workerdは重複を除き7file/184件で、今回の合計は **1,615件成功**。型・lint534file・契約/設定検査とgit diff --check成功。/tmp/ncf-copy-queue-types-final.log。Web build/Worker dry-run成功（/tmp/ncf-copy-queue-build.log）、更新資料のlocal link194件も確認。HTTP/UI/schema変更はなく、browser・全workerd・実Wrangler運用ドリルは今回ローカルで再実行していない。新headのCIで確認する。remote migration/deployなし。

### 先行するコピーのD1呼出し削減

- コピーの認可照会を同じprimary batchへ集約し、各operandの入力snapshotと既存の権限assertionを維持する。単一PUT・multipart作成/completeの観測は直接ACKまたはDB-only receiptで確定できた場合だけ重複を省き、失敗時は再試行する。進捗と残予算も一つのSELECTで取得する。schema0058・75table・実行25秒/16call・200 invocation/20,000 R2 callは変更しない。
- 実R2で8blobを保存してyieldする同一fixtureを計測。Worker側D1 binding呼出しは222→132回、SQL文は705→600本となった。ControlDO/LockDO内部のSQLは別invocationのためこの値に含めない。これはローカル処理量の計測であり、remote遅延や最大10,000blob/500GiBの完走証明ではない。/tmp/ncf-copy-budget-baseline.log、/tmp/ncf-copy-budget-worker-initial.log。
- 初回の認可・単一/分割保存・executor4file/109件成功（82.43秒）。最終は全Node75file/1,431件成功（74.95秒）、関連workerd11file/294件成功（287.35秒）で、合計 **1,725件成功**。8blobのDB往復上限、4種のcredential、混在principal、入力snapshot、現在権限とrevision再検査、観測rollback後の再試行、共有/DAV・公開/停止・content ticketを確認した。想定したstream取消し診断は出るが全assertionと終了codeは成功。/tmp/ncf-copy-budget-node-full.log、/tmp/ncf-copy-budget-worker-final.log。
- Windows CIのfixture_copy_failed診断追加後、copy-execution40件も成功（34.90秒、重複分は上記合計へ加算しない）。失敗したbatchのSQLエラーと受付outcomeを残し、fixtureの自動再試行やproductionの期限緩和は追加しない。/tmp/ncf-copy-budget-ci-win3.log、/tmp/ncf-copy-budget-fixture-final.log。
- 型・lint532file・契約/設定・Web build/Worker dry-run成功。/tmp/ncf-copy-budget-types-complete.log、/tmp/ncf-copy-budget-build.log。今回はHTTP/UIを変更していないためbrowserを再実行していない。全workerd/Windows・実Wranglerドリルはpush後のCIで確認する。remote migration/deployなし。

### 先行するコピー実行処理とCI分割

- CI分割変更: 36384106965のWindows分割2はNode1,431件とintegration30file/865件まで成功し、後続の試験中にjob上限で停止した。4分割化とbackup CLI分離でも各jobの30分枠・個別試験/アプリの期限・全assertionを維持する。Vitest 4.1.11の実BaseSequencerで135fileの完全分割を確認。lint531file、ドリルのNode構文検査、git diff --check成功。実Windows/新runnerの結果はCI待ちで、製品の追加試験数には加算しない。

- [一回分のコピー実行](COPY_JOBS.md)を追加。Outbox IDからclaim・転送・object観測修復・checkpoint・一括公開までを接続し、最大32段階/25秒でyieldする。nativeの開始前にGET+PUT/part=2、init/complete/修復HEAD=1という必要数を確認する。200 invocation/20,000 R2 callと実行中16 callの枠は維持する。停止/完了の再配信はreceiptを照合し、精算前のstoppedをQueue ACKと扱わない。
- claim付き修復は現在のblob/元claim/現行権限と、job/leaseのcall加算を直接ACKした後だけHEADする。ACK喪失分を返さない。通常実行ではclaim取得時の一度だけmanifestを読み、停止判定の候補がない場合に8 MiBのmanifestを重複読込みしない。
- 初回の実行20件+既存修復29件は41成功・8失敗（89.45秒、/tmp/ncf-copy-executor-worker-initial.log）。試験用appのspreadでadmitted LockDOを実ControlDO未起動の参照へ上書きしていた。LockDO参照を明示して修正し、公開・再送・予算・claim束縛の追加検証を行った。productionの受付条件は緩めない。
- 最終の全Node75file/1,431件が成功（74.22秒）、関連workerd6file/184件が成功（242.16秒）。新規executor23件は9blobの予算境界・multipart各段階再開・修復HEADの予算/直接ACK・公開ACK喪失・停止再送を含む。今回の合計は **1,615件成功**。/tmp/ncf-copy-executor-node-full.log、/tmp/ncf-copy-executor-worker-final.log。
- 型・lint531file・契約/設定・Web build/Worker dry-run成功。/tmp/ncf-copy-executor-types-complete.log、/tmp/ncf-copy-executor-lint-final.log、/tmp/ncf-copy-executor-build.log。HTTP/UI変更がないためbrowserは再実行していない。全workerd/Windows・実Wranglerドリルはpush後のCIで確認する。schema0058・75tableを維持し、Queue/HTTP/画面は未接続。現行16 call/実行で最大blob数の完走は証明できていないため、最大規模のD1/転送/再試行予算・cleanup巡回・DLQ接続は後続とする。remote migration/deployなし。

### 先行するobject観測修復

- [実保存後のコピー観測修復](COPY_JOBS.md)を追加。schema0058・75tableを維持する。固定manifest/保持と元native succeededを要求し、単一PUTはHEADのSHA-256、multipart completeはコピー固有metadataと全partの成功を照合して、physical/hash/ETag・stored状態を原子的に復元する。HEAD前後のepoch/maintenance・native/保持を再検査し、実送信と修復の保存SQLを共通化した。修復自体はcheckpoint/namespace/予約/pinを変更しない。
- 最初の修復27件・既存単一13件・分割27件は全67件成功（89.87秒、/tmp/ncf-copy-reconcile-worker-initial.log）。実R2保存後に観測SQLだけを失敗させ、欠落復元・0 bytes・続行・停止/失効/旧epoch後のGC handoff・SHA/metadata不一致・未知native/欠落prepareの保持・HEAD前後の境界・ACK喪失・rollback・並行照合・期限・実ControlDOを検証した。追加したmultipart rollbackと実25秒timeoutを含む最終5file/154件も成功（256.00秒、/tmp/ncf-copy-reconcile-worker-final.log）。関連workerdは重複を除き7file/194件成功。stream cancellationの診断は出るが、全assertionと終了codeは成功した。
- 型・lint529file・契約/設定検査は成功。/tmp/ncf-copy-reconcile-types-final.log、/tmp/ncf-copy-reconcile-lint-final.log、/tmp/ncf-copy-reconcile-contracts.log、/tmp/ncf-copy-reconcile-config.log。全Node75file/1,431件成功（75.15秒、/tmp/ncf-copy-reconcile-node-full.log）。**全Node1,431 + 関連workerd194 = 1,625件成功**。Web build/Worker dry-runも成功（/tmp/ncf-copy-reconcile-build.log）。更新資料のlocal link195件とgit diff --checkも確認した。今回のUI/HTTP/schema変更はなく、browser・全workerd・実Wranglerドリルはローカルで再実行していない。push後CIで確認する。native unknown、part/handle観測、未送信attempt再試行、全体完走予算、Queue/HTTP/UIは引き続き未完了。remote migration/deployなし。

### 先行する既知copy multipartの中止・精算

- [停止済みコピーの既知multipart中止](COPY_JOBS.md)を内部実装。migration0058・75table。先行create/part/completeの終了証明、25秒の固定中止attempt、直接ACK後の一度だけのnative送信、遅延終了の照合、aborted receiptによる原子的な予約/pin/保持精算を追加した。未知結果・記録のないprepareでは保持を維持し、中止attemptの再試行管理とQueue/HTTP/UIは後続。
- 全Node75file/1,431件成功（71.96秒、/tmp/ncf-copy-abort-node-full.log）。新schema19件は旧column/行保持、移行前提、3段階の同一終了証明、索引利用、混在identity拒否を検査。SQL backup5ケースは単一/分割/既存精算receipt/中止準備/中止済みの全table/schema hashとfreezeを確認。epoch条件追加後の関連24件も成功（3.50秒、/tmp/ncf-copy-abort-node-final.log）。
- 新規workerd33件は0/1/2partでの中止、未送信証明、未知結果/観測欠落、prepare/native/finishのACK喪失、重複送信拒否、遅延part/abort、25秒timeout、失効/旧epoch/maintenance、改変拒否、rollback、実ControlDOでの停止中精算を検証。初回に復旧freezeの拒否条件、遅延partでstreamを消費する順序、実ControlDOのepoch履歴というfixture不備を修正し、安全条件は維持した。
- 関連workerd12file/306件の初回は305成功・1失敗（351.08秒、/tmp/ncf-copy-abort-worker-regression.log）。遅延part fixture修正と1件追加後、新33件中32件および復旧snapshot46件が成功（130.57秒、/tmp/ncf-copy-abort-worker-final.log）。残る実ControlDO fixtureへ既存試験と同じepoch履歴を追加し、対象1件が成功（4.60秒、/tmp/ncf-copy-abort-control-final.log）。復旧snapshotは旧74という期待を75とexport対象名照合へ修正した。
- **全Node1,431 + 関連workerd13file/353 = 1,784件成功**（重複を除き、修正後の対象再実行を含む）。型・lint526file・契約/設定・生成schema75table/FK索引の検査、Web build/Worker dry-run成功。/tmp/ncf-copy-abort-types-complete.log、/tmp/ncf-copy-abort-lint-final.log、/tmp/ncf-copy-abort-build.log。UI/HTTP変更はなく、browser・実Wrangler運用ドリル・全workerdは今回ローカルで再実行していない。新headのCIで確認する。remote migration/deployなし。

### 先行するCI再送試験と検索診断

- 015ab17の[CI36380239927](https://github.com/daraskme/Nextcloud-flare/actions/runs/36380239927)でbrowser27/28成功・1失敗。共有recipientのlost response/reload後、作成済みlinkが既に表示されているため、元操作の再送が届く前に送信回数を検査していた。保存traceでもCSRF更新と未完了POSTを確認。同じIdempotency-KeyのPOST応答201と未確認表示の消失を待ち、元body/key一致・共有scope・一件だけの作成・後続renameの検査は維持した。
- 先行b1fedc7のWindows検索timeoutは未再現。ローカルの同じ9試験を一時的に計測したところ、大規模fixture追加1,083ms・検索399ms・scope SQL383ms・別owner検査54msだった。SQL planはscopeから主キー/children keyset索引、search_index_scope、FTSのrowid付きMATCHを使用。Windowsの遅延がfixtureかSQLかは未確定。元テストに失敗時限定のsearch-scope-timing診断を追加し、完了段階と実行中段階のmsのみを記録する。件数・90秒timeout・production SQLは変更しない。
- 診断用の一時試験で例外とtimeoutの両方に元エラーと段階情報が表示されることを確認し、一時ファイルを削除した。最終search.test.tsは9件成功（6.89秒、/tmp/ncf-search-diagnostics-final.log）。型検査・lint522fileが成功（/tmp/ncf-ci-recovery-types.log、/tmp/ncf-ci-recovery-lint.log）。browser全28シナリオが成功（5.0分、/tmp/ncf-ci-recovery-browser.log）。今回の対象試験は計37件成功。Web buildもbrowser起動前に成功し、更新資料のlocal link185件とgit diff --checkを確認した。Node全体・workerd全体・backup drillは今回再実行せず、新headのCIで確認する。今回の変更はテストと資料のみで、schema0057・通常75table・依存・production動作は変更していない。remote migration/deployなし。

### 先行するコピーの停止・精算

- [所有者間copyの停止・限定精算](COPY_JOBS.md)を追加。migration0057・75table。元の両側権限による内部read/cancel、期限/epoch/予算による停止、32blob/25秒の精算とcursor、不変receipt、予約/pin解除、保存済みobjectの35日GC handoff、停止後のclaim解放を実装。途中multipart・未知/観測欠落・記録なしprepareは保持し、HTTP/Queue/UIは有効化しない。保持中のnative receiptは自動削除から除外する。
- 全Node74file/1,410件の初回は1,409成功・1失敗（69.02秒）。旧0056の移行テストが現行復旧SQLを旧schemaへ実行していたため、旧行保持を確認した後で後続migrationも適用するよう修正。対象3file/16件成功（2.16秒）、最終の公開schema8件も成功（2.17秒）。精算receiptを含む75tableのSQL export/import・全table/schema hash・freezeを確認。/tmp/ncf-copy-cleanup-node-full.log、/tmp/ncf-copy-cleanup-node-complete.log、/tmp/ncf-copy-cleanup-node-recovery.log。
- 新規lifecycle35件は、未着手/未送信証明/単一・分割保存後の精算、0 bytes、現在の権限と失効競合、取消し後の遅延保存、unknown/途中multipart保留、ACK喪失、8段階rollback、40blobの32+8件cursor、履歴保持とprune、旧epoch/予算失敗、改変拒否を検証。初回の例外期待と、既存履歴があるkeyへの新規PUTを要求していたprune fixtureは、実際の失敗receipt契約と別keyでのnative精算へ修正。
- 関連workerd12file/304件の初回は302成功・2失敗（282.50秒）。上記fixtureのほか、復旧SQLへ凍結条件を付加するとD1式深さ100を超えるため、全条件を維持して上位のAND群も括弧で分割。最終の復旧13件成功（5.30秒）。/tmp/ncf-copy-cleanup-worker-regression.log、/tmp/ncf-copy-cleanup-recovery-final.log。

- 最終のcopy lifecycle/実行/公開/multipart・backup barrier・control recoveryの6file/170件成功（186.39秒）。/tmp/ncf-copy-cleanup-worker-final.log。全Node1,410 + 関連workerd304 = **1,714件成功**（重複を除き、修正したfileの再実行を含む）。型・lint522file・契約/設定・schema75table/FK索引の検査は成功。/tmp/ncf-copy-cleanup-types-complete.log、/tmp/ncf-copy-cleanup-lint-final.log。Web build/Worker dry-runも成功（/tmp/ncf-copy-cleanup-build.log）、更新資料のlocal link188件とgit diff --checkは問題なし。今回のUI/HTTP変更はなく、browserと実Wrangler運用ドリルは再実行していない。新headの全workerd/Windows/browser/backupはpush後CIで確認する。remote migration/deployなし。

### 先行するコピーの一括公開

- [所有者間copyの一括公開](COPY_JOBS.md)を追加。migration0056・74table。コピー先LockDO/common admissionのcopy.publishで、固定metadata、node/props/検索、上書きtrash、quota/ref、activity/Outbox、成功時のpin/保持/lease精算を同じbatchにまとめる。両側選択、native成功とpending不在、上書きsnapshot、元memberの現行所属を再検査する。取消し/失敗時精算・結果不明修復・最大転送予算・Queue/HTTP/UIは後続。

- 新規公開35件は単一/分割保存後の公開、空folder/Depth 0、root→folder、固定属性とalias、受付後のsource内容変更、上書きtrash、双方の選択share、直前lock/失効、pending native、応答喪失、14段階のrollback、10,000 nodeを検証。初回にD1式の深さ・FTS changes()・長いLIKEの制限を確認し、検査式の分割・FTSの実データ照合・ID範囲検索へ修正。追加lock fixtureのdisplay_href不足も修正した。
- 全Node73file/1,404件の初回は1,400成功・4失敗（67.87秒）。旧copy backup fixtureが0055までしか移行していなかった点と、freeze fixtureに実barrier recordがなかった点を修正し、最終の関連3file/23件は成功（2.82秒）。既存data/保持/part receiptを残す0056移行、SQL export/importの全table/schema hash、freezeと復旧の拒否条件を確認。/tmp/ncf-copy-publication-node-full.log、/tmp/ncf-copy-publication-node-complete.log。
- 関連workerd12file/286件の初回は263成功・23失敗（221.45秒）。共通の復旧照合式がD1の式の深さ100を超えたため、公開receiptの全検証条件を維持してpredicateを括弧でまとめた。復旧13件成功（5.57秒）、最終の公開35件+backup barrier22件の57件成功（70.71秒）。今回の全286件が成功した状態を確認。/tmp/ncf-copy-publication-worker-regression.log、/tmp/ncf-copy-publication-recovery-depth.log、/tmp/ncf-copy-publication-worker-complete.log。
- **全Node1,404 + 関連workerd286 = 1,690件成功**（重複を除き、修正後の対象file再実行を含む）。型・lint519file・契約/設定・schema74table/FK索引・Web build/Worker dry-run成功。/tmp/ncf-copy-publication-types-complete.log、/tmp/ncf-copy-publication-lint-complete.log、/tmp/ncf-copy-publication-contracts-complete.log、/tmp/ncf-copy-publication-build.log。UI/HTTP変更はなくbrowserと実Wrangler運用ドリルはこの変更では再実行していない。新headの全workerd/Windows/browser/backupドリルはpush後のCIで確認する。remote migration/deployなし。

### 先行するコピーの分割保存

- [所有者間copyの分割保存](COPY_JOBS.md)を追加。migration0055・74table。固定Rangeからのstream、create/part/completeのnative記録、固定geometry/upload ID、part hash/ETag・checkpoint、lease再取得後の続行、遅延応答とACK喪失の照合を実装。multipartの全体SHA-256はNULLを維持する。copy保持中のkeyは全bucket用abortから保護し、既知handleをtrackedとして認識する。最大規模の完走予算・未知/未送信/観測欠落の修復・公開・取消し/精算・Queue/HTTP/UIは後続。
- 全Node71file/1,389件成功（71.60秒）。コピーの旧manifest/保持・分割upload/part/途中進捗を含む74tableのSQL export/importと全table/schema hashを照合。既存15種のnative pending/terminal receiptを全field保持する移行とfreeze/FK/indexも確認。/tmp/ncf-copy-multipart-node-full.log。
- 分割copy21件・既存copy claim/read40件・単一保存13件・stream10件の84件成功（87.50秒）。9 MiBの8+1 MiB分割、claim再取得、hash/ETag/bytes、namespace非公開、3段階のprepare/native/finish ACK喪失、権限失効・lease解放後の実結果保存を含む。/tmp/ncf-copy-multipart-focused.log。
- 関連workerd8file/273件は271成功。追加したbucket回収保護で、trackedのSQL guardがupload行だけを認めていた点と、外側で一般化されるエラー文字列の期待を修正した。最終3file/73件成功（100.11秒）、分割copyは27件。native送信ゼロとDBのcopy保持guard、9 MiBを一つのpartとしてstreamする場合、upload ID/part/attempt差替え拒否も確認。/tmp/ncf-copy-multipart-regression.log、/tmp/ncf-copy-multipart-regression-final.log。
- 前回CIのbackup失敗に備え、Wrangler wrapperへ限定したcommand番号・終了code/signalの診断を追加。SQL・引数・応答本文・署名URLは出さず、再送も行わない。追加6件と最終schema/復旧freeze/backupの計106件成功（18.12秒）。/tmp/ncf-copy-multipart-schema-final.log。
- 今回は重複を除き **全Node1,396 + 関連workerd336 = 1,732件成功**。型・lint515file・契約/設定・生成schema74table/FK graph・Web build/Worker dry-run成功。/tmp/ncf-copy-multipart-types-final.log、/tmp/ncf-copy-multipart-lint-final.log、/tmp/ncf-copy-multipart-build.log。資料local link584件とgit diff --checkも成功。UI変更がなくbrowserは再実行していない。remote migration/deployなし。

- 完了時の全part照合は、一つのkeyに属するnative履歴の反復走査から(kind,source_ref)の一意索引へ変更。SQLiteの実行計画を検査する追加1件を含む8件成功（2.09秒）。/tmp/ncf-copy-multipart-index.log。最終copy multipart27件も成功（42.36秒）。型・lint515file・Worker dry-runを再確認。/tmp/ncf-copy-multipart-worker-complete.log、/tmp/ncf-copy-multipart-types-complete.log、/tmp/ncf-copy-multipart-lint-complete.log、/tmp/ncf-copy-multipart-worker-build-complete.log。
- 74tableの実Wrangler運用ドリル成功。daily/maintainで5世代を作成・検証し、monitor/sweep、R2読戻し・隔離SQL復元、database:restoreのprepare/replay/verify/verify-d1/inspect/cancelを確認した。取消し後も元epochと停止を保持する。SQL 9,170bytes、.wrangler/backup-run-drill-WC9DbP、/tmp/ncf-copy-multipart-backup-run-drill.log。想定した不正要求の拒否・補助WorkerのDO exportに関する診断は出るが、全assertionと終了codeは成功。前回CI失敗の根本原因が確定したことは意味しない。

### 先行するコピーの単一保存

- [所有者間copyの単一保存](COPY_JOBS.md)を追加。migration0054・72table。8 MiB以下の条件付きPUT/SHA-256検査、転送attempt/staging blob、ControlDOでの現行認可とnative receipt、physical/hash/ETag記録、確定後のcheckpoint・再取得を実装。大きいblobのmultipart、大量blobのbatch化と完走予算、未知/未送信/観測欠落の修復、公開・取消し/精算・Queue/HTTP/UIは未実装。
- 初回の新規保存10件と既存claim/read40件が成功（45.71秒）。共通fixtureを共有化し、実R2の条件付き保存、空blob、prepare/observe/native finish/checkpointのACK喪失、共有停止後の物理会計、既存objectの非上書きを確認。/tmp/ncf-copy-put-first.log。
- 全Node70file/1,381件のうち1,380件成功（59.66秒）。既存multipart照合triggerをmigrationで再作成した際、freezeより先にdomainエラーになった1件を、freezeガードの再作成で修正。新旧14種のpending/terminal receiptを全field保持する移行、旧copy保持行の追加column初期値、SQL backup/restore、復旧freezeの関連3file/17件は修正後成功（最終3.19秒）。/tmp/ncf-copy-put-node-final.log、/tmp/ncf-copy-put-schema-final.log、/tmp/ncf-copy-put-schema-final-2.log。
- 関連workerd8file/210件成功（168.27秒）。ControlDOのR2送信、uploadの共通受付、copy受付/claim/read、backup barrier、復旧を回帰。転送中destination blobのDELETE/GC拒否と既存upload R2 writeの追加検証3file/51件も成功（45.96秒）。ControlDOは小さい保存済みidentity/node情報で再認可し、nativeごとのmanifest本文再読込を禁止する試験を追加。最終copy put13件+claim/read40件の53件成功（48.44秒）。/tmp/ncf-copy-put-worker-final.log、/tmp/ncf-copy-put-worker-final-2.log、/tmp/ncf-copy-put-worker-final-3.log。
- 今回の合計は **全Node1,381 + 関連workerd228 = 1,609件成功**（重複試験を除き、修正対象の再実行を含む）。型・lint510file・契約/設定・生成schema72table/FK graph・Web build/Worker dry-run成功。/tmp/ncf-copy-put-types-complete.log、/tmp/ncf-copy-put-lint-complete.log、/tmp/ncf-copy-put-build.log。HTTP/UI変更がなくbrowserは再実行していない。全workerd/Windowsと実Wrangler backupドリルはpush後のCIで確認する。remote migration/deployなし。

### 先行するコピー実行claimと読取り

- [所有者間copyの実行基盤](COPY_JOBS.md)を追加。migration0053・72table。永続claim/token/epoch/初期checkpoint、owner同時2claim、25秒、全体200 invocation/20,000 R2 call、8MiB/Range・16 read/invocation。固定nodeの現行認可、固定pin/blob/物理ETag、直接ACK後のGET、読取り後の再認可、期限・cancel・遅延body破棄を実装。転送先書込み・checkpoint進行・公開・取消し/精算・Queue consumer/HTTP/UI接続は後続。
- 初回workerd34件は33成功。空blob fixtureを既存blobのサイズ変更から初期INSERTへ直し、追加ケース後の38件は37成功。R2が空objectにも返すoffset=0/length=0のRange情報を認める修正を追加。失敗時・期限後に届くbodyもcancelする。/tmp/ncf-copy-execution-worker-1.log、/tmp/ncf-copy-execution-worker-2.log。
- 全Node69file/1,376件成功（54.32秒）。0053で既存leaseのtoken/epoch/期限/attemptが保持されること、copy manifest・pin・予約・期限切れleaseのcall数を含むSQL export/importの全table/schema hash一致を確認。/tmp/ncf-copy-execution-node-full.log。

- 関連workerd11file/281件成功（155.62秒）。新規40件は並行取得、owner上限、旧claim拒否、共有/credential/owner停止、独立した転送先grant、旧blob保持、条件付きRange/空blob、短い/長いbody、取消し・遅延応答、結果不明writeの再取得拒否、実行予算、直接ACK欠落を含む。既存copy受付/準備・ControlDO/共通受付・Outbox・backup barrier/復旧を回帰。既知のLockDO admission_closed診断は出るが全assertion/終了codeは成功。/tmp/ncf-copy-execution-worker-final.log。
- 今回の合計は **全Node1,376 + 関連workerd281 = 1,657件成功**。0053試験のNode URL型修正後の再実行も成功。型・lint505file・契約/設定・生成schema72table/FK graph・Web build/Worker dry-run成功。/tmp/ncf-copy-execution-types-final.log、/tmp/ncf-copy-execution-lint.log、/tmp/ncf-copy-execution-build.log。UI/HTTP変更がなくbrowserは再実行していない。実Wrangler backupドリル・全workerd/Windowsはpush後のCIで確認する。remote migration/deployなし。

### 先行するコピーの永続受付

- [所有者間copyの永続受付](COPY_JOBS.md)を追加。migration0052・72table、内部copy.enqueue operation、固定manifestの64KiB分割保存、pin/予約/bulk job/Outboxの一括確定、202受付receipt、両側の現行認可による再送照合を接続。R2転送・公開・取消し/精算・HTTP/UIは未実装。
- 初回workerd3file/51件は47成功・4失敗。全tableの件数を数えたfixtureと復旧bootstrap未設定を修正し、追加ケースを含む次の3file/56件が成功（22.29秒）。約7MBのmanifest、独立した転送先共有、Depth 0、停止/epoch変更、未知consumerの非ACKを確認。/tmp/ncf-copy-jobs-first.log、/tmp/ncf-copy-jobs-second.log。
- 初回schema関連Node2file/35件は34成功。旧0051データ保持試験が後続0052のcatalogue追加まで同一と期待していたため、保持比較は0051時点で行い、現行復旧query前に0052を適用する。新規0052移行試験でも既存データ保持を確認する。/tmp/ncf-copy-jobs-schema-first.log。
- 全Node67file/1,374件のうち1,373件成功（53.50秒）。上記旧schema比較後に現行復旧queryを呼ぶfixtureへ0052適用を追加し、対象23件が成功（4.55秒）。その後、新しいcopy job/64KiB超のbinary chunk/pin/予約を含む72tableのSQL export/import往復1件も成功。往復の初回はimmutable/freeze triggerの発火順に依存したエラー文字列の期待だけが失敗し、両方の拒否を認めてschema hash/全table hashの一致を維持した。/tmp/ncf-copy-jobs-node-final.log、/tmp/ncf-copy-jobs-node-final-2.log、/tmp/ncf-copy-jobs-backup-roundtrip-2.log。
- 関連workerd17file/451件は450成功（249.53秒）。backup-barrierの汎用lease fixtureがnode.create operationへ旧形式node.copy jobを結合していたため、元operationと同じnode.createに修正。対象file22件が成功（25.91秒）。同期DAV・選択付き書込み・LockDO・operation照会・Outbox・ControlDO/復旧・backup freeze/完了・72table snapshotを確認。新規copy job23件には約7MB分割保存、1万node全件、ACK喪失・同時再送・元/先のgrant停止・quota rollback・lock競合を含む。/tmp/ncf-copy-jobs-worker-final.log、/tmp/ncf-copy-jobs-worker-final-2.log。
- 今回の合計は **全Node1,375 + 関連workerd451 = 1,826件成功**（fixture修正後の対象file再実行を含む）。型・lint501file・契約/設定・生成schema72table/FK graph・Web build/Worker dry-runも成功。HTTP/UIは未接続のためbrowserは再実行していない。/tmp/ncf-copy-jobs-types-final.log、/tmp/ncf-copy-jobs-build.log。資料local link579件とgit diff --checkも成功。72tableの実Wrangler backupドリルも成功（SQL 9,892bytes、隔離export・R2保存/読戻し・offline restore・FTS/FK/schema・停止保持）。/tmp/ncf-copy-jobs-backup-drill.log、.wrangler/backup-drill-xfm0XM。補助configのControlDO export診断は出るがドリルの全assertionと終了codeは成功。今回のprivate operator/runドリルと全workerd/Windowsはpush後のCIで確認する。remote migration/deployなし。

### 先行するコピー準備処理

- [所有者間copyの準備](COPY_JOBS.md)を追加。source/overwriteの全metadataとblob storage receiptを固定し、両側の選択・資格情報・構成・属性・衝突を確定batchで再検査する。unique source blobごとのpinとdestination reservationを同じbatchで取得し、COW aliasは一度だけ転送・予約する。まだ永続job/Queue/R2転送/一括公開/取消し/再試行/HTTP/UIへ未接続。schema0051・69table、schema/依存追加なし。
- 新規workerd初回24件は21件成功。immutable storage/depth guardを無視したfixture2件を修正。1万件は30秒timeoutし、診断実行で1件91.31秒。SQLite実行計画がspaceの全nodeをJSON groupごとに反復走査していたため、ID集合から主キーへCROSS JOINする形へ修正。同じ24件は5.44秒、runner全体7.89秒で成功。/tmp/ncf-copy-preparation-worker-first.log、/tmp/ncf-copy-preparation-large-diagnostic.log、/tmp/ncf-copy-preparation-worker-second.log。
- 先行8dbdcc6の[CI36363511416](https://github.com/daraskme/Nextcloud-flare/actions/runs/36363511416)はUbuntu・Windows1/3と2/3・browser成功、backupは最終確認時に実行中。Windows3/3はNode1,360/1,361件成功。r2-write-schemaの期限経過前のpending INSERTが、秒単位のdispatch guardで拒否され失敗。SQLite試験用のstrftime時計を固定し、明示的な3秒経過後にもunknownが閉じないことを実triggerで検証する。productionの条件は不変。修正後の関連Node12件成功（2.30秒）。/tmp/ncf-transfer-scope-ci-win3.log、/tmp/ncf-r2-schema-clock.log。
- 最終の全Node66file/1,361件成功（54.21秒）。関連workerd初回6file/130件は128件成功で、追加chunk検証のLIKE patternがD1の長さ制限に触れた2件をfixtureのprefix範囲照合へ修正した。変更対象fileの最終29件は成功（8.44秒）。先に成功した共有認可・検索・集計・upload ledgerの5file/101件と合わせ、関連workerd130件成功。/tmp/ncf-copy-preparation-node-final.log、/tmp/ncf-copy-preparation-worker-final.log、/tmp/ncf-copy-preparation-worker-final-2.log。
- 型・lint496file・契約/設定・Web build/Worker dry-run・資料local link・git diff --check成功。今回の合計は **全Node1,361 + 関連workerd130 = 1,491件成功**。HTTP/UIの変更はなくbrowserは再実行していない。全workerd/Windowsはpush後のCIで確認する。/tmp/ncf-copy-preparation-types-final.log、/tmp/ncf-copy-preparation-build.log。

### 先行する共有間DAV転送

- [共有間のDAV転送](DAV_SHARED.md)を同一owner/spaceの別mountへ拡張。転送元と転送先の選択をoperation・digest・LockDO permit・claim・確定・結果照会・Outboxへ保持。COPYはread→edit、MOVEはedit→editを要求し、上書きも転送先で認可する。明示的な個人領域はactor所有に限定し、別grantへの暗黙の代替はしない。cross-owner COPYの非同期jobとAccessの共有間pickerは後続。
- migration0051でdestination space/share ID/versionを追加し、不変tuple・種別・同一space・所有者の整合性を検査。旧データとNULL履歴・legacy digestを保つ。復旧では停止後の正常な過去versionを許可し、破損tupleを拒否する。69通常table、依存追加なし。
- 新規workerd25ケースは両側の選択、再送の省略/差替え拒否、いずれかの共有停止、確定直前の停止、元/先のlock token、第三mountのIf拒否、permit差替え、claim proof、確定ACK喪失、COPY/MOVE上書きを対象にする。初回追加分は未完了claimの解放とR2未保存fixtureのHEADで2件失敗。操作をfailedへ片付け、実PUTから上書きを検証するfixtureに修正した。
- 新規Node23ケースは移行前全tableデータ/FK保持、停止済みの履歴、不可変tuple、不正なpair/space/種別、STRICT整数検査、破損復旧記録、digest互換性と権限複製を対象にする。初回全Nodeはテスト中のmigration編集でbackup schema照合1件が失敗。次の固定実行は非整数fixtureをSQLite STRICTが拒否する期待の誤り2件が失敗し、fixtureを修正した。
- 最終の全Node66file/1,361件成功（54.16s）、関連workerd16file/339件成功（142.08s）。新規25件に加えて既存DAV共有・app password・認可・operation・lock・選択付き更新・Outbox・namespace mutation・共有閲覧・復旧監査と受付を検証した。/tmp/ncf-transfer-scope-node-final-3.log、/tmp/ncf-transfer-scope-worker-final-2.log。
- 型・lint494file・契約/設定・schema69table/FK graph・Web build/Worker dry-run成功。資料local link569件、git diff --check成功。remote migration/deployは未実施。/tmp/ncf-transfer-scope-types-final.log、/tmp/ncf-transfer-scope-build.log。
- 新schemaで共有画面browser6件成功（1.5分）。受信者の閲覧/停止、直接fileの親情報遮蔽、再送/reload、multipart、上書き、move/copy/trashと所有者復元を確認。UI変更はなく全browser28件は再実行していない。既知の自己署名TLS probe診断は出るが全assertionは成功。/tmp/ncf-transfer-scope-browser.log。
- 今回の最終検証は **全Node1,361 + 関連workerd339 + browser6 = 1,706件成功**。製品全体の完了ではなく継続目標を維持する。

### 先行するDAV Sharedの検証

- [内部共有のWebDAV](DAV_SHARED.md)を実装。固定mount一覧/解決、read/edit操作、root制限付き資格情報の非公開、各scopeと選択pairの維持、共有外ancestorのlock情報遮蔽に対応。異なるmount・個人領域との転送は403とし、二つの共有選択を扱う経路は後続。migration0050・69通常table、依存追加なし。
- HTTP PUTのIf-Match/If-None-Match検査を追加し、直接file mountの保存名を保持。LOCKで作る空fileのR2 keyをownerへ修正。DAV upload元、operation、native R2 admission、LockDO intent、completion、Outboxと復旧監査に選択pairを接続。新規schema試験は旧DBの全tableデータ保持、NULL mount維持、歴史的DAV記録、pair差替え拒否を確認。
- 初回の共有fixtureはapp ID形式・XML Content-Type・削除record・Outbox送信stateに誤りがあり修正。従来のDAV prepublication schemaがowner本人だけを要求していた箇所は0050で選択付き受信者に対応。全Node初回は1,337/1,338成功で、旧schema試験のapp password拒否期待を新仕様に更新。Node URL型のimportも修正。最終の全Node65file/1,338件は成功（51.27s）。/tmp/ncf-dav-shared-node-final.log。
- 先行a9af702の[CI36359614104](https://github.com/daraskme/Nextcloud-flare/actions/runs/36359614104)は初回5job成功、Windows分割2/3のorphan-admission受付回数3の期待に対し2で1件失敗。同じcommitの失敗job再実行で全6job成功。productionの期限や検査は緩めていない。

- 最終の関連workerd18file/373件成功（164.54s）。新規共有DAV20件に加え、既存認可・app password・operation・lock・選択付きAccess更新・Outbox・DAV保存/回収/受付・復旧監査とControlDOを検証。前回Windows CIのorphan-admissionもローカルでは成功。LockDOのadmission_closed診断が1行出るが、全assertionと終了codeは成功。/tmp/ncf-dav-shared-worker-final.log。
- 型・lint490file・契約/設定・生成schema69table/FK graph・Web build/Worker dry-run成功。今回の全workerd/Windowsはpush後のCIで確認する。remote migration/deployは未実施。/tmp/ncf-dav-shared-types-final.log、/tmp/ncf-dav-shared-lint-final.log、/tmp/ncf-dav-shared-build.log。

- 共有画面browser6件成功（1.5分）。新schemaの初期化から、受信者の閲覧/停止、直接fileの親情報遮蔽、再送/reload、multipart、上書き、move/copy/trashと所有者復元を確認。今回はUI変更がないためbrowser全28件は再実行していない。既知のローカル自己署名TLS probe診断は出るがテストは全成功。/tmp/ncf-dav-shared-browser.log。
- 今回の最終検証は **全Node1,338 + 関連workerd373 + browser6 = 1,717件成功**。資料のlocal linkとgit diff --checkも成功。製品全体の完了ではなく、継続目標は維持する。

## 先行チェックポイントの検証記録

- [共有内の整理](SHARED_WORKSPACE.md)を接続。edit共有のmove/copy/trash、共有rootで止まる宛先picker、同じshare pairによる確定済み再送、元source/parentを含む照会・Outbox認可を追加。削除actorを残し、所有者がtrash一覧/restore/purgeを行う。共有rootの移動・削除、範囲外の宛先、別grantへの代替は拒否する。schema0049・69通常table、migration/依存追加なし。
- 新規workerd13ケースはmove/copy/trashのscope付き再送・選択省略/変更拒否・照会・Outbox、確定直前の共有停止と全rollback、read共有とroot削除拒否、元source/parentの範囲外移動、所有者trash・子共有停止・受信者の復元/完全削除拒否を確認。初回はread fixtureが選択に余分なdisabled列を含めていたため修正し、関連26件が成功（23.54s）。最終の認可・lock・namespace mutation・Outbox・復元・共有閲覧を含む9file/182件も成功（141.41s）。/tmp/ncf-shared-transfer-worker-final.log。
- 新規browserシナリオはmobileでfolder COPY→file MOVE→trash応答喪失→reload/同じkey/body再送→所有者の復元→共有外での非表示を確認。初回はテストのroute.fetchがlocal hostnameを解決できず、次はtrash行をtrと誤指定して失敗。既存のlocalFetchと実際のarticleへ修正し、新規1件成功（39.4s）。mobile画像を確認。最終の全browser28件も成功（6.0分）。/tmp/ncf-shared-transfer-browser-3.log、/tmp/ncf-shared-transfer-browser-final.log。
- 全Node64file/1,325件成功（49.96s）。先行ec0a9ebの[CI36358399164](https://github.com/daraskme/Nextcloud-flare/actions/runs/36358399164)のWindows分割2/3と3/3は、同じbackup-health複合試験が30秒を超過し、それぞれ1,324/1,325件成功。5つの実SQL世代の生成・公開と2回の実検証は維持し、この試験だけWindowsの実行枠を60秒へ変更した。productionのI/O期限は変更していない。先行21cd396のR2保存先照合失敗とは別であり、その原因は未確定。/tmp/ncf-shared-transfer-node-all.log、/tmp/ncf-shared-write-ci-win2.log、/tmp/ncf-shared-write-ci-win3.log。

- 最終は全Node1,325 + 関連workerd182 + 全browser28 = **1,535件**。型・lint486file・契約/設定・Web build/Worker dry-run、資料のlocal link239件とgit diff --checkも成功。今回は全workerdをローカル再実行しておらず、Windowsと合わせpush後のCIで確認する。remote migration/deployは行っていない。/tmp/ncf-shared-transfer-build-final.log。

### 先行する受信共有への書込み

- [受信共有の編集](SHARED_WORKSPACE.md)を実装。edit共有でfolder作成・改名・単一/分割upload・上書きができる。直接共有したfileのparent IDを取得せず上書きし、容量は所有者へ計上する。migration0049でoperations/uploadsに選択share pairを保存し、再送・operation照会・Outbox・UploadDO・R2書込みの許可・公開確定・回収・復旧照合まで同じ選択を保つ。69通常table、依存追加なし。
- 新規workerd13件は別edit grantによる代替拒否、選択付きoperationの再送/照会/Outbox、commit直前失効・native R2許可直前失効、read共有からの書込み拒否、単一/分割uploadの再送・停止・所有者容量、直接file共有の上書きとparent非公開を確認。関連5file/79件成功（41.14s）。先行検査で見つかった列数固定のOutbox fixtureは明示列INSERTへ修正。/tmp/ncf-shared-writes-integration-3.log。
- 全Node64file/1,325件成功（48.84s）。追加14件は選択の複製・不正入力・旧digest互換性、migrationのpair/不変性/完了operation整合性、停止後の正常な過去記録と不整合な復旧記録の拒否を検証。lint486file・型・契約/設定・Web build/Worker dry-run成功。/tmp/ncf-shared-writes-unit-final.log、/tmp/ncf-shared-writes-static-final.log、/tmp/ncf-shared-writes-build-final.log。
- 共有browser5件成功（1.3分）、全browser27件も成功（5.7分）。新規3件はfolder作成応答喪失後のreload/同じkey・共有付きbody再送と改名、分割uploadの既存part省略/同じattempt再開/owner課金、単体file上書きの親非公開/完了応答喪失後の非再送を確認。mobile screenshotと横はみ出しなしを確認。/tmp/ncf-shared-writes-browser-final.log。
- 全workerd初回で復旧freezeが確定しない問題を発見し中断。復旧SQLを確定batchへ組み込むとD1の式深さ上限100を超えることを、追加した実D1回帰テストで再現した（`Expression tree is too large`）。条件を変えずに述語をグループ化した。修正後は復旧audit/freeze/snapshotの3file/92件成功（117.83s）、Node復旧6件と型・lint・Worker dry-runも成功。/tmp/ncf-shared-writes-freeze-repro.log、/tmp/ncf-shared-writes-freeze-fixed.log。
- 最終の全workerd123file/2,691件が成功。2分割の内訳は62file/1,385件（1,230.57s）と61file/1,306件（1,186.32s）、両方とも終了コード0。全Node1,325 + workerd2,691 + browser27 = **4,043件**を確認した。新規はNode14/workerd14/browser3件。/tmp/ncf-shared-writes-workerd-final-1.log、/tmp/ncf-shared-writes-workerd-final-2.log。
- remote migration/deployは行っていない。0049適用後の旧Workerへのrollbackは選択情報を失うため、停止維持と対応版での再検証が必要。

### 先行する受信共有の閲覧

- [受信共有の閲覧](SHARED_WORKSPACE.md)を実装。Sharedの一覧・配下/単体file閲覧・content取得を接続。selected share id/versionを認可・cursor・ticketへ固定し、共有rootより上のparent ID/breadcrumb名を遮蔽する。schema0048・69通常table、migration/依存追加なし。共有への編集/uploadは後続。
- 修正前の実D1テストで非共有祖先名の漏出を再現し、修正後は新規workerd14件を含む4file/73件が成功（16.00s）。share失効/version/root変更・credential/owner/recipient失効・祖先trash・maintenance/epoch競合と選択cursorを確認。/tmp/ncf-shared-read-repro.log、/tmp/ncf-shared-read-worker.log。
- 最初のbrowser検査は2件失敗。test identityの全origin向けextra headerがcontent CORSに混入したためapp限定Cookieへ変更し、DELETE helperに必須Content-Typeを付けてCSRF通過後のowner認可を検査するよう修正した。production CORSは変更していない。共有管理3件＋受信共有2件の計5件成功（42.8s）。mobile screenshotを確認。/tmp/ncf-shared-browse-browser-2.log。
- 全Node62file/1,311件成功（50.58s）。selected shareの複製/freeze・入力拒否16件とWeb APIの選択維持1件を追加。lint482file・型・契約/設定検査も成功。全体workerd122file/2,677件も成功（1,755.26s）。最終Web build/Worker dry-run成功、全体`pnpm check`終了コード0。/tmp/ncf-shared-workspace-check.log。
- 全browser24件成功（6.5分）。全体checkのasset再生成と干渉しないよう、ソースとbuildを`/tmp/ncf-shared-browser-M5jroA`へ複製して`pnpm exec playwright test`を実行した。実行後にdocsを除く549fileとbuild7fileのSHA-256一致を確認。新規Sharedページの認証/unknown fallbackも既存assetシナリオへ追加。/tmp/ncf-shared-workspace-browser-final.log。
- 最終確認はNode1,311 + workerd2,677 + browser24 = **4,012件**。新規はNode17/workerd14/browser2件。git diff --check成功。remote migration/deployは行っていない。

### 先行する内部共有管理

- [内部共有の管理](INTERNAL_SHARES.md)を実装。migration0048、通常69table。所有者のCRUD、受信一覧API、作成時固定mount名、相手/role/期限の更新、version照合と旧grant/session/ticket失効を共通mutation受付へ接続。配信budgetを保持。Filesの共有管理画面では応答喪失時に自動再送せず入力を維持する。受信Shared画面/DAV Shared/公開linkは後続。
- 新規workerd21件を含む関連4file/63件成功（16.33s）。入力/共有mountのNode2file/89件成功（13.42s）。実ブラウザー新規3件成功（31.3s）。最終workerd 4file/63件も成功（20.67s）。/tmp/ncf-internal-share-worker-final.log。
- 前回CIのintegration/schema.test.tsがmigration件数を46に固定していた不備を修正。適用済み件数と読み込んだmigration列の長さを比較し、FK graph照合を保持する。

- 全Node62file/1,294件成功（56.93s）、新規17件。初回はsandboxの子プロセス/loopback制限で39件失敗・1未処理例外が発生し、必要な権限で全体を再実行して成功。/tmp/ncf-internal-share-unit-final.log。lint479file・型・契約/設定・69table schema生成・Web build/Worker dry-runが成功。
- 全browserの初回は既存19件成功後、固定JWTを使うtest fixtureがlogout済みになり、後続の共有検査を開始できず中断。test-onlyの明示Access再ログインを追加し、旧sessionの失効は保持する。共有検査はbeforeEachで新fingerprintを取得する。最終の全browser22件が成功（4.2分）。共有管理のmobile画面と横はみ出しなしを確認。/tmp/ncf-internal-share-browser-final.log、test-results/shares-internal-shares-cre-38dbd-ough-the-real-API-on-mobile/share-management-mobile.png。

- 最終lint479file・型検査成功。契約/設定検査、69table schema生成成功。最終Web build/Worker dry-run成功（/tmp/ncf-internal-share-build-complete.log）。全Node1,294 + 関連workerd63 + 全browser22 = **1,379件**を確認。全workerd suiteとremote検証は今回ローカルでは実行していない。新規テストはNode17/workerd21/browser3件。remote migration/deployなし。

### 先行するmultipart中止成功記録の回復

- [multipart中止の実成功記録の回復](MULTIPART_ABORT_RECONCILIATION.md)を実装。migration0047・69通常table。元native tupleの9項目と独立DO履歴を照合し、upload handle成功の回復とbucketの補足成功記録を保存する。既存28method・CLI引数を維持し、全体閉鎖/容量holdは未解除。
- Nodeのschema/backup生成/復旧inventory 3file174件が成功（15.58s）。初回workerd38件は37成功・1失敗（73.67s）。停止故障注入後に残るprobe leaseを同じ試験内で満了させるfixtureへ修正。型検査の部分R2 mockのassertionも修正後、型・lint471file・契約/設定検査とWeb build/Worker dry-runが成功。
- 中間workerd7file/283件は282成功・1失敗（322.28s）。snapshot試験の68tableの旧assertionを69へ更新。upload中止の送信前にsource/tokenを保存し、その組もnative grantと成功照合の両方で確認する条件を追加。旧記録へsourceを推測して補填しない。
- 全Node61file/1,277件は1,276成功・1失敗（56.52s）。database-restore試験の表数期待値が旧68のまま残っていたため修正し、同file全34件が成功（27.92s）。他の60fileと合わせ全Node1,277件を確認。/tmp/ncf-abort-reconcile-unit-all.log、/tmp/ncf-abort-reconcile-unit-final.log。
- private operatorドリルは69tableで成功。元backup11,370bytes・snapshot57,512bytes、全28methodの拒否、7domain、空inventory、12ページ監査と受付/GC再開を確認。/tmp/ncf-abort-reconcile-operator-final.log、.wrangler/operator-drill-t5BwhN/report.json。初回は表数の旧assertionで停止し更新後に再実行した。実S3/Time Travelは合成provider。
- source照合追加後の型・lint471file・契約/設定・Web build/Worker dry-run成功。最終workerd5file/198件が成功（274.31s）。新しいinventory fileは42件で19件追加。9項目の不一致、DO履歴の欠落/結果/期限、補足保存ACK喪失、遅い成功と元diagnostic保持、eviction、停止変更直前のatomic拒否、別scan round、source/token不一致、再中止禁止と容量保持を確認。/tmp/ncf-abort-reconcile-worker-source.log、/tmp/ncf-abort-reconcile-build-final.log。全体Nodeと最終workerdを合わせ1,475件。remote migration/deployは未実施。

### 先行するmultipart inventoryの運用接続

- [multipart inventory](DATABASE_RESTORE_INVENTORY.md)をprivate `repairInventory`と`inventory-restored --action verify|uploads|bucket|parts|abort`へ接続。採用済みBLOBS target、同じ停止token、native保留なし、write flagを要求し、毎回fresh probe。全体25秒、単発処理、元attempt再送時の非dispatch、容量保留と全監査の無効化を維持する。内部token/key/R2 ID/cursorをCLIへ出さない。共通source/読取りguardをrestoreRepairContextへ抽出し、既存7種domainにも使用する。
- 新規Node59件を含む4file/190件成功（26.53s）。operator handleの重複拒否を追加後、新規file60件が成功（0.85s）。既存分と合わせ今回Node191件を確認。入力の余分なkey・bounds・action、結果の件数/状態/ID一致、秘密除去、CLI引数、unknown RPC非再送を検証。/tmp/ncf-inventory-node.log、/tmp/ncf-inventory-node-final.log。
- workerdは初回新規20件中19成功・1失敗（21.42s）。fetch spyに前の操作の呼出しが残っていたassertionを修正。25秒timeout試験を加えた9file/193件は192成功・1失敗（255.28s）。timeout自体は成立したが、その後のDO stub呼出しが異なるI/O contextとして拒否されたため、試験全体を同じDO内へ移した。既存8file/172件は成功。
- scoped binding fenceにもD1 revision/token/期限を直接assertする条件を追加。scope関連3file/71件は68成功・3失敗（99.48s）で、D1 token故障注入を元へ戻さず次のテストへ持ち越したfixtureが原因。後片付けで注入tokenだけを戻し、未開始のGET待機でも先行errorを観測するよう修正。既存のbinding/restore-BLOBS 2file/48件は成功。新規file全23件が再実行で成功（45.72s）。故障注入callbackの代入がTS制御フローから見えない箇所は、実行時コードを変えない型assertionで修正。今回workerdは重複を除いて10file/221件、Node191件と合わせ412件を確認（新規83件）。/tmp/ncf-inventory-worker.log、/tmp/ncf-inventory-worker-final.log、/tmp/ncf-inventory-worker-scope.log、/tmp/ncf-inventory-worker-focus-final.log。
- 最終型・lint470file・契約/設定検査・Web build・Worker dry-run成功。/tmp/ncf-inventory-types.log、/tmp/ncf-inventory-types-final.log（この後、型assertion調整後の端末上で最終型検査成功を確認）、/tmp/ncf-inventory-build-final.log。D1 schema0046・通常68table・依存追加なし。
- private bindingドリルは停止tokenのSQL照合追加前後とも成功。全28復旧methodの権限拒否、7種domainとmultipartのfresh照合・空upload修復、12ページ全監査、hold解除と受付/GC再開を確認。最終snapshot68table/SQL57,512bytes、元backup11,370bytes。/tmp/ncf-inventory-operator-final.log、.wrangler/operator-drill-9yTZQQ/report.json。S3/Time Travelは合成provider、D1 control巻戻しfixtureであり実Cloudflare復旧ではない。remote migration/deploy・通知・timer設置は行っていない。

### 先行するGC・孤立走査の接続

- 復旧要求に固定した`repair-restored`へblob-gc/orphan-gc/orphan-inventoryを追加。private operatorのmethodは27のまま。GCの新規candidate拒否、pin・35日猶予・不明native保持、LIST/HEAD前後・DELETE直前の停止照合、実遅延終了の保存を維持する。孤立走査は1ページだけを記録し、途中失敗時にcursorと容量を保持する。CLI出力は件数/状態だけへ正規化し、内部key/token/cursorを除く。
- Node3file/131件成功（28.25s、新規19件）。GC/走査の種別・件数・状態関係・秘匿値除去・完了/保留判定と既存復旧CLIを検証。/tmp/ncf-restore-gc-node.log。
- 新規workerd18件成功（28.82s）。実DELETE、physicalの一度だけの精算、candidate/pin/lease/35日保護、実体置換後の猶予更新、未知DELETE保持、最終DB応答喪失、停止直前/直後とnative終了、LIST/HEAD後の停止、途中ページ失敗と再開、eviction、事前native保留を検証。初回2file/44件は27成功・17失敗（60.79s）で、前fixtureのusersに対応するbootstrap設定が未設定のため後続の復旧準備が拒否された。テスト準備でbootstrapを既存管理者へ合わせ、前fixtureのscan leaseを片付けて再実行し、新規18件がすべて成功。既存domain fileは追加3種の空実行を含む26件が初回で成功。/tmp/ncf-restore-gc-worker.log、/tmp/ncf-restore-gc-worker-focus.log。
- 既存GC/孤立走査/ごみ箱復元の回帰5file/122件成功（127.00s）。再実行を含む今回のworkerd7file/166件とNode131件、計297件を確認（新規40件）。/tmp/ncf-restore-gc-regression.log。
- 型・lint464file・契約/設定検査・Web build・Worker dry-run成功。D1 schema0046・通常68table・依存追加なし。/tmp/ncf-restore-gc-types.log、/tmp/ncf-restore-gc-build.log。
- private bindingドリル成功。全27復旧methodの権限拒否、native走査と7種類のdomain修復、12ページ全監査、hold解除と受付/GCの段階再開を確認。孤立走査は既知object1件を見て追加計上せず完了した。snapshot68table/SQL57,512bytes、元backup11,370bytes。/tmp/ncf-restore-gc-operator.log、.wrangler/operator-drill-hN9bUu/report.json。S3/Time Travelは合成provider、D1 control巻戻しfixtureであり実Cloudflare復旧ではない。remote migration/deploy・通知・timer設置は行っていない。

### 先行するupload・予約・outbox修復

- [復元後のupload・予約・outbox修復](DATABASE_RESTORE_DOMAINS.md)をprivate `repairDomain`と`repair-restored --kind ... --limit ...`へ接続。元要求/採用済みepoch/同じ停止token、write flag、DO/D1 native保留なしを確認して1回最大20件を修復し、監査を無効にする。単一uploadの元期限、予約のupload/DAV保護、outboxのcommitted operation/stepを維持する。内部token・keyを出力せず、未解決状態は終了code 2とする。
- multipartの前回cleanupを、新しいtokenへ上書きする前に照合。全9列のR2識別tuple/source_refとDO履歴が一致した実abort成功からDBの閉鎖記録を補い、HEADと容量精算へ進む。未送信証明なら新しい中止が可能。不足/不一致は元tokenと容量を保持して60秒backoffし、後続対象へ進める。claimにも元tupleをassertし、停止変更前後の未送信/遅延終了を記録する。
- 新規Node26件を含む3file/112件成功（29.70s）。4種類の単発実行、limit/CLI引数、結果のcount/種別/要求照合、秘密非出力、unknown RPC再送拒否を確認。/tmp/ncf-domain-node.log。
- 新規workerdは初回21件成功（37.88s）。未対応outboxとDO-only R2保留、hold解除後拒否を加えた7file/190件の回帰は189成功・1失敗（168.27s）。不一致を作るfixtureの期限+1msが、元grantの開始時刻と同じmsでは5秒上限を越えていた。制約内の-1msへ修正し、新規file全23件が成功（37.01s）。再実行を含め7file/190件を確認した。実abort後のclosure失敗/修復ACK喪失/rollback/期限不一致、eviction、未送信/遅延native終了、DBだけの成功行、未知handle、保持と後続処理、予約/physical/GC handoff、監査無効化を検証。既存single/multipart/inventory/復旧受付の6file/167件も成功。/tmp/ncf-domain-worker.log、/tmp/ncf-domain-worker-final.log、/tmp/ncf-domain-worker-focus-final.log。
- 型・lint463file・契約/設定検査・Web build・Worker dry-run成功。fixtureのR2 handle wrapperへ実uploadPart/complete methodを委譲して型を修正し、最終型検査も成功。/tmp/ncf-domain-types.log、/tmp/ncf-domain-build.log。D1 schema0046・通常68table・依存追加なし。
- private bindingドリル成功。全27復旧操作の権限拒否、68table/SQL57,512bytesのsnapshot、native修復、空の4種類のdomain修復、12ページ全監査、hold解除と受付/GC段階再開を確認。/tmp/ncf-domain-operator.log、.wrangler/operator-drill-ZgeAGQ/report.json。元backupは11,370bytes。S3/Time Travelは合成provider、D1 control巻戻しのfixtureであり、実Cloudflare復元ではない。remote migration/deploy・通知・timer設置は行っていない。

### 先行するlive終了記録の修復と保留判定

- 復元後のnative修復へ既存live KDF/R2精算を接続。各種類をpage-size件まで処理してから履歴走査を行う。DOの未知記録と保存失敗を保持し、各記録の前後に採用済み要求と同じ停止tokenを確認する。D1全体のpending件数もページ後に再取得し、CLIは走査完了だけでは成功終了しない。APIの追加・schema変更・依存追加なし。
- 新規Node17件を含むCLI52件成功（0.66s）。DOだけの未知記録、D1の未精算、保存失敗、件数欠落/境界/不正値、出力正規化と再開拒否を確認。/tmp/ncf-live-native-node.log。
- 新規workerd5件を含む復元/KDF/R2の3file・105件成功（104.57s）。履歴保存失敗中の既知未送信KDF、現epochの実R2削除後のD1失敗、eviction後の精算、途中の停止競合、走査済みcursorより前へ現れたD1 claim、D1行のないDO未知記録を確認。初回は採用前にlive記録を置いたfixtureがsnapshotの前提に拒否され、試験を中断した。採用後の保留を明示的に作るfixtureへ修正し、最終コードで全件成功。/tmp/ncf-live-native-worker.log、/tmp/ncf-live-native-worker-final.log。
- 型・lint457file・契約/設定検査・Web build・Worker dry-run成功。/tmp/ncf-live-native-types.log、/tmp/ncf-live-native-build.log。全体checkの3,706件は前回daa143eの検証であり、今回の157件とは分けて扱う。
- private bindingドリル成功。26操作の権限拒否、68table/SQL57,512bytesのsnapshot、native修復のDO/D1保留0・pending=false、12ページ全監査と受付/GCの段階再開を確認。/tmp/ncf-live-native-operator.log、.wrangler/operator-drill-0GPJhS/report.json。元backupは11,370bytes。S3/Time Travelは合成provider、D1 control巻戻しのfixtureであり、実環境の復元ではない。remote migration/deploy・通知・timer設置は行っていない。

### 先行するnative終了履歴と復元行の照合

- [復元後のKDF/R2終了記録の修復](DATABASE_RESTORE_NATIVE.md)を実装。D1精算後の実終了証拠をDOへ36日保持し、保存確認後だけlive receiptを削除する。private operator・repair-restored-native CLIは採用済み要求/停止tokenへ束縛した最大20行の走査を永続化する。未知行は保持し、nativeを再実行せず、FTS/監査を無効化する。D1 schema0046・通常68table・依存追加なし。
- Node2file/69件成功（27.26s）、うち新規13件。完了走査とunknownの区別、page予算、出力正規化、応答喪失時の再送拒否、引数境界を確認。/tmp/ncf-native-node.log。
- 初回workerd4file/100件成功（96.71s）。未知の先頭行を越える実KDFのprivate修復、D1失敗と反対の終端への競合を追加し、最終4file/103件成功（127.78s）、うち新規17件。実PBKDF2/R2終了後のD1巻戻し、eviction、ACK喪失、識別tuple/停止競合、cursor保持、履歴保存失敗/容量/不変性/32件剪定/復旧中保持、修復後の再監査と解除後拒否を確認。/tmp/ncf-native-worker.log、/tmp/ncf-native-worker-final.log。
- private bindingドリル成功。26操作の権限拒否、68table/SQL57,512bytesのsnapshot、停止中epoch採用、pendingなしのnative修復2ページ、12ページ全監査、hold解除と受付/GCの段階再開を確認。元backupはSQL11,370bytes。/tmp/ncf-native-operator.log、.wrangler/operator-drill-n2RIoD/report.json。初回reportの説明文は25操作のままだったため26へ訂正した（検査配列自体は26）。provider/S3は合成応答、D1 control巻戻しのfixtureであり、実Time Travelではない。
- 全体`pnpm check`成功。Node59file/1,155件（43.34s）、workerd117file/2,551件（1443.80s）、合計3,706件。型・lint457file・契約/設定・Web build・Worker dry-runも成功。途中でworkerdのpump canceled/admission_closed/Network connection lostログが出るが、全件成功・終了code 0を確認。/tmp/ncf-native-check.log、/tmp/ncf-native-types-final.log、/tmp/ncf-native-lint.log。更新9資料のlocal link186件とgit diff --checkも成功。実環境の復元・migration/deploy・通知・timer設置は行っていない。
- 前回a57175cのWindows分割1は30分のjob上限で取消し（GitHub check annotationで確認）。Node1,142件と統合53file/1,268件まで成功し、失敗assertionは記録されていない。残りの統合/最終buildは未完了。Windows matrixを2分割から3分割へ増やし、アプリと各testの期限は変更しない。固定版VitestのBaseSequencerで117fileを39/39/39に分割し、重複/欠落なしを確認。`list --filesOnly`はshardを適用しない実装のため、全file一覧に実sequencerを適用して検査した。/tmp/ncf-ci-108672008190.log、/tmp/ncf-native-shard-coverage.json。

### 先行する復元後の監査と段階再開

- [復元後の監査と段階再開](DATABASE_RESTORE_RECOVERY.md)をprivate operator・CLIへ接続しました。FTS再構築と同じtokenの全監査を完了し、D1最終fence・DO未終了処理・予約履歴を再確認して復旧holdを解除します。受付とGCは別操作で順に再開し、後の停止やGC pauseを古い復旧要求が上書きしないよう、解除と再開の証拠を保存します。
- Node4file/110件成功（26.90s）、うち新規22件。監査のpage予算、出力の正規化、失敗時の再送/解除拒否、GCの別操作化、CLI引数境界を確認。/tmp/ncf-recovery-node.log。
- 初回workerd3file/110件は78成功・32失敗。未終了R2を模したfixture行が残り、後続testのbeforeEachが正しくfreeze_pendingを返していた。実際にはnative送信していないfixtureをfinallyでnot_startedへ記録する後片付けを追加。既存DO台帳の移行テストも追加し、最終4file/144件成功（167.21s）、新規10件。FTS再構築と監査tokenの束縛、未終了処理/maintenance holdの拒否、古い再開要求の拒否、GC再送が後のpauseを上書きしないこと、次の復旧要求作成、遅延fenceで解除しないことを確認。/tmp/ncf-recovery-worker.log、/tmp/ncf-recovery-worker-final.log。
- private binding通し試験成功。全25復旧操作の権限拒否、68table/SQL57,512bytesのsnapshot検証、停止中epoch採用、実R2ファイルを含む12ページ全監査、hold解除、受付再開後のeviction、GC再開まで確認。元backup世代はSQL11,370bytes。初回はgeneric operator errorで失敗。その調査で従来fixtureがfake ETagとSQLだけでR2実体を持たないことを確認し、実blob PUTの結果をledgerへ記録するfixtureへ修正後に成功した。初回エラーとの直接因果は独立に切り分けていない。/tmp/ncf-recovery-operator.log、/tmp/ncf-recovery-operator-final.log、.wrangler/operator-drill-sQqDSC/report.json。
- 型・lint453file・契約/設定・Web build・Worker dry-run成功。/tmp/ncf-recovery-types-final.log、/tmp/ncf-recovery-lint.log、/tmp/ncf-recovery-build.log。schema0046・通常68table・依存追加なし。実環境の復旧・再開・migration/deploy・通知・timer設置は行っていない。

### 先行する予約epochの停止中採用

- [復元後の予約epoch採用](DATABASE_RESTORE_ADOPTION.md)をprivate operator・adopt-epoch CLIへ接続しました。検証済みcontrolの全列を比較する原子的D1 batchで旧凍結/tokenを解消し、予約epoch・新しい停止tokenを設定します。独立CLIがそのtokenを指定先から読み返した後、DOへ同じepochを採用します。完了済みoperationと未終了KDF/R2記録を保持し、採用後もmaintenance・GC停止・復旧holdを維持します。
- 初回Node4file/100件は91成功・9失敗。D1のepochトリガーによるKDF待機期限延長を期待hashに反映できていなかったため、同列の下限以上を許容し、他のcontrol全列を厳密照合する形へ修正。最終4file/104件成功（26.82s）、うち新規20件。schema0037/0039/0040/0046、backup/restore凍結の原子的解除とrollback、terminal保持、KDF/R2保留保持、mutation admission閉鎖、設定変更・読戻し不一致・秘密非出力を確認。/tmp/ncf-adoption-node.log、/tmp/ncf-adoption-node-final.log。
- 初回snapshot/adoption workerd26件成功（28.04s）。遅延成功と最終CAS競合を追加し、snapshot/adoption・復旧要求・凍結・admissionの4file/134件成功（123.81s）、新規12件。epoch採用後のeviction、応答喪失の読戻し収束、結果不明の再送拒否、通常再開拒否、停止中監査への接続を確認。既存admission拒否fixtureでworkerdのadmission_closedログが出るが、全テストは成功。/tmp/ncf-adoption-worker.log、/tmp/ncf-adoption-worker-final.log。
- private bindingドリル成功。全20復旧操作の権限拒否、68table/SQL57,492bytesのsnapshot検証から停止token独立読戻し・epoch3のD1/DO採用・eviction後停止維持・Time Travel再送拒否まで確認。最初はfixtureがRPC proxy全体をplain objectと直接比較して失敗したため、status正規化と各propertyの検査に修正。/tmp/ncf-adoption-operator.log、/tmp/ncf-adoption-operator-final.log、.wrangler/operator-drill-Y5ISFT/report.json。providerは合成応答で、D1 control行巻戻しを模擬している。
- 型・lint450file・契約/設定・Web build・Worker dry-run成功。12資料のlocal link272件とgit diff --checkも成功。/tmp/ncf-adoption-types-final.log、/tmp/ncf-adoption-lint.log、/tmp/ncf-adoption-build.log。schema0046・通常68table・依存追加なし。実Cloudflare restore/migration/deploy、通知・timer設置は行っていない。全監査・復旧hold解除・段階再開・運用終了証明・安全な中止・logical importは後続。

### 先行する復元後snapshotの隔離検証

- [復元後snapshotの隔離検証](DATABASE_RESTORE_SNAPSHOT.md)をControlDO/private operator/verify-restored CLIへ接続。実成功済みのTime Travel要求・予約epoch・3bindingへchallengeを束縛する。DOと独立CLIのcontrol/schema/catalogueを照合し、信頼済みmigration prefix・全table hash・隔離SQL/FK/FTS検証の証言をDOへ保存する。D1の内容と旧DO epoch、停止を維持し、epoch採用や受付再開は許可しない。
- 新規Nodeは隔離検証16件と読取りadapter1件。最初の3file/89件は88成功・1失敗で、FK異常fixtureが既存のimmutable session triggerに止められていた。FK違反のnode_propsを作るfixtureへ修正し、CLI/target/Time Travel/epoch/復旧準備の5file/150件が成功（27.60s）。古い0037 schema、NUL/引用符を含む値、committed/failed terminal保持、未知schema、FK違反、読取り中の変更、設定/期限/ACK喪失を確認。/tmp/ncf-restored-snapshot-node.log、/tmp/ncf-restored-snapshot-node-final.log。
- 初回workerd3file/50件が成功（46.44s）。未終了の履歴PUTと遅延D1照会を追加し、snapshot/凍結/復旧要求/epoch履歴の4file/100件が成功（99.81s）。最後に実行grantと選択bookmark/epochの一致を明示検査し、snapshot全16ケースも成功（24.88s）。重複を除く関連は6file/138件。/tmp/ncf-restored-snapshot-worker.log、/tmp/ncf-restored-snapshot-regression.log、/tmp/ncf-restored-snapshot-worker-final.log。
- private bindingドリル成功。全18復旧操作の権限拒否、Time Travel合成応答・control行巻戻し後の全68table/SQL57,492bytesの隔離検証、DO証言保存、eviction照会、再送拒否、D1不変を確認。元のbackup世代は68table/SQL11,350bytes。/tmp/ncf-restored-snapshot-operator-final.log、.wrangler/operator-drill-cCdnbH/report.json。これは実remote Time Travelではない。
- 型・lint445file・契約/設定・Web build・Worker dry-run成功。/tmp/ncf-restored-snapshot-types-complete.log、/tmp/ncf-restored-snapshot-lint-final.log、/tmp/ncf-restored-snapshot-build.log。schema0046・通常68table・依存追加なし。remote resource作成・migration・deployなし。全Node/workerd・Windows/browserはpush後のCIで確認する。
- 検証結果は読取り時の観測で、採用用の持続したD1停止障壁でも、新しいbinding書込みchallengeでもない。復元snapshotの旧token/permit/claimを処理する原子的epoch採用、外部I/O全終了の運用証明、全監査・段階再開、logical import、安全な中止、大規模検証の再開/RTOは未完了。

### 先行するTime Travel送信と実応答記録

- [Time Travelの一度限りの送信・実応答記録](DATABASE_RESTORE_TIME_TRAVEL.md)をprivate RPC/CLIへ接続。RESTORE_WRITE_ENABLEDは既定で無効。要求・予約epoch・3binding・bookmark・元の時刻を固定し、pendingをDOに保存してからgrantを返す。新しい観測・native履歴終了・D1凍結・最終停止条件を再確認する。実成功応答だけをD1にアクセスせず記録し、旧DO epochと停止を維持する。timeout/ACK喪失/再起動で再送しない。
- 新規Node34ケースを含む3file/94件が成功（26.63s）。provider応答の欠落/異常/秘密非出力、本文16KiB/10秒、redirect拒否、期限/設定/対象変更、遅延成功、結果不明と再送拒否を検証。最終34件も成功（0.25s）。/tmp/ncf-time-travel-node.log、/tmp/ncf-time-travel-node-final.log。
- workerd4file/94件が成功（84.45s）。native履歴不明と最終D1確認の遅延/未終了を追加し、ControlDO/epoch履歴と新規22ケースの3file/60件が成功（38.98s）。eviction、同時送信、grant改変、D1 schema利用不能時の結果記録、遅延結果後も停止維持を確認。重複を除いて6file/136件。/tmp/ncf-time-travel-worker.log、/tmp/ncf-time-travel-regression.log。
- Windows CIの既存multipart試験は1msのタイマーがnative dispatchより先に発火すると、正しく送信されなかったabortの終了をfixtureが待ち続けていた。native entryを確認してからfake timerを進める形へ変更し、同file19件が成功（43.74s）。本番の待機期限は変更していない。今回workerd関連は計7file/155件。/tmp/ncf-time-travel-multipart.log。CI失敗ログは/tmp/ncf-ci-36329896475-failed.log、/tmp/ncf-ci-108653418052.log。
- private bindingドリルは68table・SQL11,350bytesで成功。全16復旧操作の権限拒否、実epoch予約、1回送信・応答記録・eviction再照会・再送/cancel拒否を確認。providerは合成応答で、D1 control行だけの巻戻しを模擬した。最初のドリルはRPCプロキシ全体のdeepEqualで失敗したため、戻り値の各propertyを検査するfixtureへ修正。/tmp/ncf-time-travel-operator.log、/tmp/ncf-time-travel-operator-final.log、.wrangler/operator-drill-U8RFD1/report.json。
- 型・lint439file・契約/設定・Web build・Worker dry-run成功。/tmp/ncf-time-travel-types-complete.log、/tmp/ncf-time-travel-lint-final.log、/tmp/ncf-time-travel-build.log。schema0046・通常68table・依存追加なし。全Node/workerd・Windows/browserはpush後のCIで確認する。remote resource作成・migration・deploy・実Time Travelは行っていない。
- 外部I/O全終了の運用証明、logical import、復元snapshot照合、予約epoch採用、結果不明/予約後の安全な中止、全監査・段階再開は未完了。送信フラグの有効化はこれらの証明を代替しない。

### 先行する復旧用epochの事前予約

- [復旧要求に固定したepoch事前予約](DATABASE_RESTORE_EPOCH.md)をControlDO/private DatabaseRestoreOperator/CLIへ接続。凍結mirrorと未失効source証言を確認し、履歴走査前に永続intentを保存する。将来番号とnative receiptを同時保存し、同じ要求では番号を変えない。予約中/完了後の通常cancelを拒否し、D1のepoch・全table・凍結は変更しない。
- 新規Node26ケースを含むCLI/source/binding/epochの4file/126件が成功（26.48s）。要求・対象・番号の改変、config変更、応答喪失、秘密非出力、予約CLIの引数を確認。/tmp/ncf-restore-epoch-node.log。
- 初回workerd4file/82件は81成功・1失敗（47.17s）。不正JSONのエラー名が未正規化だったため、履歴本文を例外へ含めない`epoch_history_conflict`に統一。D1照会・履歴走査失敗・取消し競合など追加4ケースを含む7file/162件が成功（89.54s）。新規15ケースで全68通常table不変・番号固定・eviction・unknown保持・遅延応答を確認。/tmp/ncf-restore-epoch-worker.log、/tmp/ncf-restore-epoch-regression.log。
- 型検査でbookmark fixtureの不要なobservedAtを除去し、optional環境変数を明示undefinedからプロパティ削除へ修正。最終予約15件も成功（14.22s）。型・lint434file・契約/設定・Web build・Worker dry-run成功。/tmp/ncf-restore-epoch-final.log、/tmp/ncf-restore-epoch-types-final.log、/tmp/ncf-restore-epoch-lint.log、/tmp/ncf-restore-epoch-build-final.log。schema0046・通常68table・依存追加なし。remote resource作成・migration・deployなし。
- private binding運用ドリルが68table・SQL11,350bytesで成功。新しいreserveEpochを含む全14復旧操作の権限拒否と、実R2予約・eviction後の同番号再実行・cancel拒否・旧D1 epoch/凍結不変を確認。S3/Time Travel応答は合成provider。/tmp/ncf-restore-epoch-operator.log、.wrangler/operator-drill-59Piel/report.json。
- 今回は関連範囲をローカル検証した。全Node/workerd・Windows/browserはpush後のCIで確認する。外部I/Oの全終了証明、実D1上書きと予約epoch採用、予約後の安全な中止、全監査・段階再開は未完了。

### 先行するepoch履歴のnative終了記録

- epoch履歴PUTを専用の`control_epoch_write`へ接続。pending intentとreserved receiptの同時保存、1回だけのnative PUT、実成功/null応答による終了記録、1024byte/10秒の読取りとpending tuple再検査を実装。応答喪失やGET一致でunknownを解消せず、遅延した処理からのD1採用・DO公開を拒否する。詳細は[EPOCH_HISTORY_WRITES](EPOCH_HISTORY_WRITES.md)。
- 最初のworkerd2file/33件が成功（8.43s）。型検査で見つかったTextDecoder optionとテストfixtureの型互換を修正し、期限境界・停止本文など5ケースを追加。最終のcontrol・epoch履歴・受付・復旧監査・D1復旧・凍結・backup barrierの7file/177件が成功（129.33s）。新規24ケース。既存のPUT応答喪失試験はunknown保持へ更新し、D1失敗後のeviction再試行と全DO喪失時の数値下限を維持。/tmp/ncf-epoch-native-worker.log、/tmp/ncf-epoch-native-regression.log。
- epoch下限・履歴走査・認証fingerprintの既存Node11件が成功（0.14s）。型・lint430file・契約/設定・Web build・Worker dry-runも成功。/tmp/ncf-epoch-native-node.log、/tmp/ncf-epoch-native-type-final.log、/tmp/ncf-epoch-native-lint.log、/tmp/ncf-epoch-native-build.log。
- private binding運用ドリルが68table・SQL11,350bytesで成功。実ControlDO起動、日次生成と4補充・世代回収、13復旧操作の権限拒否、D1/BLOBS/BACKUPS照合・凍結・eviction再照会・取消しを確認。S3/Time Travel応答は合成provider。/tmp/ncf-epoch-native-operator.log、.wrangler/operator-drill-p9hEGJ/report.json。
- 今回は関連範囲をローカル検証した。全Node/workerd・Windows/browserはpush後のCIで確認する。schema0046・通常68table・依存追加なし。remote resource作成・migration・deployなし。
- 復旧要求に固定したepoch事前予約とD1採用の分離、native不明・旧実装・receipt全喪失の運用証明、実D1上書きと全監査・段階再開は未完了。

### 先行するCLI保存のnative終了記録

- 外部CLIのpublish/run/daily/maintainを保存grantとnative終了記録へ接続。単独publishにもoperator descriptorを必須化。S3 HTTP 200/412、local binding PUTの成功だけから終了を記録し、正確なGETやtimeoutではunknownを解消しない。保存前後のprivate照会で全object既存の場合の再実行も保護する。
- 新規Node22ケースを追加し、全1,023件（54file、46.97s）が成功。S3/local bindingの成功・条件競合・例外・timeout後の実応答、grant RPC応答喪失と遅延、grant項目不一致、終了RPC応答喪失、callback欠落、単独publishの必須設定を確認。既存publication/operator試験も未知結果を保持する契約へ更新。/tmp/ncf-cli-publication-unit.log。
- 保存照会の新規workerd1ケースと既存receipt試験の照会assertionを追加。保存受付・完了・barrier・dailyの4file/83件が成功（50.08s）。/tmp/ncf-cli-publication-worker.log。
- 型・lint428file・契約/設定・Web build・Worker dry-runが成功。/tmp/ncf-cli-publication-type.log、/tmp/ncf-cli-publication-build.log。
- private binding運用ドリルが68table・SQL11,350bytesで成功。実際のbinding storeからnative終了callbackを使い、日次生成・4補充・保持判定・回収と復旧照合を確認。保存の3操作は環境不一致・capabilityなし・無効化した接続からの拒否も確認。S3/Time Travel応答は合成provider。/tmp/ncf-cli-publication-operator.log、.wrangler/operator-drill-8WjF9f/report.json。
- 単独publishの実CLIドリルを実ControlDO begin/private bindingへ更新し、68table・SQL9,829bytesで成功。capture→verify→publish→download→restore-offline、条件付きPUT不成立の終了、FTS/会計/FK/Unicode/NULと元D1の凍結保持を確認。/tmp/ncf-cli-publication-drill.log、.wrangler/backup-drill-2eRRhG/report.json。Wrangler proxyの未export DO警告を含むが、実対象Workerのprivate RPCと全assertion・終了コードは成功。
- daily/run/maintainの別CLIドリルも成功（SQL9,107bytes）。実getPlatformProxyと別CLIプロセスで初回保存・同世代再実行・隔離復元・保持期間内削除拒否・期限切れ削除、4補充による5世代保持、monitor、sweep、restore prepare/verify/verify-d1/inspect/cancelを確認。期待する拒否経路のworkerdログとproxy警告を含むが、全assertion・終了コードは成功。/tmp/ncf-cli-publication-run-drill.log、.wrangler/backup-run-drill-DiYjqN/report.json。
- schema0046・通常68table・依存追加なし。native結果不明の運用証明、epoch履歴の記録、新epoch予約・live採用は後続。remote resource作成・migration・deployなし。

### 先行する保存受付API

- [バックアップ保存の送信受付](BACKUP_PUBLICATION_WRITES.md)をControlDOとprivate BackupOperatorへ追加。全D1凍結中のためDO SQLiteに記録し、既存backup_tokenで停止を保持する。正確な世代tuple・key/hash/bytes、単一pending、同UUIDの再送拒否、終了token照合、完了検証・解除との競合拒否を実装。CLI実PUTへの接続は後続。migration0046・68tableのまま、依存追加なし。
- 新規workerd18件を含む保存受付・backup完了・barrierの3file/57件が成功（37.82s）。全68table不変、実PUT後の終了、正確な読戻しでunknownを解消しないこと、grant応答喪失・eviction・並行受付・次世代への古い終了要求・D1読取り後の競合を確認。/tmp/ncf-backup-publication-grants-worker.log。
- private binding adapterに2操作を追加し、既存CLI接続のNode42件が成功（44.27s）。/tmp/ncf-backup-publication-grants-node.log。
- 先行0dbb5a5のWindows CIは既存probe移行試験の最初のINSERTがr2_write_unavailableで失敗。時刻をJavaScriptで秒単位に丸めてからINSERTしており、秒境界を跨ぐとtriggerの必要余裕を失うfixtureだった。probe/BACKUPS probe/世代削除の同型3fixtureを同じSQL文内の時刻計算へ変更。15件成功（2.89s）。production期限やtriggerは変更していない。/tmp/ncf-0dbb5a5-windows1.log、/tmp/ncf-backup-publication-grants-schema.log。
- 型・lint425file・契約/設定・Web build・Worker dry-runが成功。共有validatorはNodeの直接importも確認。/tmp/ncf-backup-publication-grants-types.log、/tmp/ncf-backup-publication-grants-build.log。
- private binding運用ドリルも68table・SQL11,350bytesで成功。新規2操作の環境不一致・capabilityなし・無効化時の拒否を追加し、既存の日次生成/補充・回収・13復旧操作・D1/BLOBS/BACKUPS照合・凍結・取消しを確認。S3/Time Travelは合成provider。/tmp/ncf-backup-publication-grants-operator.log、.wrangler/operator-drill-TNYH6g/report.json。
- 今回は関連検査の範囲で、全Node/workerd・Windows/browserはpush後のCIで確認する。外部CLI native PUT、epoch履歴、unknown運用証明、新epoch予約・live採用は未完了。remote resource作成・migration・deployなし。

### 先行するBACKUPS世代削除の送信記録

- migration0046でBACKUPS世代の部品batch DELETEと最終manifest DELETEを14種類目のR2送信・終了記録へ接続。完成receipt/hash・35日保持・元のepoch/停止mode/revision/tokenと正確なkey集合を再検査し、元の25秒全体期限と10秒I/O期限を維持する。同じ世代のpendingがある間は追加削除とabsent確定を拒否する。削除したことの観測をnative終了へ読み替えない。
- 新規Node5ケースで全13種類・全状態・期限切れpendingの旧11列保持、元試行一意性、凍結中移行拒否を検証。保存世代0046も追加し、2file/25件が成功（8.42s）。Node全1,001件（53file、46.99s）も成功。/tmp/ncf-backups-prune-node.log、/tmp/ncf-backups-prune-unit-all.log。
- 新規workerd9ケースを追加。初回3file/53件は51成功・2失敗（60.93s）。再送拒否試験がspyで増える配列自体を反復していたfixtureと、backup開始後の旧エラー名期待を修正し、削除/一括削除の全48件が成功（26.90s）。/tmp/ncf-backups-prune-targeted.log、/tmp/ncf-backups-prune-targeted-final.log。
- 共通R2・backup開始/完了・inventory・daily・復旧先BACKUPSの6file/162件も成功（145.45s）。schemaの5件と合わせ、関連workerd215件を確認。/tmp/ncf-backups-prune-regression.log。
- private binding運用ドリルが68table・SQL11,350bytesで成功。日次生成と補充、期限切れ世代の回収、全13復旧操作の権限拒否、BLOBS/BACKUPS照合・D1凍結・取消しを確認。S3/Time Travelは合成providerで、remote検証ではない。/tmp/ncf-backups-prune-operator.log、/tmp/ncf-backups-prune.5HtfRI/.wrangler/operator-drill-QHep92/report.json。
- 上記は直前の全体check中に分離した作業コピーで実行し、終了後に本作業ツリーへ反映した。変更17fileの内容一致を確認。本ツリーのlint422file・型・Web build・Worker dry-runも成功。/tmp/ncf-backups-prune-root-typecheck.log、/tmp/ncf-backups-prune-root-build.log。契約/設定検査も成功。今回の全workerd・Windows・browserはpush後のCIで確認する。
- BACKUPSの外部CLI保存・epoch履歴、native結果不明の運用証明は後続。通常68table・依存追加なし、remote resource作成・migration・deployなし。

### 先行するBACKUPS probeの送信記録

- migration0045でBACKUPS接続probeの条件付きPUTを13種類目のR2送信・終了記録へ接続。固定key・null owner、元の復旧要求/試行/nonce/bucket/期待ETagと停止challengeを要求する。DOの原本をgrantの前後・送信直前に検査し、D1 batchでも停止revision/tokenを再検査する。25秒と元challengeの短い方を期限として保持する。
- 全12種類の旧receipt・全状態・期限切れpendingを11列保持するNode5件を追加。0045の保存世代も追加し、2file/24件が成功（7.05s）。/tmp/ncf-backups-probe-node-targeted.log。型・lint420file・契約/設定検査も成功。
- workerd13ケースを追加。初回5file/129件は100成功・29失敗（121.09s）。D1だけ停止revisionを変えた際の精算期待と、時刻全体を進めてD1の受付時計と乖離したfixtureを修正した。後者のtimeoutが後続27件にも影響した。再実行は39/41成功（21.93s）で、残り2件は旧timeout名の期待とその未処理assertionを修正。最終BACKUPS全41件は成功（20.64s）、初回と合わせ関連129件を確認。/tmp/ncf-backups-probe-targeted.log、/tmp/ncf-backups-probe-focus.log、/tmp/ncf-backups-probe-focus-final.log。
- private binding運用ドリルが68table・SQL11,350bytesで成功。13復旧操作の権限拒否、同じchallengeでのBLOBS/BACKUPS照合、D1凍結・実更新拒否・eviction・取消しを確認。S3/Time Travelは合成providerで、remote検証ではない。/tmp/ncf-backups-probe-operator.log、.wrangler/operator-drill-LmV9qJ/report.json。
- 全体checkが成功。Node995件（52file、48.51s）＋workerd2,407件（111file、1,540.61s）、計3,402件。lint420file・型・契約/設定検査・Web build・Worker dry-runも成功。/tmp/ncf-backups-probe-check.log。停止拒否・切断fixtureのworkerdログを含むが、テスト結果と終了コードは成功。検証中のソースは固定し、開始時snapshotとの一致も確認した。
- BACKUPSの保存/削除・epoch履歴、native結果不明の運用証明は後続。通常68table・依存追加なし、remote resource作成・migration・deployなし。

### 先行するBLOBS probeの送信記録

- migration0044でBLOBS接続probeの条件付きPUTを送信・終了記録へ接続。明示null owner、固定system key、元のlease token/nonce/source/期待ETagと復旧の停止revision/tokenを要求する。元の25秒期限を延長せず、grant後にscopeが閉じた場合は送信前にnot_startedを記録する。新しいprobeの成功は古いunknownを解消しない。
- 新規workerd14件を含むprobe・共通受付・復旧先BLOBS・schemaの5file/125件が成功（57.65s）。/tmp/ncf-probe-writes-targeted.log。応答喪失、scope終了、grant待機中のlease/phase/mode/proof変更、timeout後の実成功、凍結/再開拒否を確認した。
- 全11種類・全状態・期限切れpendingの11列保持、元probeの一意性、凍結中移行拒否のNode5件を追加。0044保存世代も追加し、移行/過去世代の2file/23件が成功（6.39s）。/tmp/ncf-probe-writes-node-schema.log。
- 全体checkが成功。Node989件（51file、45.21s）＋workerd2,392件（111file、1,504.86s）、計3,381件を確認。lint418file・型・契約/設定検査・Web build・Worker dry-runも成功。/tmp/ncf-probe-writes-check.log。停止拒否・通信切断fixtureのworkerdログを含むが、テスト結果と終了コードは成功。
- 全体check後の最終レビューで、同期scope確認中に5秒のgrant期限を越えた場合にもPUTを呼んでしまう境界を追加試験で再現（1件失敗、2.95s）。/tmp/ncf-probe-writes-clock-before.log。scope確認直後の時刻再検査を追加し、元の停止challengeの残り時間が25秒より短い場合はprobe全体もその期限を使うようにした。期限境界の新規2ケースを含むR2/probe/upload/GC/復旧の6file/260件が成功（128.14s）。/tmp/ncf-probe-writes-regression-final.log。全体checkと追加2件で計3,383ケースを確認し、追加・修正した境界は最終コードで再検証した。
- private binding運用ドリルが68table・SQL11,350bytesで成功。/tmp/ncf-probe-writes-operator.log、.wrangler/operator-drill-97ylHb/report.json。全13復旧操作の権限拒否、BLOBS/BACKUPSの同じchallengeでの照合、D1凍結・実更新拒否・eviction・取消しを確認。S3/Time Travelは合成providerで、remote運用の検証ではない。
- 期限境界の修正後もlint418file・型・Web build・Worker dry-runとprivate binding運用ドリルが成功。/tmp/ncf-probe-writes-typecheck-final.log、/tmp/ncf-probe-writes-build-final.log、/tmp/ncf-probe-writes-operator-final.log、.wrangler/operator-drill-9ssqjh/report.json。
- BACKUPS側probe・保存/削除・epoch履歴とnative結果不明の運用証明は後続。通常68table・依存追加なし、remote resource作成・migration・deployなし。

### 先行するupload・multipartの送信記録

- migration0043、通常68table。単一/DAV PUT・multipart作成/part/完了と初期化失敗/既知ID cleanup/未知ID inventory/全bucket abortを永続記録へ接続。元のattemptをsource_refに固定し、kindとの一意制約で二重送信を防止。grant待機25秒と送信後の元の15分leaseを分離した。同keyのpendingがある間は予約解放・cleanup完了・GC handoffを拒否する。
- Node全983件（50file、44.16s）が成功。/tmp/ncf-upload-writes-unit-local.log。最初のsandbox内実行ではHTTP受信fixtureがlisten EPERMとなり、CLI stderr試験も失敗したため、ローカル接続を許可した実行で全件を再確認した。
- migration0042→0043の全receipt保持、期限切れpending、元attempt重複、未送信receipt、凍結中移行拒否のNode10件が成功（3.39s）。backup世代検証にも0043を追加した。
- 関連8fileは331件中324件が成功（235.44s）。新規試験の失効先table/cleanup lease設定と、旧abort不明時の精算期待7件を修正し、新規17件＋multipart cleanup36件の53件が成功（38.42s）。/tmp/ncf-upload-writes-focus.log、/tmp/ncf-upload-writes-targeted-final.log。先行する6fileは189件中176件成功、失敗はこのcleanup fixture/旧精算期待に含まれる。
- lint415file・型・契約/設定検査・Web build・Worker dry-runが成功。private binding運用ドリルも68table・SQL11,350bytesで成功。/tmp/ncf-upload-writes-operator.log、.wrangler/operator-drill-NahcX5/report.json。S3/Time Travelは合成providerで、remote検証ではない。
- 全workerdは2,378件中2,324件が成功（110file、1,684.00s）。/tmp/ncf-upload-writes-integration-all.log。初回は5fileの54件が失敗し、終了コードは1。失敗した全ケースは下記355件と復旧監査11件の再実行で成功した。Node983件・workerd2,378件・browser19件を合わせ、再実行を含めローカル計3,380件を検証。このcommitのCIはpush後に確認する。
- 初回の失敗内訳は、終了済み合成R2試行を試験間で精算していなかったDAV/HTTP fixture18件、gc-confirm到達前に期限を使い切った故障注入fixture1件、旧形式のupload IDを直接作っていた復旧fixture2件、backup開始保護の修正前に起動したworkerで新しい試験を読んだ33件。最後の33件は最初のbackupが凍結へ進んだ後、32件がbackup_frozenで連鎖失敗した。fixtureを修正し、新規workerで全失敗ファイルを再確認した。実行中のworkerが読み込んだソースと後から追加した試験が混在したため、以後はソース変更を止めて検証する。
- 最終レビューで、native終了記録が未精算のまま通常backupを開始すると、凍結と精算・元policy復帰が相互に待つ競合を確認。新規backup intent保存前にD1 pendingとDO receiptを検査し、記録の精算後に再試行できるようにした。D1だけ・DOだけの記録を含む3ケースを追加。最終3ケース、backup全経路と全体実行で失敗したfixtureを含む11fileの355件が成功（311.37s）。/tmp/ncf-upload-writes-regression-final.log。
- 最終コードのbrowser全19件が成功（6.6分）。/tmp/ncf-upload-writes-browser-final.log。初回は16/19件成功。検証中のControlDO変更と開発サーバーの再読み込みが重なり、seed 503とfixture再初期化のrecovery_final_fence_pendingが発生した。ソース変更を止めた新規環境で全件を再実行した。
- backup開始保護の修正後もprivate bindingドリルが68table・SQL11,350bytesで成功。/tmp/ncf-upload-writes-operator-final.log、.wrangler/operator-drill-8k8D1p/report.json。
- 旧epoch復旧fixtureのupload IDを実際のup_形式へ合わせ、現epochのmultipart.abort成功receiptも検査。復旧監査11件が成功（12.29s）。/tmp/ncf-upload-writes-audit-final.log。変更した試験のlintと最終型検査も成功。/tmp/ncf-upload-writes-typecheck-last.log。
- 最終コードのlint415file・型検査・Web build・Worker dry-runも成功。/tmp/ncf-upload-writes-typecheck-current.log、/tmp/ncf-upload-writes-build-final.log。productionの期限変更はなく、CIのUbuntu job枠だけ15分→30分へ変更した。
- binding probe/BACKUPS/epoch履歴の全終了統合、native不明の運用証明、新epoch予約・live採用は後続。remote resource作成・migration・deployは実施していない。

### 先行するGCの送信記録

- blob GC（通常・停止中・ゴミ箱復元中）とorphan GCのDELETEを共通のDO/D1送信・終了記録へ接続。実成功の記録後だけ確認HEADへ進み、結果不明はlease満了やHEAD不在で解消しない。claim再取得・deleted精算・復元ready・凍結・再開を保留する。grantのbatchでclaimとdomain条件を再検査し、元の固定期限と復元pause期限を維持する。migration0042、通常68table、依存追加なし。
- 0042は期限切れpendingと全終端行を全フィールド照合して移行し、全索引・freeze/immutable/保留guardを再作成する。orphanのownerは明示nullで、未復元ownerと長いUnicode keyも扱う。Nodeの移行・過去世代・schema関連39件（4file、5.17s）が成功。/tmp/ncf-gc-writes-node-final.log。
- 全体checkのNode972件（49file、43.47s）が成功。workerdは2,358件中2,356件（109file、1,419.03s）が成功し、失敗2件は下記Cron fixture修正後に該当62件の再実行で成功した。再実行を含めローカル計3,330件を検証。全体check自体の終了コードは1で、最終lint411file・型・Web build・Worker dry-runは別実行で成功。契約/設定検査も成功。/tmp/ncf-gc-writes-check.log。
- private binding運用ドリルが68table・SQL11,350bytesで成功。全13復旧操作の権限拒否、D1書込み凍結、実更新拒否、eviction後再照会、停止token更新による取消しを確認。/tmp/ncf-gc-writes-operator.log、.wrangler/operator-drill-RdTDsk/report.json。S3/Time Travelは合成providerで、実remote検証ではない。
- GCの回帰165件（4file、67.80s）が成功。続く6fileは125/126件が成功し、失敗した既存復元試験を「lease満了後も実DELETE終了までreadyを返さない」契約へ更新した。初回のNode失敗はbackup fixtureのFK不足、workerd失敗はRPC stubのbind呼出し、Cron fixtureの新規provider不足、遅延DELETEの旧期待値だった。fixtureと期待を修正し、固定期限試験が目的の受付段階まで到達するよう試験内の時計を調整した。productionの期限は延長していない。/tmp/ncf-gc-writes-regression-second.log、/tmp/ncf-gc-writes-latest.log。
- 先行CIのWindows分割1では1,257/1,258件が成功。失敗はmultipart-bucket-admissionのlease/scan-pageケースで、故障注入前のfixture走査がr2_binding_verification_failedになった。原因は未確定。次回失敗時にprobe phase/last_errorと非閉鎖受付の集計だけを出す診断を追加し、token/nonceは出力しない。自動retryやproduction期限変更は加えていない。
- 診断追加後のmultipart-bucket-admissionはローカル73件（1file、107.75s）が成功。/tmp/ncf-gc-writes-multipart-diagnostic.log。最終lint411fileと型検査も成功。これはWindowsでの再現性確認とは区別する。
- 修正した復元待機の1ケースも単独で成功（1file、6.79s、他28件は選択対象外）。lease満了後もready=false、旧DELETEの実終了後に現claimで回収して一度だけ容量を精算する。/tmp/ncf-gc-writes-restore-final.log。変更13資料のlocal Markdownリンク258件に欠落なし。
- 全体検査中に既存upload/multipart cleanupのCron試験2件が失敗。両fixtureのControlDO代替に送信・終了記録providerが不足していたため追加し、該当2file全62件（35.05s）が成功。production変更はなし。最終lint・型検査・Web build・Worker dry-runも成功。/tmp/ncf-gc-writes-cleanup-final.log、/tmp/ncf-gc-writes-build-final.log。
- 全R2操作の最終終了証明・native結果不明の運用収束・新epoch予約・live上書き/採用は後続。実Cloudflareのresource作成・migration・deployは実施していない。今回のCI/browserはpush後に確認する。

### 先行する空ファイル・manifestの送信記録

- 空ファイルPUT・target manifest PUT/DELETEをDO/D1へ送信前から記録。直接ACKによる一度限りのgrant、実成功/未送信の終端事実、未知結果の保持、停止中の既知終了repair、凍結/再開/対象GC拒否を接続。migration0041、68通常table、依存追加なし。Node16件・workerd34件を追加。
- 全体checkが成功。Node965件（48file、37.34s）＋workerd2,346件（109file、1,267.46s）、計3,311件を確認。lint410file・型・契約/設定検査・Web build・Worker dry-runも成功。/tmp/ncf-r2-writes-check-final.log。停止拒否・通信切断fixtureのworkerdログを含むが、全テスト結果・終了コードは成功。最終資料のlocal Markdownリンクも確認した。
- 最新の経路回帰98件（workerd3file、66.40s）、Node schema/backup92件（4file、21.74s）、旧世代互換性とschema88件（2file、7.15s）が成功。先行する広範囲回帰248件（workerd10file、182.93s）も成功。/tmp/ncf-r2-writes-final-regression.log、/tmp/ncf-r2-writes-latest-node.log、/tmp/ncf-r2-writes-history.log、/tmp/ncf-r2-writes-regression.log。
- private bindingの運用ドリルが68table・SQL11,350bytesで成功。全13復旧操作の権限拒否、凍結、実D1更新拒否、eviction後再照会、停止token更新による取消しを確認。/tmp/ncf-r2-writes-operator-final.log、.wrangler/operator-drill-s6sXpC/report.json。S3/Time Travelは合成providerで、実remote検証ではない。
- 全体検査の初回は最新68tableを旧schemaにも要求するバックアップ互換性問題11件と、schema期待値67の1件で失敗。保存時migrationの検証済みprefixで作った隔離DBに限り当時のtable一覧を使い、現在のcaptureは68tableを必須のままとした。schema0037〜0041の復元を試験へ追加し、ドリルの期待値も更新した。
- 新規経路の先行試験では、同keyの並行空PUTを禁止するindexと旧HEAD回収の期待を修正。各条件付きPUTを個別に記録し、native例外をHEADで成功へ読み替えない。未公開fixture manifestの監査拒否とRPC例外のテストhook波及も修正した。既知終了の24時間超のrepair中に自己receiptを掃除しない試験を追加。
- 全R2操作の最終終了証明・新epoch予約・live上書き/採用は後続。今回のfreezeを手動上書き許可として使わない。実Cloudflareのresource作成・migration・deployは実施していない。最新commitのCI/browserはpush後に確認する。

### 先行するD1凍結の記録

- D1書込み凍結を追加。migration0040・全67通常table guard、DO永続intent、修復受付拒否、正確な対象固定による再照会、取消し時の停止revision/token更新を接続。Node24件・workerd31件を追加。全体checkが成功し、Node949件（47file、38.96s）＋workerd2,312件（108file、1,239.63s）、計3,261件を確認。lint405file・型・契約/設定検査・Web build・Worker dry-runも成功。/tmp/ncf-freeze-check.log。停止拒否・通信切断fixtureのworkerdログを含むが、全テスト結果・終了コードは成功。最後にコメント・試験名だけを修正し、lintとCLI help、変更した11資料の251個のlocal Markdownリンクも確認した。
- 関連Node66件（2file、1.47s）、新規workerd31件（1file、33.05s）が成功。全table guard、CLI入力/再送/秘密非出力、eviction、対象相違、待機中の受付/事前照会後のD1競合、ACK喪失、期限切れ、遅いbatch、25秒timeout、DO保存のABORT/IGNOREと取消しrollbackを検証。/tmp/ncf-freeze-node.log、/tmp/ncf-freeze-workerd-final.log。
- `pnpm backup:operator-drill`が成功。67table・SQL11,350bytes、全13復旧操作の権限拒否、保留予約による凍結拒否、既知の試験用予約解放後の凍結、実D1更新拒否、eviction後再送、取消し時の新しい停止tokenを確認。/tmp/ncf-freeze-operator-drill-final.log、.wrangler/operator-drill-5b3o6C/report.json。S3/Time Travel応答は合成providerで、実remote検証ではない。
- 初回試験ではschema fixtureの列名誤りと既存mutation receiptの削除禁止に当たり、正しい列・receiptを保持するepoch更新へ修正した。専用ドリルの初回凍結は既知の保留予約があるため正しく拒否し、その拒否も期待結果へ追加して全体を再実行した。
- 直前8a220e7の[CI36309001925](https://github.com/daraskme/Nextcloud-flare/actions/runs/36309001925)は全5ジョブ成功。今回はWindows/browser/実CLI backupドリルをローカル再実行していない。schema0040・通常67table・依存追加なし。実Cloudflareの操作は行っていない。
- D1凍結を外部I/O全終了や復元実行許可として扱わない。空object PUT、target manifestのstaging/削除に送信・終了記録の不足を確認し、DATABASE_RESTORE_FREEZE/HANDOFFへ次の接続点を記録した。新epoch予約・実上書き後採用・全監査/段階再開は後続。

### 先行するBACKUPS・一括照合の記録

- BACKUPS照合と同一D1 challengeでのD1/BLOBS/BACKUPS一括照合を追加。Node42件・workerd28件を追加。全体checkが成功し、Node925件（46file、33.40s）＋workerd2,281件（107file、1,219.92s）、計3,206件を確認。lint400file・型・契約/設定検査・Web build・Worker dry-runも成功。/tmp/ncf-backups-check.log。停止拒否・通信切断fixture由来のworkerdログを含むが、全テスト結果・終了コードは成功。最終コメント修正後のlintとCLI helpも成功した。
- 関連Node141件（4file、12.81s）と新規workerd28件（1file、13.16s）が成功。対象固定・取消し・D1-only停止変更・3回の外部予算ACK喪失・nonce/version不一致・保存/lease解放の原子的rollback・遅延create/CAS PUT・同一challengeの現在試行を検証。/tmp/ncf-backups-node.log、/tmp/ncf-backups-workerd.log。初回fixtureでRPC拒否例外が後続hookへ影響したためDO内で捕捉し、Wrangler自身が重複bindingを拒否する境界も試験へ反映して再実行した。
- `.local-toolchain/run pnpm backup:operator-drill`が成功。67table・SQL11,322bytes、全12復旧操作の権限拒否、同一challengeでの3 binding照合、eviction後の新nonce/試行、取消し後拒否を確認。S3 providerは署名と固定URLを確認するローカルfixtureであり、実remote照合とは区別する。/tmp/ncf-backups-operator-drill.log、.wrangler/operator-drill-mkog45/report.json。
- Nodeのnative TypeScript読込みとWorkerのbundleが同じ共有validatorを使えるよう、noEmitの型検査で.ts importを許可した。D1 schema0039・通常67table・依存は維持。実Cloudflareの操作は行っていない。
- DESIGN §11.3の古い時刻ベースepoch・抽出開始時のbarrier解除・lease期限だけでの復元開始を、BRIEF §8と現在の実装契約へ整合させた。最終停止・復元専用epoch予約・採用は未実装として明記し、DATABASE_RESTOREへ次工程で確認すべきDO/D1の境界を記録した。
- 直前0e298b2の[CI36290565335](https://github.com/daraskme/Nextcloud-flare/actions/runs/36290565335)は全5ジョブ成功。今回のWindows・browser・実CLI backupドリルはローカル再実行していない。

### 先行するBLOBS照合の記録

- 復旧先BLOBSの対象固定・fresh probe照合・DO観測保存を追加。Node40件・workerd26件を追加。全Node883件（45file、36.24s）が成功。`.local-toolchain/run pnpm check`で全workerd2,253件（106file、1,260.46s）も成功し、計3,136件を確認。lint394file・型・契約/設定検査・Web build・Worker dry-runも成功。/tmp/ncf-blobs-check.log。停止拒否・切断fixture由来のworkerdログを含むが、テスト結果・終了コードは成功。
- `vitest run --config vitest.config.ts`でprobe/共通受付の関連workerd106件（3file、40.01s）が成功。取消し、待機中のD1停止変更、外部予算ACK喪失、誤bucketの古いnonce、保存失敗、時計逆行、25秒timeoutと遅延継続、eviction後の対象固定を検証。/tmp/ncf-blobs-workerd.log。
- `.local-toolchain/run pnpm backup:operator-drill`が成功。67table・SQL11,322bytes、全9復旧操作の権限拒否、実BLOBS probeの更新・再起動後の新nonce照合・取消し後拒否を確認。S3 providerは固定URL/署名形式を確認するローカルfixtureで模擬し、remote照合とは扱わない。/tmp/ncf-blobs-operator-drill.log、.wrangler/operator-drill-1lxITR/report.json。初回はfixtureのS3秘密値が既存設定検査の最短長に満たず失敗し、テスト値を修正して全ドリルを再実行した。
- 直前26d0ef3の[CI36288518080](https://github.com/daraskme/Nextcloud-flare/actions/runs/36288518080)はUbuntu・Windows両分割・backup・browserの全5ジョブが成功。前回修正したWindows一時pathの正規化も確認済み。
- schema0039・通常67table・依存は維持。今回はWindows・browser・実CLI backupドリルをローカル再実行していない。実Cloudflareのresource作成・migration・deploy・Time Travel・S3接続は行っていない。

### 先行するTime Travel bookmark照合の記録

- Time Travel候補の準備・時刻検索照合・DOへの証言保存を追加。Node42件・workerd24件を追加し、全Node843件（44file、43.33s）が成功。/tmp/ncf-bookmark-unit.log。
- bookmark/D1対象/復旧準備/復旧元/受付の関連workerd144件（5file、131.49s）が成功。時刻競合の試験が実際にD1読取り後まで到達することを強めた後、新規24件も再確認（8.78s）。/tmp/ncf-bookmark-regression.log、/tmp/ncf-bookmark-workerd-final.log。既存LockDO拒否fixtureのadmission_closedログを含むが、テスト・終了コードは成功。
- named service bindingドリルが成功。67table・SQL11,322bytesの世代検証に加え、全8復旧操作の権限拒否、合成remote descriptor/provider応答によるbookmark証言保存、eviction後の新challenge再実行、取消し後拒否を確認。/tmp/ncf-bookmark-operator-drill.log、.wrangler/operator-drill-CpShcr/report.json。実remote検索・復元の証明ではない。
- lint389file・型・契約/設定・Web build・Worker dry-runが成功。/tmp/ncf-bookmark-{lint,typecheck-final,contracts,config,build}.log。D1 schema0039・通常67table・依存は維持。
- 今回は全workerd・Windows・browser・実CLI backupドリルをローカル再実行していない。Nodeの子プロセスとworkerdのlocalhost待受けがsandboxで拒否されたため、テスト範囲を変えず制限外で再実行した。実Cloudflareの操作は行っていない。

- 直前7b39e93の[CI36153888412](https://github.com/daraskme/Nextcloud-flare/actions/runs/36153888412)は両Windowsジョブで一時pathのRUNNER~1/runneradmin比較が失敗。実装の正規化に合わせて既存D1対象試験のfixtureをrealpathへ解決するよう修正。実Windowsでの結果は今回のCIで確認する。

### 先行する復旧先D1照合の記録

- 復旧先D1の照合を追加。Node39件、workerd23件を追加し、全Node801件（43file、39.33s）が成功。/tmp/ncf-restore-d1-unit-final.log。
- 復旧先/復旧準備/復旧元/受付停止の回帰118件（4file、109.70s）と、保存時のRETURNING確認・追加2境界を含む最終D1照合23件（8.89s）が成功。重複を除くworkerd120件。/tmp/ncf-restore-d1-regression.log と /tmp/ncf-restore-d1-target-final.log。
- named service bindingドリルが成功。67table・SQL11,322bytesの世代検証に加え、復旧全7操作の権限拒否、新しいD1停止tokenの独立照合、eviction後の再検証、取消し後拒否を確認。/tmp/ncf-restore-d1-operator-drill.log、.wrangler/operator-drill-7WSuJO/report.json。
- 前回の隔離local fixtureを再利用したD1対象の実CLIドリルも成功。prepare→verify-d1→新challengeでの再実行→別DB設定拒否→cancel→再検証拒否を確認。source自体は未検証の選択であり、このドリルをSQL検証やR2照合の証明に使わない。/tmp/ncf-restore-d1-cli-drill.log、.wrangler/backup-run-drill-mNzlxg/d1-target-report.json。継続的なCLI検証はbackup:run-drillにも追加したが、今回その全行程はローカル再実行していない。
- lint385file・型・契約/設定・Web build・Worker dry-runが成功。buildは/tmp/ncf-restore-d1-build.log。今回のworkerd検証は上記関連範囲で、全体checkの再実行はpush後のCIで確認する。
- 先行1285adfの[CI36134958172](https://github.com/daraskme/Nextcloud-flare/actions/runs/36134958172)はUbuntu・Windows両分割・backup・browserの全5ジョブ成功。今回のcommitのCIとは分けて扱う。

### 先行する復旧専用CLIとSQL検証の記録

- 復旧専用CLIとSQL検証証言を追加。Node34件、DO/RPC10件を追加し、全Node762件（42file、47.52s）と関連DO/RPC24件（11.06s）が成功。型・lint380file・契約/設定検査も成功。
- 実named service bindingドリルが67table・SQL11,322bytesで成功。復旧全5操作について、異なる環境・backup用purpose・権限設定なし・backupだけ有効の4種を拒否。実SQL世代の検証・証言保存、eviction後の再実行、取消し後の停止保持を確認。/tmp/ncf-restore-operator-drill-final.log。
- 実CLIドリルも67table・SQL9,079bytesで成功。Wrangler dev/getPlatformProxyでprepare再送→verify→inspect→cancelを確認し、取消し後のverify拒否と元epoch・書込み/GC停止保持も確認。/tmp/ncf-restore-cli-drill.log。
- 全体checkが成功。Node762件（42file、47.52s）＋workerd2,180件（103file、1,479.63s）、計2,942件。lint380file・型・契約/設定検査、Web build・Worker dry-runも成功。/tmp/ncf-restore-operator-check.log。今回追加した34件＋10件を含む。
- 先行1ac31bfの[CI36131132194](https://github.com/daraskme/Nextcloud-flare/actions/runs/36131132194)は全5ジョブ成功。da90db7の[CI36130676778](https://github.com/daraskme/Nextcloud-flare/actions/runs/36130676778)も全5ジョブ成功。CLI追加1285adfのCI成功は冒頭の記録を参照。

### 先行する復旧元照合の記録

- 専用codex/database-restoreへab05fc5・3b96ea2・da90db7をpush済み。[CI36130676778](https://github.com/daraskme/Nextcloud-flare/actions/runs/36130676778)はbrowser成功・残り実行中。共有mainは更新していない。
- 追加修正: 完了後の再照会の競合と時計逆行により保存済み観測時刻を上書きできる問題を修正前に再現。CASへ観測時刻・期限も含め、DO/RPC14件（9.02s）、lint375file・型検査が成功。/tmp/ncf-restore-source-refresh-repro.log と /tmp/ncf-restore-source-refresh-final.log。復旧元照合の新規試験は計42件、関連は重複を除き115件。追加修正の全体CIはpush後に別実行で確認する。
- 復旧元の部品/receipt/期限/遅延応答の28件、DO/RPC/cursor/再起動/取消し/時計逆行の13件を追加。転送fixtureを実SQL復元の証明として扱わない。
- 世代照合・復旧準備・既存受付再開の関連113件（4file、117.56s）が成功。さらに時計逆行を修正前に再現し、追加・修正後のDO/RPC全13件も成功（1file、8.27s）。重複を除く関連114件を確認。ログはローカル /tmp/ncf-restore-source-final.log と /tmp/ncf-restore-source-controller-final.log。
- lint375file・型・契約/設定・Web build・Worker dry-runが成功。ビルドは /tmp/ncf-restore-source-build.log。現在の変更に対する全体CIはpush後に確認する。
- 直前の復旧準備commit 3b96ea2は全体checkが成功。Node728件（41file、40.16s）とworkerd2,128件（101file、1,300.64s）、計2,856件。全体ログは /tmp/ncf-restore-check-final.log。
- ab05fc5の監視付き実CLIドリル（SQL9,079bytes）は成功済み。共有mainへのpushは個別承認待ち。専用codex/database-restoreブランチのCI結果と混同しない。
- schema0039・通常67table・依存を維持。remote migration・deploy・実通知送信・D1復元は実行していない。

## 今回の実装

以下の既存checkpoint行は当時の検証記録を維持する。最新状態は冒頭と[CURRENT_STATE](CURRENT_STATE.md)を参照。

| 項目 | 成果物 / 実証内容 | 状態 |
|---|---|---|
| 4 復旧先D1の照合 | 対象固定・fresh停止token・独立Wrangler query・DOへの5分の観測 | Node39件/workerd23件追加。全Node801件・関連workerd120件と実binding/CLI成功。実上書き・R2照合は後続。[DATABASE_RESTORE_TARGET](DATABASE_RESTORE_TARGET.md) |
| 4 復旧準備CLIとSQL証言 | 独立capability、prepare/verify/inspect/cancel、全SQL再検証とDOへのhash証言 | Node34件・DO10件追加。全checkの2,942件と実binding/CLI両ドリルが成功。[DATABASE_RESTORE_OPERATOR](DATABASE_RESTORE_OPERATOR.md) |
| 4 logical復旧元の照合 | 完了receipt・R2 manifest/部品hash・35日・永続cursor・実ControlDO RPC | 新規42件。関連115件。追加修正と先行版の検証範囲は冒頭参照。SQL/schema再検証は専用CLIへ追加済み。最終停止・実D1上書きへの接続は後続。[DATABASE_RESTORE_SOURCE](DATABASE_RESTORE_SOURCE.md) |
| 4 D1復旧準備 | DO外部I/O前の要求保存・世代選択固定・停止維持・照会/取消し・遅延処理の排他 | workerd28件成功。全体の最終検証は冒頭。準備はD1上書き許可ではなく、最終停止・新epoch採用・実復旧は後続。[DATABASE_RESTORE](DATABASE_RESTORE.md) |
| 4/9 バックアップ実行監視 | monitor-directory・host SQLite・独立watchdog・HTTPS通知・同じIDで再送・短時間の失敗保持・復旧通知・service/timer例 | Node32件追加。秘密非出力、時計、並行送信とACK喪失、loopback受信fixture、実CLIを検証。最終Node728件と監視付き実CLIドリルが成功。結果は冒頭参照。schema0039・通常67table・依存を維持。[BACKUP_MONITORING](BACKUP_MONITORING.md) |
| 4 期限切れ世代の自動走査 | ControlDO永続round/cursor・固定年齢/最大ID、100 step、既知破損保留、maintainとservice例の明示option | Node22件・workerd13件を追加。eviction、100件超の不在receipt、途中削除、応答喪失、破損保留、epoch/backup競合、期限を検証。全checkの計2,796件と専用binding/実CLIドリルが成功。詳細は冒頭参照。schema0039・通常67table・依存を維持。[BACKUP_SWEEP](BACKUP_SWEEP.md) |
| 4 期限切れSQL世代の明示回収 | 専用prune、D1/R2世代照合、35日超・20部品/100RPC、manifest最終削除・再実行 | Node12件・workerd26件を追加。全Node674件（39file、30.53s）、回収26件と既存完了17件の計43件（12.79s）が成功。専用bindingドリルは67table・SQL11,322bytesで成功。実CLIドリルもSQL9,079bytesで成功し、期限内拒否・回収・再実行・receipt保持を確認。全check成功、Node674件＋workerd2,087件（99file、1,143.07s）の計2,761件。型・契約/設定検査・Web build・Worker dry-run、最終lint361fileも成功。期限試験の時計設定を調整後、回収26件（6.29s）と型検査を再確認しました。schema0039・67table・依存を維持。[BACKUP_PRUNING](BACKUP_PRUNING.md) |
| 4 日次運用と世代補充 | maintain・完了ID照合・不足/鮮度補充・定時起動例 | Node18件・workerd8件を追加しました。Windowsと同じ並列数・上限を指定した全Node661件（38file、40.70s）が成功。その後追加した鮮度回復を含む補充18件（151ms）も成功し、重複を除く662件を確認しています。バックアップ関連workerd87件（4file、43.78s）、lint356file・型・契約/設定検査・Web build・Worker dry-runも成功しました。Windows実機側の結果は今回のCIで再確認します。 実ControlDO/D1/R2の専用bindingドリルで、日次1世代と追加4世代を作り、5世代すべての検証、eviction後の再実行で世代が増えないこと、取得・隔離復元を確認しました。7操作の権限拒否、67table・SQL11,322bytesも確認済みです。実CLIのdaily/run/receipt/health/download/restore-offlineもSQL9,079bytesで成功し、maintainが旧epochを変更前に拒否することを確認しました。成功する5世代補充は専用bindingドリルで検証しています。 timer設置・外部通知・期限切れ削除・remote/live復旧は未完了。[BACKUP_MAINTENANCE](BACKUP_MAINTENANCE.md) |
| 4 バックアップ保持判定 | inventory/health、サーバー時刻・実R2/SQL検証、35日/最少5世代/最新24時間、終了コード | Node27件・workerd23件を追加しました。全Node644件（37file、34.40s）と、バックアップ関連workerd79件（4file、43.54s）が成功。実際に保存した5世代の全SQL検証と、1世代の破損によって有効数が4へ減ることを確認しました。35日の前後1ms、24時間、検査中の期限超過、同時開始、eviction、205行のページング、破損/不正receipt、検査上限と秘密情報の非出力を含みます。lint354file・型・契約/設定検査・Web build・Worker dry-runも成功しました。 専用bindingの実D1/DO/R2ドリルは67table・SQL9,582bytesで成功し、inventoryを含む6操作の権限・環境・無効化による拒否を確認しました。実CLIのdaily→再実行→receipt→health→download→restore-offlineもSQL9,079bytesで成功しました。healthは保存済み1世代を検証し、不足4世代と終了コード2を返し、元の停止状態を変更しませんでした。 外部通知・自動補充/削除・live復旧は未接続。[BACKUP_RETENTION](BACKUP_RETENTION.md) |
| 4 日次バックアップ | ControlDOの永続ID、UTC取得日、同日R2/SQL再検証、公開済み世代の再開 | Node17件とworkerd17件を追加しました。全Node617件（36file、33.23s）、バックアップ関連workerd55件（3file、36.73s）、その後追加した日跨ぎ完了を含む日次17件（3.93s）が成功し、重複を除く関連56件を確認済みです。lint349file・型・契約/設定検査・Web build・Worker dry-runも成功しました。 専用service bindingの実D1/DO/R2ドリルは67table・SQL9,582bytesで成功し、dailyを含む5操作の権限・環境・無効化による拒否を確認しました。実CLIのdaily→同日再検証→明示run再送→receipt→download→restore-offlineもSQL9,079bytesで成功しました。 定時起動の設置・保持/不足通知・live復旧は未完了。[BACKUP_OPERATOR](BACKUP_OPERATOR.md) |
| 4 値を保持するデータ出力 | typed query・BLOB hex・NUL TEXT・bounded writer、旧世代互換 | Node16件を追加し、統合後の全600件（36file、18.58s）が成功しました。schema0039の3ドリルも成功し、通常CLIは67table/SQL9,755bytes、専用bindingは9,582bytes、実CLI run→receipt→download→restore-offlineは9,079bytesでした。実D1でUnicode・引用符・CR/LF・literal backslash・NUL・BOM、BLOBと似たTEXT、NULL・小数の保持を確認しています。保存済み0037/0038/0039世代の実CLI検証も成功。lint348file・契約/設定検査も成功しました。 [BACKUP_EXPORT](BACKUP_EXPORT.md) |
| 4 過去schemaと全table照合 | 信頼済みprefix、保存当時のschema、未知table/view/virtual・抽出中schema変更の拒否 | 過去世代の検証と抽出漏れ防止にNode19件を追加し、GC保護との統合後は全584件（35file、19.17s）が成功しました。保存済み0037/0038世代を実CLIで検証・復元し、当時のschema・凍結・FKを維持しています。実D1で全table一覧の前後照合を含む3ドリルも成功し、従来CLIは67table/SQL9,599bytes、専用bindingは9,613bytes、実CLI run→receipt→download→restore-offlineは9,110bytesでした。lint346fileも成功。Worker本体とmigrationはGC検証後に変更していません。詳細は[BACKUP_HISTORY](BACKUP_HISTORY.md)。 |
| 4 バックアップ用GC保護 | migration0039、35日猶予、最終参照trigger、再参照競合、WebDAV空ファイルの直接削除除去 | Node565件（34file、18.55s）が成功しました。workerd全体は2,013件中2,012件が成功し、失敗した1件は旧仕様の即時削除を期待するDAV試験でした。35日以内の削除拒否・容量保持と期間経過後の回収へ更新し、そのfileの17件（7.06s）が成功。再実行を含めworkerd全2,013件を確認しています。lint345file・型・契約/設定検査、Web build・Worker dry-runも成功しました。schema0039の実D1試験5件と、従来CLI（67table・SQL9,599bytes）、専用binding（9,613bytes）、実CLI run→receipt→download→restore-offline（9,110bytes）の3ドリルも成功しました。この変更のCIはプッシュ後に確認します。 [BACKUP_GC_PROTECTION](BACKUP_GC_PROTECTION.md) |
| 4 バックアップ運用コマンド | BackupOperator、run/receipt/cancel、実service binding・CLIドリル、local R2保存先修正 | Node25件を追加し、全552件（33file、19.71s）が成功しました。専用bindingの実ControlDO/D1/R2ドリルは67table・SQL9,613bytesで成功し、全4操作の権限/環境/無効化、eviction後の再実行、取消・履歴、復元先のFTS/会計を確認しました。R2保存先修正後の実CLI run→receipt→download→restore-offlineもSQL9,110bytesで成功し、同じ引数の再実行と元policyへの復帰を確認しています。従来CLIのcapture/publish/download/restore-offlineも修正後に67table・SQL9,599bytesで成功しました。全体checkも成功し、Node552件＋workerd2,009件（95file）の計2,561件、lint・型・契約・設定検査、Web buildとWorker dry-runを確認しました。 運用コマンドは専用service bindingを持つ信頼されたSQL検証者向けです。最新の元BLOBS削除猶予は[BACKUP_GC_PROTECTION](BACKUP_GC_PROTECTION.md)を参照。remote認証・日次/保持管理・live復旧は後続です。 [BACKUP_OPERATOR](BACKUP_OPERATOR.md) |
| 4 バックアップ完了記録 | completeBackup、永続cursor/hash、R2検証、原子的receipt/解除、migration0038 | Node22件・workerd18件を追加し、全体checkが成功しました。Node527件（32file、14.22s）・workerd2,009件（95file、1,085.53s）、計2,536件を検証しています。lint335file・型・契約/設定検査・Web build・Worker dry-runも成功。schema0038で実CLIのcapture→verify→local R2 publish→download→restore-offlineが67table・SQL9,599bytesで成功しました。今回commitのCI/browserはプッシュ後に確認します。 completeBackupは内部RPCです。SQL/source/schema/FK/FTSの全検証は信頼された生成コマンドが担い、ControlDOはそのhashでR2実体を再検査します。利用者が指定したhashを転送する公開APIは追加していません。CLIからの認証付き運用接続、元BLOBSの保護、live復旧、全storage喪失からの運用復旧は未完了です。 [BACKUP_COMPLETION](BACKUP_COMPLETION.md) |
| 4 バックアップR2保存・取得 | objectStore/publication、publish/download CLI、実local R2を含むdrill | Node41件を追加し、全505件（30file、12.43s）が成功。lint329file・型・契約/設定検査も成功しました。実Wranglerのcapture→verify→local BACKUPS publish→download→restore-offlineが67table・SQL9,599bytesで成功し、実R2の条件競合、FTS/FK/容量、元DBの凍結保持を確認しました。8MiB超の複数part、途中失敗からの再開、ACK喪失、同時公開、改変/欠落、期限・本文上限・署名を試験しています。Worker本体・schema0037・通常67table・依存は変更していません。 保存対象はD1の論理SQLで、元のBLOBS object本体は含みません。barrier解除・backup_runs.completed・live復旧は未接続です。local R2は検証済み、remote S3経路は実装済みですが実環境では未検証です。途中失敗partのdeleteや自動回収は行いません。 [BACKUP_GENERATIONS](BACKUP_GENERATIONS.md) |
| 4 バックアップ世代・オフライン復元 | pnpm backup、capture/verify/restore-offline、専用local drill、backup CI job | Node32件を追加し、全464件（28file、8.08s）が成功。lint324file・型・契約/設定検査も成功しました。実Wranglerのcapture→verify→restore-offlineが全67table、SQL9,599bytesで成功し、元DBの凍結、容量、FTS検索を確認しました。欠落/内容変化、不正SQL、世代/schema/checksum不一致、既存出力保護、UTF-8/文上限/途中切れを試験しています。Worker本体・migrationは変更せず0037/通常67tableを維持。新しいbackup CI jobで同じドリルを実行します。今回のCIはプッシュ後に確認します。 [BACKUP_GENERATIONS](BACKUP_GENERATIONS.md) |
| 1/4 バックアップ書込み停止 | migration0037、ControlDOの永続barrier、watermark、全通常table guard、前のpolicyへ原子的復帰 | Node5件・workerd21件を追加。全体checkが成功し、Node432件（27file、7.90s）・workerd1,991件（94file、1,075.05s）、計2,423件を検証しました。旧schemaの移行、全通常tableのguard、同時刻の確定順序、ACK/primary喪失、遅延開始/解除、元のpolicy、総storage喪失、解除途中のrollbackを含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。実Wranglerのローカル67table data-only抽出と、隔離SQLiteへの同一schema復元・FK/容量一致・FTS再構築も成功しました。R2実体・運用経路・epoch更新を含む復旧試験とremote exportは未検証です。schema0037/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。 [BACKUP_BARRIER](BACKUP_BARRIER.md) |
| 1/3/7 DAV長時間転送 | migration0036、本文後のpermit、未結合操作IDの原子的公開・回収 | Node3件・workerd25件を追加。全体checkが成功し、Node427件（26file、6.34s）・workerd1,970件（93file、1,051.32s）、計2,397件を検証しました。31秒転送、元の認可・revision・lock維持、実ControlDOの共有枠・停止・eviction、未結合台帳の回収競合、前方移行を含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。schema0036/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。 [DAV_UPLOAD](DAV_UPLOAD.md) |
| 1/3/7 DAV PUTの保存台帳 | migration0035、直接ACK/条件付きPUT、所有spaceの保存事実/失敗精算、24h回収/GC | Node2件・workerd47件を追加。全体実行はNode424件（25file、6.25s）・workerd1,944/1,945件（91file、1,010.68s）成功。唯一の失敗は移行数の旧期待値34で、35へ修正後に実D1のschema5件（2.71s）が全成功しました。ローカル計2,369件を検証済みです。最終lint・型・契約/設定・Web build・Worker dry-runも成功。Windows分割は実Vitestの91fileを46/45fileへ重複・欠落なしと確認し、CIでの実行結果は別途確認します。schema0035/通常67table、依存追加なし。 [DAV_UPLOAD](DAV_UPLOAD.md) |
| 1/3 upload公開失敗後の精算受付 | 所有space・DB-only補償・厳密な保存証明と再照会 | workerd51件を追加（境界46件・実ControlDO4件・HTTP1件）。関連109件（66.06s）と実ControlDO4件に加え、全体checkが成功。Node422件（25file、6.20s）・workerd1,898件（87file、990.88s）、計2,320件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 [UPLOAD_FAILED_COMPLETION](UPLOAD_FAILED_COMPLETION.md) |
| 1/4 旧epoch修復の全体受付 | 所有spaceの予約/通知・global FTS、原子的な停止条件、同一ControlDO | workerd67件を追加（境界59件・実ControlDO8件）。追加67件（14.72s）・既存復旧23件（12.96s）と全体checkが成功。Node422件（25file、5.81s）・workerd1,847件（85file、983.56s）、計2,269件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 全体check後にCI試験を調整し、KDF統合20件（7.15s）・待機列Node8件（104ms）・lint・型検査を再確認しました。 [RECOVERY_REPAIR](RECOVERY_REPAIR.md) |
| 1/4 全bucket multipartの全体受付 | scan/parts/abortの8経路、所有者なし、直接ACK、固定期限、同一ControlDO | workerd82件を追加（境界73件・実ControlDO9件）。関連109件（97.66s）と全体checkが成功。Node422件（25file、5.68s）・workerd1,780件（83file、971.26s）、計2,202件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 [MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md) |
| 1 未追跡object調査・回収の全体受付 | scan/GCの10経路、所有者なし、直接ACK、固定期限、同一ControlDO | workerd105件追加（境界93件・実ControlDO12件）。全体check成功、Node422件（25file、6.01s）・workerd1,698件（81file、888.73s）、計2,120件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 [ORPHAN_INVENTORY](ORPHAN_INVENTORY.md) |
| 1 所有者なし更新の全体受付 | migration0034・global RPC・R2 probe、通常と同じ枠 | Node6件・workerd68件追加（probe境界58件・実ControlDO等9件・移行1件）。全体check成功、Node422件（25file、6.04秒）・workerd1,593件（79file、851.58秒）、計2,015件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。診断表示の追加後も関連59件（44.02秒）と型検査が成功。schema0034/通常67table、依存追加なし。 [MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1 Queue送信・受信の全体受付 | 所有spaceの5経路、直接send ACK、current認可、終端のread-only再照会、固定25秒batch | workerd57件追加（境界51件・実ControlDO6件）。全体check成功、Node416件（25file、5.55秒）・workerd1,525件（77file、778.32秒）、計1,941件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。S3タイムアウト試験の修正後88件（261ms）も成功。schema0033/通常67table、migration・依存追加なし。 [OUTBOX](OUTBOX.md) |
| 1/4 既存uploadの未知multipart調査受付 | round・予算・観測・ID/page・中止receipt・lease返却・エラー、同一ControlDO受付 | workerd66件追加（境界59件・実ControlDO7件）。全体check成功、Node416件（25file、5.90秒）・workerd1,468件（75file、755.11秒）、計1,884件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 [MULTIPART_INVENTORY](MULTIPART_INVENTORY.md) |
| 1/3 blob GCの全体受付 | 通常/停止中/復元中、claim・外部予算・精算・エラー、同一ControlDO受付 | workerd80件追加（GC境界73件・実ControlDO7件）。全体check成功、Node416件（25file、5.66秒）・workerd1,402件（73file、705.27秒）、計1,818件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 [MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1/3 upload自動回収の全体受付 | claim・外部予算・観測・閉鎖・精算・エラー、ControlDO直接受付 | workerd62件追加。90c4593のローカル全check成功、Node416/workerd1322、計1,738件。CIは以下の実行記録参照。 [MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1/3 UploadDO台帳の全体受付 | 初期化・通常反映・停止反映・喪失時停止、dirty/alarm/容量保持 | workerd33件追加。8892b4fのローカル全check成功、Node416/workerd1260、計1,676件。CIは以下の実行記録参照。 |
| 1/3 復旧用更新の全体受付 | migration0033、system/mode不変、共有32/256、物理観測・既知ID・初期化停止・直接ACK claim | Node8件/workerd41件追加。f9dffcbのCI全成功、Node416/workerd1227/browser19、計1,662件。 [MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1/3 upload中止/検証の全体受付 | single/multipart利用者中止、multipart検証済み情報、exact receipt/返却、遅延PUTの容量保持 | workerd45件追加。f62dad8のCI全成功、Node408/workerd1186/browser19、計1,613件。 [MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1/3 upload転送の全体受付 | 単一start/recover/verify・multipart start/complete、current authority/claim/receipt/返却、直接ACKのみdispatch | workerd45件追加。47160c4のCI全成功、Node408/workerd1141/browser19、計1,568件。 [MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1/3 upload予約の全体受付 | 単一/分割・新規/上書きの共有32枠、quota/blob/uploadと確定記録/解放を同一batch、既存receiptは読取りのみ | workerd42件追加。e90ee88のCI全成功、Node408/workerd1096/browser19、計1,523件。[MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1/2 配信更新の全体受付 | budget・ticket発行/交換/取消しの共有32枠、コンテンツ所有space、待機後の現行認可/期限と確定記録、取消し証明後のR2 manifest削除 | workerd70件追加。522f616のCI全成功、Node408/workerd1054/browser19、計1,481件。[MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1 session・初回owner・logout受付 | migration0032、space作成前も共有32枠、既存JWTのread-only照合、変更/確定記録/解放を一括保存 | Node4/workerd22件追加。8e7243eのCI全成功、Node408/workerd984/browser19、計1,411件。[MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1 app password更新受付 | 発行・失効・pepper更新を共通32枠へ接続、KDF後取得、変更/確定記録/解放を一括保存、混雑503 | workerd32件追加。既存認証55件と最終境界60件、計1,366件を検証。旧fixture1件修正後の再検証・残るgateも成功。[MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1 DAVロックの全体受付 | migration0031、LOCK/refresh/UNLOCK共有枠、lock変更・確定記録・枠解放の一括確定、60秒保持と索引cleanup | Node4/workerd22件追加、対象Node8/workerd72件成功。全check1,334件（Node404/workerd930）成功。HTTP token再取得・別RPC結果再生は未実装。[MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1 namespace全体受付 | migration0030、ControlDO/D1 active32・waiting256・5秒、LockDO全8許可経路、失効と復旧fence、HTTP 503 | 追加21件と全check1,308件成功。全account経路・backup barrier・実環境は後続。[MUTATION_ADMISSION](MUTATION_ADMISSION.md) |
| 1 KDF終了記録repair | ControlDO SQLite最大20件の送信前記録と終端proof、D1精算の再照合、停止中内部RPC、ローカル未解決も復旧再開fence | 追加14件で応答喪失/eviction/遅延/重複/未知保持を検証済み。終了証明を失った試行は保持。実環境未検証 |
| 1 KDF全体制限 | migration `0029`、D1 rate/未精算台帳、ControlDO固定PBKDF2、600受付/65秒・20未精算枠、通常instance内1件、epoch cooldown、発行/認証/鍵更新 | 新規Node7件・workerd20件と既存認証34件成功。応答喪失/取消し/601回目/HTTP503/実RPCとstorage喪失を検証。終了証明を失った試行の運用収束・共有/IP制限・実環境は未完了。[KDF_ADMISSION](KDF_ADMISSION.md) |
| 4 upload行喪失時のmultipart中止 | migration `0028`の不変attempt台帳、正確なhandleの1回dispatch、fresh proof、同一ID再送、64件予算、10秒待機、ControlDO接続 | 新規19件でhold維持、稼働upload/lease、claim/receipt応答喪失、proof期限、遅い応答と上限を検証。全体閉鎖・精算・実S3は未完了。[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md) |
| 4 upload行喪失時のmultipart容量保留 | migration `0027`の3table、全`u/`走査、正確なkey/ID対応、partページと最大観測bytesのowner physical計上、ControlDOと復旧fence | 27件でページ上限/競合/応答喪失/所有者復元/整数上限/0-byte再開拒否を検証。全体閉鎖・精算・実S3は未完了。[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md) |
| 4 multipart修復の対応検証接続 | 毎回fresh nonceでBLOBS/S3を照合し、claim・page・abort・physical観測・lease解放を同一batchのproof fenceで保護。停止/GC pause必須、保存済み成功を再利用しない | 誤bucket・旧nonce・失効・応答喪失の境界を追加。全体閉鎖・容量精算・実S3は未完了。[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md) |
| 5 要求時のフォルダー集計 | Access account stats、所有folderの再帰件数/現在のlogical bytes、同一batch認可と1万件上限、Files情報dialog | D1追加12件、既存検索9件の回帰。最終全check/browser結果は実行記録。[FOLDER_STATS](FOLDER_STATS.md) |
| 5 フォルダー配下検索 | Access API、正規化/部分一致、scope10,000/page200、現行認可と検索専用cursor、Files検索/元保存先保持。子一覧更新後のrename/move索引修正 | query/cursor、実D1境界、browser検索/201件pagination/更新競合。最終結果は実行記録。[SEARCH](SEARCH.md) |
| 2/3 配信leaseの期限 | DOのbyte期間内のlease、旧有効leaseの保持、R2 HEAD/GETと応答bodyへの期限伝播、取消し・1回限りの精算 | Node追加20件、workerd追加6件と既存境界。最終結果は実行記録。[CONTENT_LEASES](CONTENT_LEASES.md) |
| 2/3 作成receiptの回収 | 応答喪失後に対象revisionが進んでも同じkey/ID/capabilityを再取得し、中止できる。旧本文/確定は拒否し、二重予約/R2再初期化をしない | workerd HTTP追加5件、browser追加2件。最終結果は実行記録。[UPLOAD_OVERWRITE](UPLOAD_OVERWRITE.md) |
| 2/3 上書きupload UI・配信対象budget | 確認付き上書き、target snapshot/元file名保持、single/全part If-Match、競合拒否、完了応答喪失/分割再開。BudgetDOの重複しない対象台帳と使用量保持、CORS error | browser追加3件、workerd追加6件と既存境界を検証。全check結果は実行記録。[UPLOAD_OVERWRITE](UPLOAD_OVERWRITE.md) / [BUDGET_ALLOWANCE](BUDGET_ALLOWANCE.md) |
| 1/2 本文なしHTTP操作 | DAV MKCOLの415誤判定を修正。COPY/MOVE/DELETE/UNLOCK、private ticket/app-password取消し、logoutに5秒・16read上限の共通EOF検査 | Node境界13件、workerdの待機中失効/停止2件を追加。独立HTTPのDAV操作・ticket発行/交換/取消しを検証。全結果は実行記録。[EMPTY_HTTP_BODY](EMPTY_HTTP_BODY.md) |
| 1 KDF isolate内制限 | app password作成・検証・pepper更新で同時1件、待機256件・5秒、取消し・例外時解放、503再試行、計算前のAccess/root検査 | Node境界8件、workerd追加9件と既存23件が成功。全check/browserの結果は実行記録。ControlDO/D1全体制限は上記へ接続済み。[KDF_ADMISSION](KDF_ADMISSION.md) |
| 4 通常稼働中のtrash復元 | migration `0026`、永続GC pause、管理者設定保持、既存deleting drain、原子的なoperation/token/epoch/期限assertと解放alarm | 実ControlDO/LockDO/D1/R2の29件とschema制約1件を追加。連続alarm失敗6回で閉じる。実browserの復元・応答喪失再照会。詳細は[RESTORE_GC](RESTORE_GC.md) |
| 2/3 Files UI | React/TanStack、認証付きprivate build graph、一覧・操作・trash・single/multipart再開upload・複数タブlogout | ローカル実APIのbrowser試験8件とCSRF/operationのNode4件を追加。restoreもGC稼働中のfixtureで検証。詳細・残作業は[FILES_UI](FILES_UI.md) |
| 1/4 ControlDO受付再開 | migration `0025`、永続revision/tokenと監査proof、最終batch fence、repair hold、受付→GC段階再開 | 実ControlDO/LockDO/D1/R2、HTTP bootstrap、応答喪失・停止/epoch競合・eviction/全喪失の追加27件が成功。全check結果は実行記録。実環境・完全restore・account mutation・終了証明を失ったKDFの運用収束は未完了 |
| 4 停止中GC drain | migration `0024`のclaim epoch/counter、blob/orphanの既存deleting回収、ControlDO内部RPCと監査再初期化 | 新規25件を含む全check1,022件が成功。全復旧監査fixtureは成功、実環境・完全restore・admission再開は未完了 |
| 4 R2/S3対応検証 | migration `0023`、固定64-byte system probe、fresh nonce/CAS PUT、scope内D1 fence、ControlDO検証と復旧監査 | 全check997件（Node330/workerd667）が成功。遅延PUT・応答喪失・誤bucket・scope/epoch/leaseと監査を検証。全体閉鎖/予約精算への接続と実S3試験は未完了 |
| 4 multipart ID修復 | migration `0022`のscan/handle台帳、既存uploadの未知複数ID走査・実BLOBS abort、immutable receipt、予約hold、physical観測、ControlDO停止中repair | 実D1/R2/DOで複数ID/ページ・応答喪失・遅延ID・epoch/token/pin/lease・S3障害会計を検証。毎回freshな対応検証との接続は追加済み。全体不在証明・予約精算・upload行ごと失われたIDの中止・実S3は未完了 |
| 4 multipart S3診断 | 署名付きListMultipartUploads/ListParts/lifecycle取得、1 GET・最大100件・1 MiB・10秒、厳密XML/echo/markerと停止中ControlDO診断 | Node/workerdで署名・失敗境界、D1 maintenance/epoch fence、監査再初期化と予約保持を検証。対応検証と既存uploadの未知ID中止は別serviceへ接続済み。全体閉鎖・実S3接続は未完了 |
| 3 private multipart HTTP | 既存routeのcreate/part/status/page/complete/abort、Upload-Attempt-Id、D1 receipt snapshot、期限切れ後照会、中止CAS、初期化結果不明receipt | 実Access JWT/CSRF/D1/R2/DOで再送・上書き・page・失効・中止/確定・遅延part・初期化応答喪失・入力境界を検証。基本Files UIとローカル実admissionは接続済み。公開共有・実環境は未実装 |
| 4 未知完成物inventory | migration `0021`の2table、bounded R2 list/HEAD、D1 cursor/lease、35日grace、owner physical会計、独立GCとキー再利用拒否、Cron/停止中ControlDO inventory/復旧監査 | 応答喪失、並行処理、置換・再出現、owner復元、pause/epochを実D1/R2で検証。incomplete multipart、他prefix、実環境は未完了。停止中の既存deleting回収は追加済み |
| 3 multipart回収 | migration `0020`の永久停止markerと閉鎖証明、独立cleanup budget、R2 abort/HEAD、physical計上/予約精算/GC、Cron/停止中ControlDO repair、DO alarm停止 | 応答喪失、競合、遅延init/HEAD、旧epoch、pin、未知metadata隔離、DO全喪失、偽GC handoff拒否を実D1/R2/DOで検証。未知IDの外部inventory修復は未完了。Files UIは接続済み |
| 3 multipart確定 | migration `0019`の一度限りcomplete attempt・object proof、paged manifestからR2 complete/HEAD、LockDO/D1原子的公開、旧版保持、DO terminal照合 | D1/R2/DOで応答喪失・同時確定・失効・physical会計・全10 step rollbackを検証。R2 abort/期限切れcleanupは既知IDで接続済み、private HTTPは接続済み |
| 3 multipart D1/R2 part接続 | migration `0018`の固定geometry・ledger marker・revision、D1予約、1回限りR2 create、認可RPC・dirty part mirror、streaming R2 part/SHA-256、停止再送alarm | 実D1/R2/DOで64 MiB+末尾、応答喪失、同時claim、失効/予約解除競合、storage全喪失を検証。R2 complete/head・原子的公開は追加済み。既知ID cleanupは接続済み、private HTTPは接続済み |
| 3 単一upload回収 | migration `0017`のcleanup lease、24時間後のHEAD、実physical計上/予約精算/GC handoff、CronとControlDO停止中repair、汎用reservation bypass防止 | 実D1/R2/DOでabsent/present、応答喪失、並行claim、遅延HEAD、epoch/pin競合、metadata隔離、原子性、bounded scanを検証。未知object全般・実Cronは未完了 |
| 3 private単一upload | migration `0016`、専用HMAC capability、D1予約、1回限りR2 PUT/SHA-256、応答喪失GET照合、原子的新規/上書きcomplete、status/abort HTTP | 実D1/R2/LockDO、10 step rollback、同時送信、失効/応答喪失、CSRF/Origin、stream deadlineを検証。公開共有、UIは未実装 |
| 3 multipart台帳 | UploadDOの内部SQLiteにattempt/leaseと独立counterを永続化。固定分割、4並列/3試行、unknown→aborting、idle/deadline、旧epoch失敗、complete/abort排他、200件page | Node/workerd検証。D1認可/予約/mirror、R2 create/partは内部接続済み。complete/原子的公開は追加済み。既知ID cleanupは接続済み、private HTTPは接続済み。Phase 3完了ではない |
| 0.1 toolchain | Node/pnpm/TS/Wrangler/Vitest/fflate を exact 固定、pnpm lockfile、公開日証拠 `toolchain.json`、CI | ローカル実装済み |
| 0.1 binding | 全 Env binding、SQLite DO の eviction 後の永続化、未実装 route は fail closed、未処理 Queue は retry | ローカル実装済み |
| 0.1 KDF/Images | PBKDF2-SHA256 100,000/16B/32B を OpenSSL の vector と照合。PNG→WebP。20,000,000B/寸法/40MP のアプリ入力境界 | ローカル実装済み、実サービス gate は未完了 |
| 0.2 D1 barrier | `changes()` の直前 statement 性、CHECK rollback、G01 node/tree/trash、全8必須 step の zero-row 注入、前後 EXISTS fallback | workerd D1 で実証 |
| 0.2 outcome | 例外の分類、commit 後の応答喪失を注入して primary で terminal を照合、最大3回/5秒、未確定503 | ローカル実装済み |
| R6 #2 の probe | expired-open/revoked/released/wrong-space permit、old epoch、失効/期限切れ session、disabled actor | 最小 fixture で実証。全 principal 認可は Phase 1 |
| 0.3 streams | FixedLengthStream + DigestStream を直列供給。0B/3B/95,000,000B、長短 mismatch、R2 条件不成立、slow consumer/cancel | ローカル実装済み |
| 0.3 Range | R2 部分取得、HTTP probe の206/416/HEAD/304、suffix/open-ended/多重 Range の正規化 | ローカル実装済み |
| 2 immutable blob read 基盤 | current `node.read` assertion と node/blob/物理観測行を同一 D1 batch で照合し、R2 key の owner/blob 束縛、object のサイズ/ETag、D1 content ETag、HEAD/206/304/416、If-Range、MIME/Disposition、no-store/nosniff を内部 helper で処理 | 実 D1/R2 binding と失効競合で検証。purpose、content session、BudgetDO、公開 route は未接続 |
| 6 content blob read 基盤 | 署名 ticket の D1 現行検査→発行元 ticket 束縛 content session→署名 Cookie→node/blob/R2 manifest と current credential を同一 D1 batch で検証。内部共有は選択した share root と対象ノードの祖先関係を同じ batch で確認 | private/匿名 share の実 D1/R2、共有外への移動、失効・share version・hash 競合、復旧監査で検証。content/GET/HEAD 以外の経路は未接続 |
| 6 BudgetDO 基盤 | `budget_id` の SQLite 永続 counter、target bytes×3、1024 requests/10分、8並列、10分 lease/alarm、unknown 全額消費。配信 GET/Range/HEAD/304 の reserve/settle を内部ストリームに接続。D1 trigger で owner あたり active budget 64件を制限 | eviction、上限、失効後の再初期化、実 R2 配信と64/65件境界を workerd で検証。budget 発行・全 route 接続は未完了 |
| 6 budget 確保基盤 | `u:<user>`、`u:<user>:s:<share>`、`s:<share>:c:<unlock>` の ID を D1 で再利用。node/owner、選択 share root、現行 credential、expiry、maintenance を同一 batch で検査し、revoke は再有効化しない | private・app password・内部共有・匿名共有、別 tab 相当の再確保、共有外への移動、失効と停止、最大長 ID の ticket 署名を workerd で検証。target set/ticket の内部発行サービスは実装済み。HTTP 発行 route は未接続 |
| 6 target set/ticket 発行基盤 | 最大1,000件の target を決定的 JSON と SHA-256 で R2 に staging・読戻し検証し、全 node/blob/share の現行認可、budget、ticket と target set を D1 batch で確定。応答喪失後は D1 を再照合し、未確定 object を削除 | private・内部共有・匿名リンク、複数 target、credential 失効競合、D1 応答喪失を workerd で検証。HTTP 発行 route は未接続 |
| 6 ticket 取り消し基盤 | current credential を確認し、ticket と派生 content session を同じ D1 batch で失効。budget は他 ticket と共有するため維持 | 再実行、Cookie と redemption の失効、別 credential・失効 session の拒否、D1 応答喪失後の照合を workerd で検証。HTTP 取り消し route は未接続 |
| 6 private ticket HTTP handler | app host の Access JWT→D1 session→CSRF 発行→同一 origin・bounded JSON の ticket 発行/取消を Worker entry に接続。ticket 期限は Access session 期限以内 | RS256 JWT、実 D1/R2、CSRF、session 登録から取消、JWT 欠落と設定欠落の拒否を workerd で検証。ControlDO は maintenance 固定で公開停止、remote issuer/AUD/署名鍵/bootstrap 設定は未完了 |
| 1 private account HTTP | `/api/v1/me` は current credential/user/space/quota を照合、logout は CSRF 後に D1 session と派生 content session を失効して Access logout に 303 | RS256 JWT、CSRF 欠落拒否、logout 後の再入場拒否を workerd で検証。ブラウザーのstate削除・複数タブ通知・navigationをFiles UIへ接続済み |
| 2 Files read HTTP | app の node 詳細、root-first breadcrumb、children 一覧を `node.read` 祖先証明＋maintenance の D1 batch に接続。path は同一space/ownerのlive親を最大64 edge、一覧はkeyset最大200件。専用 HMAC cursor は parent/credential/epoch/tree generation/最終 sort key/期限を束縛 | 実 D1 でpath、201件を2ページ、改変・期限切れ・tree変更・他user・maintenanceを拒否。remote cursor ringは未設定。Files UIは接続済み |
| 4 trash read/restore/purge/GC | trash一覧、restore、purgeを接続。purgeはmigration `0014`のmanifestからFK順・深さ降順に確定し、7日猶予candidate化。migration `0015`のGC claimはpause/epoch/ref/複数pinを原子的に再検査し、R2 delete/head後だけdeleted/physical精算 | REST冪等再送、別trash子、深いsubtree、Outboxに加え、実R2削除、複数pin、pause、delete応答喪失、lease再取得、一方向stateを実D1/R2で検証。基本Files UIは接続済み。GC稼働中restoreのpause holdは未接続 |
| 2 folder create HTTP | `POST /api/v1/nodes` の bounded JSON、CSRF、Idempotency-Key を LockDO/permit/D1 の folder mutation に接続。`GET /api/v1/operations/:id` は同 credential の current operand/result を照合 | 実 LockDO/D1 の作成・再送・照会、CSRF 欠落、異 payload の409を workerd で検証。test-only admission であり実 ControlDO 再開は未実装 |
| 2 Files mutation HTTP | private REST の `DELETE /nodes/:id`、`POST /nodes/:id/move`、`POST /nodes/:id/copy` を CSRF、bounded JSON、Idempotency-Key、LockDO、固定 subtree manifest、atomic trash/MOVE/COW COPY へ接続。REST operation は `node.trash` / `node.move` / `node.copy` として DAV と区別し、consumer・復旧監査も両 provenance を検証 | copy→move→trash、各 namespace 結果、Outbox 消費、operation kind、削除後の同一 DELETE 再送を実 D1/DO で検証。ローカル実ControlDOとFiles UIを接続済み。実環境は未検証 |
| 6 content HTTP 基盤 | content host の `/session` POST/OPTIONS と `/c/:nodeId/:blobId` GET/HEAD を ticket/Cookie、現行 D1 認可、BudgetDO、R2 に接続。exact Origin CORS、署名鍵と ControlDO/D1 admission の gate | handler で Cookie 発行から実 R2 配信を workerd 検証。ControlDO は maintenance 固定で実公開は停止、署名鍵・remote host inventory 未設定。page/entry/track/ZIP と全 route 会計は未完了 |
| 0.3 / ZIP配信基盤 | STORE serializer、空folder、固定v2 manifest、認可付きsubtree snapshot、正確なbudget bytes、期限付きpinとcleanup | 内部基盤をローカル実装済み。ticket/API/stream/画面は未接続 |
| 1.1 契約・schema | 58通常テーブル + FTS、147経路、scope/operation catalogue、FK index/削除順の生成、tree/terminal/session/accounting guards | migration と基盤契約を追加。全機能の状態遷移・認可は未完了 |
| 1.1 primary adapter | Sessions API を避け、全 authority query を直接 D1 binding へ発行 | 修正・回帰確認済み |
| R6 #4 epoch | SQLite pending→R2 history→D1 mirror→公開、eviction/storage loss、例外後の照合、単一 ControlDO | ローカル実装済み。admission/復旧 verifier/再開は未完了 |
| 1 ControlDO quiesce | 停止側 DO status→D1 maintenance/GC pause→permit revoke/claimed failed を atomic に収束。D1 応答喪失時の postcondition 照合、active job lease 診断、SQL 障害 rollback | 内部 RPC 実装。停止中GC drainはローカル接続済み。admission/再開と実環境は未完了 |
| 1 復旧監査ページ | D1 quiesce、bootstrap/admin/root、owner ledger/ref、R2 HEAD size/etag と list 全件の D1 blob/derivative/archive 照合、outbox provenance/lease、share 予約量・root・version、credential の参照先種別・有効 scope root と4種の参照元 registry 行を各最大20件ずつ検証。FTS5 `integrity-check` (`rank=1`) と予約・未完了 upload・旧 outbox 等の最終 D1 fence を追加。完了後の再照会でも最終 fence を再確認し、失敗時は監査を先頭に戻す。停止中の FTS `rebuild`、旧 epoch の upload に紐づかない予約の bounded release と、旧 epoch `node.created` / `node.renamed` の bounded failed 収束は監査を初期化。ControlDO SQLite の epoch/token/R2 cursor 永続化、eviction・失敗ページ再試行・旧 epoch 拒否を実証 | 診断・限定修復。credential/share/outbox の全意味検証、他 event kind の cleanup、他prefix/不正な既知keyの repair、incomplete multipartの全体閉鎖、残るUpload/Queue drainと再開gateは未完了。既存deletingのGC drainは接続済み |
| R6 #3 session | fingerprint 一意登録、logout tombstone、同 user の content session 失効、job chunk の current-credential assertion | JWT verifier/内部 login に接続済み。HTTP 経路は未接続 |
| R6 #5/#6 schema | revoked scope detach、削除中 blob 復帰禁止、single upload 全49遷移の検証 | DB制約、同期purge、R2削除GC、private単一uploadと期限切れ回収を実証。multipartの既知R2 ID cleanup・private HTTPは接続済み |
| 1 auth/JWKS | jose exact、固定 issuer/AUD、user/service 分離、KV1h・既知 stale24h、single-flight/rate/鍵数/size/timeout 上限 | Node/workerd 検証済み。rate は isolate 単位、実 Access/MFA policy gate は未完了 |
| 1 app password Basic 基盤 | `ap_<ULID>` と32B secret の厳密な HTTPS/DAV 入力、HMAC pepper kid＋PBKDF2-SHA256 100,000回の16B salt/32B digest、D1 current credential/epoch/maintenance の認証前後照合 | 実 D1 で成功、誤 secret、browser Origin/JWT 混在、失効競合を検証。旧 kid 成功時の条件付き再ハッシュと D1 応答喪失後の再照合を検証。DAV 入口は rate limit、Basic 認証、root 相対 path 解決、Class 1 OPTIONS、file GET/HEAD/Range、PROPFIND Depth 0/1、MKCOL、原子的 PROPPATCH、95 MBまでのstreaming PUT、原子的COPY/MOVEを接続。remote pepper secret 設定は未接続 |
| 7 DAV conditions | RFC 4918 `If` の tagged/untagged、condition AND、全 list production OR、`Not`、state token、strong/weak ETag と独立 token submission、単一 `Lock-Token` を bounded parser/evaluator に実装 | 8 KiB、resource tag/list 各16、全64・各list16 condition、token/ETag/URI長を unit fixture で検証。same-origin current D1 path/ancestor lock/ETag stateを評価し、提出tokenをMKCOL/PROPPATCH/PUTのLockDO/D1 assertionへ接続。不一致412、malformed 400、条件が常真でも必要token未提出は423。`Lock-Token` はUNLOCK以外で400 |
| 7 DAV lock | bounded `lockinfo` XML、Depth、Timeout、既存 node の exclusive write LOCK、未存在pathのlocked empty file作成、空 body + `If` tokenのrefresh、UNLOCKをHTTP/LockDO/D1へ接続。lock-nullは空R2 blob/物理観測/file node/親/tree/search/activity/outbox/lockを10-step `dav.lock` fsMutationで同時確定。tokenはhashのみ保存し、refresh/UNLOCKは同userとcurrent write認可を再検証。PROPFINDはexclusive write `supportedlock` と直接・祖先infinity lockのmetadata/取得時lockrootを返しtokenは非表示。LOCK公開前にactive permit不存在を原子的に検査 | 既存200・lock-null201・UNLOCK204、直後の0-byte GET、lock/permit競合423、期限切れpermit回収、条件不一致412、token再利用409、timeout最大1時間、直接/継承`lockdiscovery`を実D1/R2で検証。PUT/DELETE/COPY/MOVEはlock fence済み |
| 1 app password private API | Access/CSRF 付き `GET/POST/DELETE /api/v1/app-passwords`、一度だけ返す32B secret、DAV 用 node scope、所有者 root、20件・90日既定/365日上限、同 batch の credential/scopes/派生 content session 失効 | 実 D1 で発行→一覧→Basic 認証→失効、別 user root・admin scope・20件上限を検証。remote pepper 設定は未完了 |
| 1 bootstrap | allowlist、初回 admin/space/root の atomic CAS、競合/rollback/応答喪失、暗黙 signup 禁止 | ローカル D1 で実証 |
| 1 node authorize | EffectiveLive、4 principal の scope/root/grant/current credential、commit 時 revision/tree/epoch/parent/blob assertion。rename は root と share/scope root を拒否し、edit/node:write を要求。content/property write は edit/node:write を要求し、content write は file に限定 | read/create/rename/content/property write/automation の内部基盤。残る operation の認可は未完了 |
| R6 #7 CSRF | session 束縛 HMAC、TTL1h、再利用・再発行、purpose/aud/epoch/credential、current session/share、Origin 境界 | 内部サービスと D1 テスト実装済み。HTTP profile 接続待ち |
| 1 quota/ref/pin | owner/share reservation、unique logical、R2 HEAD physical、ref≤1,000、pin-only除外、各再送の一度だけ計上 | migration/内部サービス実装済み。GC/repair/namespace mutation 接続待ち |
| 1 D1 permit | space ごとの open 一意、identity固定、期限 revoke+claim failed+次 grant の atomic batch、応答喪失、old commit 拒否 | D1 primitive 実証。create/rename/property write 用 LockDO へ接続済み |
| 1 LockDO | create/rename/property write 認可と ancestor/対象/親 lock、intent 永続化、eviction/storage loss、新 epoch recovery、同 user 別 credential の token 検査 | ローカル実装。ControlDO admission 成功側は test fixture、実再開 gate 待ち |
| 1 operation claim | bounded canonical intent、同一 credential/key、claim 競合/応答喪失/current auth、lookup の情報制限 | create/rename/PROPPATCH/PUT/trash/COPY/MOVE の内部サービス実装。DAV PROPPATCH、MKCOL、PUT、DELETE、COPY、MOVE は HTTP 接続済み |
| AVIF/AV1/Opus 追加要件 | bounded container sniff、実 codec の MIME、native 再生可否 probe、AVIF 原本 fallback | 単体20件。track parser/content/UI 接続は後続 phase、詳細 `MEDIA_FORMATS.md` |
| 1 fsMutation/create | node/parent/tree/search base/FTS/activity/outbox/terminal を一括確定。全必須 step の0行 rollback、並行再送、commit 応答喪失 | 内部サービス実装。公開 HTTP/実 ControlDO admission は未接続 |
| 1 rename mutation | 対象と親の lock/認可/permit、node/parent/tree revision、FTS の旧語削除と新語追加、activity/outbox/terminal を D1 batch で確定。実 LockDO 経由の実行、同一キー再送、異なる意図の衝突、失効後の拒否、衝突時 rollback を検証 | 内部サービス実装。公開 HTTP/実 ControlDO admission は未接続 |
| 1 名前/検索索引 | NFC/portable/byte/scalar、固定 Unicode 17 full casefold、NFKC/かな統一/bigram、同名拒否 | 名前検索を private API / Files UI へ接続済み。media metadata の全文索引・索引更新の運用・実 D1 の性能 gate は未完了 |
| 1 outbox producer | D1 lease→ID-only Queue send→sent、応答喪失/lease 回収/旧 sender/fast completed、bounded repair scan。Worker scheduled handler と毎分 Cron を設定し、ControlDO/D1 admission 後に最大50件を送る | ローカル接続済み。ControlDO が maintenance 中のため実送信は停止。実 Cron/Queue/DLQ 配信は未検証 |
| 1 outbox consumer 基盤 | `node.created` と `node.renamed` の current credential/権限、30秒 claim、元 operation step による由来確認、terminal CAS を D1 で検証。ID-only Queue の terminal ack と claim 中の再送抑止を追加。Worker Queue handler は ControlDO status と D1 mirror の一致を admission gate にして consumer に接続 | ControlDO が maintenance 中のため実 delivery は retry。実 Queue/DLQ、残る kind、再開は未完了 |

`packages/worker/test/fixtures/d1-schema.sql` は最小 probe schema であり、本番 migration ではない。
`src/db` と `src/platform` の基盤コードも公開 route には接続していない。
ControlDO は内部 RPC の epoch 発行・復旧を実装したが、maintenance / GC pause を解除しない。
LockDO は各 namespace mutation と DAV lock 用の内部 RPC を実装したが、実 ControlDO の admission は閉じている。UploadDO はmultipart台帳・認可付き内部RPC・D1 mirror・alarmを接続済み。WorkerのR2 create/part/completeと原子的公開をprivate HTTPへ接続済みだが、実admissionは閉じている。BudgetDO の内部 RPC と content HTTP handler は動作するが、ControlDO admission が閉じ、署名鍵も未設定のため実公開は停止している。実装契約・残る境界は [`FOUNDATION.md`](FOUNDATION.md) を参照。

## Toolchain の判断

- 選定日 2026-09-21、公開日 cutoff 2026-09-14 00:00 UTC。直接依存の registry 証拠は `docs/toolchain.json`。
- jose 6.2.12 は2026-09-22に追加選定、公開日2026-09-05で既存 cutoff も満たす。Node/workerd の署名検証に使用。
- unicode-case-folding 1.1.1 は2026-09-22に追加選定、2025-10-01公開。Unicode 17.0.0 公式 C/F 表1,585件と全未割当 mapping の一致を確認。公開日・公式表の hash は `toolchain.json`。
- React/TanStack/Radix/TailwindとPlaywrightを2026-09-24に追加選定。既存cutoff以前のexact版とpeer/licenseを`toolchain.json`に記録。browser依存はWorker bundleへ入れない。
- `pnpm-workspace.yaml` の `minimumReleaseAge: 10080` で推移依存にも7日の公開期間を要求。
- 使用する `@cloudflare/vitest-pool-workers@0.22.0` は Vitest 4 の `cloudflareTest` API。旧 `defineWorkersConfig` は使わない。
- pool 同梱 workerd が 2026-08-15 のため、compatibility_date を同日へ固定。設計の例示値 2026-09-21 を設定して黙って古い runtime に fallback させない。staging もこの値で検証し、更新時に gate を再実行する。
- Wrangler 自体は4.131.1、同梱 workerd は2026-09-11。staging でのランタイム差は未検証。
- pnpm 12 の `allowBuilds` を使用し、esbuild/workerd の install script だけを許可。
- 公式参照: [Workers tests](https://developers.cloudflare.com/workers/testing/vitest-integration/)、[FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/)、[DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[R2 binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。依存の実際の API は固定した package の型定義とも照合した。

## 未完了の gate / 次の実装

1. 承認された staging inventory で全 binding/環境 marker/Access を照合し、実 D1 で同じ SQL barrier を再実行する。今回の「応答喪失」は commit 後の fault injection であり実ネットワーク断ではない。
2. Images 実サービスの20MB境界・codec・dimension、KDF CPU/cost、R2転送/キャンセルを計測する。ローカル Images は Miniflare 実装なので料金やサービス限界の証拠にしない。
3. Phase 1 残り: outbox の実 Queue ack/DLQ、他 kind の result CAS と repair、残る operation tuple の authorize/LockDO。account mutation / 終了証明を失ったKDFの運用収束、backup barrier、残るHTTP surface/CSRFの接続も必要。isolate内KDF実行制限は接続済み。全監査後の内部RPC受付再開はローカル実装済み。
4. R6 §8 の残りの fixture と仕様 v0.7 反映を Phase 1 内で閉じる。Files core/upload/trash/GC の本実装は Phase 1 gate 後。

## M/U/I/R と復旧

- **M**: `0001`〜`0026` を追加し、隔離 D1 と SQLite へ適用して61通常table、FK/CHECK/trigger/FTS/会計/permit/operation/outbox identity/trash keyset/purge manifest/GC claim/upload transfer/cleanup lease/multipart geometry・marker・revision・completion proof・永久停止/閉鎖証明を確認。リモート DB は未変更。probe schema は別 test file に隔離。
- **U**: Node の Range/Images 入力/長さ/commit分類・期限/SQLite テスト。
- **I**: Windows と NixOS のローカル workerd binding テスト。初回 CI の Windows 改行失敗を `.gitattributes` で修正し、[2fd68ac の CI](https://github.com/daraskme/Nextcloud-flare/actions/runs/35629022538) は Windows/Ubuntu 両方で成功（media 込み350 tests 時点）。今回の453 tests と前回の450/448/447/446/443/442/440/439/437/436/433/429/426/422/415 tests は以下のローカル実行記録。最新 HEAD の CI は GitHub Actions で照合する。
- **R**: 本番状態を変更していないため production rollback は N/A。依存更新の rollback は manifests/lockfile/toolchain記録を同じ版へ戻して frozen install。テスト R2 object は test 内の finally で削除する。
- 開発 state の破棄は dev 停止後に、このリポジトリ配下の `.wrangler/state` だけを対象として行う。実行前に絶対パスを確認する。staging/production の state や既存 bucket を削除しない。

## 実行記録

- 2026-09-25、日次運用と自動補充を追加。Node18件・workerd8件を追加しました。Windowsと同じ並列数・上限を指定した全Node661件（38file、40.70s）が成功。その後追加した鮮度回復を含む補充18件（151ms）も成功し、重複を除く662件を確認しています。バックアップ関連workerd87件（4file、43.78s）、lint356file・型・契約/設定検査・Web build・Worker dry-runも成功しました。Windows実機側の結果は今回のCIで再確認します。 実ControlDO/D1/R2の専用bindingドリルで、日次1世代と追加4世代を作り、5世代すべての検証、eviction後の再実行で世代が増えないこと、取得・隔離復元を確認しました。7操作の権限拒否、67table・SQL11,322bytesも確認済みです。実CLIのdaily/run/receipt/health/download/restore-offlineもSQL9,079bytesで成功し、maintainが旧epochを変更前に拒否することを確認しました。成功する5世代補充は専用bindingドリルで検証しています。 保持判定は`3609dae`までmainへプッシュ済みです。[CI36085658959](https://github.com/daraskme/Nextcloud-flare/actions/runs/36085658959)はUbuntu・backup・browserが成功しましたが、Windowsの両ジョブでNodeテスト/fixture準備の時間上限に達しました。今回、Windowsの単体試験を2並列・テスト30秒・準備60秒へ調整しました。製品の期限は変更していません。直前の日次実行`221952f`の[CI36084559502](https://github.com/daraskme/Nextcloud-flare/actions/runs/36084559502)は全5ジョブ成功です。

- 2026-09-25、保持判定と不足/破損レポートを追加。Node27件・workerd23件を追加しました。全Node644件（37file、34.40s）と、バックアップ関連workerd79件（4file、43.54s）が成功。実際に保存した5世代の全SQL検証と、1世代の破損によって有効数が4へ減ることを確認しました。35日の前後1ms、24時間、検査中の期限超過、同時開始、eviction、205行のページング、破損/不正receipt、検査上限と秘密情報の非出力を含みます。lint354file・型・契約/設定検査・Web build・Worker dry-runも成功しました。 専用bindingの実D1/DO/R2ドリルは67table・SQL9,582bytesで成功し、inventoryを含む6操作の権限・環境・無効化による拒否を確認しました。実CLIのdaily→再実行→receipt→health→download→restore-offlineもSQL9,079bytesで成功しました。healthは保存済み1世代を検証し、不足4世代と終了コード2を返し、元の停止状態を変更しませんでした。 日次バックアップは`221952f`までmainへプッシュ済みです。[CI36084559502](https://github.com/daraskme/Nextcloud-flare/actions/runs/36084559502)はUbuntu・Windows 2/2・backup・browserが成功し、Windows 1/2は確認中です。今回の保持判定もローカル検証が完了しました。今回のCIはプッシュ後に確認します。

- 2026-09-25、日次バックアップとrunnerのローカル喪失からの再開を追加。Node17件とworkerd17件を追加しました。全Node617件（36file、33.23s）、バックアップ関連workerd55件（3file、36.73s）、その後追加した日跨ぎ完了を含む日次17件（3.93s）が成功し、重複を除く関連56件を確認済みです。lint349file・型・契約/設定検査・Web build・Worker dry-runも成功しました。 専用service bindingの実D1/DO/R2ドリルは67table・SQL9,582bytesで成功し、dailyを含む5操作の権限・環境・無効化による拒否を確認しました。実CLIのdaily→同日再検証→明示run再送→receipt→download→restore-offlineもSQL9,079bytesで成功しました。 直前の`3b897ea`までmainへプッシュ済みで、[CI36083116061](https://github.com/daraskme/Nextcloud-flare/actions/runs/36083116061)はWindows2分割・Ubuntu・backup・browserの全5ジョブが成功しました。今回の日次実行もローカル検証が完了しました。今回のCIはプッシュ後に確認します。

- 2026-09-25、Node22件・workerd18件を追加し、全体checkが成功しました。Node527件（32file、14.22s）・workerd2,009件（95file、1,085.53s）、計2,536件を検証しています。lint335file・型・契約/設定検査・Web build・Worker dry-runも成功。schema0038で実CLIのcapture→verify→local R2 publish→download→restore-offlineが67table・SQL9,599bytesで成功しました。今回commitのCI/browserはプッシュ後に確認します。 完了までのcursor/hashをDO SQLiteへ保存し、evictionや途中失敗から同じ世代を継続できます。commitとprimary照合の両応答を失ってもintentを保持します。遅延R2/DB要求、同時検証、cancel/次世代との競合を検査し、元がclosedならclosedへ戻して保留uploadの容量も維持します。migration0038はterminal receiptの必須形状と不変性を追加します。通常67tableは維持しています。 completeBackupは内部RPCです。SQL/source/schema/FK/FTSの全検証は信頼された生成コマンドが担い、ControlDOはそのhashでR2実体を再検査します。利用者が指定したhashを転送する公開APIは追加していません。CLIからの認証付き運用接続、元BLOBSの保護、live復旧、全storage喪失からの運用復旧は未完了です。

- 2026-09-25、Node41件を追加し、全505件（30file、12.43s）が成功。lint329file・型・契約/設定検査も成功しました。実Wranglerのcapture→verify→local BACKUPS publish→download→restore-offlineが67table・SQL9,599bytesで成功し、実R2の条件競合、FTS/FK/容量、元DBの凍結保持を確認しました。8MiB超の複数part、途中失敗からの再開、ACK喪失、同時公開、改変/欠落、期限・本文上限・署名を試験しています。Worker本体・schema0037・通常67table・依存は変更していません。 保存対象はD1の論理SQLで、元のBLOBS object本体は含みません。barrier解除・backup_runs.completed・live復旧は未接続です。local R2は検証済み、remote S3経路は実装済みですが実環境では未検証です。途中失敗partのdeleteや自動回収は行いません。 今回のCIはプッシュ後に確認。
- 2026-09-25、直前commit `2b6f23f`の[CI36072846945](https://github.com/daraskme/Nextcloud-flare/actions/runs/36072846945)は全5ジョブ成功。Ubuntu7m42s、Windows 1/2は14m50s・2/2は13m40s、browser2m14s、backupドリル2m31s。Node464・workerd1,991・browser19、重複を除く計2,474件と67tableの復元を確認しました。今回のR2保存・ダウンロードはこのCIには含まれず、プッシュ後のCIで確認します。

- 2026-09-25、WebDAV PUTは本文保存後に公開用の30秒permitを取得する方式へ変更しました。31秒を超える実転送でも公開でき、本文受信中にnamespace permitや共通更新枠を保持しません。 Node3件・workerd25件を追加。全体checkが成功し、Node427件（26file、6.34s）・workerd1,970件（93file、1,051.32s）、計2,397件を検証しました。31秒転送、元の認可・revision・lock維持、実ControlDOの共有枠・停止・eviction、未結合台帳の回収競合、前方移行を含みます。lint・型・契約/設定・Web build・Worker dry-runも成功。schema0036/通常67table、依存追加なし。今回のcommitに対するCI/browserはプッシュ後に確認します。
- 2026-09-25、直前commit a9b8af2はmainへプッシュ済み。[CI36064368977](https://github.com/daraskme/Nextcloud-flare/actions/runs/36064368977)は全4ジョブ成功。Ubuntu6m46s、Windows 1/2は16m1s（46file/1,057件）、2/2は12m19s（45file/888件）、browser2m6sです。Node424・workerd1,945・browser19、重複を除く計2,388件を確認しました。Windows分割後も全件とbuild/dry-runを通過し、前回の30分上限中断を解消しました。今回の転送と公開の分離はこのCIには含まれません。

- 2026-09-25、WebDAV PUTの保存前に予約・staging blob・転送台帳を原子的に保存し、保存結果が不明でも容量を保持する処理を実装しました。保存事実と公開失敗後の精算は、実ownerの共通32 active/256 waiting枠を通ります。 Node2件・workerd47件を追加。全体実行はNode424件（25file、6.25s）・workerd1,944/1,945件（91file、1,010.68s）成功。唯一の失敗は移行数の旧期待値34で、35へ修正後に実D1のschema5件（2.71s）が全成功しました。ローカル計2,369件を検証済みです。最終lint・型・契約/設定・Web build・Worker dry-runも成功。Windows分割は実Vitestの91fileを46/45fileへ重複・欠落なしと確認し、CIでの実行結果は別途確認します。schema0035/通常67table、依存追加なし。
- 2026-09-25、直前commit101a7bbはmainへプッシュ済み。[CI36060684164](https://github.com/daraskme/Nextcloud-flare/actions/runs/36060684164)はUbuntu（5m）・browser（1m50s）成功。WindowsもNode422件・workerd1,898件（1,705.00s）とbuild/dry-runを通過しましたが、終了処理中にジョブの30分上限でcancelledになりました。今回、Windowsの統合テストを2 shardへ分割し、各shardのlint/型/契約/設定/Node/build検証とUbuntu・browserを維持しています。分割後のWindows成功は次のCIで確認します。

- 2026-09-25、単一・分割uploadで公開operationの失敗が確定した後の精算を共通system受付へ接続しました。実際の所有spaceで通常操作と同じ32 active/256 waiting枠を取得し、upload・blob・予約解放・確定記録を一つのbatchで保存します。 workerd51件を追加（境界46件・実ControlDO4件・HTTP1件）。関連109件（66.06s）と実ControlDO4件に加え、全体checkが成功。Node422件（25file、6.20s）・workerd1,898件（87file、990.88s）、計2,320件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。
- 2026-09-25、直前commit9cbc24cはmainへプッシュ済み。[CI36057631001](https://github.com/daraskme/Nextcloud-flare/actions/runs/36057631001)はUbuntu（6m27s）・Windows（21m41s）・browser（2m9s）の全job成功。両OSでNode422/workerd1,847、browser19件、計2,288件を確認しました。WindowsのKDF統合20件（6.861s）も成功。今回の公開失敗後の精算受付はまだ含まれません。

- 2026-09-25、旧epochの予約解放・Outbox通知の停止・検索索引の再構築を共通受付へ接続しました。予約と通知は実際の所有space、索引再構築は明示null scopeで、通常操作と同じ32 active/256 waiting枠を使います。 workerd67件を追加（境界59件・実ControlDO8件）。追加67件（14.72s）・既存復旧23件（12.96s）と全体checkが成功。Node422件（25file、5.81s）・workerd1,847件（85file、983.56s）、計2,269件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 全体check後にCI試験を調整し、KDF統合20件（7.15s）・待機列Node8件（104ms）・lint・型検査を再確認しました。
- 2026-09-25、直前commit357de9fはmainへプッシュ済み。[CI36054612441](https://github.com/daraskme/Nextcloud-flare/actions/runs/36054612441)はUbuntu（6m19s、Node422/workerd1,780）・browser（2m22s、19件）成功。Windowsは20分のjob上限で中断し、既存KDF並行試験にも1件の失敗が記録されました。追加したbucket関連82件はWindowsでも成功。Windows jobを30分にし、KDF試験は2件ずつ3組で同時1件・全6件の確定記録を検査するよう調整しました。製品の5秒期限・制限は維持し、Windowsの結果は次のCIで確認します。今回の旧epoch修復受付はこの直前CIに含まれません。

- 2026-09-25、全bucketの未完了multipart調査・中止を共通global受付へ接続しました。scanとpartの開始・外部予算・ページ保存、中止の開始・結果保存の8経路が、通常操作と同じ32 active/256 waiting枠を使います。 workerd82件を追加（境界73件・実ControlDO9件）。関連109件（97.66s）と全体checkが成功。Node422件（25file、5.68s）・workerd1,780件（83file、971.26s）、計2,202件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。
- 2026-09-25、直前commit943712fはmainへプッシュ済み。[CI36051299505](https://github.com/daraskme/Nextcloud-flare/actions/runs/36051299505)はUbuntu・Windows・browserすべて成功しました。Node422/workerd1698/browser19、計2,139件を確認済みです。Ubuntu7分37秒、Windows16分47秒、browser2分18秒。今回の全bucket受付はまだ含まれません。

- 2026-09-25、未追跡の完成済みR2 objectの調査・回収を共通global受付へ接続しました。scanのclaim・外部予算・観測・ページ保存・lease返却と、GCのclaim・外部予算・置換観測・削除確定・エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 workerd105件追加（境界93件・実ControlDO12件）。全体check成功、Node422件（25file、6.01s）・workerd1,698件（81file、888.73s）、計2,120件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。
- 2026-09-25、直前commitb971f01はmainへプッシュ済み。[CI36048664003](https://github.com/daraskme/Nextcloud-flare/actions/runs/36048664003)はUbuntu・Windows・browserすべて成功しました。Node422/workerd1593/browser19、計2,034件を確認済みです。Ubuntu5分43秒、Windows17分17秒、browser2分20秒。以前Windowsで失敗したmultipart試験も今回は成功しました。今回のorphan受付はまだ含まれません。

- 2026-09-25、所有者を持たないR2接続確認を共通受付へ接続しました。専用global RPCは通常操作・初回登録・所有者付きsystem更新と同じ32 active/256 waiting枠を使い、架空のownerや別枠を作りません。 Node6件・workerd68件追加（probe境界58件・実ControlDO等9件・移行1件）。全体check成功、Node422件（25file、6.04秒）・workerd1,593件（79file、851.58秒）、計2,015件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。診断表示の追加後も関連59件（44.02秒）と型検査が成功。schema0034/通常67table、依存追加なし。

- 2026-09-25、直前commit2bb6659はmainへプッシュ済み。[CI36044950637](https://github.com/daraskme/Nextcloud-flare/actions/runs/36044950637)はUbuntu・browser成功、Windowsは既存multipart inventoryのrollback-release試験1件で失敗しました。UbuntuはNode416/workerd1525、browser19。WindowsはNode416件成功、workerd1,524件成功・1件失敗です。今回のglobal受付はまだ含まれません。 Ubuntu5分28秒（workerd283.44秒）、browser2分7秒。

- 2026-09-25、Queueの送信・受信処理を共通system受付へ接続しました。送信claim、送信前の確認、送信済み記録、受信claim、処理完了が通常操作と同じ32 active/256 waiting枠を使います。受付対象は元operationの所有spaceで、通知を起こしたactorのspaceと混同しません。 workerd57件追加（境界51件・実ControlDO6件）。全体check成功、Node416件（25file、5.55秒）・workerd1,525件（77file、778.32秒）、計1,941件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。S3タイムアウト試験の修正後88件（261ms）も成功。schema0033/通常67table、migration・依存追加なし。 製品コードは全体check前に確定。

- 2026-09-25、直前commit0f1cb82はmainへプッシュ済み。[CI36042342676](https://github.com/daraskme/Nextcloud-flare/actions/runs/36042342676)はUbuntu・browser成功、Windowsは既存S3本文タイムアウト試験1件で失敗しました。UbuntuはNode416/workerd1468、browser19。WindowsはNode415件成功・1件失敗で停止し、workerdは未実行です。 Ubuntu5分35秒（workerd289.73秒）、browser2分12秒、Windows1分22秒でNode段階停止。Windowsの失敗は20msの試験期限が署名中に切れ、本文読取りのキャンセル検査へ届かない競合でした。本文のread開始を確認してからfake timerを20ms進め、fetchとcancel各1回を検査する方式へ修正しました。製品の10秒transport期限は変更していません。

- 2026-09-25、既存upload行に紐づく未知multipart IDの調査・回収を共通system受付へ接続しました。走査の再初期化、外部呼出し予算、物理観測、遅れて判明したID、ページ保存、中止確認、lease返却、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 workerd66件追加（境界59件・実ControlDO7件）。全体check成功、Node416件（25file、5.90秒）・workerd1,468件（75file、755.11秒）、計1,884件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 実ControlDO6経路の満杯待機・返却と、予算ACK喪失後のeviction/別予算での再試行を検証。最初の境界試験は58/59成功、1件のfixtureが存在しないcredentials.revoked_atを参照していたため、実session失効へ修正。最終対象66件成功、製品の制約は変更なし。

- 2026-09-25、直前commit1993f9cはmainへプッシュ済み。[CI36040104582](https://github.com/daraskme/Nextcloud-flare/actions/runs/36040104582)はUbuntu・Windows・browser全成功。Node416/workerd1402/browser19、計1,837件。 Ubuntu6分22秒、Windows13分42秒、browser2分9秒。workerdはUbuntu345.11秒/Windows728.79秒。

- 2026-09-25、台帳に登録済みのファイルを対象に、GC（不要ファイルの物理回収）の通常実行・停止中の回収・ゴミ箱復元中の回収を共通system受付へ接続しました。claim、delete/HEAD予算、完了精算、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 workerd80件追加（GC境界73件・実ControlDO7件）。全体check成功、Node416件（25file、5.66秒）・workerd1,402件（73file、705.27秒）、計1,818件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0033/通常67table、migration・依存追加なし。 実ControlDOで通常4経路の満杯待機・返却、停止/復元中の同一instance受付、送信予算ACK喪失後のevictionと再精算を検証。製品コードは全体check前に確定。

- 2026-09-25、直前commit90c4593はmainへプッシュ済み。[CI36037522754](https://github.com/daraskme/Nextcloud-flare/actions/runs/36037522754)はUbuntu・Windows・browser全成功。Node416/workerd1322/browser19、計1,757件。 Ubuntu5分15秒、Windows15分30秒、browser2分17秒。workerdはUbuntu269.67秒/Windows824.05秒。

- 2026-09-25、単一・分割アップロードの自動回収を共通の復旧用受付へ接続しました。停止claim、HEAD/abort予算、物理観測、既知handleの閉鎖、容量精算・GC引渡し、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。 workerd62件追加。90c4593のローカル全check成功、Node416/workerd1322、計1,738件。CIは以下の実行記録参照。 初期回帰168件のうち164件成功、3件はDB-only ACK回収導入後の期待値、1件はfixture抽出後のimport漏れだった。修正後の境界54件と分割回収36件、計90件（27.92秒）が成功。追加の期限境界と実ControlDOを含む最終対象100件（37.97秒）が成功。

- 2026-09-25、直前commit8892b4fはmainへプッシュ済み。[CI36034974068](https://github.com/daraskme/Nextcloud-flare/actions/runs/36034974068)はUbuntu・Windows・browser全成功。Node416/workerd1260/browser19、計1,695件。 Ubuntu7分34秒、Windows16分52秒、browser2分17秒。workerdはUbuntu412.26秒/Windows927.33秒。

- 2026-09-25、commit47160c422f76d82eb11fcbb7ecd57f0a15d712d3の[CI36027205940](https://github.com/daraskme/Nextcloud-flare/actions/runs/36027205940)全成功。Ubuntu4分39秒、Windows12分42秒、browser2分19秒。両OSでNode408/25files、workerd1141/67files（Ubuntu237.23秒/Windows587.72秒）、browser19（1.5分）、計1,568件。

- 2026-09-25、upload中止/検証3経路の共通受付を追加。workerd45件追加。f62dad8のCI全成功、Node408/workerd1186/browser19、計1,613件。 最終pnpm check成功: Node408/25files（5.32秒）+ workerd1186/68files（575.28秒）。lint/typecheck/contracts/config・Web build・Worker dry-run成功。中止とclaimの競合、別要求terminalと自分の確定証明の分離、全照合喪失、物理容量/予約保持を検証。migration・依存追加なし。

- 2026-09-25、commit e90ee882efe5c79655cf45603ad01ec52ffde4b4の[CI36024332349](https://github.com/daraskme/Nextcloud-flare/actions/runs/36024332349)全成功。Ubuntu5分4秒、Windows12分20秒、browser2分47秒。両OSでNode408/25files、workerd1096/65files（Ubuntu261.30秒/Windows656.65秒）、browser19（1.5分）、合計1,523件。

- 2026-09-25、upload転送5経路の共通受付を追加。workerd45件追加。47160c4のCI全成功、Node408/workerd1141/browser19、計1,568件。 初期の実ControlDO fixtureで不変sessionのepochを更新しようとしたため、作成時の値へ修正。後処理もclosed receiptを再更新しない条件へ修正。最終境界40件と実ControlDO5件（5.89秒）は成功。製品の制約は変更なし。最終pnpm check成功: Node408/25files（5.19秒）、workerd1141/67files（549.33秒）、lint/typecheck/contracts/config・Web build・Worker dry-run成功。migration・依存追加なし。

- 2026-09-25、upload新規予約の共通受付を追加。workerd42件追加。既存single/multipart55件（27.78秒）、初期境界と実ControlDO73件（49.42秒）、全照合喪失と実時計の期限切れ追加後の新規境界40件（14.08秒）成功。最終pnpm check成功。Node408/25files（5.33秒）+ workerd1096/65files（517.53秒）=1,504件。lint/typecheck/contracts/config、Web build、Worker dry-runも成功。今回のbrowserと両OSのCIはpush後に確認する。schema0032/通常67table・migrationと依存追加なし。
- 2026-09-25、直前commit522f616009359e5bc0a40c42575442b01c7d57b7の[CI36020805225](https://github.com/daraskme/Nextcloud-flare/actions/runs/36020805225)全成功。Ubuntu4分14秒、Windows12分59秒、browser2分36秒。両OSでNode408/25files、workerd1054/64files（Ubuntu214.22秒/Windows699.53秒）、browser19（1.5分）、合計1,481件。
- 2026-09-25、content budget・ticket発行/交換/取消しの共通受付を追加。workerd70件追加。既存対象17件成功。初期境界83件のうちapp password fixture4件が既存kdf_params CHECKに失敗したため、fixtureのiterationsを既存制約に合わせた。4 principalの失効と待機中の実時計による期限切れ、実ControlDOの満杯待機/返却を追加し、最終対象101件（新規content66件+ControlDO35件、67.96秒）成功。最終pnpm check成功。Node408/25files（5.53秒）+ workerd1054/64files（498.38秒）=1,462件。lint/typecheck/contracts/config、Web build、Worker dry-runも成功。今回のbrowserと両OSのCIはpush後に確認する。migration0032/通常67table・依存変更なし。
- 2026-09-25、直前commit `8e7243ede16285dfbb8330b60b1d8b0d28af516b`の[CI36016276272](https://github.com/daraskme/Nextcloud-flare/actions/runs/36016276272)全成功。Ubuntu4分32秒、Windows9分25秒、browser2分12秒。Node408/25files、workerd984/63files（Ubuntu202.73秒/Windows481.36秒）、browser19（1.5分）、合計1,411件。
- 2026-09-24、session/初回owner/logoutの共通受付を追加。Node4/workerd22件追加。型検査成功。対象Node83件、認証更新21件と既存29件・受付12件、bootstrap/実ControlDO5件成功。初期の旧エラー文字列期待とRPC拒否を試験内で捕捉するfixtureを修正した。初回全checkでNode用fingerprint試験にCloudflare runtimeが混入するimport依存を検出し、canonical ControlDO名をruntime非依存moduleへ分離。再実行はNode408/25files成功、workerd983成功/1失敗（984件・63files、464.31秒）。app-passwordの応答喪失fixtureが受付側にも同じ故障を注入していたため、fixtureの受付DBを独立させた。関連3files全57件（23.68秒）とlint/typecheck/Web build/Wrangler dry-runを再検証し成功。productionコードは全体試験から変更なし。契約・設定も成功。合計Node408/workerd984=1,392件を確認。CIで全check/browserを新規実行する。migration0032/通常67table・依存変更なし。
- 2026-09-24、直前commit `a9ab6767c26efdb201bdab847e1177f7aa6c6bd2`の[CI36012173188](https://github.com/daraskme/Nextcloud-flare/actions/runs/36012173188)全成功。Ubuntu3分51秒、Windows11分23秒、browser3分55秒。Node404/workerd962/browser19、合計1,385件。
- 2026-09-24、app password発行・失効・pepper更新の共通mutation受付を追加。workerd32件追加。既存認証55件と最終境界60件成功。初回 `pnpm check` はNode404/25files成功、workerd961成功/1失敗（962件・61files、454.01秒）。content-ticketの旧fixtureが停止中ControlDOを参照し、発行201に対して503となったため、fixtureのみ明示受付へ修正。対象file全11件（3.95秒）、lint/typecheck/Web build/Wrangler dry-runを再確認して成功。productionコードは全体試験から変更なし。契約・設定を含む全検証項目、計Node404 + workerd962 = **1,366 tests**を確認。CIで全checkとbrowserを新規実行する。owner/current authority、root/20件上限、停止/epoch、ACK/readback喪失、並行rotation、全rollback、HTTP503・Basic再認証不要、実ControlDOのKDF/32枠を検証。migration0031/通常67table・依存変更なし。
- 2026-09-24、直前DAV commit `64ed2375ebf58da6d2a18383262ff96befdf83e6`の[CI36008397681](https://github.com/daraskme/Nextcloud-flare/actions/runs/36008397681)全成功。Ubuntu4分27秒、Windows10分40秒、browser2分46秒。Windows Node404/workerd930（558.21秒）、browser19（1.8分）。合計1,353件。
- 2026-09-24、DAVロックの共通受付と確定記録を追加。Node4/workerd22件追加、対象Node8件・workerd72件成功。最終 `pnpm check` はNode404/25files + workerd930/60files = **1,334 tests**、workerd440.79秒。lint/typecheck/contracts/config/schema・Web build・Wrangler dry-run成功。今回のbrowser/CIはpush後に確認する。migration0031・通常67table・依存変更なし。認可fixtureのID組立てを修正し、productionの拒否条件は維持。実ControlDOの32枠待機/返却、HTTP503、停止/epoch/失効、batchとreadbackの応答喪失、別unlockとの混同防止、全rollback、旧DB移行、60秒保持・clock rollback・cleanup query planを検証する。
- 2026-09-24、直前namespace受付commit `89cc9b7952f9658c013bf90bee240a72d80f5d84` の[CI 36005018219](https://github.com/daraskme/Nextcloud-flare/actions/runs/36005018219)全成功を確認。Ubuntu3分44秒、Windows10分49秒、browser2分52秒。Windows Node400/workerd908（workerd555.72秒）、browser19成功。合計1,327件。
- 2026-09-24、namespace更新の全体受付を追加。新規Node4件・workerd17件。最終 `pnpm check` 成功: Node400 + workerd908 = **1,308 tests**（25+59 files）、workerd436.48秒。lint/typecheck/contracts/config/schema・Web build・Wrangler dry-run成功。D1 migration0030・通常67table、依存変更なし。待機後の認可/lock/停止、FIFOと32/256上限、応答喪失、実ControlDO再起動、clock rollback、HTTP 503を検証。先行試験のfixture初期化順・HTTP path・制約エラー判定を修正し、productionの期限・拒否条件は維持した。今回のbrowser/Windowsはpush後のCIで確認する。

- 2026-09-24、直前KDF終了記録repairのcommit6b65a47はpush済み。CI36001142967はUbuntu2分53秒・Windows8分38秒・browser2分8秒で全成功。Node396 + workerd891 + browser19 = **1,306件**。

- 2026-09-24、KDF終了記録の永続化・修復を追加。関連4file/89件成功（89.48秒）、追加の最終14件成功（11.54秒）。最終`pnpm check`成功: Node396 + workerd891 = **1,287 tests**（24+58 files）、workerd425.30秒。lint/typecheck/contracts/config/schema・Web build・Wrangler dry-run成功。新規D1 migration・依存なし、DO SQLiteに最大20件の記録。取消しfixtureはAbortControllerの作成と取消しを同じDO contextへまとめ、productionの取消し条件を維持した。今回のbrowser/Windowsはpush後のCIで照合する。

- 2026-09-24、commit `4dbafdd`の[CI run35997960544](https://github.com/daraskme/Nextcloud-flare/actions/runs/35997960544)は全成功。Ubuntu3分4秒・Windows10分43秒・browser2分56秒。Node396 + workerd877 + browser19 = **1,292 tests**。WindowsのKDF20件13.176秒、workerd552.04秒。

- 2026-09-24、KDF全体制限を追加。Node budget7件 + schema71件が成功（3.77秒）、新規workerd20件 + 既存認証34件が成功（19.67秒）。最終`pnpm check`成功: Node396 + workerd877 = **1,273 tests**（24+57 files）、workerd410.07秒。lint/typecheck/contracts/config/schema・Web build・Wrangler dry-run成功。testの待機終了処理を調整後にもlint/typecheckと新規workerd20件が成功（4.95秒）。migration `0029`、66通常table、追加依存なし。browser19件も成功し、合計**1,292件**。Windows CIは前回13分57秒の実績と追加coverageに合わせjob全体上限を15分から20分へ変更した。Ubuntu/browserの15分、個々のtest/hook timeoutとproduction deadline・assertionは維持。今回のCIはpush後に照合する。

- 2026-09-24、commit `026f534`の[CI run35993638387](https://github.com/daraskme/Nextcloud-flare/actions/runs/35993638387)はUbuntu2分42秒・Windows13分57秒・browser1分32秒で全成功。Node389 + workerd857 + browser19 = **1,265 tests**。Windowsの新規中止19件15.359秒、検索9件42.962秒、配信lease5件48.308秒。

- 2026-09-24、upload行喪失時の発見済みmultipart中止・不変attempt台帳を追加。新規19件成功（10.83秒）、Node schema71件とworkerd schema5件も成功。migration `0028`、65通常table、依存追加なし。最終`pnpm check`成功、Node389 + workerd857 = **1,246 tests**（23+56 files）、workerd411.79秒。lint/typecheck/contracts/config/schema・Web build・Wrangler dry-run成功。今回のbrowser/Windowsはpush後のCIで確認する。全体閉鎖・容量精算・実S3は未完了。

- 2026-09-24、commit `284a202`の[CI run35966922855](https://github.com/daraskme/Nextcloud-flare/actions/runs/35966922855)はUbuntu2分39秒・Windows8分55秒・browser2分11秒で全成功。Node389 + workerd838 + browser19 = **1,246 tests**。Windows検索9件26.338秒、content-lease5件46.715秒。以下の2件のfixture timeoutは解消済み。

- 2026-09-24、commit `5544432`の[CI run35965874860](https://github.com/daraskme/Nextcloud-flare/actions/runs/35965874860)はUbuntu（3分7秒）・browser（2分17秒）成功。Windowsの検索9件は成功したが、既存content-leaseのlate GETテストだけ90秒timeout（837/838件成功）。fixtureの初期期限5秒を準備中に超えると、BudgetDOが仕様どおり更新済みticketの2分期限へrenewするため、短い期限の試験にならない。準備を含むfixture期限を15秒にし、2回目のgrantが元の期限を保持することを直ちに検査する。本番コード・期限は変更しない。 修正後の配信期限5件は成功（48.00秒）、lint/typecheckも成功。最新SHAでCI全checkを確認する。

- 2026-09-24、commit `dfd2468`の[CI run35964611990](https://github.com/daraskme/Nextcloud-flare/actions/runs/35964611990)はUbuntu（6分23秒）・browser（19件、2分7秒）成功。Windowsは新機能27件を含む837/838件が成功し、既存の1万件検索fixtureだけ個別60秒でtimeout。個別指定を既存Windows runner予算と同じ90秒へ揃える。検索の1万件上限・アサーション・本番期限は変更しない。 修正後の検索9件は成功（6.07秒）、lint/typecheckも成功。新しいSHAでCI全checkを確認する。

- 2026-09-24、upload行喪失時の全bucket multipart走査とpart容量保留を追加。新機能27件成功（10.42秒）、schema5件成功。新規migration `0027`、64通常table、依存追加なし。最終`pnpm check`成功、Node389 + workerd838 = **1,227 tests**（23+55 files）、workerd395.26秒。lint/typecheck/contracts/config/schema・Web build・Wrangler dry-runも成功。browser19件も同commitのCIで成功（計1,246件）。Windowsの検索fixture timeoutは別記録。実S3・全体閉鎖・中止・容量精算は未完了。詳細は[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md)。

- 2026-09-24、未知multipart IDの修復にfreshなBLOBS/S3対応検証を接続。maintenance/GC pauseとcurrent proofをclaim・round reset・各dispatch・page/abort receipt・physical観測・lease解放の同一D1 batchで検査する。誤bucket、旧nonce、停止解除、期限切れ、page応答喪失後のdispatch、再開時のfresh検証など12境界を追加し、旧epoch試験を実ControlDO復旧へ統合（net +11件）。関連100件成功（27.79秒）に加え追加2境界成功（2.99秒）。最終`pnpm check`はNode389 + workerd811 = **1,200 tests**（23+54 files）、workerd380.36秒。lint/typecheck/contracts/config/schema、Web build、Wrangler dry-run成功。同commit `9811560`の[CI run35954162544](https://github.com/daraskme/Nextcloud-flare/actions/runs/35954162544)はUbuntu・Windows・browser全job成功、browser19件。D1 migration・依存追加なし。全体閉鎖・容量精算・upload行喪失・実S3/stagingは未完了。詳細は[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)。

- 2026-09-24、フォルダー集計commit `26c4d07c4877c3f4493f579467b70dd38c2b0e28`を`origin/main`へpushし、[CI run35926517271](https://github.com/daraskme/Nextcloud-flare/actions/runs/35926517271)のbrowser・Ubuntu・Windows全job成功を確認。Windows runnerの期限調整後も全assertionが成功した。進捗の入口を[PROGRESS](PROGRESS.md)へ追加。

- 2026-09-24、所有folderの要求時集計をAccess API/Files情報dialogへ接続。現在のfile/folder件数とlogical bytes、同一batchの認可/停止/epoch/世代assert、scope込み10,000ノードと絶対depth64、部分結果/content不足、再集計中/拒否後の旧数値非表示を実装。検索の索引付き走査を共通化。追加workerd12件と既存検索9件の21件成功（11.38秒）、新規browser1件成功（16.8秒）。最終`pnpm check`はNode389 + workerd800 = **1,189 tests**（23+54 files）、workerd375.59秒。lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。別途`pnpm test:browser`は**19 tests**成功（3.4分）、合計**1,208件**。PC/mobileの集計画面を実際に確認し、はみ出しなし。直前のWindows CIでmigration hook10秒とControlDO試験30秒のtimeoutを確認したため、Windowsのrunner限度のみhook60秒/test90秒へ変更。アプリ内部期限とassertionは維持し、変更後のconfigのlint/typecheckも成功。D1 migration・依存追加なし。実D1予算/共有/media/全体admission/復旧/公開のgateは未完了。[FOLDER_STATS](FOLDER_STATS.md)参照。

- 2026-09-24、フォルダー配下の検索APIとFiles検索を接続。名前と共通の正規化、literal query、1文字/記号/絵文字のbounded fallback、検索専用cursor、現行credential/祖先/owner/internal grantと同一batchの最終assertを実装。索引付きsuccessor walkでscope10,000/step20,000/絶対depth64を制限し、rowidに限定したFTS候補とsubstringの後に名前順page200を返す。旧/欠落索引と上限到達を不完全な結果として通知。子追加後の親rename/moveが失敗する問題を2件の実service試験で再現し、原子的な旧FTS削除/新索引更新を保持して修正。Node追加13件、workerd追加11件。関連57件成功（15.72秒）、追加境界を含む検索9件成功（5.59秒）。最終`pnpm check`はNode389 + workerd788 = **1,177 tests**（23+53 files）、workerd447.57秒。lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。その後のUI変更は上限通知の文言のみでlint成功、最終Web buildを含む別途browser **18 tests**成功（4.2分）、合計**1,195件**。新規2件で未表示子孫の検索、元parentへの上書き、実content確認、保存場所/改名/検索解除、実201件pagination、同一語の再検索、世代競合409と認証拒否後の非表示を確認。最終PC/mobile画面と横はみ出しなしを確認。schema/migration・依存追加なし。media metadata parser/索引同期・索引version再構築運用・実D1予算・共有/media/全体admission/復旧/公開のgateは残る。詳細は[SEARCH](SEARCH.md)。

- 2026-09-24、配信leaseの期限をDOの保存済みbyte期間内へ制限し、旧実装のまだ有効なleaseは精算/期限切れまで保持する処理を追加。実D1のticket期限更新後に有効なleaseが消える`budget_lease_missing`と、修正前の配信関数が期限後の3 byteを返す問題を独立試験で再現。`/c`のR2 HEAD/GET・body・最終精算に期限を伝播し、未読/停止応答、遅延R2、request abort、timerのcallback前に時計が進む境界を処理する。精算は1回とし、結果不明は予約全額を保持。Node追加20件、workerd追加6件。関連結合29件成功（31.16秒）、新規配信5件成功（18.22秒）。最終`pnpm check`はNode376 + workerd777 = **1,153 tests**（22+52 files）、workerd361.14秒。lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。別途browser **16 tests**成功（2.1分）、合計**1,169件**。D1 schema/migration、依存、UI実装は変更していない。実HTTP切断伝播、長時間downloadのRange/ticket更新UI、全media/public配信経路、全体admission・共有/検索/media・復旧/実環境のgateは残る。詳細は[CONTENT_LEASES](CONTENT_LEASES.md)。

- 2026-09-24、上書き作成応答の喪失後に対象revisionが進むと元のreceiptを回収できない問題を修正。実APIの単一・分割2件で修正前の409を確認し、同じkey/bodyへの再送では現行権限を原子的に再検証して元のID/capabilityを返す。予約を加算せず、旧revisionの新規予約・R2初期化・本文・確定は引き続き拒否する。multipart初期化が対象変更で止まれば202 receiptから中止できる。workerd HTTP追加5件で実上書き・quota不変・R2再初期化なし・中止後の新内容保持、最終batch直前のcredential失効、予約直後の対象変更を検証。関連79件成功（37.05秒）。最終`pnpm check`はNode356 + workerd771 = **1,127 tests**（21+51 files）、workerd331.06秒。lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。別途browser **16 tests**成功（2.2分）、合計**1,143件**。追加2件で実作成応答の破棄→別更新→reload→元file再選択→同じreceipt回収→本文/completeなしで中止→新内容保持を確認。D1 schema/migration、依存、UI実装の追加変更はない。対象の移動・削除・失効・期限切れ、全体admission・共有/検索/media・復旧/実環境のgateは残る。詳細は[UPLOAD_OVERWRITE](UPLOAD_OVERWRITE.md)。

- 2026-09-24、Filesの確認付き上書きと配信budgetの対象台帳を接続。最終`pnpm check`成功、Node356 + workerd766 = **1,122 tests**（21+51 files）、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。workerd313.97秒。別途`pnpm test:browser`の**14 tests**成功（1.8分）、合計**1,136件**。browser追加3件で確認前取消し・異なる元file名・空file・確定応答喪失/reload・確認前/PUT直前の更新競合・96 MiB分割上書きの同じtarget/attempt/If-Matchを実APIで検証。配信枠が最初のtarget setで固定される不具合を再現し、検証済みpurpose/blobの重複排除台帳と原子的な追加/使用量検査へ変更。workerd追加6件で重複集合/COW/eviction、size矛盾/manifest破損、失効競合、旧保存領域、1,024対象/leaseと1 MiB上限、短いticket期限での10分request制限保持を検証。最後の期限問題は修正前の失敗を確認し、修正後の専用14件と全checkが成功。HTTP429のCORSと使用量不変も既存試験で確認。PC/mobile実画面を確認。詳細は[UPLOAD_OVERWRITE](UPLOAD_OVERWRITE.md)と[BUDGET_ALLOWANCE](BUDGET_ALLOWANCE.md)。D1 migration追加はなく0026/61通常table。全体admission、残るQueue・共有・検索・media・復旧/実環境は未完了。

- 2026-09-24、本文なしHTTP操作の空stream誤判定を修正。`pnpm check`成功、Node356 + workerd760 = **1,116 tests**（21+51 files）、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。workerd313.69秒。別途`pnpm test:browser`の**11 tests**成功（1.1分）、合計**1,127件**。追加Node13件でEOF/実データ/既読/locked/取消し/5秒期限/空chunk上限を検証。workerd追加2件で本文待機中のapp password失効・maintenance移行後にnode/operationを作らないことを確認。既存DAV/private ticket試験をclosed stream・偽Content-Length・読取り失敗で拡張。新しい独立HTTP試験でMKCOL/PUT/LOCK/UNLOCK/COPY/MOVE/GET/DELETEとticket発行/交換/取消しを確認し、不正本文の拒否後もfile/lock/ticketが残ることを検証。詳細は[EMPTY_HTTP_BODY](EMPTY_HTTP_BODY.md)。migration追加はなく0026/61通常table。実OS DAV client、実Cloudflareの切断伝播、全体admission、共有・検索・media・実環境は未完了。

- 2026-09-24、app-password KDFのisolate内制限を追加。`pnpm check`成功、Node343 + workerd758 = **1,101 tests**（20+51 files）、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。workerd314.73秒。追加はNode8/workerd9、既存API試験に空DELETE stream・偽Content-Length・読取り失敗・取消し再送の境界を加えた。明示的な`enable_request_signal`設定後にもlint/typecheck/configとbrowser **10 tests**が成功（1.1分）、合計**1,111件**。独立HTTPの8並列DAV認証・誤secret・取消し後の拒否を確認。ローカルWrangler経由のHTTP切断診断はabort通知を観測できず、実Cloudflareの切断伝播を未検証gateとして[KDF_ADMISSION](KDF_ADMISSION.md)に記録。診断用endpointは残していない。最終設定を含む全checkは最新SHAのCI結果と照合する。migration追加はなく0026/61通常table。全体KDF rate/同時数、mutation admission、共有・検索・media・実環境は未完了。

- 2026-09-24、復元用alarmの再試行上限追加後の`pnpm check`成功。Node335 + workerd749 = **1,084 tests**（19+50 files）、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。workerd314.48秒。追加5件で6回の連続失敗・eviction・DB全面障害時の永続閉鎖、成功時の回数リセット、古い6回目の失敗対新hold/管理者設定変更を確認。対象検証は8成功/21選択除外も実施。browser suiteは9件でCI別job。直前の復元機能commit `a975424` はCI run `35895999363`でUbuntu/Windows/browserすべて成功。最新HEADのCIは別途SHAを照合する。D1 schema変更はなく、DO SQLiteに失敗台帳を追加。

- 2026-09-24、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node335 + workerd744 = **1,079 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。workerd全50fileは370.46秒。別途実ブラウザー**9 tests**成功（1.6分）、合計**1,088件**。migration `0026`（61通常table）でGC稼働中のごみ箱復元を接続。復元専用24件とschema1件を追加し、管理者設定・期限・lease・token・停止/epoch競合、D1/R2応答喪失と遅延削除、eviction/全喪失、HTTP再試行を確認。browserは復元前後のGC再開と、復元commit後の応答喪失から同一key再照会を確認。補助fetchのFetch Metadata不足と再照会待機を修正し、作成/復元が実際に成功した後だけ応答を破棄する。最終のbrowser修正後にlint/typecheckも成功。実環境、account/KDF admission、backup barrier、残るQueue・共有・検索・mediaは未完了。

- 2026-09-24、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node335 + workerd719 = **1,054 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。別途`pnpm test:browser`の**8 tests**が成功し、FolderPickerの親階層ボタンがsubmitしない回帰検査を含む実Filesシナリオも再確認。合計1,062件。PC/mobileの実画面を確認。private asset全graphの認証/host/fallback/HEAD、96 MiB multipart中断/reload/同一attempt/既送信part省略、操作応答喪失/同一key、複数タブlogoutを実ローカルAPIで検証。追加Node4件はCSRF失効競合とoperation再照合。既存workerdテストでchildrenのsize/mimeと空stream logout/非空拒否を拡張。schema変更なし。GC稼働中restoreのpause hold、上書き/共有/検索/media UI、実環境gateは未完了。

- 2026-09-24、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 331 + workerd 719 = **1,050 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。migration `0025`、全監査後のControlDO受付・GC段階再開を追加。追加Node1件/workerd27件でrevision/token境界、実ControlDO/LockDO namespace mutation、Worker entryのJWT/bootstrap/HTTP、commit前後・readbackの応答喪失、遅延open/stop/GC/epoch publication、同時再開、監査後の予約/permit/bootstrap変更、repair hold、eviction/全喪失を検証。workerd全49fileは263.37秒。account/KDF admission、backup barrier、未知multipart全体閉鎖/予約精算、残るQueue修復、Files UIと実環境gateは未完了。

- 2026-09-24、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 330 + workerd 692 = **1,022 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。migration `0024`のclaim epoch/dispatch counterと、停止中ControlDOのblob/orphan GC drainを追加。新規25件で旧deletingだけの回収、猶予/lease/pin保持、claim/counter/final batch/R2応答喪失、同時回収、遅延削除、各dispatch/精算時のepoch/mode/lease、容量の一度だけの精算、未知multipart予約holdの迂回拒否、回収後の全復旧監査を検証。未知multipartの全体閉鎖と予約精算・Queue drain・admission再開・実restore drillは未完了。

- 2026-09-24、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 330 + workerd 667 = **997 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。migration `0023`のsystem probe台帳（61通常table）と停止中ControlDOのBLOBS/S3対応検証を追加。新規workerd22件とNode4件でfresh nonce、実R2条件付きPUT、遅延create/更新、scope終了・保存SQLの失効、D1/R2応答喪失、誤bucketの古い値、64-byte境界、epoch/pause/lease、復旧監査・容量保持を検証。全体閉鎖/予約精算への接続と実S3/stagingは未完了。

- 2026-09-23、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 326 + workerd 645 = **971 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。migration `0022`のscan/handle台帳2table（60通常table）と停止中ControlDOの未知ID修復を追加。新規33件で複数IDの実R2 abort、全ページ後の中止、隣接key除外、cursor/claim/receiptの応答喪失、counter未確認時のdispatch抑止、遅延IDと旧cleanupの排他、epoch/token/pin/lease、source再走査、完成物のphysical計上（S3障害時も）を検証。実S3/BLOBS対応証明・全体不在証明・予約精算は未完了で、予約holdと最終復旧fenceを維持する。

- 2026-09-23、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 326 + workerd 612 = **938 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。未完了multipartのS3診断にNode 84件とworkerd 7件を追加。XML/echo/marker・署名・redirect/再送なし・timeout・body上限、D1停止fence、ControlDO監査再初期化、空一覧/404時の予約保持を検証。最終の解析前markup上限追加後も対象Node 84件を再実行して成功。実S3接続・BLOBS対応証明・永続scan・未知ID修復は未完了。

- 2026-09-23、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 242 + workerd 605 = **847 tests**、lint/typecheck/contracts/config、schema整合性、Web build、Wrangler dry-run成功。migration `0021`に未知完成物と走査cursor/leaseの2tableを追加（58通常table）。`u/`のbounded list/HEAD、35日grace、owner physical計上/後日復元、独立GC、同key再利用拒否、Cron/停止中ControlDO inventory/復旧監査を接続。新規41件とControlDO3件で、cursor/観測/精算の応答喪失、並行走査/GC、古いHEAD対置換/削除、期限・pause・epoch・token、置換/再出現、所有者不明、不正key、会計を検証。4catalogueのkey照合が索引検索になることもSQLite query planで確認。unknown multipart ID、他prefix、未完了GC drain・ControlDO再開、UI、stagingは未完了。

- 2026-09-23、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 242 + workerd 561 = **803 tests**、lint/typecheck/contracts/config、schema整合性、Web build、Wrangler dry-run成功。private multipartのcreate/part/status/page/complete/abortをAccess HTTPへ接続。現在認可付きD1 receiptは期限後も照会可能で、最大200件ずつ返す。初期化応答喪失の202 receipt、同attemptの二重送信防止、If-Match、並列429、確定不明503、abort対complete/遅延part、失効対snapshot、DO台帳喪失時の読み取りを新規46件で検証。復旧テストの後片付けが確定済みremoved_atを再更新する時刻依存の不具合も修正し、対象11件と全checkを再実行。migration追加なし。未知ID/objectのinventory修復・Files UI・実Cloudflare検証・ControlDO再開は未完了。

- 2026-09-23、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 242 + workerd 515 = **757 tests**、lint/typecheck/contracts/config、schema整合性、Web build、Wrangler dry-run成功。migration `0020`に永久停止marker・R2閉鎖証明と不変性guardを追加。既知multipart IDのabort/HEAD、actual physical計上、予約精算/GC handoff、CronとControlDO停止中repairを接続。回収35件・復旧2件の新規試験でR2/D1応答喪失、並行claim、遅延init/HEAD、lease待ち、旧epoch/pin競合、metadata隔離、既知complete完成物、原子性、DO全喪失、偽GC handoff拒否を検証。既存multipart確定/partと単一upload回収も再検証。unknown creation IDの外部inventory修復・HTTP/UI・実Cloudflareのlifecycle/障害検証は未完了で、ControlDO admissionは閉鎖中。

- 2026-09-23、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 242 + workerd 478 = **720 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。migration `0019`でmultipart complete attempt/lease・object etag proof、成功partの不変性、completed終端guardを追加。R2一度限りcomplete/HEAD、physical観測、LockDO/D1原子的公開・旧版保持、DO terminal照合を接続。34件の新規試験でR2/claim/physical/proof/namespace応答喪失、同時確定、R2完了中の失効、metadata/size不一致、HEAD budget、全10 step rollback、偽terminal拒否、DO全喪失/旧epochを検証。既存64 MiB+末尾partの試験も原子的公開まで延長。R2 abort/期限切れcleanup・HTTPは未接続でControlDO admissionは閉鎖中。
- 2026-09-23、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 242 + workerd 444 = **686 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。migration `0018`でmultipart geometry・ledger marker・revisionを追加。D1予約、R2一度限りcreate、UploadDO認可RPCとdirty part mirror、part stream/SHA-256、初回/停止再送alarmを接続。27件の統合試験で64 MiB+短い末尾、D1/R2応答喪失、DO全storage喪失、同時create/4並列claim、失効/予約解除との競合、旧epoch停止、complete/abort競合を検証。R2 complete/head照合・原子的公開・R2 abort/期限切れcleanup・HTTPは未接続。ControlDO admissionは閉鎖を維持。
- 2026-09-23、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 242 + workerd 417 = **659 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。migration `0017`でcleanup lease/retry/indexを追加。単一uploadの24時間期限後のHEAD、未記録physicalの計上、予約精算、GC handoff、absent確定、Cron、ControlDO停止中repairを接続。回収26件とControlDO1件を追加し、3箇所のD1応答喪失、HEAD失敗、並行claim、遅延結果、epoch/pin競合、未知metadata隔離、虚偽size、completing/未束縛claim、部分step拒否、rollback、bounded scanを検証。汎用旧epoch reservation回収がterminal uploadを先に解放できた経路を閉じ、最終復旧fenceで未処理cleanupを拒否する。実CloudflareのCron/R2障害、multipart接続、未知object全般のrepair、admission再開は未完了。
- 2026-09-23、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 242 + workerd 390 = **632 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。migration `0016`を追加し、private単一uploadのD1予約、HMAC capability、1回限りR2 PUT/SHA-256、GET照合、原子的complete、status/abortを接続。0 byte、上書き旧版保持、全10必須step rollback、R2/DB応答喪失、同時送信、失効、CSRF/Origin/If-Match、鍵rotation、stalled sourceのlease中止を検証。single期限はR6に従い24時間とし、abortとclaimの競合・遅延PUTでは予約とphysical計上を維持する。既存1,024回D1 budget試験が30秒を超えたため、その試験だけ60秒へ調整後、全checkを再実行して成功。虚偽sizeのR2試験ではworkerdが意図した切断診断を出す。期限切れ/orphan cleanup、multipart接続、公開共有、UI、実ControlDO admissionとstagingは未完了。
- 2026-09-23、ユーザー指定のNixOS workspace `/home/hiroshi/ドキュメント/Nextcloud-flare`へGit履歴・依存・local stateを移し、Node 24.21.0 / pnpm 12.4.1で`pnpm check`成功。Node 235 + workerd 361 = **596 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-run成功。multipart計画17件と台帳18件を追加し、eviction、claim応答再送、4並列、3試行、unknown/lease expiryと遅延応答、idle/deadline、旧epoch、complete/abort排他、SQL rollback、200行page、alarmを検証。D1 schema変更なし。台帳のfixture試験であり、D1/R2接続済みuploadや実Cloudflare試験を意味しない。
- 2026-09-23、purge blobのbounded GCをCronへ接続。7日猶予後、epoch/maintenance/gc pause/ref count/複数pin/materialized fenceをD1で再検査し、blob/candidateを同時に不可逆`deleting`へ進める。claim leaseで競合と再試行を直列化し、R2 delete応答喪失をheadで収束、不在確認後だけ`deleted`とphysical bytes減算を同時確定する。実R2、複数pin、pause、応答喪失、期限切れlease再取得を検証。Node 218 + workerd 343 = **561 tests**、lint/typecheck/contracts/config/schema generator、Web build、Wrangler dry-runを再検証。
- 2026-09-23、`POST /api/v1/trash/:opId/purge`をCSRF/Idempotency-Key、所有者trash membership、space root authority、LockDO permitへ接続。migration `0014`のoperation束縛node/blob manifestを作り、credential/share/upload/media/state/search/version/trash membershipをFK順、nodeをdepth降順に削除する。別trash子をNULL親へ退避し、blob ref/quota trigger後のGC candidate、`node.purged` Outbox、復旧監査、terminalを同時確定。REST再送と深いsubtreeを実D1/DOで検証。Node 218 + workerd 338 = **556 tests**、lint/typecheck/contracts/config/schema generator、Web build、Wrangler dry-runを再検証。
- 2026-09-23、`POST /api/v1/trash/:opId/restore`をCSRF/Idempotency-Key、所有者trash membership、復元先`node:create`、LockDO permitへ接続。GC pauseとdeleting不在、参照blob状態をfenceし、最大64層・1,000 nodeをrootから深さ順に同じD1 transactionで復元する。名前衝突suffix、別trash operationの削除済み子を維持し、tree/search/activity/`node.restored` Outbox/terminalを同時確定する。Node 218 + workerd 338 = **556 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-runを再検証。
- 2026-09-23、`GET /api/v1/trash`を所有者space rootのcurrent認可・epoch・maintenanceと同じD1 batchへ接続。migration `0013`のpartial keyset index、最大200件、credential/epoch/tree generation/spaceに束縛した10分HMAC cursorを追加し、複数page、改変、tree変更、他user、maintenanceを実D1で検証。Node 218 + workerd 337 = **555 tests**、lint/typecheck/contracts/config/schema generator、Web build、Wrangler dry-runを再検証。
- 2026-09-23、`GET /api/v1/nodes/:nodeId/path`をcurrent `node.read`・epoch・maintenanceと同じD1 batchのroot-first breadcrumbへ接続。同一space/ownerのlive親、最大64 edge、root到達、連続したparent chainを検証し、query/fragmentと不完全pathを拒否する。64 edge成功と65 edge目のschema拒否を含め、Node 218 + workerd 336 = **554 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-runを再検証。
- 2026-09-23、private Files REST の trash/MOVE/COPYを既存の原子的 mutationへ接続。strict JSON/CSRF/Idempotency-Key、`node.*` operation provenance、LockDO intent、operation lookup、Outbox consumer、旧epoch復旧監査をDAVと共通化し、削除後の同一DELETE再送もterminal operationから冪等に返す。Node 218 + workerd 335 = **553 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-runも成功。
- 2026-09-23、DAV COPYをstrict `Destination`/`Overwrite`/method別`Depth`、migration `0012`の固定source→copied manifest、同一owner・最大1,000 node/10 GiBのsame-owner COWへ接続。file/folder、Depth 0/infinity、dead properties、blob ref/quota trigger、上書きtarget trash、201/204/412、Outbox/復旧provenance、terminal replayを実D1で検証。Node 218 + workerd 334 = **552 tests**、lint/typecheck/contracts/config/schema generator、Web build、Wrangler dry-runも成功。
- 2026-09-23、DAV MOVEをstrict same-origin `Destination`/`Overwrite`/`Depth` parserと、同一owner・最大1,000 node/10 GiBの固定manifestを持つ19-step `dav.move` commitへ接続。循環防止、cross-space拒否、両親/tree revision、source/overwrite lock終了、上書きtargetのtrash/share/session失効、201/204、Outbox/復旧provenance、terminal replayを実D1で検証。Node 218 + workerd 331 = **549 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-runも成功。
- 2026-09-23、DAV DELETEを`node:delete`、subtree/parent/ancestor lock fence、最大1,000 nodeのmembershipを持つ13-step `dav.delete` trash commitへ接続。node不可視化、share/session/ticket失効、Outboxと復旧provenance、子lock token提出、1,001 nodeの403を実D1で検証。Node 215 + workerd 327 = **542 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-runも成功。
- 2026-09-23、DAV PUTを最大95 MBのbounded request streamからR2とSHA-256へ同時配送し、quota予約をR2書込み前に確保して、新規fileを10-step、既存fileの条件付き上書きを旧blob version保存込み8-step `dav.put` mutationへ接続。201/204、428、immutable version、physical観測、Outbox、lock 423を実D1/R2で検証。Node 215 + workerd 325 = **540 tests**、lint/typecheck/contracts/config、Web build、Wrangler dry-runも成功。
- 2026-09-23、`pnpm check` 相当の全 gate 成功。Node 215 + workerd 324 = **539 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。未存在DAV pathへのLOCKを`dav.lock` operationと10-step fsMutationへ接続し、空R2 blobと物理観測、file node、namespace索引/outbox、lockを同時確定。201後の0-byte GETとUNLOCK、operation provenanceを実D1/R2で検証。
- 2026-09-23、`pnpm check` 相当の全 gate 成功。Node 215 + workerd 323 = **538 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。locksにbounded display hrefを保存し、PROPFIND `lockdiscovery`へ直接・祖先Depth infinity lockのmetadataとlockrootをcurrent D1 snapshotから接続。hash-only tokenは応答へ再表示しない。
- 2026-09-23、`pnpm check` 相当の全 gate 成功。Node 215 + workerd 323 = **538 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。DAV LOCKとmutation commitの順序を補強し、active permit中のLOCKを423、期限切れpermit/claimを原子的に収束後LOCK可能とした。PROPFIND `supportedlock` はexclusive write能力を返す。
- 2026-09-23、`pnpm check` 相当の全 gate 成功。Node 215 + workerd 323 = **538 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。既存 resource の DAV LOCK/refresh/UNLOCK を LockDO と実 D1 に接続し、bounded XML/Depth/Timeout、hash-only token、競合、creator user、current write認可、応答喪失後照合を実装。lock-null と `lockdiscovery` が未完了のため `DAV: 1` を維持。
- 2026-09-23、`pnpm check` 相当の全 gate 成功。Node 211 + workerd 322 = **533 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。DAV `If` をsame-origin path、ancestor depth lock、file/collection ETagのcurrent D1 stateへ接続し、MKCOL/PROPPATCHへ提出tokenを渡す。file `"b-<blob>"`、collection `"c-<node>-<revision>"` をGET/HEAD・PROPFIND・条件評価で共有し、token/ETag成功、412、常真branchだけでtoken未提出の423を実workerdで検証。
- 2026-09-23、`pnpm check` 相当の全 gate 成功。Node 209 + workerd 322 = **531 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。DAV `If` / `Lock-Token` の bounded parser と純粋 evaluatorを追加し、tagged/untagged論理と、条件評価から独立した全branchのtoken submissionを検証。D1 state/mutation接続前なのでHTTPはfail closedを維持。
- 2026-09-23、`pnpm check` 相当の全 gate 成功。Node 204 + workerd 322 = **526 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。DAV PROPPATCH を write-only app password の `node:write`、LockDO permit、`dav.proppatch` claim、dead property と node revision の同一 D1 batch に接続。mixed-content XML、冪等再送、保護 live property の403と他 property の424、全 rollbackを検証。
- 2026-09-23、`pnpm check` 成功。Node 202 + workerd 321 = **523 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。DAV MKCOL を write-only app password の `node:create` 親 path 解決から `dav.mkcol` operation、LockDO permit、既存 fsMutation へ接続し、成功・再送・key競合・同名・bodyを検証。
- 2026-09-23、`pnpm check` 成功。Node 202 + workerd 320 = **522 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。DAV PROPFIND の bounded XML adapter、allprop/propname/prop、Depth 0/1 の最大1,000 child集合取得、live/dead property 207、finite-depth 403、超過507を検証。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 318 = **517 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。DAV file GET/HEAD/single Range を current path・credential・blob の D1 assertion と R2 size/ETag 照合へ接続し、200/206、末尾 slash 404、物理 object 欠落 503 を検証。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 317 = **516 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。DAV path の一度だけの decode・深さ/長さ/portable name 制約、app password root からの casefold 解決、scope/失効/移動競合の D1 再照合と Class 1 OPTIONS を検証。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 314 = **513 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。DAV HTTP 入口を Worker に接続し、Edge rate limit を Basic KDF より前に適用。誤 secret は 401、制限超過は 429、認証後の未実装 operation は 503 として検証。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 313 = **512 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app password の旧 pepper kid を成功時に D1 の条件付き batch で再ハッシュし、D1 の応答喪失時も現行 secret を再照合することを検証。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 311 = **510 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app password の private GET/POST/DELETE を Access JWT entry に接続し、発行した secret の Basic 認証、一覧からの secret 非表示、CSRF、失効と派生 content session 失効、範囲・20件上限を D1 で検証。ControlDO は maintenance 固定、remote pepper と DAV は未接続。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 309 = **508 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app password の Basic secret verifier と発行用 hash helper を追加し、current D1 と失効競合を検証。DAV route と rate limit は未接続。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 306 = **505 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。`node.content.write` の file 限定と current edit/node:write、blob/revision/maintenance の commit proof を追加し、user/app password/link share で検証。実 content write サービスは未実装。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 303 = **502 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。`node.created` / `node.renamed` の outbox consumer と復旧監査で、通知 payload と保存済み operand/result の一致を確認。誤った結果を持つ event は完了せず、監査も拒否する。ControlDO は maintenance 固定で公開停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 301 = **500 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app HTTP の node rename を既存サービスへ接続し、実 LockDO/D1 で CSRF、確定、再送、operation 照会、競合を検証。ControlDO は maintenance 固定で公開停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 300 = **499 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。folder 作成と operation 照会の app HTTP route を追加し、実 LockDO/D1 の作成・再送・競合を検証。ControlDO は maintenance 固定で公開停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 299 = **498 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app の node 詳細・children 一覧を追加し、201件 keyset、署名 cursor と競合拒否を実 D1 で検証。ControlDO maintenance 固定と remote cursor ring 未設定で実公開は停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 298 = **497 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app の `/me` と logout を追加し、current identity、CSRF、失効後の再入場拒否、Access logout 303 を検証。ControlDO は maintenance 固定で公開停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 298 = **497 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app Worker entry に Access/CSRF/ticket 発行・取消を接続し、RS256 JWT と session 登録からの実 D1/R2、認証・設定欠落の拒否を検証。ControlDO maintenance 固定と remote 設定未完了のため実公開は停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 296 = **495 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。認証済み private content ticket HTTP handler を追加し、CSRF・同一 origin・bounded JSON、発行から取消まで実 D1/R2 で検証。Worker entry の Access 接続は未実装。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 295 = **494 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。ticket 取り消しと派生 content session の一括失効、budget 維持、別 credential・失効 session の拒否、D1 応答喪失後の照合を追加。HTTP 取り消し route は未接続。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 292 = **491 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。target manifest の決定的符号化・R2 読戻し、最大1,000 target の認可証明一括処理、private/内部共有/匿名リンクの ticket 発行、D1 応答喪失と失効競合後の照合・R2 cleanup を追加。HTTP 発行 route は未接続。
- 2026-09-22、`pnpm check` 成功。Node 196 + workerd 285 = **481 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。private/内部共有/匿名 share の安定 ID で budget を D1 batch 確保し、同じ user の app password と Access が予算を共有すること、共有 root・maintenance・revoke・期限を検証。target set/ticket 発行は次の接続対象。
- 2026-09-22、`pnpm check` 成功。Node 196 + workerd 282 = **478 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。BudgetDO の旧有効期間終了後の再初期化と、内部共有 content read の選択 share root 祖先照合を追加。別権限で読める node を共有 root 外へ移した時の拒否を実 D1/R2 で検証。
- 2026-09-22、`pnpm check` 成功。Node 196 + workerd 281 = **477 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。migration `0010` で owner ごとの未期限切れ active budget を64件に制限。insert と再有効化の境界、revoke 後の再受付を SQLite と実 D1 binding で検証。budget 発行 API は未接続。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 280 = **475 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。content host の POST/OPTIONS ticket 交換と GET/HEAD blob 配信 handler を追加。Cookie→実 R2、CORS、blob ID 不一致、maintenance 中の発行拒否、Worker entry の鍵未設定 gate を検証。実 ControlDO admission とリモート署名鍵は未設定で公開停止。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 279 = **474 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。BudgetDO の SQLite 永続 lease と内部 blob 配信を接続。eviction、known/unknown 精算、8並列、0 byte を含む1024 request、同一ミリ秒の連続 request、alarm、失効 credential、GET/Range/HEAD/304 会計を workerd で検証。後続の修正で期限切れ lease 行の回収と窓更新後の再受付も検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 273 = **468 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。content ticket と Cookie の専用 HS256 kid ring、D1 ticket redemption、`content_sessions.ticket_id` migration、Cookie からの current blob plan を追加。private と匿名 share、cancel/version/rotation を workerd で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 270 = **465 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。R2 target manifest の bounded hash 検証と node/blob/purpose/size 所属を `prepareContentBlobRead` に接続。D1 batch 直前の ticket/hash 変更を拒否。復旧監査の R2 list でも target manifest を検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 269 = **464 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。content session・ticket・target set・budget の D1 assertion を追加し、credential/purpose 不一致、target expiry、ticket/session 失効、budget revoke を検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 268 = **463 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。blob read plan の R2 key と owner/blob ID の一致を D1 内で検証し、誤った key を持つ初期行を workerd で拒否。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 267 = **462 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。`prepareNodeBlobRead` で current `node.read` assertion と node/blob/物理観測行を同一 D1 batch で照合。batch 直前のセッション失効と実 R2 配信を workerd で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 266 = **461 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。内部 R2 配信 helper のサイズ/ETag 照合、D1 content ETag、HEAD/Range/If-Range、no-store と MIME/Disposition を実 binding で検証。認可/content session/BudgetDO と公開 route は未接続。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 265 = **460 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。有効な app password と service credential の scope root を space root まで再帰検証し、scope root 自体が残っていても祖先が trash の場合は復旧監査を拒否する。両種を個別に workerd で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 264 = **459 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。復旧監査の共有 root を space root まで再帰検証し、共有 root 自体が残っていても祖先が trash の場合は拒否する。実 `trash_ops` と復元後の監査を workerd で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 264 = **459 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。改名サービスの LockDO→D1→terminal 経路を workerd で検証。同一キー再送は副作用を重複させず、異なる意図とセッション失効を拒否する。
- 2026-09-22、復旧監査の outbox provenance に `node.created` / `node.renamed` と operation kind、step 1 node ID の対応検査を追加。偽装した kind と payload の拒否を D1 で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 263 = **458 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。旧 epoch の `node.renamed` outbox を元の operation/node step の照合と claim drain 後に failed へ収束。改名操作に偽装した作成通知は残して最終 fence で拒否する。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 263 = **458 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。rename の LockDO permit、operation claim、D1 一括 mutation、FTS の語句入れ替えと `node.renamed` consumer を追加。公開 HTTP と実 admission は未接続。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 258 = **453 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。最後に内部共有と service の rename ケースを追加し、対象32テストを再実行して成功。`node.rename` の current authority/親 operand assertion を追加。rename mutation/HTTP は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 255 = **450 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。旧 epoch `node.created` outbox を claim drain 後に bounded failed へ収束し、failed の再配信を ack する。実 Queue/DLQ と ControlDO 再開は未完了。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 253 = **448 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。最後に ControlDO 閉鎖時の Cron ケースを追加し、対象23テストも再実行して成功。scheduled handler と毎分 Cron を追加。実配信と ControlDO 再開は未完了。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 252 = **447 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。Queue handler の ControlDO/D1 admission gate を内部 consumer に接続。実 Queue delivery/DLQ と ControlDO 再開は未完了。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 251 = **446 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。最終 D1 fence と bounded stale reservation release を追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 251 = **446 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。完了済み監査の最終 D1 fence を再照会時に検証し、失敗した監査を初期化。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 248 = **443 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。credential registry の逆向き参照を4種の source に追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 247 = **442 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。R2 完成済み object の全件照合と永続 cursor を追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 245 = **440 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。FTS5 再構築・元テーブルとの整合性検証を追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 244 = **439 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。share/credential の復旧監査を追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 242 = **437 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。outbox の復旧監査を追加。ControlDO SQLite 監査進捗は診断専用であり、admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 241 = **436 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。ControlDO SQLite 監査進捗は診断専用であり、admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 238 = **433 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。復旧監査は読み取り専用・ページ単位で、再開 gate は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 234 = **429 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。ControlDO admission/復旧 verifier は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 231 = **426 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。実 Queue 配信/DLQ は試験していない。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。配布済み workerd/Biome バイナリの ELF interpreter をローカル `node_modules` 内だけで調整。Node 195 + workerd 227 = **422 tests** 成功。lint/typecheck/contracts/config と Wrangler dry-run build も成功。リポジトリの固定版 Node 24.21.0 / pnpm 12.4.1 とは異なるため、CI で固定版の確認が必要。
- 2026-09-22、Windows / Node 24.21.0 / pnpm 12.4.1 で `pnpm check` 成功。
- Biome、TypeScript、contracts/config verifier: 成功。
- Node 単体: 9 files / 195 tests 成功。
- 前回の Windows ローカル Workers 統合: 18 files / 220 tests 成功（合計415 tests）。
- Vite build と Wrangler deploy **dry-run**: 成功。配備や remote migration は実行していない。
- Windows sandbox 内で esbuild の親 directory 読取りが拒否されたため、テストと dry-run build は承認された制限外プロセスで実行。Cloudflare の本番資格情報は使用していない。
