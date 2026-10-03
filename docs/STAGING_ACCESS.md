# Staging の Cloudflare Access 設定

Cloudflare Access で staging のログイン入口を絞るための runbook です。2026-10-03 時点で、下表の Access application と policy は Cloudflare API で存在を確認済みです。初回管理者のログインと個人スペース作成は実 staging で確認済みです。一般利用者の招待・ログイン・データ分離は別途確認してください。

この runbook は [DESIGN.md の §2.2](DESIGN.md) の host / Access 境界を正本とします。

## 重要: Access の許可とアプリの招待は両方必要

Access ポリシーにテスターを追加しても、Nextcloud-flare の D1 `users` 行は作られません。アプリの初回 bootstrap は `BOOTSTRAP_OWNER_EMAILS` または `BOOTSTRAP_OWNER_IDENTITIES` に一致する最初の identity 1 人だけを管理者として登録します。複数の候補を bootstrap allowlist に入れても、管理者が複数作成されるわけではありません。

初回管理者はアプリの「設定 → WebDAV」にある「利用者の招待」から各テスターの正確なメールアドレスを招待します。招待は7日間有効で、Access が検証した issuer とメール表記が一致する本人の初回ログイン時に一度だけ消費され、Access の subject と個人スペースに結び付きます。期限切れ後は同じメールを再招待できます。保留中招待は最大200件です。招待を受けた人は一般利用者として登録され、初期容量は1 GiBです。メールの大文字・小文字も含めて Access が返す値と一致させます。アプリは招待メールを送らず、ログイン用の One-time PIN は Cloudflare Access が送信します。初回管理者の実 Access ログインと D1 bootstrap は確認済みです。一般利用者の招待とログインは未検証です。

## Access 境界

| Host / path | Cloudflare Access | Worker 側の認証・認可 |
| --- | --- | --- |
| `staging-app.darask.date/*`（app host 全体。以下のより具体的な例外を除く） | Allow。承認済み user identity のみ | Access user JWT とアプリ DB の既存 user |
| `staging-app.darask.date/api/v1/automation/*` | 現在は Everyone を Deny。実装後の設計は Service Auth | handler 未実装。現在は Access が拒否する |
| app host の `/s`, `/s/*`, `/api/v1/public/shares/*`, `/public-assets/*`, `/dav`, `/dav/*` | path-specific Bypass | share secret / session / CSRF、公開 asset manifest、または app password Basic |
| `staging-content.darask.date` | Host を Bypass | `/session`, `/c/*`, `/reader/*` は content-session Cookie / ticket を検証 |

Bypass は Access の認証と request logging を外す設定です。上記の公開経路にだけ限定し、Worker 独自の認証・認可を省かないでください。未知の path / method は Worker が拒否します。Access Bypass が Worker の認証を代替することはありません。

## 管理者: 人のテスターを Access に許可する

