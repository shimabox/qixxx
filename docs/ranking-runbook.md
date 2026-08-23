# スコアランキング 運用手順書(D1 / シーズン / 検証ルール)

`POST /api/scores` + D1 `scores` テーブルで動くスコアランキングの運用手順。
**本番デプロイ前の準備**、**日常運用(不適切な投稿の削除)**、
**シーズン切替**、**検証ルール変更**を扱う。

関連ファイル:

- スキーマ: [`migrations/0001_create_scores.sql`](../migrations/0001_create_scores.sql)
- シーズン定数: [`functions/_lib/ranking/season.ts`](../functions/_lib/ranking/season.ts)
- ルール定数: [`src/config.ts`](../src/config.ts)(`RULESET_VERSION` / `REPLAY_FORMAT_VERSION` / `MAX_VERIFIED_CLAIMS`)
- CPU 計測と投稿頻度見積り: [`docs/ranking-cpu-measurement.md`](./ranking-cpu-measurement.md)

---

## 0. 用語と「正」の所在

> ### ⚠ `--remote` を付け忘れないこと(最重要)
>
> **wrangler 3.114.17 では、`d1 execute` / `d1 migrations apply` は
> `--remote` を付けない限りローカル(`.wrangler/state/` の SQLite)に対して実行される。**
> 本番 D1 を操作したいのに `--remote` を忘れると、
> **何のエラーも出ないまま**ローカルだけが変更され、本番は無傷のまま残る
> (逆に、ローカルを触るつもりで `--remote` を付けると本番を壊す)。
>
> | 対象 | 付けるフラグ |
> | --- | --- |
> | **本番 D1** | **`--remote` を必ず付ける** |
> | ローカル D1(開発用) | `--local`(省略時もローカル。明示推奨) |
>
> 本手順書のコマンドはすべて**本番向けに `--remote` 付き**で書いてある。
> ローカルで試すときは `--remote` を `--local` に置き換えること。

| 概念 | 正の所在 | 意味 |
| --- | --- | --- |
| `CURRENT_SEASON_ID` | **サーバー**(`functions/_lib/ranking/season.ts`) | シーズン。クライアントは申告しない |
| `RULESET_VERSION` | `src/config.ts`(core と共有) | ゲームルールの版。変わると過去スコアと比較不能 |
| `REPLAY_FORMAT_VERSION` | `src/config.ts` | リプレイ入力列のエンコード形式の版 |
| 順位 | `score DESC, rank_seq ASC` | **同点は先着優先**。`created_at` は同一ミリ秒があり得るので使わない |

**絞り込み規則(厳守)**: ランキング表示・11位以下削除・圏内判定は
**すべて `season_id = 現行 AND ruleset_version = 現行`** で絞る。
これにより、仮にシーズンの繰り上げを忘れても旧ルールのスコアが混ざることはない。

---

## 1. 本番デプロイ準備(初回のみ)

> **停止ポイント**: 本番 D1 の作成・Paid 契約・本番デプロイは
> **ユーザーの明示的な承認を得てから**行うこと。

1. **D1 データベース**

   作成済み。`database_id` は `wrangler.toml` を参照する。

2. **マイグレーション適用**

   ```sh
   # 本番(--remote 必須。付け忘れるとローカルだけに適用され、本番は空のまま)
   npx wrangler d1 migrations apply qixxx-scores --remote

   # ローカル(開発用)
   npx wrangler d1 migrations apply qixxx-scores --local
   ```

   適用後、本番に実際にテーブルができたことを確認する:

   ```sh
   npx wrangler d1 execute qixxx-scores --remote --command \
     "SELECT name FROM sqlite_master WHERE type='table' AND name='scores';"
   ```

4. **`[limits] cpu_ms` を確定する**(現在の値は暫定)

   現在の `4000` は **ローカル in-process wall-clock ベンチマーク**
   (`docs/ranking-cpu-measurement.md` §4)から置いた**暫定値**であり、
   Cloudflare が課金・制限する CPU 時間の実測ではない。

   **preview 環境で実 CPU 時間**(`wrangler tail` の `cpuTime` /
   ダッシュボードの CPU time メトリクス)を測り直し、その p99 の 2 倍程度に
   確定すること。手順は同文書 §4.8。**Paid 成立の可否も同じ実測で判断する**
   (ローカルベンチマークでは判断しない)。

5. **疎通確認**

   - `GET /api/ranking` が `{"entries":[]}` を返すこと
   - 実プレイ1件を投稿し、`accepted: true` と順位が返ること
   - そのエントリのリプレイが再生できること

---

## 2. 日常運用: 不適切な投稿の削除

名前・X ハンドルはユーザー入力なので、不適切な投稿は手で消す。

**手順0: 現行のシーズンとルール版を確認する**

下の SELECT は現行ランキングだけを見るために両方の値で絞る。
**ハードコードせず、毎回ソースを見て置き換えること** — シーズンを切り替えた後に
古い値のまま実行すると、**旧シーズンのランキングを表示して的外れな行を消しかねない**。

| 値 | 参照するファイル | 定数 |
| --- | --- | --- |
| `<CURRENT_SEASON_ID>` | `functions/_lib/ranking/season.ts` | `CURRENT_SEASON_ID` |
| `<RULESET_VERSION>` | `src/config.ts` | `RULESET_VERSION` |

```sh
grep -n 'CURRENT_SEASON_ID' functions/_lib/ranking/season.ts
grep -n 'RULESET_VERSION' src/config.ts
```

**手順1: 対象を特定する**(消す前に必ず中身を見る)

