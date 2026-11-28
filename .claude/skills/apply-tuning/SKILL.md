---
name: apply-tuning
description: デバッグパネル（?debug）の EXPORT ボタンで出力した JSON を src/config.ts のチューニング定数に反映するオーケストレーション。引数または直前の会話に貼られた JSON を入力とする。オーケストレーターは指示・検証・コミットのみを行い、config.ts の編集はサブエージェント(haiku)に委譲する。例: /apply-tuning {"WISP_SPEED_MULTIPLIER": 1.5, ...}
---

# apply-tuning: チューニング値の実装反映

デバッグパネル（`npm run dev` + `?debug`）で調整 → **EXPORT** → JSON をこの会話に貼る → 本スキルで `src/config.ts` に反映する、という運用フロー（docs/plan.md §12.4）の最終工程を担う。

## 絶対ルール（implement-plan と共通）

1. オーケストレーターは `src/` を Edit/Write しない。反映はサブエージェントに委譲する。
2. 検証（lint / typecheck / test / build）とコミットはオーケストレーターが自分で行う。
3. サブエージェントの自己申告を信用せず、diff を自分で読む。

## モデル選定

| 状況 | モデル |
|---|---|
| 通常（定数値の置き換えのみ） | **haiku** |
| マッピングが曖昧 / テストが落ちた / 構造変更が必要になった | **sonnet** に切り替えて新規エージェントで再実行 |

## 手順

### 1. 入力の確認（オーケストレーター)

- 引数または会話に貼られた JSON を取得する。JSON が見つからなければユーザーに依頼する
- `_notes` キーはマッピングの補足情報。値としては反映しない
- `STAGE` キーは EXPORT を押したときのステージ（1 始まり）。config.ts の定数ではなく、下の「ステージの実効値」がどのステージのものかを示す。値としては反映しない
- 現在の `src/config.ts` を Read し、各キーの反映先を決める:
  - **キー名がそのまま config.ts の定数名**のもの（例: `TIME_LIMIT_TICKS`, `BIG_CLAIM_SHARE`, `BIG_CLAIM_MULTIPLIER`, `NEAR_MISS_DISTANCE_CELLS`, `NEAR_MISS_BONUS`, `MISS_GRACE_TICKS`, `MISS_LINE_LOCK_TICKS`, `EMBER_FIRST_SPAWN_SEC`（ステージ 1 の最初のエンバーまでの待ち）、FX の区画の `FX_*`、SOUND の区画の `SFX_LEVEL_*` などの音量の定数）→ その定数の値を置き換え
  - **ステージの実効値**（`WISP_COUNT`, `WISP_SPEED_MULTIPLIER`, `EMBER_MOVE_TICKS`, `EMBER_SPAWN_INTERVAL_SEC`, `EMBER_BRANCH_CHASE_PROBABILITY`, `DEFAULT_REQUIRED_OCCUPANCY`）→ **同じ名前の定数へそのまま書き写さない**。これらは `STAGE` のステージで実際に使われていた値で、config.ts の同名の定数（あれば）はステージ 1 の値や基準値にすぎない（`src/config.ts` の `STAGE_TABLE` とその直後、`src/core/stage.ts` の `getStageConfig()`）。反映先は次のとおり決める:
    - ふつうは、`STAGE` のステージの `STAGE_TABLE` の行（ステージ 15 以降は最後の行）の、該当する列（`wispCount`, `wispSpeedMultiplier`, `emberMoveTicks`, `emberSpawnIntervalSec`, `requiredOccupancy`）を直す。`emberSpawnIntervalSec` を変えると、`firstEmberSec` を指定していない行では最初のエンバーまでの時間も変わる
    - `EMBER_BRANCH_CHASE_PROBABILITY` は表の列ではない。ステージ 1 の `EMBER_BRANCH_CHASE_PROBABILITY`（0.7）から `EMBER_BRANCH_CHASE_MAX_STAGE`（ステージ 4）の `EMBER_BRANCH_CHASE_PROBABILITY_MAX`（1.0）へ線形に補間した値なので、たとえばステージ 4 で書き出した `1.0` を同名の定数へ写すと、ステージ 1 の基準値まで変わってしまう。どの端の値を変えたいのかを決めてから直す
    - `WISP_SPEED_MULTIPLIER` は、EASY で書き出すと難易度の補正（`EASY_WISP_SPEED_FACTOR` の 0.7 倍）が入った値になる。EXPORT の JSON には難易度が入らない。たとえば調整していないステージ 1 でも EASY で書き出すと `0.7` になり、これを表へ写すと NORMAL が 0.7、EASY が 0.49 になってしまう。表へ写すのは NORMAL で書き出した JSON の値だけにし、EASY で書き出した値は写さない（どちらで書き出したか分からなければユーザーに確認する）。NORMAL のステージ 6 からの加速（`WISP_SURGE_*`）は、この値に含まれない
    - `WISP_COUNT` は、ステージ 15 までは `STAGE` のステージの行の `wispCount`。ステージ 16 以降は、最後の行の `wispCount` に 15 を超えたステージの数を足し、`LATE_STAGE_WISP_COUNT_MAX` で抑えた値で、表のどの行の値でもない。このときの書き戻し先（最後の行の `wispCount` か `LATE_STAGE_WISP_COUNT_MAX`）は `STAGE` だけでは決まらないので、そのまま写さず、どちらを変えたいかを決めてから直す
  - `EMBER_COUNT` は、そのとき生きていたエンバーの数。反映しない（同時数の上限は `STAGE_TABLE` の `maxConcurrentEmbers`）
  - **それ以外で対応が分からないもの** → `_notes`、今のステージの表（`src/config.ts` の `STAGE_TABLE`）、docs/plan.md §12.4 を読んで反映先を判断する。**判断に迷う場合は反映せず、ユーザーに「どの定数に反映するか」を確認する**（勝手に推測して広範囲を変えない）
  - **現在値と同じもの** → 変更不要としてスキップ
