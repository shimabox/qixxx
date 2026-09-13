# 敵対的レビュー 2026-09-13

対象: リポジトリ全体(ゲーム core、Pages Functions、非同期監査ジョブ、運用手順)。
2026-09-09 のセキュリティレビュー(入力検証・注入・ヘッダ・レート制限)で潰した領域は
再掃除せず、**設計の前提そのものを崩す**観点に絞った。

## 結果サマリ

| 区分 | 件数 | 内容 |
|---|---|---|
| 修正済み | 4 | claim 上限超えの無警告削除 / 公開リプレイ複製の再投稿 / 満杯時の重複が 429 になる / housekeeping がホスト時計依存 |
| 実験でシロ | 1 | WebKit(Safari)で記録したプレイが Node の監査で不一致になるか |
| 机上でシロ | 7 | D1 の競合・リース・型親和性・時計ずれ(§C) |
| 判断待ち | 3 | `MAX_VERIFIED_CLAIMS` の値 / `/api/ranking` のキャッシュ / 監査停止の検知 |

## A. 監査(再シミュレーション)の決定論性

### A-1. JS エンジン差 — シロ(実験)

Wisp は毎 tick `Math.cos / sin / atan2` を使い(`src/core/enemy.ts`)、位置を `Math.round` で格子化する。
三角関数の結果は ECMAScript で正確丸めが要求されておらず、JavaScriptCore(Safari)と V8 で最終 ulp が異なる。

実験: `src/core` を esbuild で 1 本の IIFE に束ね、同じバンドルを Node 20(vm)と
Playwright の WebKit / Chromium で実行して比較した。

| 比較 | 件数 | 結果 |
|---|---|---|
| sin / cos / atan2 の生ビット指紋 | 200 万点 | **3 環境すべて異なる** |
| ボット入力の完走リプレイ(score / stage / duration / 終了理由) | 200 本 | 不一致 0 |
| 待機入力で 10800 tick、Wisp 座標を毎 tick 指紋化(既定難易度) | 60 seed | 不一致 0 |
| 同上、Wisp 10 体 × 速度 5 倍 | 60 seed | 不一致 0 |

ulp 差が `Math.round` の境界(.5)を跨ぐ確率は 1 回あたり 2^-52 程度で、1 プレイの丸め回数
(約 4×10^5)を掛けても 10^-10 のオーダー。実機 iOS も Apple libm なので同じ扱いでよい。

### A-2. クライアント側の tick と記録 — シロ

`InputRecorder.observe` は `session.update` の直後に毎 tick 呼ばれ、`totalTicks` が進んだ tick だけ
記録する。stageclear / gameover / title の tick は `totalTicks` が進まず記録されず、replayEngine は
同じ状態を CONFIRM で自動送りする。フレーム落ちで 1 フレーム 2 tick 進んでも `update()` は tick
ごとに呼ばれるので入力サンプルも 2 個記録される。

### A-3. 時間切れとミスの同 tick — シロ

`GameSession.update` は `updatePlaying` の後に時間切れを判定し `time` が勝つ。`verifyReplay` の
「time なら duration == 10800、life なら < 10800」はこの順序と一致する。

### A-4. `MAX_VERIFIED_CLAIMS`(100)超えのプレイ — **修正**

クライアントは上限を知らず、超えたプレイも「SUBMITTED — PENDING VERIFICATION」と表示したまま、
数分〜数時間後に監査が黙って削除していた。小さな陣地を刻む慎重なプレイほど claim 数が増えるため、
上位に届くプレイが到達し得る値である。

修正: `src/main.ts` が `area-claimed` イベントを数えてゲームオーバー時のスナップショットに載せ、
`decideSubmissionOffer` が「圏内だが claim 超過」を `over-claim-cap` として区別し、フォームの代わりに
理由だけを表示する。判定はサーバと同じ `MAX_VERIFIED_CLAIMS` を参照する。

