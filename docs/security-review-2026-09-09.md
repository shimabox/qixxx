# セキュリティレビュー 2026-09-09

- 対象: ブランチ `feat/ranking-free-async` @ `539410e`(既存コードを含むリポジトリ全体)
- 範囲: `functions/**`、`scripts/audit/**`、`migrations/*.sql`、`src/ui/**`、`src/storage/**`、`src/seedParam.ts`、`src/debug/panel.ts`、`src/main.ts`、`src/runMode.ts`、`src/core/{session,inputRecorder,replayEngine,rle,rankingLimits}.ts`、`wrangler.toml`、`.github/workflows/ci.yml`、`package.json`、`vite.config.ts`、`index.html`、`public/`
- 方法: 静的読解のみ(コード実行・本番アクセスなし)。DoS / コスト系も対象に含める

## 結果サマリ

| 深刻度 | 件数 |
|---|---|
| HIGH | 0 |
| MEDIUM | 3 |
| LOW | 3 |

認可バイパス・インジェクション・XSS・データ漏洩は見つからなかった。指摘はすべて DoS / コスト系と防御の一貫性。

## MEDIUM

### 1. `/share` の本文サイズ無制限

- 場所: `functions/share.ts:33`
- 確度: 0.95
- 内容: `request.json()` で本文を丸ごとバッファし、サイズ検査も `Content-Type` 検査もない。レート制限(`share.ts:46-51`)は本文読み込みの後に走るため、不正 JSON を送り続けてもレート制限に到達しない。`functions/api/scores.ts:223-237` のコメントが説明している「`Content-Length` を省略・偽装したクライアントが Cloudflare の 100 MB 上限まで Worker(メモリ 128 MB)にバッファさせられる」穴が既存コードに残っている。
- 攻撃例:

  ```sh
  curl -X POST https://qixxx.orukubami.sh/share \
    -H 'Origin: https://qixxx.orukubami.sh' \
    --data-binary @100MB.json
  ```

  Origin ヘッダは非ブラウザから偽装できるので Origin 検査は防御にならない。数リクエスト並行で isolate が OOM(1102)。
- 対策: `scores.ts` の順序をそのまま流用する。`Content-Type` 検査(`scores.ts:291-294`)→ `Content-Length` 早期 413(`296-299`)→ レート制限 → `readBodyWithLimit()`(`238-265`、export 済み)→ `JSON.parse`。`readBodyWithLimit` は `functions/_lib/` に移して共有する。本文は `{score, stage, hi}` だけなので上限 1 KiB で十分。
- 兄弟確認: `s.ts` / `og.ts` / `ranking.ts` / `replay.ts` は GET のみで本文読み込みなし。

### 2. `/og` の OG 画像を毎回フルレンダリング

- 場所: `functions/og.ts:115-141`
- 確度: 0.7(要検証)
- 内容: Satori + resvg の PNG 生成(`new ImageResponse`)をリクエストごとに実行。レート制限なし、`caches.default` 未使用(`grep caches\. functions/` ヒットなし)。`Cache-Control: public, max-age=31536000, immutable`(`og.ts:140`)はブラウザ / クローラ向けで、Worker 生成レスポンスは Cloudflare エッジで自動キャッシュされない。コードベースで最も CPU コストの高い公開経路(`wrangler.toml` の `cpu_ms = 4000` は Paid で従量課金)。
- 攻撃例: 正規に 1 回 `/share` して id を得るか、公開ツイートの id を拾い、`?id=<id>&x=1,2,3…` とクエリを変えて連打。毎回フルレンダリング → CPU 課金(denial-of-wallet)と、正規クローラの遅延 / 1102。
- 検証: 本番で同じ `/og` URL を 2 回 fetch し `cf-cache-status` を確認。`HIT` なら LOW に格下げ。
- 対策:
  1. id を `/^[0-9a-f]{32}$/`(`functions/_lib/shareId.ts` の生成形式)で KV read 前に検査し、不一致は 404
  2. `caches.default` でラップ。キーは余分なクエリを落とした正規化 URL。レコードは不変なので安全

     ```ts
     const cache = caches.default;
     const hit = await cache.match(canonicalRequest);
     if (hit) return hit;
     // ...render...
     context.waitUntil(cache.put(canonicalRequest, response.clone()));
     ```

  3. 任意: キャッシュミス時に `_lib/rateLimit.ts` の `consumeRateLimit()` を適用