以下の `<CURRENT_SEASON_ID>` / `<RULESET_VERSION>` は手順0の実際の値に置き換える。

```sh
npx wrangler d1 execute qixxx-scores --remote --command \
  "SELECT rank_seq, id, score, stage, name, x_handle, datetime(created_at/1000,'unixepoch') AS created
   FROM scores
   WHERE season_id = <CURRENT_SEASON_ID> AND ruleset_version = <RULESET_VERSION>
   ORDER BY score DESC, rank_seq ASC LIMIT 10;"
```

現行ランキングが空に見えたら、まず**置き換えた値が正しいか**を疑うこと
(シーズンを繰り上げた直後は、実際に空になっているのが正常でもある)。

**手順2: 1件削除**(公開 ID 指定。`rank_seq` ではなく `id` を使う — 公開 API が返すのは `id`。
`id` はシーズンに関係なく一意なので、こちらは絞り込み不要):

```sh
npx wrangler d1 execute qixxx-scores --remote --command \
  "DELETE FROM scores WHERE id = '<公開ID>';"
```

注意点:

- **削除すると11位以下が繰り上がらない**。`scores` は各 `(season_id, ruleset_version)` に
  つき上位10件しか保持しない仕様(POST の batch 内で11位以下を削除している)ので、
  繰り上げ候補はそもそも残っていない。削除後は単に9件になる。
- 名前だけを消したい(記録は残したい)場合は `UPDATE` を使う:

  ```sh
  npx wrangler d1 execute qixxx-scores --remote --command \
    "UPDATE scores SET name = '(removed)', x_handle = NULL WHERE id = '<公開ID>';"
  ```

- **上のコマンドはすべて `--remote` 付き = 本番 D1 に対する操作**である。
  `--remote` を落とすとローカル D1 だけが変更され、**本番は何も変わらないのに
  成功したように見える**(冒頭の警告を参照)。ローカルで試すときは
  `--remote` を `--local` に置き換えること。
- 削除・更新は取り消せない。実行前に必ず上の SELECT で対象を確認すること。

---

## 3. シーズン切替(ランキングのリセット)

ルールは変えずにランキングだけリセットしたいとき。

1. `functions/_lib/ranking/season.ts` の `CURRENT_SEASON_ID` を **+1** する
2. デプロイする

以上。**過去データは削除しない** — 絞り込み規則により、旧シーズンの行は
表示にも圏内判定にも現れなくなる。リプレイ取得(`GET /api/ranking/:id/replay`)も
現行シーズンと一致しない行には **410** を返す(データは保持される)。

---

## 4. ルール変更時のチェックリスト(厳守)

### 4.1 `RULESET_VERSION` を変えるとき

ゲームルール・難易度・スコア計算など、**同じ入力列が同じスコアを生まなくなる**変更。

- [ ] `src/config.ts` の `RULESET_VERSION` を +1
- [ ] **`functions/_lib/ranking/season.ts` の `CURRENT_SEASON_ID` も必ず +1**
      ← これを忘れないこと。忘れても絞り込み規則で事故にはならないが、
      `season_id` が「ルールの時代」を表す意味を失う
- [ ] 両方を**同一デプロイ**に含める
- [ ] デプロイ後、ランキングが空になっていることを確認

### 4.2 `REPLAY_FORMAT_VERSION` だけを変えるとき

入力列のエンコード形式のみの変更(ルールは不変)。

- [ ] `src/config.ts` の `REPLAY_FORMAT_VERSION` を +1
- [ ] `CURRENT_SEASON_ID` は**変えなくてよい**
- [ ] 既存エントリは**ランキング表示には残る**が、リプレイ再生はできなくなる
      (`replayAvailable: false` として返り、再生ボタンは無効化される)

### 4.3 `MAX_VERIFIED_CLAIMS` を変えるとき

**これは投稿可否に影響するプロトコルパラメータである。**
現在の値は 100(`src/config.ts`)。サーバーはリプレイ検証中に
**101回目のクレームを検出した時点で即時拒否**する。

- [ ] **シーズンまたは検証ルールの変更として扱うこと。**
      値を緩める(増やす)と、それまで拒否されていた入力列が通るようになり、
      同一シーズン内で「拒否されたプレイヤー」と「通ったプレイヤー」が
      **異なる検証ルールで同じランキングに並ぶ**ことになる
- [ ] したがって、変更する場合は `CURRENT_SEASON_ID` を +1 すること
- [ ] 併せて CPU コストを再計測すること(上限を上げる = 攻撃入力の上界が上がる)。
      方法論は `docs/ranking-cpu-measurement.md` §3.2

---

## 5. 容量の考え方

D1 の制約(正確に記載すること):

- **1行・文字列・BLOB の上限: 2MB**
- **Free プラン: 1データベースあたり 500MB、アカウント合計 5GB**

`scores` は `(season_id, ruleset_version)` の組ごとに**上位10件のみ**保持する。
BLOB(`inputs`)が上限いっぱいの 2MB でも
**1組あたり最大 10行 × 2MB = 20MB**。実際の入力列は 10800 サンプルの RLE で
数十 KB 程度なので、現実的にはこの試算よりはるかに小さい。

圏外リプレイの別途保管は v1 では行わない。

---

## 6. 既知の限界(v1)

`replay_hash` は受信 BLOB そのものではなく
**season + rulesetVersion + seed + 正規化済み入力列**から計算しているので、
同一入力を異なる RLE 分割で表現し直した連投は弾ける。

一方で、**本方式でも防げないもの**:

- ボットによる自動プレイ入力
- 公開済みリプレイを微改変しての再投稿

これらは v1 の既知の限界として受け入れる。
