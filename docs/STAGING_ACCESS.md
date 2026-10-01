# Staging の Cloudflare Access 設定

Cloudflare Access で staging のログイン入口を絞るための runbook です。これは設定手順と検証基準であり、Cloudflare 側の実設定が完了した証明ではありません。Access の path-specific application と Bypass の挙動は、実 staging gate で確認してください。

この runbook は [DESIGN.md の §2.2](DESIGN.md) の host / Access 境界を正本とします。

## 重要: Access の許可とアプリの招待は両方必要

Access ポリシーにテスターを追加しても、Nextcloud-flare の D1 `users` 行は作られません。アプリの初回 bootstrap は `BOOTSTRAP_OWNER_EMAILS` または `BOOTSTRAP_OWNER_IDENTITIES` に一致する最初の identity 1 人だけを管理者として登録します。複数の候補を bootstrap allowlist に入れても、管理者が複数作成されるわけではありません。

初回管理者はアプリの「設定 → WebDAV」にある「利用者の招待」から各テスターの正確なメールアドレスを招待します。招待は7日間有効で、Access が検証した issuer とメール表記が一致する本人の初回ログイン時に一度だけ消費され、Access の subject と個人スペースに結び付きます。期限切れ後は同じメールを再招待できます。保留中招待は最大200件です。招待を受けた人は一般利用者として登録され、初期容量は1 GiBです。メールの大文字・小文字も含めて Access が返す値と一致させます。アプリは招待メールを送らず、ログイン用の One-time PIN は Cloudflare Access が送信します。この経路はローカル実装済みで、remote migration・deploy と実 Access での検証は未実施です。

## Access 境界

| Host / path | Cloudflare Access | Worker 側の認証・認可 |
| --- | --- | --- |
| `staging-app.darask.date` の private app (`/`, `/private-assets/*`, private `/api/v1/*`) | Allow。承認済み user identity のみ | Access user JWT とアプリ DB の既存 user |
| `staging-app.darask.date/api/v1/automation/*` | 実装時の設計: Service Auth。登録済み Service Token のみ | handler 未実装。現在は Worker が 404 を返す |
| app host の `/s`, `/s/*`, `/api/v1/public/shares/*`, `/public-assets/*`, `/dav`, `/dav/*` | path-specific Bypass | share secret / session / CSRF、公開 asset manifest、または app password Basic |
| `staging-content.darask.date` | Host を Bypass | `/session`, `/c/*`, `/reader/*` は content-session Cookie / ticket を検証 |

Bypass は Access の認証と request logging を外す設定です。上記の公開経路にだけ限定し、Worker 独自の認証・認可を省かないでください。未知の path / method は Worker が拒否します。Access Bypass が Worker の認証を代替することはありません。

## 管理者: 人のテスターを Access に許可する