**判断待ち**: 100 という値自体。CPU 上限の根拠は Free 同期検証時代のもので、現行の監査は Mac 上で
5 分予算で走る。緩めるならシーズン切替が必要(`docs/ranking-runbook.md` §4.3)。

## B. スコア改竄の経済性

### B-1. 公開リプレイの複製再投稿 — **修正**

TOP10 のリプレイ(seed + 入力列)は公開されている。`replay_hash` は入力列の同一性しか見ないので、
末尾 1 サンプルを変えるだけで別ハッシュになり、他人のプレイが別名で 2 行目になれた。

修正: migration `0005_scores_rng_key.sql` で実効 seed `rng_key` を UNIQUE にし、INSERT 時に既存の
409「duplicate replay」経路で弾く。正当な衝突確率は組ごとに 2^-32。自己置換の DELETE 候補からは
同 seed の自行を除外し、満杯時も同じ 409 になるようにした。本番適用前の重複確認手順は
`docs/ranking-audit-runbook.md` §2.2。

残っていた穴(修正済み): seed を変えた複製がすべて監査で落ちるわけではない。`deriveStageSeed()` は
`"<seed>:<stage>"` の FNV-1a なので、`"<seed>:"` までのハッシュ状態が一致する seed の組
(例: `1485211075` と `2522981067`)は全ステージで同じ乱数系列になり、同一入力列を両 seed で
投稿すると両方 200・監査も両方成功した(ローカル D1 で確認: score 4602、stage 1、4772 tick)。
seed も `replay_hash` も異なるため、数値 seed の UNIQUE(当初の 0005 案)では拒否できない。
FNV-1a の更新は全単射なので「stage 1 だけ衝突」は存在せず、`deriveStageSeed(seed, 1)` が
同値類の代表になる。0005 はこの値を `rng_key` 列として持ち UNIQUE にする形に改め(数値 seed の
一意性はこれに含まれるので `seed` 列には張らない)、既存行は SQL 内の同じ FNV-1a でバックフィルする。
投稿 API の満杯時 409 判定と自己置換の除外条件も `rng_key` 基準に揃えた
(`docs/ranking-runbook.md` §6、`docs/ranking-audit-runbook.md` §2.2)。

### B-2. 満杯時の重複が 429 になる — **修正**(サブエージェント指摘)

上限付き `INSERT...SELECT` は WHERE が偽だと UNIQUE index に到達しないため、満杯中の再投稿は
「あとで再試行」(429)と答えていた。再試行しても成功しない。`changes === 0` のときだけ
seed / replay_hash の存在を読んで 409 に振り分ける。

### B-3. ボットプレイ・seed 選び — 受容(既知)

`?seed=` は除外済み。POST の seed は自由だが、seed を総当たりして「楽な盤面」を選んでも敵は
プレイヤーに反応するので利得は小さい。ボット入力は v1 の既知の限界のまま。

### B-4. pending 表示窓 — 受容(既知)

表示は最大 3 行、72 時間。監査が止まると偽スコアが最大 3 日間見える。→ 判断待ち「監査停止の検知」。

## C. 同時実行・状態遷移(D1)— シロ

サブエージェントによる 7 シナリオのトレース。結論はすべて「行の消失・二重計上・監査の同時書き込みなし」。

| シナリオ | 判定 | 根拠の要点 |
|---|---|---|
| 自己置換バッチと監査の同一行競合 | SAFE | DELETE 候補は `status='pending'` を再確認、監査側は `rank_seq` + fence で空振りを `no-op-still-owner` に分類 |
| TOP10 cleanup と閾値 SELECT の競合 | SAFE | cleanup は 11 位以下だけ削除し 10 位の点は単調非減少。古い閾値は pending を 1 行余計に受理するだけ |
| リース失効・fence・retry | SAFE | fence と `acquireLock` が同じ `locked_until >= unixepoch()` を D1 時計で評価。`next_attempt_at` は同一 run では再取得されない |
| REST アダプタの `params.map(String)` | SAFE(実測) | SQLite 3.51 で列親和性により数値比較になることを確認。式との比較は監査 SQL に存在しない |
| レート制限 UPSERT と housekeeping | SAFE | 24h 以上放置の行しか消さず、負けても UPSERT が count=1 で再作成 |
| 時計ずれ | 1 件修正 | D1 時計が支配的。唯一ホスト時計だった housekeeping を `unixepoch()` へ(§D-3) |
| 同一リプレイの同時投稿 | SAFE | UNIQUE で片方が 409、満杯時はバッチがロールバック |

