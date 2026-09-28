# 受信した共有の閲覧と編集

更新: 2026-09-28。内部共有の受信一覧・フォルダー閲覧・ファイル配信に加え、edit共有へのフォルダー作成・改名・単一/分割upload・上書き・共有内の移動/コピー/ごみ箱への移動を接続。[DAV Shared](DAV_SHARED.md)の同じ共有内の操作も接続済み。公開link、cross-owner copyは後続。

## 画面とAPI

サイドバーの「共有された項目」から現在アクセスできる共有を開く。`/shared`は100候補単位の受信一覧、`/shared/:shareId`は共有ルート、`/shared/:shareId/:nodeId`は共有配下を表示する。フォルダーは200件単位で追加読込みでき、ファイル単体の共有も開ける。これらのHTMLも既存のprivate asset経路と同じapp host・Access認証・no-store・CSPを要求する。

`GET /api/v1/shares/:id`は所有者の設定に加え、現在の受信者にも利用できる共有の詳細を返す。受信者の`recipients`は空配列で、ほかの受信者のメールアドレスを公開しない。変更・停止は引き続き所有者だけに許可する。

共有内のnode詳細・path・childrenは`shareId`と`shareVersion`の両queryを必要とする。片方だけ、重複、未知query、非canonicalな正整数versionは400。選択なしで別ownerのmetadataを読む要求、停止済み/旧versionの選択、選択した共有範囲外は404。自分のFiles APIは従来のqueryなしで利用できる。

## 共有の範囲

認可principalに検証・複製・freezeした`selected_share`を保持する。現在のgrantだけでなく、選択したshareのid/version/actionを認可SQLへ束縛し、別の広い共有や所有者権限で代替しない。選択を設定できるprincipalはAccess userだけ。

nodeReadは認可の再検査と同じD1 batchでshare root/owner/versionを固定する。breadcrumbは共有ルートで止まり、node詳細もルートの`parentId`をnullにする。共有より上の親ID・名前を返さない。認可自体は共有ルートより上もspace rootまで検査するため、上位フォルダーのtrash・循環・切断でアクセスを許可しない。childrenの署名cursorには選択したshare id/versionも含め、別共有・更新後versionでの継続を拒否する。

ファイルを開くと、既存content ticketへ所有者のspaceIdと同じshare id/versionを渡す。別originのPOSTでHttpOnly Cookieへ交換し、tokenをURLへ出さずにcontentを取得する。共有停止は既存session/ticket失効経路へ接続され、発行済みCookieでも次の取得を拒否する。

画面のquery keyはaccount/epoch/share/version/nodeを含む。再検査中・認可拒否後は以前の一覧やbreadcrumbを隠し、手動更新で現在のshare詳細から読み直す。既に表示済みの情報を遠隔消去する仕組みではなく、画面更新・再表示・新しいAPI要求時に検査する。タブへ戻るだけでは自動更新しない。

## 編集と再開

edit共有のフォルダーでは新規フォルダーとuploadを表示し、子項目の改名とfile上書きを許可する。共有ルート自体の改名は許可しない。read共有には書込みボタンを表示しない。成功後は共有一覧・詳細・node/path/childrenを読み直す。

`POST /api/v1/nodes`、`PATCH /api/v1/nodes/:id`、`POST /api/v1/uploads`のJSONに`share: { id, version }`を指定する。直接共有したfileを上書きする場合は`parentId`を送らず、選択した共有でtargetを認可してserver内で親を解決する。親IDをupload receiptへ返さない。容量はコンテンツ所有者へ計上する。

migration `0049_selected_share_writes.sql`はoperations/uploadsへnullableな`selected_share_id`・`selected_share_version`を追加する。pair、internal share、所有者、principal/sourceの整合性を検査し、保存後のscope差替えを禁止する。completion operationとuploadのpairも一致を要求する。過去の選択なし記録はNULLのまま、operation IDと従来のrequest digestを維持する。通常table数は69のままで依存追加はない。

選択したshareはcanonical request digestへ含める。同じIdempotency-Keyで選択を省略・変更した要求は別intentとして拒否する。operation照会、Outbox、UploadDO、R2書込みの許可、upload公開・結果照合・後始末は保存済みscopeを復元して使用する。別のedit grantが残っていても停止した共有を代替しない。復旧検査はscope pairとupload/operationの対応を検査するが、過去の正常な記録に対して現在のgrantを要求しない。

