# 本文なし HTTP 操作

更新: 2026-09-24。

実HTTP経由のWebDAV `MKCOL` が本文なしでも `415` になる不具合を修正した。HTTP adapter は本文の長さが0でも、`Request.body` に空のstreamを渡すことがある。streamの有無だけでは本文の有無を判定できない。

## 判定と接続経路

`api/emptyBody.ts` の共通検査は本文なし（null）または0 byteのままEOFに到達するstreamを受け入れる。既に読まれた本文、他のreaderが使用中のstream、実データ、読取り失敗、取消し、5秒の期限切れを拒否する。空chunkが続く場合も最大16回のreadで終了する。遅延timerに備えてEOF時にも期限を検査する。

本文を連結・保存せず、最初の実データで拒否する。失敗時は読取りを取り消してreaderを解放し、取り消し自体の完了待ちで処理を止めない。`Content-Length: 0` を実際の本文検査の代わりにはしない。

| 経路 | 空本文 | 本文あり・読取り失敗等 |
|---|---|---|
| DAV MKCOL | 認可・名前・冪等キーを照合して作成 | 415 |
| DAV COPY / MOVE / DELETE / UNLOCK | 条件・現行権限・lockを照合して操作 | 400 |
| private ticket DELETE | CSRF・現行credentialの後でticket/sessionを失効 | 400 |
| app password DELETE | CSRF・現行Accessの後でcredentialを失効 | 400 |
| logout POST | CSRF・現行Accessの後でsessionを失効 | 400 |

認証とprivate CSRFの検査を通ってから本文を調べ、操作固有のヘッダー検査も維持する。待機後も各サービスの既存のD1最終認可・epoch・operation fenceが必要であり、空本文の確認が書込み権限の証明になることはない。GET/HEAD、JSON/XML payload、upload streamの処理はそれぞれの既存profileに従う。

## 検証

- Node: EOF、空chunk、payload、読取り失敗、既読/locked、取消し、5秒期限、遅延timer、取消しが完了しないsource、空chunkの連続。
- workerd: 実D1/LockDOを使う既存のMKCOL/COPY/MOVE/DELETE/UNLOCKとprivate ticket取消しをclosed streamでも検証。payload/読取り失敗と偽Content-Lengthでticketを取り消せないことも確認する。本文読取り中のapp password失効・maintenance移行ではMKCOLが拒否され、node/operationが作成されないことを確認する。
- 独立したHTTP request: MKCOL、PUT、LOCK/UNLOCK、COPY、MOVE、GET、DELETEを実APIへ接続し、拒否されたpayloadの後にも元のfile/lockが残ることを確認する。private ticketは発行・交換・不正な取消し拒否・空本文による取消し・交換拒否まで確認する。

成否と件数は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を参照する。実Cloudflareの切断伝播、OS標準WebDAV clientとの相互運用、stagingのネットワーク障害試験は残る。[KDF_ADMISSION](KDF_ADMISSION.md)のローカル切断診断の制約も引き続き有効である。
