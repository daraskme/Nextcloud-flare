# KDF の isolate 内実行制限

更新: 2026-09-24。

アプリパスワードの作成・検証・pepper 更新を `auth/kdf.ts` の共通 executor に接続した。これは一つの Worker isolate 内の計算量を制限する仕組みである。ControlDO による全体の rate / 同時実行制限と mutation admission は別途必要で、まだ実装していない。

## 動作

- 同時実行は 1 件。HMAC pepper、PBKDF2 key import、100,000 回の PBKDF2-SHA256 を同じ枠で実行する。形式・長さ検査は枠取得前に行う。
- FIFO の待機列は最大 256 件、待機時間は最大 5 秒。満杯・期限切れ・取消しは `KdfUnavailableError` で終了する。解放時にも期限を照合し、timer callback が遅れても期限切れの計算を始めない。
- 待機中の取消しはその場で列から除去する。実行開始後の Web Crypto は途中停止できないため、計算が終了するまで枠を保持し、取消し済みの結果を返さない。
- `enable_request_signal` を明示する。[Cloudflare の互換性フラグ仕様](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests)では、HTTP client の切断を `Request.signal` で受け取るための opt-in 設定で、config verifier でも必須とする。実環境の切断伝播は下記の未検証項目に残る。
- 次の呼出しには Promise の完了だけを通知する。別リクエストの crypto callback を、前のリクエストの解放処理から直接実行しない。
- 計算が失敗しても `finally` で枠を解放する。メモリ上の peppered 中間値は計算終了時にゼロで上書きする。

DAV の認証と private app-password 作成 API は、容量不足を `503 not_ready` / `Retry-After: 1` / `private, no-store` で返す。容量不足では `WWW-Authenticate` を付けない。誤った secret・失効済み credential への既存の `401` と区別する。

作成サービスは、現行の Access session と root 権限を計算前に確認する。待機中に失効・停止・権限変更が起きても、最終 D1 batch の既存の assertion を通らない限り書き込めない。検証側も計算後に現行 credential / digest / epoch / maintenance を再照合する。pepper 更新前後の再検証も同じ executor を使う。

実 HTTP 試験で判明した app-password 取消しの空本文判定も修正した。本文なしの DELETE が空の closed stream として届く場合は EOF を読み取って受け入れる。本文付き・読取り失敗は拒否し、Content-Length が `0` でも実データを無視しない。取消し後は同じ secret で DAV 認証できない。

## 検証

- Node: FIFO、例外後の回復、256 件の境界、待機・実行中の取消し、5 秒期限、遅延 timer。
- workerd: 実 PBKDF2 の並行数、DAV / private API の混雑応答と回復、取消し時の未作成、待機中の失効・停止、pepper 更新経路。
- ローカル HTTP / Chromium: private API による発行、独立した DAV fetch 8 件の並行認証、誤 secret と取消し後の拒否。test-only entry の鍵は実行時に生成する。

最新の成否と件数は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を参照する。実 Cloudflare の CPU・費用・負荷・切断挙動は未検証。

切断伝播の診断では、ローカルWranglerの前段経由でブラウザーfetch中止・HTTPS socketの強制切断を行っても、待機中のWorkerの`Request.signal`がabortされず、次の計算が実行された。この経路を取消し成功と数えない。明示的なAbortSignalの単体・結合検査は成功しているが、実Cloudflareで待機中/計算中に接続を切り、取消し通知と枠の回復を確認するgateが残る。診断専用HTTP endpointは通常のtest entryにも残していない。

## 残る制御

DESIGN §4.4 / §14.2 の ControlDO による KDF 全体 600 回/分・同時 20 件、share/IP ごとの制限、account 単位 mutation 同時 32 件・待機列、backup barrier は未実装。共有 password / unlock 自体も未接続。この executor はそれらの代替ではない。isolate の再作成でローカル状態は消えるため、永続的な全体の制限や認可の正本に使わない。