- 反映プラン（キー → 定数 → 旧値 → 新値 の表）を作ってからサブエージェントを起動する

### 2. 反映（サブエージェント・haiku）

プロンプトに必ず含める:

- 反映プランの表（キー → 定数名 → 新値）
- **src/config.ts の該当定数の値だけを変更する。**構造・コメント・他の定数・他のファイルは変更しない（コメント内に旧値の説明が書かれていて実態と食い違う場合のみ、そのコメントを新値に合わせて修正してよい）
- 完了条件: `npm run lint` / `npm run typecheck` / `npm test -- --run` / `npm run build` が green
- コミット禁止・報告形式（変更した定数の一覧: 旧値 → 新値）

### 3. 検証（オーケストレーター)

- `npm run lint && npm run typecheck && npm test -- --run && npm run build` を自分で実行
- `git diff src/config.ts` を読み、反映プランどおりか（余計な変更がないか）確認
- **テストが落ちた場合**: テストが config 定数を参照して期待値を計算している場合は正当な失敗ではないはず。定数の値をテストがハードコードしている場合はチューニング変更の正当な影響なので、**テスト側の期待値修正を sonnet エージェントに委譲**する（expect の削除・緩和ではなく、新しい値に基づく正しい期待値への更新のみ）。判断がつかなければユーザーに報告
- 可能なら dev サーバで軽く動作確認（明らかな破綻がないか）

### 4. コミット（オーケストレーター）

- メッセージ例:

  ```
  chore: チューニング値を反映（デバッグパネル EXPORT）

  - MISS_GRACE_TICKS: 60 → 48
  - STAGE_TABLE ステージ 3 の wispSpeedMultiplier: 2.4 → 2.2
  ```

- push はユーザーの指示を待つ（implement-plan と同じ運用）

## 注意

- ステージ依存パラメータ（Wisp 数・速度倍率など `STAGE_TABLE` に由来するもの）は、ステージ 15 までなら `STAGE` キーでどの行かが分かるが、上の例外（`EMBER_BRANCH_CHASE_PROBABILITY`、EASY で書き出した `WISP_SPEED_MULTIPLIER`、ステージ 16 以降の `WISP_COUNT`）や `STAGE` がない JSON では、「どの値を変えたいのか」が JSON からは分からない。**曖昧なら必ずユーザーに確認**する
- デバッグパネルの調整はステージ既定値への**オーバーライド**であり、EXPORT された値が必ずしも全部変更対象とは限らない（既定値と同じものはスキップ）