### 3. IPv6 ローテーションでレート制限と pending 上限を回避

- 場所: `functions/api/scores.ts:317-318`、`functions/_lib/ranking/ipHash.ts:42`、`functions/_lib/kv.ts:29`
- 確度: 0.85
- 内容: IP 単位の制御(D1 レート制限 30/h、`MAX_PENDING_PER_IP = 3`、KV `/share` 制限)はすべて `CF-Connecting-IP` の生文字列をキーにしている。一般家庭の IPv6 は /64(2^64 アドレス)を持つので、アドレスごとに別 `ip_hash` になる。1 人で `MAX_GLOBAL_PENDING = 200` に到達でき、30/h 制限は意味を持たない。
- 攻撃例: 同一 /64 内の約 200 アドレスから `POST /api/scores` を 200 件。`score: 9007199254740991`(`validateScore` に上限なし、設計どおり)、`seed` は毎回ランダム(`replay_hash` が全部異なる)、デコード可能な任意 RLE、正しい `Origin`。すべて pre-gate を通過して pending 保存される。
  - (a) 正規プレイヤー全員が `429 pending submission limit reached`(`scores.ts:548-553`)。監査がキューを消化するまで継続
  - (b) `GET /api/ranking` の上位 3 行が攻撃者の任意 24 文字名 + 巨額スコアで埋まる(`ranking.ts:103-124`)。launchd 1 サイクル約 5 分
  - (c) 攻撃者の 1 行あたり最大約 1.5 秒の再シミュレーション。200 行で `AUDIT_MAX_RUNTIME_MS` の 5 分予算をほぼ消費。正規行は `rank_seq` 順(`runAudit.ts:244-248`)で後回し。監査ごとに再充填可能
  - `ranking_rate_limits` にアドレスごと 1 行増える(24h 後にハウスキーピング、`constants.ts:30`)
- 対策: `_lib/ranking/ipHash.ts` に `normalizeClientIp(ip)` のような純粋関数を追加し、IPv6 を /64(または /56)プレフィックスに丸め、IPv4 はそのまま返す。`scores.ts:318` と `share.ts:47` のハッシュ / キー生成前に通す。グローバル上限はバックストップとして維持。任意で `MAX_DISPLAY_PENDING_CANDIDATES` を `ip_hash` ごとに適用(現状は全体で 3 なので 1 人で埋められる)。

## LOW

### 4. share id を未検証で KV 参照

- 場所: `functions/s.ts:56-61`、`functions/og.ts:110-115`
- 確度: 0.8
- 内容: null / 空以外は任意文字列で `share:<id>` の KV read が走る(課金対象)。KV のキー上限 512 バイト超で `env.SHARES.get()` が throw し、未捕捉で 404 ではなく 500 になる。インジェクションではない(値は `encodeURIComponent` 経由で、レコードが存在する場合しか描画しない)。
- 対策: 2 と同じ `/^[0-9a-f]{32}$/` 事前検査。`_lib/shareId.ts` に `isShareId()` を 1 つ作り両ハンドラで使う。

### 5. `/share` のレート制限キーに生 IP を KV 保存

- 場所: `functions/_lib/kv.ts:27-30`、`functions/share.ts:47`
- 確度: 0.95
- 内容: KV キー `ratelimit:<ip>:<hour>`(TTL 1h)に生の `CF-Connecting-IP` が入る。ランキング側の方針(`ipHash.ts:1-5`「生 IP は保存しない」、`migrations/0002:19-21`)と矛盾。攻撃可能性はないが、D1 側が避けた PII の保存が KV 側に残っている。
- 対策: 既存の `computeIpHash(ip, requireIpHashKey(env.RANKING_IP_HASH_KEY))` を KV キーにも使う(最低でも 3 の /64 正規化形)。`share.ts` には `RANKING_IP_HASH_KEY` の fail-closed 検査がないので `scores.ts:306-315` と同じ `requireIpHashKey` ガードを追加する。

