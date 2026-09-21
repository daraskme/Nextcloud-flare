設計書とラウンド2のレビュー・解決記録を読み、Cloudflare Access の仕様は公式資料で照合します。ファイルは変更せず、設計に明記された防御と未規定の事項を分けてレビューします。v0.3 では、全 operand の認可、共有失効の commit 時再検査、typed ticket、復旧 epoch など、前回の主要な防御が明文化されています。一方、Access のトークン種別・失効伝播、共有 Cookie の属性、公開 API の CSRF、プレビューの安全な既定値には未規定の点が残っています。WebDAV には RFC と食い違う記述もあり、一次資料で確認しています。# ラウンド3 — セキュリティ／認証・認可レビュー

## 総評

v0.3 は、ラウンド2で問題になった **全 operand の認可、commit 時の再検査、typed ticket、復旧 epoch、公開ルートの分離**を大きく改善しています。これらは維持すべきです。

一方、実装契約としては次の境界が未確定です。

- Access の **user JWT と Service Token JWT の識別・受入経路**
- ログアウト、Access 失効、アプリ内停止、app password 失効の関係
- **共有 root より上の祖先が削除された場合の read 認可**
- 共有 Cookie と公開 JSON API の CSRF 契約
- プレビューの MIME・CSP・origin 分離の具体的な安全条件
- 自動生成されるプラットフォームログからの capability 漏えい
- WebDAV の RFC と食い違う lock／ETag の記述

**本レビューでは、実装済みの致命的脆弱性を確認したわけではありません。** 以下は「設計上の矛盾」「危険な実装を排除できない契約不足」「明記済みの防御」を区別した評価です。実環境の Access 設定、D1 SQL、ブラウザ挙動は未検証です。ファイルは変更していません。

対象：[DESIGN.md](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)
参考：[round2-astra.md](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/reviews/round2-astra.md) [round2-resolution.md](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/reviews/round2-resolution.md)

---

## 1. 脅威モデル

ここでの「到達」は、正規権限で扱える資産と、攻撃入力を到達させられる処理を分けています。

| 攻撃者 | 到達できる資産・処理 | 明記された防御 | 未規定・残存リスク |
|---|---|---|---|
| **(a) 未認証の外部者** | share landing、公開 API、DAV 認証処理。認証・XML・URL パーサ、レート制御、Worker／DO の費用面へ攻撃入力を送れる。正規の private データアクセスは不可 | §2.2 の allowlist・未知経路404・private fallthrough禁止・Worker-first、§4.2 JWT検証、§4.4 KDF前レート制限、§7.2 XML制限 | JWT/JWKS の入力・更新予算、無効 token による状態生成の上限、公開 API の CSRF 詳細、具体的な認証試行上限が不足〔A1–A2、T4、T6、I1–I2〕 |
| **(b) 共有リンク保持者** | read：現在の共有 subtree と発行済み ticket の固定 blob。edit：許可された変更。upload-only：新規受取と自分の receipt／upload 状態のみ | §4.3 action表、§8 の root・version・expiry・用途分離、配信時認可、TicketDO、upload-only非列挙・非上書き | 削除された上位祖先の検査、unlock Cookie属性・寿命、匿名 edit の具体的 endpoint、公開 JSON mutation のCSRF、個別セッション失効が未確定〔Z1–Z2、T1、T4〕 |
| **(c) 認証済み一般メンバー** | 自分の space、内部共有で許可された他者 subtree、通常 UI／API。自分のファイル名・内容を他者に表示させられる | `iss+sub`、disabled判定、全operand認可、同一space制約、quota、不変blob、内部共有pathの打切り | 「自分のspaceのowner」と全体管理者の区別、管理APIの判定表、認証済みというだけでデータ認可を省略しない型・実行時契約、保存型XSS対策〔Z1、C1–C2〕 |
| **(d) app password を盗んだ者** | その credential のDAV scope／optional rootと、元ユーザーが現在持つ権限の範囲。rwなら書込み・削除・LOCK等 | Basic over HTTPSのみ、他方式へのfallback禁止、HMAC保存、timing-safe比較、scope、expiry／revoke、epoch失効 | Access／IdPログアウトではこの資格情報は自動失効しない。ユーザー停止の全経路への反映、権限との積集合、エントロピー・通常ローテーション・有限TTLが不足〔A4、Z3、T3〕 |
| **(e) Cloudflareアカウント全権管理者** | D1・R2・backup・ログ、Access設定、Worker配備、実行中secretの利用。データと監査を変更できる | §13.3でtrust boundary内、管理者への暗号学的改竄耐性は保証外。環境分離あり | **この攻撃者への機密性・完全性は保証されない。** 同一accountのCONTENT_HOST分離でも防げない。最小権限、管理者MFA、配備承認、外部保全の運用が未規定〔S2〕 |
| **(f) 悪意ある／侵害されたWebDAVクライアント** | 保持するcredentialの全権限、XML・各種DAVヘッダ、lock・quota・変換処理への入力。読めるデータは持ち出せる | XML上限、DTD等禁止、scope、If／lockの分離、metadata quota、part予算、不変blob・versions | 正当なcredentialによる権限内持出しは防げない。lock creator照合の不足、MOVE時lock意味論、weak ETag、ヘッダのパース上限が残る〔W1–W3、I2〕 |

### 明記しておくべき保証外事項