UIの未確認操作は共有付きの元body/keyをsessionStorageへ保存する。uploadのIndexedDB記録には受信者のaccount/epoch、所有者のspace、選択したshareと上書き対象revision/blobを保持する。reload後も同じ記録を使い、分割済みpartは再送しない。直接共有されたfileでは保存するparentIdもnullのまま。共有停止やversion変更後の送信・確定・再開は拒否し、未確定の容量は既存のserver回収処理へ残す。

0049適用後に選択付きwriteを受け付けたDBは、選択情報を読まない旧Workerへそのまま戻さない。旧版はuploadやOutboxのscopeを復元できないため、rollback時はmaintenanceを保ち、選択情報を扱うWorkerを再配備・検証する。新しい列を削除して旧版へ合わせることはしない。remote migration・配備・rollback演習は未実施。

## 移動・コピー・ごみ箱

共有内の子項目の「その他の操作」から、移動・コピー・ごみ箱への移動を行う。移動先/コピー先のpickerも選択したshareで一覧とpathを読み、共有ルートより上へ移動しない。同一共有内のsame-owner COPYは既存COWを使い、内容所有者・容量会計を維持する。共有ルート自体の移動・改名・削除は許可しない。

`POST /api/v1/nodes/:id/move`、`POST /api/v1/nodes/:id/copy`、`DELETE /api/v1/nodes/:id`もJSONの`share: { id, version }`を受け付ける。元と先の両方を同じ共有で認可し、別の広いedit共有で代替しない。確定済みのoperation shortcutも保存したshare pairを明示比較し、省略・変更した再送を拒否する。結果照会とOutboxは元のsource/parentと現在の宛先を同じ共有で再検査する。選択を省略したoperation照会だけは保存scopeを復元する。

共有での削除は選択付きAccess userのedit grantに限定する。live subtreeのmembership、子の共有停止、ticket/session失効、activity/Outboxを既存の原子的trashへ接続する。trash_ops.actor_idには削除した受信者を保存し、ごみ箱の一覧・復元・完全削除はspace所有者で検査する。受信者には所有者のごみ箱や復元権限を公開しない。所有者の復元先が共有外なら、受信者は復元後の項目を取得できない。停止した子の共有も自動復活しない。

schema0049・69通常tableを維持し、migration追加はない。移動・コピー・削除の確定直前の共有停止では全変更をrollbackする。share root削除、read共有からの削除、範囲外の宛先、元source/parentが共有外へ移った後の照会・Outbox、所有者以外によるtrash一覧/restore/purgeを回帰試験で検査する。browserではmobileのfolder COPY・file MOVE、削除ACK喪失後の同じkey/body再送、所有者の復元まで確認する。

## 検証

従来のpathが共有ファイルより上の非共有フォルダー名を返すことを、実D1テストで修正前に再現した。新規workerd14件は共有ルートでのparent遮蔽、read共有から別edit共有への権限代替拒否、停止/version/root/credential/recipient/owner/祖先trash/maintenance/epochのbatch直前競合、201件paginationとcursor選択束縛、HTTP query境界を検証する。

ブラウザーでは所有者と受信者を独立したAccess sessionにし、実APIで共有を作成する。mobileで一覧→子フォルダー→reload→実bytesのダウンロード→所有者の共有停止→発行済みcontent Cookieの拒否・一覧更新を確認する。単体file共有、祖先名の非表示、受信者の共有停止拒否、範囲外への直接URLも確認する。test-only identityはapp host限定Cookieで切り替え、content originのCORS条件は変更しない。最新結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

編集の実D1試験では、別grantへの代替拒否、共有付きoperationの再送・照会・Outbox、commit直前とnative R2受付直前の失効、単一/分割uploadの再送・停止・所有者容量、単体file上書きのparent非公開を確認した。保存済みscopeの不正pair、完了operationとの不一致、停止済み共有に属する正常な過去記録も復旧検査で区別する。復旧freezeの全SQLを実D1の確定batchで実行し、式深さ上限を超えないことを回帰試験に含める。

編集のbrowser試験では、folder作成の応答喪失後にreloadして同じkey/bodyで照会・再送する経路、改名とmobile表示、96MiBの分割uploadを同じattemptで再開して送信済みpartを省略する経路、直接file上書きのparent非公開・完了応答喪失後の非再送を確認した。全browser27件が成功している。

## 次の実装

同じ所有者の異なる共有間のDAV転送は[DAV Shared](DAV_SHARED.md)へ接続済み。Access画面での共有間宛先選択、cross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIP、共有メディアと実環境検証が残る。今回の受信画面だけでPhase 6完了とはしない。