### 6. セキュリティレスポンスヘッダ不在

- 場所: `functions/_lib/response.ts:3-10`、`functions/s.ts:68-71`、`public/`(`_headers` なし)
- 確度: 0.9
- 内容: `public/_headers` / `_redirects` が存在せず、`jsonResponse` は `content-type` のみ設定。`/s` の HTML とゲームページに `X-Content-Type-Options: nosniff`、`X-Frame-Options` / `frame-ancestors`、CSP がない。ゲームページは iframe 可能なので、クリックジャッキングで GAME OVER の「POST TO X」/「SUBMIT」を押させることは理論上できる(影響: 被害者自身のプレイの望まぬ共有 / 投稿、小)。API JSON に `Cache-Control` がないが、現状ユーザー固有データはないので問題なし。
- 対策: `public/_headers` に `/*` 向けで `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`(または CSP `frame-ancestors 'none'`)、`Referrer-Policy: strict-origin-when-cross-origin`。`jsonResponse` に `nosniff` と `Cache-Control: no-store` を追加(1 行、全 API が継承)。

## 問題なしと確認した領域

| 領域 | 根拠 | 証跡 |
|---|---|---|
| SQL インジェクション | 全 D1 文がバインド変数。SQL 文字列合成は定数 `LOCK_FENCE_SQL_FRAGMENT` のみ(6 呼び出し箇所すべてで `?N` 番号の整合を確認)。REST アダプタは `params.map(String)` | `scores.ts:84-111,184-210`、`ranking.ts:80-112`、`replay.ts:55-60`、`pendingGate.ts:62-72`、`rateLimit.ts:4-15`、`runAudit.ts:114,211,244-250,298,318-321,355-358,376,407-417`、`lock.ts:38-85,97`、`rateLimitHousekeeping.ts:10` |
| コマンドインジェクション / child_process | `execFileSync`(配列引数、シェルなし)はテスト補助のみ。ラッパスクリプトはユーザー入力なし、`set -eu`、`/usr/bin/security` 絶対パス、PATH は launchd 環境変数から再構築 | `testSupport/localD1.ts:59-63`、`run-ranking-audit.sh:2-14` |
| パストラバーサル(監査設定) | 設定パスは `import.meta.url` 由来のみ。CLI / env による上書きなし。CLI は `--remote` か引数なしのみ受理 | `d1Adapter.ts:24-28,44`、`auditCommand.ts:35-41` |
| HTML / SVG インジェクション(`s.ts` / `og.ts`) | 補間されるのは書き込み時に整数検証済みの `score/stage/hi`(`validation.ts:31-55`)と `encodeURIComponent(id)` のみ。レコードが存在する場合しか描画しない。注: KV レコードの読み出し時再検証はない(KV 書き込み権限が必要なので指摘対象外。`isNonNegativeInteger` の再検査 3 行で defense-in-depth になる) | `s.ts:14-50,66`、`og.ts:86-105,120` |
| XSS / DOM シンク(`src/`) | `innerHTML` / `insertAdjacentHTML` / `outerHTML` / `document.write` なし。サーバ由来文字列は `textContent`。動的 `href` は `https://x.com/${encodeURIComponent(xHandle)}` のみ(サーバも `^[A-Za-z0-9_]{1,15}$` を強制)、`rel="noopener noreferrer"`。ポップアップは `opener = null` | `ranking.ts:313-322,524-536`、`gameOverModal.ts:56-64,228-262`、`main.ts:224-227` |
| オープンリダイレクト(`/s`) | 遷移先は `${new URL(request.url).origin}/` を `JSON.stringify` したもの。攻撃者は操作不能 | `s.ts:15,43,67` |
| 認可 — 自己置換 | DELETE 候補は `submitter_hash = ?`(NULL は一致しない)かつ `score < new`、INSERT と同一バッチ。削除のみは場合分けで防止。他人の行は削除不能 | `scores.ts:184-210,514-547` |
| 認可 — replay `[id]` | 128bit ランダム id のみで検索。期限切れ pending は 404。追加フィールドは `status` のみ | `replay.ts:50-95` |
| 監査ロック / fencing | リース取得・更新・解放すべてに owner + 未期限の条件(D1 の時計基準)。全書き込みに fence を AND。`changes === 0` は `stillHoldsLock` で判別。リース 10 分 > 予算 5 分 + チャンク 75 秒 | `lock.ts:36-97`、`runAudit.ts:150-155,219-253,390`、`constants.ts:36-47` |
| 乱数 | share id(16B)、submitter token(16B)、lock owner(16B)、run seed(uint32)すべて `crypto.getRandomValues`。セキュリティ経路に `Math.random` なし | `shareId.ts:25-27`、`src/ui/submitterToken.ts:44-50`、`lock.ts:14-21`、`main.ts:425-429` |
| ipHash 鍵管理 | HMAC-SHA-256 + secret env。`scores.ts` と `auditCommand.ts` は fail-closed(`share.ts` は未適用、指摘 5)。docs 以外にハードコード鍵なし。`.dev.vars` は gitignore 済みで履歴にも不在(`git log --all -- .dev.vars` 空)。`wrangler.toml` の id は非秘密 | `ipHash.ts:28-46`、`scores.ts:306-315`、`auditCommand.ts:54-63`、`.gitignore` |
| データ露出 — API | `ranking.ts` は id/createdAt/score/stage/name/xHandle/replayAvailable/status、`replay.ts` は seed/rle/versions/status を返す。`ip_hash`、`submitter_hash`、`rank_seq`、`replay_hash` はサーバ外に出ない。500 本文は固定文字列、D1 メッセージは `console.error` のみ | `ranking.ts:65-75,126`、`replay.ts:88-95`、`scores.ts:497-504,533-538` |
| データ露出 — 監査ログ | エラーは許可リストのクラス名に縮約。メッセージは `AUDIT_LOG_ERROR_DETAIL` 有効時のみ(launchd は未設定)。イベント項目は id / 件数 / 理由種別に限定。`d1Adapter` のエラーは固定文字列、トークンは `Authorization` ヘッダのみ。ログファイルは umask 077 | `logSafety.ts:63-140`、`cli.ts:48-56`、`runAudit.ts:51-65,289-292`、`d1Adapter.ts:65-96,215-227`、`run-ranking-audit.sh:4`、plist `Umask 63` |
| localStorage / submitter token | `localStorage['qixxx:ranking:submitterToken']` と POST 本文にのみ存在。URL / 共有 / ログには出ない。サーバは SHA-256 を保存し、verify 時に null 化 | `submitterToken.ts:85-98`、`ranking.ts:899`、`runAudit.ts:355` |
| CSRF / Origin | 変更系 2 エンドポイント(`/share`、`/api/scores`)とも `Origin === self` 必須。GET(`/s`、`/og`、`/api/ranking`、`/api/ranking/:id/replay`)は副作用なし | `share.ts:25-29`、`scores.ts:285-289` |
| CORS | `Access-Control-*` ヘッダなし → 同一オリジンのみ | `functions/` grep |
| レート制限のヘッダ信頼 | `CF-Connecting-IP`(Cloudflare 設定)のみ読む。`X-Forwarded-For` / `X-Real-IP` 不使用 | `share.ts:47`、`scores.ts:317` |
| `/api/scores` の順序と上限 | 軽い検査 → レート制限(D1 書き込み 1)→ ストリーム 256 KiB 上限 → 検証 → SELECT 1 → INSERT 1(+ 上限時にバッチ 1)。RLE デコードはストリーミングで 10800 サンプル上限。`computeReplayHash` の `decodeRleToSamples` も同上限。varint は 5 バイト上限 + `isSafeInteger`。リクエスト経路で `verifyReplay` は走らない | `scores.ts:284-345,420-432,453-458`、`rle.ts:83,121-159`、`rleDuration.ts:22-28`、`hash.ts:33-41` |
| `/api/ranking`、`/replay` のコスト | それぞれインデックス付きクエリ 2 と 1、リクエストあたり定数。≤256 KiB blob の base64 | `ranking.ts:80-112`、`replay.ts:42-46,55-60`、`migrations/0002:49-66` |
| 攻撃者由来 DB 内容 → 監査ランナー | 消費するのは `seed` / `inputs` / 数値列のみ。シミュレーションは有界(10800 tick、100 claim、`guard > 10`)。例外は行単位で捕捉 → 3 回リトライ後削除。`name` / `x_handle` はランナーが読まない。DB 由来の値がファイルパス / シェルに触れない | `runAudit.ts:255-334`、`verifyReplay.ts:60-87`、`replayEngine.ts:193-227` |
| D1 REST タイムアウト | リクエストあたり 30 秒 `AbortSignal.timeout`、予算 / リースとの不変条件を検査。リトライループなし(run を失敗させ launchd が 5 分後に再実行) | `d1Adapter.ts:208-242`、`constants.ts:16,40-47` |
| Keychain / PATH | 秘密は実行時に `security -w` で子プロセスの env にのみ渡す。コマンドラインには出ない。PATH = `NODE_BIN_DIR` + システムディレクトリ。ジョブ内に `git pull` / `npm ci` なし | `run-ranking-audit.sh:5-14` |
| CI / サプライチェーン | `push` + `pull_request` のみ(`pull_request_target` なし)、secrets 参照なし。e2e は `main` のみ。Actions はメジャータグ参照(`@v4`、SHA 固定でない。一般的、情報のみ)。`package.json` scripts はローカル開発コマンドのみ、`workers-og` は完全固定 | `.github/workflows/ci.yml:1-58`、`package.json:6-20,38` |
| `?seed=` / デバッグパネル | seed 指定 / taint 済みの run はクライアント側で投稿対象外、サーバ側でも再シミュレーションで落ちる。デバッグパネルは `import.meta.env.DEV` ゲートで本番から除去 | `seedParam.ts:27-32`、`ranking.ts:126-128`、`main.ts:549-562,1035-1043` |
| マイグレーション | 追加のみ。`audit_lock` は番兵 `''` / `0` で初期化。`request_count >= 1` CHECK | `migrations/0002:80-95`、`0004:1-6` |