- 共有リンク・ticket の転送、取得済み内容の複製は防げません。§0.2／§8.2の非DRM方針は妥当です。
- 悪意あるクライアントが**正規権限内で**実行するダウンロードや削除は、認可バイパスではありません。最小scope、失効、versions／backupで影響を制限します。
- マルウェア検査は非ゴールです。attachment配信は、利用者がダウンロード後に危険なファイルを開くことまで安全にしません。
- (e) が「Access設定だけを管理できる担当者」なのか「account全権管理者」なのかは運用上分けるべきです。上表は後者です。

---

## 2. Cloudflare Access 統合

### A1 — JWT受入プロファイルが未完成  
**重大／§2.2、§4.2、§14.1**

署名・issuer・audience・expiry・not-beforeを検証する方針は正しいですが、以下を固定する必要があります。

| 項目 | 必要な実装契約 |
|---|---|
| `Cf-Access-Jwt-Assertion` | private経路ではこのヘッダを正規入力とする。ヘッダの存在だけで認証せず、JWT全体を検証する。欠落・重複・不正形式は拒否 |
| `CF_Authorization` | 暗黙のfallbackにしない。ブラウザからAccessへ送られるCookieであり、Workerに必ず届くとは限らない。fallbackを設けるなら対象経路・検証・ヘッダとの競合処理を別途定義 |
| `alg` | v1は公式の署名方式に合わせて **RS256に固定**。`none`、HS256との混同、token自身が指定する任意algorithmを禁止 |
| `iss` | 設定されたteam domain URLとの厳密一致。JWT内の`iss`から任意JWKS URLを生成しない |
| `aud` | **host／route／環境ごとの許可AUD**を照合。別Access appの有効JWTを横断的に受け入れない |
| `kid` | 固定JWKS内の鍵選択にだけ使用。未知鍵、重複・不整合な鍵、許可外の鍵種別を拒否。`jku`／`x5u`等で検証先を変更しない |
| claim型 | `type=app`を要求し、global session用の`type=org`を拒否。数値時刻、audienceの型、userの非空`sub`等を厳密に検証 |
| 時刻 | `exp`必須。`nbf`がある場合は必ず評価。`iat`の過度な未来値や不合理な寿命を拒否。clock skewを明示的に小さく設定する。例えば60秒は**提案値**でありCloudflareの保証値ではない |

Cloudflare公式は、Cookieではなく **`Cf-Access-Jwt-Assertion`の検証を推奨**しています。JWTのJOSEヘッダの`typ: JWT`、payloadの`type: app`、アプリ独自ticketの`typ`は別の概念です。

複数Access appを使う場合、単なる全AUDの集合ではなく、例えば「通常API用AUD」「管理API用AUD」「automation用AUD」を経路に対応させてください。同一Access appに複数domainを登録する場合も、Worker側のhost制限は必要です。

### A2 — JWKSローテーション方針はあるが、キャッシュと更新予算が不足  
**中／§1、§4.2**

「未知kidなら一度更新、失敗はfail closed」は妥当です。ただし、**リクエストごとに一度**では、異なるkidを送るだけでJWKS取得を大量発生させられます。

**修正案：**

- 固定team domainの証明書endpointを使い、現行・旧鍵を`kid`で選択する。
- TTL、最大staleness、取得timeout、応答サイズ上限を定義する。
- issuer単位の更新cooldown／single-flightと、容量制限付きnegative cacheを設ける。
- キャッシュ済み既知鍵を利用できる条件と、更新失敗時に拒否する条件を分ける。
- 鍵削除・緊急ローテーションを反映できる最大遅延を定義する。

公式資料では、Access署名鍵は既定で**6週間ごとにローテーション、旧鍵は7日間有効**です。単一の`public_cert`を固定保存せず、JWKSの鍵集合から照合すべきです。

### A3 — Service Tokenとprivate routeの契約が衝突  
**重大／§2.2、§4.1–4.3、§14.3**

§2.2はprivate handlerを「Access user」の`AuthedContext`に限定する一方、§4.2–4.3はService TokenによるREST automationを許可しています。どの経路がservice principalを受け入れるか不明です。

また公式のService Token JWT例では：

- `type: "app"`
- `common_name`: Client ID
- `sub: ""`
- `email`なし
- `nbf`なし

となっています。user用必須claimをそのまま適用すると正規automationを拒否し、逆に空の`sub`をuserとして保存するとprincipal混同になります。

**修正案：**

1. REST automation専用のroute／method allowlistを設ける。
2. Accessでは **Service Auth** policyを使用する。BypassでClient IDヘッダを信用しない。
3. 検証済みJWTの`iss + 対象aud + common_name`を、既存service principalへ対応付ける。
4. rawの`CF-Access-Client-Id`だけを認証根拠にしない。
5. 権限は、service scope・mapped userの現在権限・対象spaceの**積集合**とする。
6. 未登録mapping、停止mapping、停止mapped userは拒否する。
7. Service Tokenをowner bootstrap、通常user session、DAV資格情報へ変換しない。

`nbf`の必須性はtoken種別ごとに規定してください。実際に発行されるclaim集合は **要確認**です。

### A4 — ログアウト・Access失効・アプリ内失効が接続されていない  
**重大／§4.2、§9、§11.4、§17**

§9の「browser cacheとmemory credentialを消す」だけでは、Access logoutにはなりません。また署名・`exp`のローカル検証だけでは、Access側の失効状態を知ることはできません。

公式資料上、Access logout endpointは次です。

- アプリdomainの `/cdn-cgi/access/logout`
- team domainの `/cdn-cgi/access/logout`

現在の公式説明では、logoutは全Access appに及び、既発行tokenの受入停止に**20–30秒**を要します。即時失効とは区別してください。

**修正案：**