1. Cloudflare dashboard で **Zero Trust → Integrations → Identity providers** を開き、既存の組織 IdP を使うか、ゲスト向けに **One-time PIN** を追加します。IdP は dashboard と IdP の双方で設定します。[Identity providers](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/)
2. **Zero Trust → Access controls → Policies → Add a policy** で `Staging testers` などの Allow policy を作成します。テスト対象を限定するため、Include に個々の **Emails** を列挙するか、管理済み IdP group を指定します。ポリシーは deny-by-default の application に割り当てます。[Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
3. Access application の login methods で必要な IdP を選びます。IdP が 1 つだけなら Apply instant authentication を使うと、Access login page を挟まず IdP に送れます。[Self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
4. 人のテスターには private app の path に `Staging testers` を設定します。初回管理者はアプリの「設定 → WebDAV → 利用者の招待」で同じメール表記の招待を作成します。本人がログインし、個別のアカウントと個人スペースが作成されたことを確認します。Access の許可だけでアプリログイン可能とは判定しません。

One-time PIN は Allow policy に含まれるメールアドレスにだけ送信され、PIN は 10 分で失効します。OTP を Include にするだけでメール範囲を制限しない設定は、任意の有効な email login method を許可するため使わないでください。[One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/), [Common Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)

## MFA

優先する方法は MFA を要求する IdP です。Access の **Require → Authentication method → mfa** は Okta、Microsoft Entra ID、Generic OIDC、Generic SAML 2.0 が IdP の MFA 情報を返す場合に使えます。その他の IdP では Access の Independent MFA を有効にし、対象 application または policy に TOTP、security key、biometrics のいずれかを要求します。[Enforce MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)

Independent MFA の利用には Zero Trust organization 側で MFA method と session duration の有効化が必要です。テスターは App Launcher の **Account → MFA devices** から authenticator を登録します。メール OTP はログイン方法であり、それ自体を二要素認証と数えないでください。[Independent MFA と enrollment](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/)

## Host と path の設定・検証 gate

Cloudflare dashboard の **Zero Trust → Access controls → Applications → Create new application → Self-hosted and private → Add public hostname** から対象 host / path を設定します。次の Access path 構成は必ず実 staging で確認してください。

- app private path は `Staging testers` の Allow。
- `/api/v1/automation/*` は設計上 Service Auth とします。現在 `packages/worker/src/index.ts` に handler がなく Worker は 404 を返すため、この path に Service Token を設定しても機能は使えません。Access のより具体的な path rule は root の policy を継承せず置き換えるため、実装時は path ごとに必要な policy を明示します。
- public share、public assets、DAV の Bypass path を private Allow path より具体的に設定し、path 外へ拡張しないことを確認します。Bypass は `/s`, `/s/*`, `/api/v1/public/shares/*`, `/public-assets/*`, `/dav`, `/dav/*` に限定します。
- `staging-content.darask.date` は Access Bypass。Access Allow を設定せず、Worker の session / ticket 検証に委ねます。

Cloudflare は同じ root path 上でより具体的な application path を優先します。さらに path override の wildcard は自動で下位 path 全体に広がらない場合があるため、`/dav` と `/dav/*` のように必要な path を明示して確認します。[Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Bypass a public endpoint](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)

staging gate では、少なくとも次を browser と HTTP client の両方で確認します。

- 許可 identity は private app にログインでき、未許可 identity は Access で拒否される。
- 実 build の `/private-assets/*` にも user Access が適用され、許可 identity の画面が JS/CSS を読み込んで表示される。未許可 identity へ bundle をそのまま配らない。
- automation handler の実装後に限り、`/api/v1/automation/*` が有効な Service Token でだけ通り、通常の browser login へフォールバックしないことを gate に追加する。現時点では未実装のため 404 が期待値であり、Service Token 通過を現行の合格条件にしない。
- public share と `/public-assets/*` は Access login に redirect されず、Worker の share / manifest 認証を受ける。
- `/dav` は Access login に redirect されず、正しい app password Basic を要求する。
- content host は Access login に redirect されず、正しい content-session Cookie / ticket なしでは Worker が拒否する。
- path specificity、未知 path / method、別 host、preview URL、`workers.dev` が private app に迂回路を作らない。

Cloudflare の Bypass は一致 request に対する Access controls と request logging を無効にします。path precedence や host 側の設定が意図どおりであることが未確認なら、staging を利用者へ開放しないでください。[Common Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)

## Service Token と Secret

CI や監視など自動化専用に、**Zero Trust → Access controls → Service credentials → Service Tokens → Create Service Token** から名前と有効期限を決めて発行します。Service Token の発行・保管は automation handler 実装後に行い、その path には Action `Service Auth`、Include `Service Token` を設定します。現在その handler はないため token を作っても `/api/v1/automation/*` は利用できません。Service Token を人の tester login に使わないでください。[Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

Client Secret は発行時にしか表示されません。Secret、API token、OTP、MFA recovery code をチャット、issue、repository、画面共有へ貼らず、承認済み secret manager に保管してください。利用者ごと・用途ごとに共有しない token を発行し、漏えい・担当終了時は rotate または revoke します。
