# スコアランキング Free 版(非同期監査)運用手順書

`plan/2026-08-19-ranking-free-async` ブランチで試作した非同期監査方式の運用手順。
Paid 版(同期検証)の運用は [`docs/ranking-runbook.md`](./ranking-runbook.md) を参照
(D1 スキーマの基礎・シーズン切替・検証ルール変更はそちらと共通)。

関連ファイル:

- 追加スキーマ: [`migrations/0002_ranking_free_async.sql`](../migrations/0002_ranking_free_async.sql)
- POST ハンドラ: [`functions/api/scores.ts`](../functions/api/scores.ts)
- GET ハンドラ: [`functions/api/ranking.ts`](../functions/api/ranking.ts)
- 監査ロジック: [`scripts/audit/runAudit.ts`](../scripts/audit/runAudit.ts)
- 監査ロック: [`scripts/audit/lock.ts`](../scripts/audit/lock.ts)
- D1 接続アダプタ: [`scripts/audit/d1Adapter.ts`](../scripts/audit/d1Adapter.ts)
- CLI エントリポイント: [`scripts/audit/cli.ts`](../scripts/audit/cli.ts)
- GitHub Actions ワークフロー: [`.github/workflows/ranking-audit.yml`](../.github/workflows/ranking-audit.yml)

---

## 0. 全体像

Paid 版との違いは「投稿時に `verifyReplay()` で即座に真偽判定する」か
「投稿は基本検査のみで `pending` 保存し、後続の監査ジョブが確定させる」かの一点。
`verifyReplay()` 自体(スコア導出・終了条件判定・RLE 検証)は完全に同じものを
POST(このブランチでは呼ばない)と監査ジョブの両方で共有する設計。

```
POST /api/scores ─→ 基本検査 + 圏内事前ゲート ─→ D1 に status='pending' で保存 ─→ 即応答
                                                          │
                                                          ▼
                                    scripts/audit/runAudit.ts (Node, 手動 or GitHub Actions)
                                                          │
                              verifyPendingEntry() (= verifyReplay() + 申告値/version 突合)
                                                          │
                     ┌────────────────────────────────────┴───────────────────────────────┐
                     ▼                                                                      ▼
        確定的に不合格 → 即削除                                              予期しない例外 → audit_attempts++
   (VerifyReplayResult.ok=false /                                          next_attempt_at で次周期送り
    申告値・version 不一致)                                                  (3回で削除)
                     │
                     ▼
        status='verified' に更新 → TOP10 整理(圏外 verified 行のみ削除)
```

## 1. ローカルでの手動実行手順(このラウンドで動作確認済み)

### 1.1 準備

```sh
# 1. マイグレーション適用(ローカル D1。0001 が未適用なら両方適用される)
npx wrangler d1 migrations apply qixxx-scores --local

# 2. ip_hash 鍵の用意(POST ハンドラ・監査コマンド両方が起動時に必須チェックする)
cp .dev.vars.example .dev.vars   # 値は開発用なら何でもよい(HMAC 鍵として不透明に扱われる)

# 3. ビルド + Pages Functions のローカルサーバー起動(バックグラウンド推奨)
npm run build
npx wrangler pages dev dist --port 8788 &
```

`wrangler pages dev` は `.dev.vars` を自動で読み込む(`RANKING_IP_HASH_KEY` が
`Using vars defined in .dev.vars` のログとともに Worker に渡る)。

### 1.2 投稿(pending 保存)

```sh
curl -X POST http://localhost:8788/api/scores \
  -H "Origin: http://localhost:8788" -H "Content-Type: application/json" \
  -H "CF-Connecting-IP: 203.0.113.1" \
  -d '{"seed":4242,"rleBase64":"<base64>","score":1234,"stage":2,"name":"TESTER","rulesetVersion":1,"replayFormatVersion":1}'
```

応答: `{"accepted":true,"id":"...","status":"pending","message":"...", "score":1234,"stage":2,"durationTicks":<サーバー導出値>}`

`rleBase64` は実際のゲームプレイでなくても(RLE として復号さえできれば)受理される
— POST は `verifyReplay()` を一切呼ばないため。`GET /api/ranking` の `pendingEntries`
に反映されることを確認する。

### 1.3 監査実行

```sh
RANKING_IP_HASH_KEY=$(grep RANKING_IP_HASH_KEY .dev.vars | cut -d= -f2) \
  npx vite-node scripts/audit/cli.ts
```

`.dev.vars` は Node プロセス(`vite-node`)には自動で読み込まれない
(`wrangler pages dev` 固有の機構)ため、上記のように環境変数として渡す必要がある。

出力例:

```
[audit] {"type":"lock-acquired","runStartedAt":1787156043}
[audit] {"type":"expired-pending-deleted","count":0}
[audit] {"type":"chunk-fetched","count":1}
[audit] {"type":"entry-verified","id":"..."}
[audit] {"type":"top10-cleanup","deletedCount":0}
[audit] {"type":"lock-released","released":true}
[audit] done. runStartedAt(D1 unixepoch)=... processed=1 verified=1 ... leaseLostMidRun=false lockReleased=true
```