| 操作 | 必要な契約 |
|---|---|
| ブラウザlogout | Access logoutへの遷移、アプリCookieの削除、memory／IndexedDB等の資格情報の扱い、他tabへの通知を定義 |
| Access／IdPでの停止 | private入口への効果と、D1内ユーザー停止への反映手順を分離。DAVはBypassなのでAccess停止だけでは止まらない |
| アプリ内ユーザー停止 | user、app password、mapped service principal、job、uploadの全経路へ反映。既存shareを止めるかも明示 |
| app password失効 | Access sessionとは独立に即時照合。通常logoutで失効させないなら、その仕様を明示 |
| share/session失効 | share versionによる全体失効と、個別unlock sessionのlogoutを区別 |
| 進行中stream | 新規requestの拒否時点と、既に開始した転送の扱いを明示。受信済みbytesの回収は保証しない |

Access側の失効伝播、Service Token由来の既発行JWT、複数appでのlogout挙動は、構成したstaging環境で **要確認**です。

### A5 — Bypassと迂回入口の基本設計は適切。ただし生成規則が必要  
**中／§2.2、§14.1–14.3**

良い点：

- private側でもWorkerがJWTを検証する。
- publicからprivateへfallthroughしない。
- Bypass requestのAccess JWTをuser principalへ昇格しない。
- `workers_dev: false`と`preview_urls: false`を両方設定する。

補完点：

- Accessは、より具体的なapplication pathを優先し、その経路に親appのpolicyが自動継承されるとは限りません。
- `/dav/*`は`/dav`を含みません。`/s`等も同様です。
- Accessのapplication pathと、Workerの**method＋route template allowlist**は同じ表現力ではありません。Worker側の最終拒否を維持してください。
- BypassではAccessの認証制御・Accessログに依存できません。アプリ監査とレート制御が必要です。
- Bypass経路にもHTTPS強制を設定する。HTTPで受け取ったBasic資格情報は、後からHTTPSへredirectしても保護できません。
- app WorkerだけでなくCONTENT_HOST側Worker、全環境、古いalias／追加custom domainにも同じ入口制限を適用する。

`workers_dev`とpreviewの無効化指定は公式仕様と整合しています。実際の全公開入口、URL正規化差、Accessの予約経路は **要確認**です。

---

## 3. 認可モデルの形式的検討

### 前提：v0.3ではAPIが変更済み

依頼文の`authorize(principal, node, action)`ではなく、本文は次に改められています。

```ts
authorize(principal, operation, operands: Operand[]): AuthorizationProof
```

これは正しい方向です。ただし、**operandを列挙することと、その全条件を一つの有効な状態に対して証明することは別**です。