## 未精読ファイル

- `src/core/session.ts`(701 行): I/O、`window` / `document` / `fetch` / `localStorage` / seed 処理を grep したのみ。純粋なゲームロジックで該当なし。行単位レビューはしていない
- `src/config.ts`: サーバが依存する定数(`MAX_INPUT_SAMPLES = TIME_LIMIT_TICKS = 10800`、`MAX_VERIFIED_CLAIMS = 100`、各 version)を grep したのみ
- `functions/_lib/fonts/pressStart2P.ts`: ヘッダのみ(生成された base64 blob)
- `eslint.config.js`: 先頭 40 行のみ
- `.dev.vars`(ローカル、gitignore 済み): 意図的に開いていない。未追跡かつ履歴に不在であることのみ確認

## 対応の提案

| 指摘 | まとめ方 | 変更箇所 |
|---|---|---|
| 1, 2, 4, 5 | 1 つの PR(share / og / s の一括整備) | `readBodyWithLimit` を `_lib/` へ移動、`isShareId()` 追加、`/og` に `caches.default`、KV キーを `computeIpHash` 化 |
| 3 | 独立した小 PR | `ipHash.ts` に `normalizeClientIp()` 追加、`scores.ts` / `share.ts` の 2 箇所で呼ぶ |
| 6 | 独立した小 PR | `public/_headers` 追加、`jsonResponse` に 2 ヘッダ追加 |

いずれもランキング PR(`feat/ranking-free-async`)とは分ける。`/share` 系はランキング機能と無関係なのでレビューを分けたほうが分かりやすい。
