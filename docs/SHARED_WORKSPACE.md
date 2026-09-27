# 受信した共有の閲覧

更新: 2026-09-28。内部共有の受信一覧・フォルダー閲覧・ファイル配信を接続した段階。共有への編集・upload、DAV Shared、公開linkは後続。

## 画面とAPI

サイドバーの「共有された項目」から現在アクセスできる共有を開く。`/shared`は100候補単位の受信一覧、`/shared/:shareId`は共有ルート、`/shared/:shareId/:nodeId`は共有配下を表示する。フォルダーは200件単位で追加読込みでき、ファイル単体の共有も開ける。これらのHTMLも既存のprivate asset経路と同じapp host・Access認証・no-store・CSPを要求する。

`GET /api/v1/shares/:id`は所有者の設定に加え、現在の受信者にも利用できる共有の詳細を返す。受信者の`recipients`は空配列で、ほかの受信者のメールアドレスを公開しない。変更・停止は引き続き所有者だけに許可する。

共有内のnode詳細・path・childrenは`shareId`と`shareVersion`の両queryを必要とする。片方だけ、重複、未知query、非canonicalな正整数versionは400。選択なしで別ownerのmetadataを読む要求、停止済み/旧versionの選択、選択した共有範囲外は404。自分のFiles APIは従来のqueryなしで利用できる。

## 共有の範囲

認可principalに検証・複製・freezeした`selected_share`を保持する。現在のgrantだけでなく、選択したshareのid/version/actionを認可SQLへ束縛し、別の広い共有や所有者権限で代替しない。選択を設定できるprincipalはAccess userだけ。

nodeReadは認可の再検査と同じD1 batchでshare root/owner/versionを固定する。breadcrumbは共有ルートで止まり、node詳細もルートの`parentId`をnullにする。共有より上の親ID・名前を返さない。認可自体は共有ルートより上もspace rootまで検査するため、上位フォルダーのtrash・循環・切断でアクセスを許可しない。childrenの署名cursorには選択したshare id/versionも含め、別共有・更新後versionでの継続を拒否する。

ファイルを開くと、既存content ticketへ所有者のspaceIdと同じshare id/versionを渡す。別originのPOSTでHttpOnly Cookieへ交換し、tokenをURLへ出さずにcontentを取得する。共有停止は既存session/ticket失効経路へ接続され、発行済みCookieでも次の取得を拒否する。

画面のquery keyはaccount/epoch/share/version/nodeを含む。再検査中・認可拒否後は以前の一覧やbreadcrumbを隠し、手動更新で現在のshare詳細から読み直す。既に表示済みの情報を遠隔消去する仕組みではなく、画面更新・再表示・新しいAPI要求時に検査する。タブへ戻るだけでは自動更新しない。

## 検証

従来のpathが共有ファイルより上の非共有フォルダー名を返すことを、実D1テストで修正前に再現した。新規workerd14件は共有ルートでのparent遮蔽、read共有から別edit共有への権限代替拒否、停止/version/root/credential/recipient/owner/祖先trash/maintenance/epochのbatch直前競合、201件paginationとcursor選択束縛、HTTP query境界を検証する。

ブラウザーでは所有者と受信者を独立したAccess sessionにし、実APIで共有を作成する。mobileで一覧→子フォルダー→reload→実bytesのダウンロード→所有者の共有停止→発行済みcontent Cookieの拒否・一覧更新を確認する。単体file共有、祖先名の非表示、受信者の共有停止拒否、範囲外への直接URLも確認する。test-only identityはapp host限定Cookieで切り替え、content originのCORS条件は変更しない。最新結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

## 次の実装

edit共有のfolder作成・改名・uploadをUIへ接続する前に、選択したshareをnamespace operationのcanonical request、再送/照会、Outboxの保存済みprincipal、復旧検査、UploadDOの権限照合まで保持する必要がある。現状のbackground復元がkind/user/credentialだけを再構成する箇所へ、選択したshareの処理を渡さない。共有選択が失われた状態で別grantに切り替わることを防ぐ試験が必要。

DAVの固定mount解決、旧NULL mount方針、公開link/password/unlock/public bundle、upload-only、ZIP、共有メディアと実環境検証も残る。今回の受信画面だけでPhase 6完了とはしない。schema0048・通常69tableのままで、migration・依存追加はない。