[DESIGN.md:273-312](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

### 必要な判定条件

通常のデータ操作について、少なくとも以下の論理積が必要です。

```text
Allow =
  認証方式がそのrouteで許可されている
  AND principal・credential・grantが現在有効
  AND epochと用途が一致
  AND 全operandについて必要権限が成立
  AND node・parent・space・blob世代の関係が整合
  AND 操作固有の削除状態・lock・revision条件が成立
```

`AuthorizationProof`には、principal／credential、grant version、操作、operand ID、対象spaceごとのtree generation、期待revision等を束縛し、別操作で使い回せないようにすべきです。`AuthedContext`だけではオブジェクト認可の証明になりません。

### Z1 — 全endpointの認可被覆は、本文だけでは証明できない  
**重大／§2.2、§4.3、§5.1、§7、§12**

| 経路群 | 評価 |
|---|---|
| node metadata／children／path／content／thumb／preview | 共通認可方針はある。HEAD、Range、条件付き応答、派生物でも同じ判定を必要とすることを明記すべき |
| create／overwrite／rename／MOVE／COPY／delete | 全operandとcommit再検査が明記され、改善済み |
| upload create／part／status／complete／abort | principal束縛は明記。ただしreceipt所有と現在の権限、失効後status開示範囲を固定する必要あり |
| trash list／restore／purge | action表に独立した権限規則がない。通常readでtrashを読ませず、専用権限を定義すべき |
| share管理／app-password管理／quota | share possession、本人のcredential管理、space owner、全体adminを明確に分離する必要あり |
| job status／cancel／retry、DLQ／requeue | 作成主体への束縛だけでは不十分。現在権限・操作種別・admin権限の判定表が必要 |
| 検索／Recent／Starred／集計／count | 検索のscope joinは良いが、全レスポンス・集計・cursorを含むroute契約は未完成 |
| public link edit | §4.3はrename／MOVE／deleteを許可するが、§5.1のpublic API表には対応経路が明確にない |
| WebDAV | PROPPATCH、LOCK／UNLOCK／refresh、lock-null作成を含めてoperationへ対応付ける必要あり |
| Queue／Cron／copy／bulk job | HTTP認証を通らない。保存principalと現在権限、各chunk／公開確定時の再認可が必要 |

特に`owner/admin`列の「許可」は、**対象spaceのownerなのか、アプリ全体adminなのか**を区別してください。一般ユーザーが自分のspaceを所有することを、他spaceへの管理権限にしてはいけません。

**修正案：** route manifestに認証方式、operation、必須operand、CSRF方式、必要管理権限を持たせ、未分類routeを登録不可にする。各routeに対する別principal／別space／失効後のnegative testを生成する。

### Z2 — 削除された上位祖先を見落とすread経路が残る  
**重大／§3.2、§4.1、§5.5、§8.2、§11.1、§12**

想定される反例は次です。

1. `P/S/F`があり、`S`をrootとする有効な共有がある。
2. ownerが`P`をtrashにする。
3. §11.1に従って`P`を先に不可視化するが、子孫tag処理は途中。
4. `S`のshareはまだ有効、`F.deleted_at`も未設定。
5. §8.2に明記された「share有効・F未削除・FがSの子孫」だけなら、内容配信を許可できてしまう。

**tree generationを確認するだけでは、この状態を拒否する述語にはなりません。**

**修正案：**

- `EffectiveLive(node)`を定義し、node自身から**space rootまで**の祖先に削除・不可視化中の境界がないことを要求する。
- capability rootへの到達確認と、全祖先の有効性確認を分ける。
- 認可内部では共有rootより上も検査する一方、応答のpathは共有rootで打ち切る。
- list、search、count、thumb、preview、ticket、ZIP entryにも適用する。
- trash／restore専用操作だけが、明示的な別規則で削除済みoperandを扱う。

[DESIGN.md:449-461](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)
[DESIGN.md:588-607](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

### ancestor判定はD1で安全に実現できるか

**実現可能です。ただし、SQLとmigrationがないため形式的な実装証明は未完了です。**

必要条件：

1. node IDから親を辿る再帰CTEを使用する。表示pathの文字列prefix比較は禁止。
2. 各辺でspace一致を検証する。
3. capability rootとの同一性／到達性と、space rootまでの有効性を検査する。
4. 深さ64を上限にし、循環・孤児・上限超過・root未到達は拒否する。
5. 読取り認可は、grant・node・祖先を整合したsnapshotで判定する。
6. mutationは本文どおりcommit batch内で再検査し、失敗をbarrierでrollbackする。
7. parent FKだけでは同一spaceや循環禁止を保証しない。§3.1が予定するtrigger／複合制約をmigration testで具体化する。

D1の`batch()`を使う方向は妥当です。なお`withSession("first-primary")`は**最初のquery**をprimaryへ送る指定であり、session全queryが常にprimaryという意味ではありません。認可・失効検査に使うDBアクセス層で、この違いを隠さないでください。

### MOVE／COPYの判定

**src／dst両側を検査する規定は反映済みです。** 以下を操作別に固定すればよい構造です。

| 操作 | 必要な権限・条件 |
|---|---|
| MOVE | source、source parentの削除／付替え権限、destination parentの追加権限、overwrite targetの削除権限。全scope・祖先・lockを検査 |
| COPY | sourceのread、destination parentのcreate、overwrite時のtarget変更／削除権限。sourceのwriteは不要 |
| cross-owner COPY | 両spaceを別々に認可。source pinは保持保証であり、読み出し権限の代用にしない |
| restore | trash操作権限と、復元先のliveなparentへのcreate権限 |
| 同一space外MOVE | v1の拒否方針を維持 |

複数の内部共有を持つuserは、それぞれの正規grantで各operandを認可できます。一方、複数のlink Cookieを暗黙に合成して一つの操作を許可してはいけません。

### Z3 — ID所有者例外とterminal result再生の制約不足  
**重大／§4.1、§5.2**

§4.1の「作成principal fingerprint **または同じspaceのowner**」は、credential scopeを上書きする例外にしてはいけません。

例えば、owner本人が発行した狭いroot限定app passwordを「ownerと同じuser IDだから」と扱うと、root外のupload／job／operationへ到達できる設計になります。

また`fsMutation`は、`claim.terminal`ならoperand認可より前にresultを返します。

**修正案：**

- 「IDの所有関係」と「その操作を現在実行できる権限」を別々に検査する。
- owner例外は制限付きprincipalのscopeを拡張しない。
- terminal result再生前にも、現在のprincipal有効性と結果の開示権限を検査する。
- 停止、scope縮小、share失効後に、旧結果のnode名・path等を返す範囲を定義する。

この早期return自体がmutationを再実行するわけではありません。問題は**結果開示と現在権限の扱い**です。

### Z4 — 復旧epoch変更を跨ぐ進行中HTTP requestの扱いが不足  
**重大／§5.2、§11.4、§14.2**

D1外にepochを置いた点は良い改善です。しかし、`fsMutation`は冒頭でControlDOを読み、復旧手順は主にQueue／Cron／jobのquiesceを規定しています。

旧epochで認証済みのHTTP mutationがR2 I/O等で停止し、復旧後に再開する場合のcommit阻止が明確ではありません。

**修正案：**

- maintenance時に新規mutationだけでなく、**進行中HTTP commitの収束**を管理する。
- ControlDOの受付／commit permit、未確定D1要求の照合、復旧開始条件を定義する。
- user停止・role変更・service mapping変更も、share／credential同様にcommit guardへ反映する。
- 復旧を跨いだ旧HTTP requestが新しいDBへ確定できないテストを追加する。

単に「commit直前にもう一度epochを読む」だけでは、外部DO読取りとD1 commit間の競合を完全には閉じられません。

---

## 4. セッション／トークン

### 個別評価

| ID・重要度・章 | 現状 | 必須の補完 |
|---|---|---|
| **T1：重大** §4.4、§8.1、§13.1 | unlockは署名付き・用途分離・share version／epochあり | **`Secure`、`HttpOnly`、SameSite、Domain、Path、TTLが未規定**。host-onlyとし、適合する設計なら`__Host-`名を使う。署名対象に`session_id`、`iat`、`exp`、`kid`、厳密なaudを含める。expiryはshare expiryを超えない。個別logoutを保証するならsession失効状態が必要 |
| **T2：中** §4.4、§8.2、§13.1 | download ticketはnode／blob／share／version／epoch、6h TTL、pin、DO予算あり | ticket IDの生成、署名形式、`exp`／`kid`、audの具体値、個別取消しを固定。6hはshare expiryを延長しない。content-hostへの交換で元ticketのbudgetを新規付与しない。署名検証前に任意ticket IDでDO状態を作らない |
| **T3：中** §4.4、§7.1、§17 | app passwordはCSPRNG、一度表示、HMAC保存、timing-safe比較、revoke／epochあり | secret長、有限の既定TTL、最大発行数、credential ID形式、通常ローテーション、scope変更時の扱いを定義。推奨は256bit random secret。比較は固定長MACを安全な暗号APIで行う。本人の現在権限との積集合を常に取る |
| **T4：重大** §2.2、§5.1、§13.2 | private mutationはOrigin＋custom header、share SSRはone-time CSRF | public JSON APIについて具体的なCSRF方式がない。unlock、ticket発行、upload create／complete／abort等に適用。tokenをsession・share・method／用途・expiryへ束縛し、one-time消費を原子的に行う。欠落／`null` Originを安易に許可しない |
| **T5：中** §3.1、§4.1、§5.4、§6 | uploadはcreator fingerprint等へ束縛、失効／終端／deadlineあり | upload IDとbearer capabilityを区別。IDは認可根拠にしない。capabilityは生成entropy、保存形式、aud、expiry、upload ID、creator、credential／share versionへ束縛。part／status／abortにも現在の認可を適用。IndexedDBに何を保存・logout時に削除するか固定 |

### 共通の不足

- §13.1の「token entropy ≥128 bits」はshare token／Cookie行にありますが、app password、CSRF nonce、upload capabilityまで明確に適用されていません。
- random IDとbearer secretは別です。認可が正しければIDの秘匿性には依存しません。
- 高entropyのshare tokenをhashだけ保存する方針は妥当です。人間のpasswordと同じ低速KDFは不要です。
- `epoch || typ || payload`は、曖昧な文字列連結ではなく、型と長さが一意なencodingまたは標準署名形式に固定してください。
- 「一度だけ表示」のsecretを、冪等応答のために`operations.result_json`、audit、journalへ平文保存してはいけません。
- key rotationはT1–T5すべてに影響します。鍵の残存期間は、最大token寿命が決まらないと安全に定義できません。

### CSRFで特に注意する点

Access JWTがWorkerへ**ヘッダとして**届いても、ブラウザ側の認証元がCookieならCSRF対策は必要です。

また、次は防御になりません。

- CORSを許可しないことだけで、すべてのcross-origin送信を防いだとする。
- SameSiteだけで、同一siteの悪意あるsubdomainを排除する。
- CONTENT_HOSTをアプリmutationのOrigin allowlistに入れる。
- Access自身のCSRF CookieをアプリAPIのCSRF対策の代用にする。

§5.1のGET／POSTをまとめた行は分解し、**unlock・ticket発行等はPOST、GETは読取り**と明記してください。通常のダウンロード予算消費は、これとは別の付随的状態更新です。

### T6 — KDFと認証費用上限の根拠が不足  
**中／§4.4、§13.1、§13.4**

PBKDF2-SHA256の300,000 iterationsは、現在のOWASP推奨値600,000より低い設定です。これだけで破られると断定はしませんが、CPU gateだけでなくoffline推測耐性の判断が必要です。

**修正案：**

- random saltの長さ、derived key長、password入力長、KDF versionの保存形式を固定する。
- 600,000を候補に、採用Workers runtime／実装の対応とCPUを実測する。具体的な実行制限は **要確認**。
- per-IP／share／credential／globalの試行数・同時KDF数・状態保存量を数値化する。
- 無効なshare ID／kid／credential IDを大量に変えても、無制限にDOやnegative cacheを作れないようにする。
- IP判定に、利用者が自由に指定できる転送ヘッダを信用しない。

---

## 5. コンテンツセキュリティ

### C1 — 「別host／strict CSP」だけでは安全条件が足りない  
**重大／§10.2–10.4、§13.2、§18.8**

| 構成 | 評価と必要な防御 |
|---|---|
| **CONTENT_HOSTあり** | app originとの分離は有効。ただし、アプリCookieのDomain共有、credential付きCORS、任意script、Service Worker、同じcontent origin上の別ファイルへの干渉を防ぐ契約が必要。content hostはapp sessionではなく限定ticketだけを受け入れ、private router／SPAへfallbackしない |
| **単一host fallback** | 未信頼HTML／SVG／JavaScript等をapp originで実行しない方針は妥当。ただし「危険MIME」の一覧と判定順がない。**inline可能な形式をallowlistにし、それ以外はattachment**にするべき |
| **iframe preview** | `sandbox`属性だけでなく、配信レスポンス自身のCSPを定義する。直接URLを開くと親iframeのsandboxは存在しない。同一originの未信頼文書に`allow-scripts`と`allow-same-origin`を同時付与しない |
| **HTML／SVG** | v1はattachment、エスケープ済みtext表示、またはSVGの安全なraster化に限定するのが安全。拡張子やclient申告MIMEを信用しない |
| **PDF** | browser内蔵viewer／PDF.jsのどちらか、更新方針、外部URL・script・添付物の扱いが未定。未検証ならattachment。sandbox／CSPによる制約は対象browserで検証 |
| **Markdown** | rendererとsanitize規則が未定。raw HTMLを無効化し、URL schemeをallowlist化。危険なlink／画像、外部tracking、raw SVG、DOMへの未escape挿入を防ぐ |

必要なheader契約：

- app／share landing：原則`frame-ancestors 'none'`。
- preview：埋込みを許すapp originのみを指定する。
- `nosniff`に加え、正しいserver決定のContent-TypeとContent-Dispositionを返す。
- CSPには`object-src`、`base-uri`、`form-action`、script／接続先の制限を含める。
- `Referrer-Policy: no-referrer`を配信・redirect・errorへ一貫して適用する。
- 206等の応答でも安全headerを失わない。
- private APIの個人情報・認可済み応答についてもcache方針を明示する。

**別hostは別siteとは限りません。** sibling subdomainならSameSiteの防御範囲外になるため、正確なOrigin照合が重要です。

また、§10.4はCONTENT_HOSTを推奨する一方、§18.8は後段optionとしています。別hostはCloudflare管理者への防御ではなく、主に**ブラウザoriginの権限分離**です。account分離と一括りにせず、v1の標準構成とfallbackで無効化するpreviewを決めてください。

privateファイルをCONTENT_HOSTへ配信する場合、share IDを持たないuser向けticketのclaim／発行経路も必要です。

[DESIGN.md:638-644](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

### C2 — ファイル名等の出力先別encodingが未完成  
**中／§3.3、§5.3、§7.2、§9、§13.3**

名前正規化は、出力encodingの代用になりません。

| 出力先 | 必要な修正 |
|---|---|
| HTML／React／Markdown UI | filename、property、errorをtextとして扱う。raw HTML挿入を禁止／sanitize。URL属性には別途scheme検証 |
| `Content-Disposition` | CR/LF、NUL、区切り文字を拒否・安全化し、quoted fallback名とUTF-8の`filename*`を正しいencoderで生成。header文字列への直接連結を禁止 |
| CSV | formula neutralize方針は明記済み。ただしCSV quotingだけでは不十分。先頭空白・制御文字に続く`= + - @`等を含む実装規則と表計算ソフト試験が必要 |
| PROPFIND XML | XML writerでtext／attributeをescape。`href`はpath encoding後にXML escape。保存dead propertyやLOCK ownerを生のXML断片として無検証に連結しない |
| ZIP entry名 | absolute、drive、UNC、`.`／`..`、backslash等は**除去して継続せず、拒否または安全な木から再生成**。変換後の重複entry、platform依存名、symlink entryも防ぐ |

§5.3の「`..`を除去する」は、名前衝突や意図しないpath変換を生むため変更すべきです。

---

## 6. 入力検証とWebDAV

### I1 — 名前・path・JSONのパース契約不足  
**中／§2.2、§3.2–3.3、§5.1、§13.1**

URLに対する「一度decode → separator/control拒否 → NFC → portable check → casefold」は良い方針です。次を追加してください。

- percent encoding不正、UTF-8不正、NUL、不正Unicodeを拒否。
- NFC後にも禁止文字と長さを検証。255 bytesは正規化後のUTF-8で測る。
- `.`／`..`、空名、末尾dot／space、Windows予約名、drive／ADSに使われるcolon等のportable policyを列挙する。
- Unicode casefoldのversion・locale非依存性を固定する。
- `/dav/Shared/`予約名はcasefold後に検査する。
- 検索用NFKCを名前空間解決へ流用しない。
- **JSONで渡された名前はURL componentではない。** JSON parse後に無条件percent decodeしない。
- edge、WHATWG URL parser、Honoの各段階でdecode／dot segment処理が重複しないことを試験する。

JSONについては、upload用95 MBをmetadata APIの許容値にしないでください。

**提案：** metadata JSONは1 MiB、nestingは32等の独立上限を置き、routeごとのschema、配列件数、文字列長、safe integer、未知field、重複key、危険なobject mergeを制御する。これらは現行仕様値ではなく追加すべき制限案です。

### I2 — ヘッダの意味論はあるが、パース・計算量上限が不足  
**中／§5.3、§6.1–6.3、§7.2–7.3、§13.1**

| 入力 | 現状と修正案 |
|---|---|
| **XML** | DTD／entity／external entity禁止、1 MiB／深さ32等は良い。XInclude・schema等の外部取得も禁止。namespace宣言・属性・text node・総要素数を制限。組込みescapeの`&amp;`等と、DTD由来の危険なentity展開を区別する |
| **Range** | grammar・range数が未定。v1は単一`bytes` rangeに限定する案が安全。suffix／open-ended／空file／範囲外／巨大整数／重複headerを検証。multi-rangeを無制限展開しない |
| **Range budget** | 実際に返すbytesをstream開始前に予約。`If-Range`不一致で200全体配信へ変わる場合も全体量を消費。HEADはbodyを読まない |
| **Content-Length** | 必須方針は良い。bodyを持つ対象methodを明記し、非負整数・上限・part expected sizeを検査。宣言値だけでなく受信streamの実bytesを数え、超過・短縮を失敗させる。全bodyのメモリ化はしない |
| **重複CL／Transfer-Encoding** | edgeが何を拒否／正規化してWorkerへ渡すか **要確認**。Workerから見えないraw framingを検証できるとは主張しない |
| **`If`** | boolean評価とtoken submissionの分離は良い。header bytes、list数、条件数、tagged URI数、token長を制限。例として8 KiB／64条件／16 URI等を§13に固定する |
| **`If-Match`** | ETag list、`*`、weak／strong、欠落時の扱いを規定。必要な事前条件が欠落した場合の応答も固定する。W3参照 |
| **Destination** | 同一hostだけでなく、設定されたHTTPS origin・port・DAV pathに照合。userinfo、不要なquery／fragment、encoded separatorを拒否。外部URIをfetchしない。RequestのHostだけを信頼基準にしない |
| **Depth** | method別に規定。PROPFINDは0/1、未指定やinfinityの扱いを固定。COPY、MOVE、LOCKはそれぞれRFCの許容値・既定値が異なる。一律0/1 parserにしない |
| **Timeout** | `Second-N`／`Infinite`、複数候補、overflow、不正値をboundedにparse。最大1hを維持し、実際に採用したtimeoutを返す |
| **Basic／共通header** | header・decode後credentialの長さ、重複Authorization、不正Base64、区切り、username形式を規定。URI全長・query項目数にも上限を設ける |

### W1 — lock creatorを通常mutationで照合しない方針はRFC不適合  
**重大／§7.3、ラウンド2対応表W-01**

§7.3は、write権限＋tokenによるmutationを許し、creator一致をUNLOCK／refreshに限定しています。これは「RFCのtoken semantics」と整合しません。

RFC 4918 §6.4は、locked resourceの変更時にも、**認証principalとlock creatorの一致をMUSTで要求**しています。

tokenを他principalの`lockdiscovery`に返さないことは、追加防御にはなりますが、creator照合の代替ではありません。

**修正案：**

- PUT、PROPPATCH、DELETE、MOVE、overwrite等、必要lockを使う全mutationでcreator一致を検査する。
- user単位かcredential単位か、principalの同一性を固定する。
- 管理者の強制解除は、別の監査付き操作として維持する。

**ラウンド2対応表の「採用」で、この問題を解決済みとすることはできません。**

### W2 — MOVE後もsource lockを継続する規定はRFCと衝突  
**中／§7.3**

§7.3の「MOVE後も同じnodeのlockは継続」は、RFC 4918 §7.6の「MOVEはwrite lockをresourceと一緒に移動してはならない」に反します。

**修正案：**

- node IDをalias解決・競合検査に使う設計は維持する。
- それとは別に、MOVEでsource lockをどう終了し、destination側のlock scopeへどう所属させるかを定義する。
- 独自のnode追従lockを採るなら、WebDAV Class 2互換を無条件には掲げない。

### W3 — weak collection ETagと必須If-Matchが両立しない  
**中／§0.3、§5.3、§7.3、§11.4**

`W/"<node_id>-<revision>"`はweak ETagです。RFC 9110 §13.1.1では、`If-Match`は**strong comparison**を要求します。

したがって、この値をそのまま`If-Match`へ返すclientは一致に成功しません。`W/`を無視して比較すると今度はserverが仕様違反です。

**修正案：**

- 強いvalidatorとして成立する表現更新規則を定義したうえで、書込み用validatorを提供する。
- recovery後のrevision再利用も防ぐため、epochを含める等の対策を行う。
- `If`内のETag評価とHTTP `If-Match`の比較規則を混同しない。

[DESIGN.md:573-582](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

---

## 7. 秘密情報・設定

### S1 — OWNER_EMAILSのbootstrap権限を固定すべき  
**重大／§0.1、§4.2、§14.1**

`OWNER_EMAILS`必須、atomic bootstrap、最後のowner保護は良い方針です。ただしemailは権限昇格の入口なので、次を明文化してください。

- Google IdPのみというゴールを、Access policyの許可IdP設定へ落とす。
- 別IdP／OTP等を後から追加しても、owner bootstrapの信頼条件が拡張されないようにする。
- bootstrap完了後は`iss+sub`へ固定し、email一致で継続的にownerを付与しない。
- email再利用、別sub、ユーザー削除・再追加、復旧でbootstrap状態が巻き戻った場合を試験する。
- email比較ルールを固定し、任意のdot除去／plus除去等で権限対象を広げない。
- owner bootstrap／移譲／高権限credential発行にはMFAや再認証の運用を定義する。

Access JWTに未定義の`email_verified` claimが必ず存在すると仮定するのではなく、検証済みAccess identityと許可IdPの契約で扱うべきです。

### S2 — vars／secretsの分類は概ね正しいが、鍵運用が未定義  
**中／§4.4、§11.4、§14.1**

| 分類 | 対象・扱い |
|---|---|
| varsでよい | Access issuer／AUD、CONTENT_HOST、制限値。`OWNER_EMAILS`も認証secretではないが、個人情報・権限設定として変更統制が必要 |
| secrets | app-password HMAC key、Cookie／ticket署名鍵、CSRF署名鍵を使う場合の鍵 |
| 配備系の別secret | Cloudflare API token、CI資格情報、外部保全用資格情報。app runtimeへ不要に渡さない |
| クライアント側secret | app password、Service Token Client Secret。D1やログへ平文保存しない |

**修正案：**

1. HMAC鍵は少なくとも256bitのCSPRNGで生成し、用途・環境ごとに分離する。
2. Worker Secrets等で保管し、Git／vars／frontend bundleへ含めない。
3. `kid`、発行中鍵、検証のみの旧鍵、失効鍵の状態を定義する。
4. 通常rotationは「新鍵配備→発行切替→最大token寿命＋skew経過→旧鍵削除」。
5. 漏えい時は旧鍵を即時失効し、関連session／ticketを無効化する手順を別に持つ。
6. app-password HMAC鍵は、旧digestだけから新鍵へ再計算できない。旧鍵による期間限定検証＋再hashか、再発行を選ぶ。
7. 復旧epoch更新と通常key rotationを混同しない。
8. secret変更・配備・Access設定変更への最小権限、MFA、承認・監査を定義する。

### S3 — 「全logでmask」とobservability設定の間に穴がある  
**重大／§5.1、§13.3、§14.1**

share tokenがURL pathにあり、Wrangler例は`observability.enabled: true`です。

Cloudflare公式では、Workers invocation logはrequest URLを含み、既定で生成されます。Tailのredactionもheuristicであり、false negativeがあると説明されています。

したがって、アプリのloggerでmaskするだけでは、**プラットフォームが先に生成・保存するログ**まで保護できません。

**修正案：**

- Workers invocation logs、Tail、Logpush、trace、WAF／HTTPログ、例外、D1 query errorを個別に棚卸しする。
- 確実な事前redactionができないtoken経路では、自動invocation logを無効化し、安全な構造化監査を別途残す等の構成にする。
- Tailで後から加工しても、元の保存済みログが消えるとは考えない。
- query削除だけでは`:token`を含むpathは保護できない。
- JWT、Cookie、Basic、Service Token secret、CSRF、upload capability、ticketをテスト用canaryで送信し、全出力先に残らないことを検証する。
- Referrer-Policyはログやbrowser historyからtokenを除去する機能ではないと明記する。

実際の自動redaction適用範囲と採用ログ製品での挙動は **要確認**です。現時点では、漏えいが必ず発生すると断定するのではなく、**「全logでmask」の保証根拠がない**と評価します。

### S4 — DEV_BYPASS_ACCESSの本番拒否は良い。remote環境にも拡張を  
**低／§14.1**

「本番に存在すればCIとstartupを失敗」は適切です。

追加で、stagingやremote previewでも禁止し、local test専用の認証差替えを本番bundleから分離してください。`DEV_BYPASS_ACCESS="false"`等の文字列truthinessや、environment名だけによる判定を避けるべきです。

---

## 8. 最終判定と必須修正

### 判定

**セキュリティ観点で、このv0.3をそのまま実装契約として渡せるか：No。**

理由は、機能の多さではなく、**どのprincipalが、どの経路で、いつまで、どの対象へアクセスできるか**について、実装者の判断に委ねられた重要箇所が残っているためです。

Foundationの検証実装は進められます。ただし、下記を契約として確定する前に、認証・共有配信・preview・WebDAVを完成仕様として実装へ渡すべきではありません。

### 必須修正リスト

| 優先 | 必須修正 | 対応指摘 |
|---|---|---|
| **P0** | JWT入力をheader基準に固定し、user／service別claim、route別AUD、JWKS更新・失敗規則を定義 | A1–A3 |
| **P0** | 全endpointの認証方式・operation・operand・管理権限をmanifestへ対応付け、owner／admin／制限付きcredentialを分離 | Z1、Z3 |
| **P0** | 読取りでもspace rootまでの祖先有効性を検査し、trash開始直後のshare／content漏えいを防ぐ | Z2 |
| **P0** | Access logout、IdP停止、アプリ停止、app password、share、jobの失効連携と最大伝播遅延を定義 | A4 |
| **P0** | unlock Cookieの属性・期限・個別失効、公開JSON APIのCSRF、全tokenのclaimと用途を固定 | T1–T5 |
| **P0** | CONTENT_HOSTと単一hostの安全なMIME／CSP／preview matrixを確定。未確定のactive previewは無効化 | C1 |
| **P0** | platform自動ログを含め、URL内capabilityと資格情報を保存しない構成を検証 | S3 |
| **P0** | locked mutationでcreatorを照合し、MOVE時lockとIf-Matchの矛盾を修正 | W1–W3 |
| **P0** | 復旧を跨ぐ進行中HTTP mutationの排除、bootstrapの一回性・identity固定を規定 | Z4、S1 |
| **P1** | 名前・JSON・XML・全ヘッダのbounded parserと、出力先別encodingを定義 | C2、I1–I2 |
| **P1** | entropy、KDF、認証費用上限、通常／緊急key rotationを数値・手順化 | T2–T6、S2 |
| **P1** | Bypass、全host／preview、Cookie設定、失効伝播を実HTTP・実browserで検証 | A5、S4 |

### 追加すべきセキュリティ受入試験

最低限、次を§15のrelease gateへ追加すべきです。

- 間違ったAUD／issuer／alg、未来`nbf`、未知kid連打、Cookieのみ、user／service混同。
- 別Access appのJWT、Bypass経路へのJWT添付、CONTENT_HOSTからprivate APIへの要求。
- `P/S/F`の`P`を削除した直後の、S共有からのcontent／thumb／search／ZIP。
- credential失効・scope縮小後のupload操作、job操作、terminal result再生。
- 旧epochのHTTP mutationを復旧後に再開するケース。
- 公開JSON mutationへのcross-origin／`Origin: null`／CSRF再利用。
- HTML／SVG／PDF／Markdown／filenameを全表示surfaceで開くケース。
- lock tokenを知る別principalのmutation、MOVE後のlock、weak ETagのIf-Match。
- canary secretを含むrequestが、すべてのログ・trace・error出力に残らないこと。

---

## 仕様照合に使用した主な一次資料

- Cloudflare： [JWT検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Application tokenのclaim](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- Cloudflare： [Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)、[Session management／logout](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- Cloudflare： [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)、[Bypass等のpolicy](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)、[Authorization Cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
- Cloudflare： [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)、[Preview URLs](https://developers.cloudflare.com/workers/configuration/previews/)
- Cloudflare： [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、[Tailのredaction](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)
- Cloudflare： [D1 batch／Sessions API](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- IETF： [RFC 4918 §6.4・§7.6](https://www.rfc-editor.org/rfc/rfc4918.html)、[RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html)
- OWASP： [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet)

なお、CloudflareのCookie公式ページでは、HttpOnlyの既定値について表と本文の記述に不一致があります。**既定値は要確認**とし、IaCで明示設定したうえで、実際の`Set-Cookie`を受入試験で確認してください。