1. Cloudflare dashboard で **Zero Trust → Integrations → Identity providers** を開き、既存の組織 IdP を使うか、ゲスト向けに **One-time PIN** を追加します。IdP は dashboard と IdP の双方で設定します。[Identity providers](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/)
2. **Zero Trust → Access controls → Policies → Add a policy** で `Staging testers` などの Allow policy を作成します。テスト対象を限定するため、Include に個々の **Emails** を列挙するか、管理済み IdP group を指定します。ポリシーは deny-by-default の application に割り当てます。[Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
3. Access application の login methods で必要な IdP を選びます。IdP が 1 つだけなら Apply instant authentication を使うと、Access login page を挟まず IdP に送れます。[Self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
4. `staging-app.darask.date/*` に `Staging testers` の Allow を設定し、その下に表の public / DAV Bypass と automation Deny のより具体的な path application を作成します。Cloudflare は空の Path 欄または `/*` で hostname 全体を保護します。`/` だけでは SPA deep link を網羅しないため使いません。初回管理者はアプリの「設定 → WebDAV → 利用者の招待」で同じメール表記の招待を作成します。本人がログインし、個別のアカウントと個人スペースが作成されたことを確認します。Access の許可だけでアプリログイン可能とは判定しません。

One-time PIN は Allow policy に含まれるメールアドレスにだけ送信され、PIN は 10 分で失効します。OTP を Include にするだけでメール範囲を制限しない設定は、任意の有効な email login method を許可するため使わないでください。[One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/), [Common Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)

## MFA

優先する方法は MFA を要求する IdP です。Access の **Require → Authentication method → mfa** は Okta、Microsoft Entra ID、Generic OIDC、Generic SAML 2.0 が IdP の MFA 情報を返す場合に使えます。その他の IdP では Access の Independent MFA を有効にし、対象 application または policy に TOTP、security key、biometrics のいずれかを要求します。[Enforce MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)

Independent MFA の利用には Zero Trust organization 側で MFA method と session duration の有効化が必要です。テスターは App Launcher の **Account → MFA devices** から authenticator を登録します。メール OTP はログイン方法であり、それ自体を二要素認証と数えないでください。[Independent MFA と enrollment](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/)

## Host と path の設定・検証 gate

Cloudflare dashboard の **Zero Trust → Access controls → Applications → Create new application → Self-hosted and private → Add public hostname** から対象 host / path を設定します。次の Access path 構成は必ず実 staging で確認してください。

- app private path は `Staging testers` の Allow。
- `/api/v1/automation/*` は現在 Everyone Deny です。`packages/worker/src/index.ts` に handler がなく、実装後に Service Auth へ切り替えます。Access のより具体的な path rule は root の policy を継承せず置き換えるため、実装時は path ごとに必要な policy を明示します。
- public share、public assets、DAV の Bypass path を private Allow path より具体的に設定し、path 外へ拡張しないことを確認します。Bypass は `/s`, `/s/*`, `/api/v1/public/shares/*`, `/public-assets/*`, `/dav`, `/dav/*` に限定します。
- `staging-content.darask.date` は Access Bypass。Access Allow を設定せず、Worker の session / ticket 検証に委ねます。

Cloudflare は同じ root path 上でより具体的な application path を優先し、その path では root application の policy を継承しません。`/*` は hostname 全体、`/dav/*` は `/dav` より下位の path を対象にしますが、親の `/dav` 自体は含みません。`/s` と `/s/*`、`/dav` と `/dav/*` のように、親 path と子 path を両方明示して確認します。[Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Bypass a public endpoint](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)

staging gate では、少なくとも次を browser と HTTP client の両方で確認します。

秘密値やCloudflare API tokenを使わない、read-onlyのローカル事前確認と限定HTTP smoke runnerを用意しています。引数なしでは静的契約を確認してdry-run計画だけ表示し、ネットワークへ接続しません。

```sh
node ops/staging/smoke-check.mjs
```

staging の配備後に固定された両 origin を明示して実行します。runner は最大9件を順番に送り、GET/HEAD のみ、Cookie/Authorization/body なし、response body 非保存、再試行なし、各 request 5秒 timeout です。Private gate は Access login path または Access 固有 host への遷移だけを合格にし、Worker のみの401、曖昧な403、未検証の外部 IdP への redirect は手動確認に回します。公開経路の一部に GET を使いますが、fixture 作成や upload、変換、Queue 起動などは行いません。

```sh
node ops/staging/smoke-check.mjs --execute \
  --app-origin https://staging-app.darask.date \
  --content-origin https://staging-content.darask.date
```

これはpublic bypassとanonymous private gateの配線だけを確認します。複数identityのAllow/拒否、招待後の初回loginと個人space、実ファイルのcontent ticket有無は別の手動browser確認が必要です。HTTP smokeが成功してもCloudflare設定全体の安全性を証明した扱いにはしません。

- 許可 identity は private app にログインでき、未許可 identity は Access で拒否される。
- 少なくとも2人のAllow済みテスターを別々のbrowser profileで試し、招待をclaimした一般利用者の個別アカウント・spaceと、互いのprivate data分離を確認する。
- Allowに含めていないidentityを別profileで試し、Accessがprivate app全体とbundleを拒否することを確認する。
- 実 build の `/private-assets/*` にも user Access が適用され、許可 identity の画面が JS/CSS を読み込んで表示される。未許可 identity へ bundle をそのまま配らない。
- automation handler の実装後に限り、`/api/v1/automation/*` が有効な Service Token でだけ通り、通常の browser login へフォールバックしないことを gate に追加する。現時点では Access の Deny が期待値であり、Service Token 通過を現行の合格条件にしない。
- public share と `/public-assets/*` は Access login に redirect されず、Worker の share / manifest 認証を受ける。
- `/dav` は Access login に redirect されず、正しい app password Basic を要求する。
- content host は Access login に redirect されず、正しい content-session Cookie / ticket なしでは Worker が拒否する。
- path specificity、未知 path / method、別 host、preview URL、`workers.dev` が private app に迂回路を作らない。
- content hostの実在するfixtureで、正しいticket/session cookieだけが内容を取得でき、cookieなし・期限切れcookieは拒否されることを確認する。smoke runnerの架空ID probeはAccess Bypass経路とWorker応答を見るだけで、この認可条件は証明しない。

Cloudflare の Bypass は一致 request に対する Access controls と request logging を無効にします。path precedence や host 側の設定が意図どおりであることが未確認なら、staging を利用者へ開放しないでください。[Common Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)

## Service Token と Secret

CI や監視など自動化専用に、**Zero Trust → Access controls → Service credentials → Service Tokens → Create Service Token** から名前と有効期限を決めて発行します。Service Token の発行・保管は automation handler 実装後に行い、その path には Action `Service Auth`、Include `Service Token` を設定します。現在その handler はないため token を作っても `/api/v1/automation/*` は利用できません。Service Token を人の tester login に使わないでください。[Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

Client Secret は発行時にしか表示されません。Secret、API token、OTP、MFA recovery code をチャット、issue、repository、画面共有へ貼らず、承認済み secret manager に保管してください。利用者ごと・用途ごとに共有しない token を発行し、漏えい・担当終了時は rotate または revoke します。
