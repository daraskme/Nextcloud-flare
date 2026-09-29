# サムネイルの配信

2026-09-29。[Queue生成](IMAGE_QUEUE.md)で公開されたWebPを、元nodeの現在の閲覧権限で配信する。生成や有料再試行はGET/HEAD内で行わない。lgは保存済みの場合だけ配信でき、要求時の生成受付は後続。

## 対象とチケット

manifest v3は`{v:3,targets:[{spaceId,nodeId,blobId,purpose:'thumb',size,imageId,variant,generator}]}`。`blobId`は原本、`imageId`は不変の生成世代、`size`はWebPの実容量。sm/md/lgのいずれかを固定し、1,000件・UTF-8 1MiB以下、重複禁止、総容量一致を要求する。v1原本・v2 ZIPは維持する。旧v1のthumb記録は原本や新サムネイルの配信権限へ読み替えない。

privateの`POST /api/v1/content-session`は、`purpose:'thumb'`時に各targetへ`variant`を要求する。`delivery:'app'`を指定すると現在のAccess credentialに束縛したsession IDを返す。署名ticketやcontent-host cookieは返さない。既定の発行方式では従来どおりticketをcontent hostの`POST /session`へ交換する。

publicの対応content-sessionは、従来の`nodeIds`・`ttlSeconds`に`purpose:'thumb'`と`variant`を指定する。同じvariantを全nodeへ適用する。app方式は元の共有Cookieと`Share-Session`も必要。upload-only共有には発行・配信しない。

## HTTPと会計

- app: `GET/HEAD /api/v1/nodes/:nodeId/thumb?variant=sm`。Access認証と`Content-Session`ヘッダーが必要。
- public: `GET/HEAD /api/v1/public/shares/:shareId/thumb/:nodeId?variant=sm`。元の共有Cookie・`Share-Session`・`Content-Session`が必要。
- content host: `GET/HEAD /c/:nodeId/:blobId?variant=sm`。thumb用途のhost-only Cookieを使う。queryなしは従来の原本用途。用途・variantの取り違えを拒否する。

同じ利用者/共有のBudgetDOを使い、原本と異なる`thumb:image_<imageId>`で実容量を登録する。同じ生成物のCOW別名・別tab・再発行は容量を加算しない。variantが異なれば別出力。GET・HEAD・Range・304・416をrequestとして数え、応答予定bytesを予約し、読取り終了・cancel・timeoutを既存の有限leaseで精算する。

発行時は現在の原本と公開済み世代、WebP metadata・実容量・checksum・pin・native終了・未退役を同じD1 batchで照合する。R2 HEAD後のチケット確定batchでも再確認する。複数の生成物は32件ごとのJSON入力とCOUNTで一括照合し、D1のstatement・binding・式の深さの上限を守る。34件の別名を実D1で検証したが、1,000件時の性能測定は未実施。配信時はmanifest hash・対象tuple・現在のcredential/共有/祖先/原本を確認し、budget待機後、R2 HEAD後、R2 GET後にも同じ認可と世代を再検査する。別の生成物へ暗黙に切り替えない。

応答はimage/webp・inline・nosniff・private,no-store。readyがない場合はチケット発行を503とし、既存対象との不一致は拒否する。原本や別variantへ自動fallbackしない。Gallery側で原本detailとplaceholderを選ぶUIは後続。

schema0071・通常79table・147 routeを維持。routeのvariant operandを明記した。migration・依存追加なし。検証は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。