最終行が `done.` ではなく `INCOMPLETE (lease lost mid-run ...)` になり、
終了コードが 1 になる場合(`leaseLostMidRun=true` または `lockReleased=false`)は、
実行の途中でリース(`audit_lock`)を失っており、**残りの pending 行や TOP10 整理を
意図的に中断している**。リース10分 > 最大実行時間5分(spec item 8)の設計上
本来起きないはずの状態なので、起きたら実行時間・D1 の応答遅延を確認すること。
未処理分は次回実行が引き継ぐため、DB 自体は壊れていない
(中断後の書き込みはフェンシングで一切適用されない)。

`GET /api/ranking` の `entries`(確定 TOP10)に移り、`pendingEntries` から消える。
`GET /api/ranking/:id/replay` が 200 で見られるようになる(pending の間は 404)。

### 1.4 偽スコアの削除を確認する

`score` に実際のシミュレーション結果と異なる値を入れて POST すると、
`accepted:true` で一旦 pending になり、`GET /api/ranking` の `pendingEntries` に
表示される。監査を実行すると `verifyPendingEntry()` が `declared-score-mismatch`
と判定して即削除される(`entry-deleted-confirmed-invalid` イベント、
`reason:"declared-score-mismatch"`)。

このラウンドの実装時に上記 1.2〜1.4 の一連を実機(`wrangler pages dev` + 実 D1 +
`scripts/audit/cli.ts`)で確認済み(完了報告の「実機確認結果」参照)。

---

## 2. D1 スキーマ(このラウンドで追加した列)

`migrations/0002_ranking_free_async.sql` が `scores` テーブルに追加する列:

| 列 | 型 | 意味 |
| --- | --- | --- |
| `status` | `TEXT NOT NULL DEFAULT 'verified'` | `'pending'` / `'verified'`。既存行は `'verified'` にバックフィル(再監査対象にしない) |
| `ip_hash` | `TEXT`(nullable) | `HMAC-SHA-256(CF-Connecting-IP)`。既存行は `NULL`(生成当時この列がなかったため) |
| `audit_attempts` | `INTEGER NOT NULL DEFAULT 0` | 予期しない例外によるリトライ回数 |
| `next_attempt_at` | `INTEGER`(nullable) | unixepoch() 秒。リトライ対象行の次回取得可能時刻 |

新設テーブル `audit_lock(id, owner_token, locked_until)`: 監査ジョブの多重起動防止用ロック。
`id=1` の1行のみ、初期行はマイグレーション自体が投入する(`owner_token=''`, `locked_until=0`)。

---

## 3. GitHub Actions での定期実行を有効化する手順(未実施・本番接続後の作業)

`.github/workflows/ranking-audit.yml` は現状 `workflow_dispatch` のみ有効。
`schedule` はコメントアウトされている(理由はワークフローファイル自身のコメントを参照)。
有効化には以下がすべて必要:

1. **本番 D1 への接続を実装する**(このラウンドの範囲外)。
   `scripts/audit/d1Adapter.ts` の `RemoteD1Adapter` が現状 throw するだけの
   スタブになっている — 実装時の選択肢は次の2つ:
   - `wrangler d1 execute --remote` をシェルアウトして呼ぶ(Actions 上で
     `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` を secret として渡す)
   - D1 の REST API を直接 `fetch` する(Cloudflare API トークンで認証)
   どちらも「Actions から D1 への認証・接続」という同じ論点で、
   ローカル監査スクリプトの `getPlatformProxy()` とは別の実装になる。
2. リポジトリ変数 `AUDIT_CRON_ENABLED` を `true` に設定
   (Settings → Secrets and variables → Actions → Variables)。
3. ワークフローファイルの `schedule:` ブロックのコメントアウトを外す。
4. リポジトリ secret `RANKING_IP_HASH_KEY` を、本番の Cloudflare Pages secret と
   **同じ値**で設定する(Settings → Secrets and variables → Actions → Secrets)。
   値が食い違うと、監査ジョブは動くが ip_hash の意味論とは無関係(このラウンドの
   audit コマンドは ip_hash を再計算しない — POST 時に確定済みの値を読むだけ)
   なので実害はないが、鍵管理の一貫性のため揃えておくこと。

## 4. ip_hash 鍵の管理

- アルゴリズム: HMAC-SHA-256(固定)。生 IP は保存しない。固定ソルト付き SHA-256 は不可
  (IP は低エントロピーで公開ソルトでは総当たり可能なため)。
- ローカル: `.dev.vars`(gitignore 済み。`.dev.vars.example` を雛形として使う)。
- 本番: Cloudflare Pages の secret(`wrangler pages secret put RANKING_IP_HASH_KEY`)。
- 鍵が未設定の場合、POST ハンドラ・監査コマンドの両方が **DB 操作前に** 検出して
  fail-closed する(`functions/_lib/ranking/ipHash.ts`)。生 IP へのフォールバックはしない。

## 5. 既知の残余リスク・未決事項

- Actions からの実 D1 接続方式(§3 の1)は未実装・未決定。
- Free 10ms CPU 適合の最終確定(実測 `cpuTime`)は本ラウンドのスコープ外
  — デプロイ判断後の Cloudflare preview 環境での実測に委ねる。
- 監査までの偽スコア表示窓(通常運用で cron 間隔+実行時間、リトライ対象は最大3周期まで)
  は非同期監査方式の本質的なトレードオフであり、実装で解消できるものではない
  (Paid 版との比較観点として完了報告に記載)。