INFO: チャンク単位の壁時間は上限がなく、D1 遅延が 6 秒/リクエストを超え続けるとリースが切れ得る
(安全側に止まるだけ)。`processedCount` は自己置換された行も数える。

## D. 可用性・コスト

### D-1. `/api/scores` の D1 書き込み — 受容

30 回/時/IP、1 リクエストで書き込み 1〜3。IPv4 を大量に持つ攻撃者なら D1 無料枠を削れるが、
既存のレート制限の範囲内。`ranking_rate_limits` の肥大は housekeeping が吸収する。

### D-2. `/api/ranking` の無制限 GET — 受容(判断済み)

毎回 2 クエリ、`Cache-Control: no-store`。`caches.default` で 5〜10 秒の共有キャッシュを入れる
余地はあるが、**リアルタイム性を優先してキャッシュは入れない**。ランキングは投稿直後・監査直後の
反映が体験の核であり、数秒の遅延を許容しない。

受容するリスク: D1 Free の読み取り枠は **500 万読み取り行/日**(リクエスト数ではない)。
必要なリクエスト数は `rows_read` の実測なしには決まらない。枠に到達すると D1 クエリ自体が
エラーになるので、影響はランキング表示だけでなく**スコア投稿・監査・リプレイ取得**にも及ぶ
(ゲーム本体のプレイは継続できる)。

### D-3. housekeeping のホスト時計依存 — **修正**

`deleteExpiredRankingRateLimits` だけが `Date.now()` を使っていた。Mac の時計が 23 時間以上進むと
現行窓の行を消して制限がリセットされる。既定を `unixepoch()` に変更。

### D-4. 監査の starvation — シロ

チャンクは処理済み行を必ず述語から外す(verified 化 / 削除 / `next_attempt_at` 先送り)ので、
5 分で打ち切られても次の run は続きから進む。pending 上限 200 × 最悪 1.5 秒 = 5 分で 1 周。

## E. クライアント信頼境界 — 指摘なし

オファー判定はサーバの pre-gate と同じ `entries` 基準。429 の 2 種(レート制限 / 待ち行列)は
`accepted` の有無で区別して文言を分けている。

## F. 運用 — 判断待ち

- **監査停止の検知**: launchd の Mac がスリープ・Keychain ロックで止まっても通知がない。pending の
  最古 `created_at` が 30 分を超えたら知らせる程度の監視があるとよい。
- 鍵ローテーション時、旧鍵の `ip_hash` 行が pending 上限とレート制限に残る(72h / 24h で自然消滅)。
- 監査 checkout と Pages のバージョン不一致は runbook §3.4 の手順で防ぐ前提。

## 修正ファイル

- `src/main.ts`, `src/ui/ranking.ts`, `src/ui/ranking.test.ts` — claim 上限の事前判定
- `migrations/0005_scores_rng_key.sql`(+ test)、`functions/_lib/ranking/rngKey.ts`(+ test)、`functions/api/scores.ts`、
  `functions/_lib/ranking/seedUniqueness.test.ts`、`pendingSelfReplace.test.ts`、
  `scoresConcurrency.test.ts`、`scoresEndpoint.test.ts`、`scripts/audit/testSupport/localD1.ts`
- `scripts/audit/rateLimitHousekeeping.ts`(+ test)
- `docs/ranking-schema.md`, `docs/ranking-runbook.md`, `docs/ranking-audit-runbook.md`
