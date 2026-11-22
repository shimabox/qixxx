// Every piece of text the game puts on screen, in English and Japanese.
//
// Only sentences — directions, notices, status and error lines — read
// differently in Japanese (`tr(en, ja)`). The HUD, headings, result labels,
// buttons and the effects' words stay English in both languages
// (`same(en)`): the HUD's width budget is counted in English characters, the
// clear screen's rows line up in a monospace face and the effects are drawn
// in the bundled Latin display face, so those keep their shape whatever the
// device's Japanese fonts look like.
//
// A value is a string, or a function of the values it shows. Both languages
// of one key take the same arguments.

type Text = string | ((...args: never[]) => string);

export interface Message<T extends Text> {
  en: T;
  ja: T;
}

/** Text that reads the same in both languages. */
function same<T extends Text>(en: T): Message<T> {
  return { en, ja: en };
}

/** A sentence with its own Japanese. */
function tr<T extends Text>(en: T, ja: T): Message<T> {
  return { en, ja };
}

export const messages = {
  // --- Title -----------------------------------------------------------------
  'title.heading': same('QIXXX'),
  'title.hiScore': same((hiScore: number) => `HI SCORE: ${hiScore}`),
  'title.start': tr('PRESS ANY KEY OR TAP TO START', 'キーを押すかタップでスタート'),
  // The tag over the Title screen's demo playback: a label, English on both pages.
  'titleDemo.label': same('DEMO'),
  // The sound toggle (#mute-button) reads the current state: a button, so
  // English on both pages.
  'sound.off': same('SOUND: OFF'),
  'sound.on': same('SOUND: ON'),
  // The EASY tag on the HUD and the GAME OVER screen: a label, English on
  // both pages.
  'difficulty.easy': same('EASY'),

  // --- Pause -----------------------------------------------------------------
  'pause.title': same('PAUSED'),
  'pause.resume': same('RESUME'),
  'pause.button': same('PAUSE'),
  // `.key` reads for a keyboard, `.touch` for the on-screen buttons.
  'pause.hint.key': tr('PRESS P OR ESC TO RESUME', 'P か Esc キーで再開'),
  'pause.hint.touch': tr('TAP RESUME TO CONTINUE', 'RESUME を押すと再開'),

  // --- HUD -------------------------------------------------------------------
  'hud.stage': same((stage: number) => `STAGE ${stage}`),
  'hud.score': same('SCORE'),
  'hud.hi': same((hiScore: number) => `HI ${hiScore}`),
  'hud.time': same((time: string) => `TIME ${time}`),
  'hud.occupancy': same((current: number, goal: number, left: number) => `${current}%/${goal}% ${left}% LEFT`),
  'hud.multiplier': same((multiplier: number) => `x${multiplier}`),
  'hud.seed': same((seed: number | undefined) => `SEED ${seed}`),
  'goal.toBest': same((points: number) => `TO BEST ${points}`),
  'goal.newBest': same('NEW BEST!'),
  'goal.toRank': same((rank: number, points: number) => `TO #${rank} ${points}`),
  'goal.top': same((size: number) => `TOP ${size}!`),

  // --- STAGE CLEAR -----------------------------------------------------------
  'stageClear.heading': same((stage: number) => `STAGE ${stage} CLEAR!`),
  'stageClear.splitNote': same('(SPLIT CLEAR!)'),
  'stageClear.next': tr('PRESS ANY KEY OR TAP FOR NEXT STAGE', 'キーかタップで次のステージへ'),
  'stageResult.area': same('AREA'),
  'stageResult.bonus': same('BONUS'),
  'stageResult.total': same('TOTAL'),
  'stageResult.next': same('NEXT'),

  // --- GAME OVER -------------------------------------------------------------
  'gameOver.heading': same('GAME OVER'),
  'gameOver.timeUp': same('TIME UP!'),
  'gameOver.newRecord': same((points: number) => `NEW RECORD +${points}`),
  'gameOver.score': same((score: number) => `SCORE: ${score}`),
  'gameOver.stage': same((stage: number) => `STAGE: ${stage}`),
  'gameOver.hiScore': same((hiScore: number) => `HI SCORE: ${hiScore}`),
  // The run's one highlight under the score, and how far the run fell short
  // of the best it started from: English in both languages, like SCORE:.
  'gameOver.highlight.split': same((splits: number) => `SPLIT ×${splits}`),
  'gameOver.highlight.bestClaim': same((percent: number) => `BEST CLAIM ${percent}%`),
  'gameOver.highlight.stage': same((stage: number) => `REACHED STAGE ${stage}`),
  'gameOver.toBest': same((points: number) => `${points} TO HI SCORE`),
  'gameOver.retry': same('RETRY'),
  'gameOver.title': same('TITLE'),
  'gameOver.share': same('POST TO X'),
  'gameOver.sharing': same('POSTING...'),
  'gameOver.shareFailed': same('FAILED - RETRY'),
  'gameOver.hintRetry': tr('PRESS ANY KEY OR TAP FIELD TO RETRY', 'キーか盤面のタップでもう一度'),
  'gameOver.hintSubmission': tr('POST OR SKIP TO CONTINUE', 'SUBMIT か SKIP で続行'),

  // --- Ranking list ----------------------------------------------------------
  'ranking.button': same('RANKING'),
  'ranking.heading': same('RANKING'),
  'ranking.close': same('CLOSE'),
  'ranking.replay': same('REPLAY'),
  'ranking.ok': same('OK'),
  'ranking.row': same((rank: number, score: number, stage: number) => `#${rank}  ${score}  STAGE ${stage}  `),
  'ranking.notice': tr(
    'X handles are self-reported — ownership is not verified. Scores may be checked after posting, and entries found invalid may be removed.',
    'X のハンドルは自己申告で、本人確認はしていません。スコアは投稿後に検査されることがあり、無効と分かった記録は削除されます。'
  ),
  'ranking.loading': tr('LOADING...', '読み込み中...'),
  'ranking.loadFailed': tr('FAILED TO LOAD RANKING', 'ランキングを読み込めませんでした'),
  'ranking.empty': tr('NO ENTRIES YET', 'まだ記録がありません'),

  // --- Replay ----------------------------------------------------------------
  'replay.unsupported': tr('THIS RECORD CANNOT BE REPLAYED ON THE CURRENT VERSION.', 'この記録は今のバージョンでは再生できません'),
  'replay.loadFailed': tr('FAILED TO LOAD REPLAY.', 'リプレイを読み込めませんでした'),
  'replay.loading': tr('LOADING REPLAY...', 'リプレイを読み込み中...'),
  'replay.playbackFailed': tr('THIS REPLAY COULD NOT BE PLAYED BACK.', 'このリプレイは再生できませんでした'),
  'replay.label': same('REPLAY'),
  'replay.skipToFinal': same('SKIP TO FINAL STAGE'),
  'replay.skipping': same('SKIPPING...'),
  'replay.exit': same('EXIT'),
  'replay.counter': same((stage: number, finalStage: number) => `STAGE ${stage} / ${finalStage}`),
  'replay.status': same((counter: string) => `REPLAY - ${counter}`),
  'replay.statusFinal': same((counter: string) => `REPLAY - ${counter} (FINAL STAGE)`),
  'replay.statusEnd': same((counter: string) => `REPLAY END - ${counter}`),
  'replay.statusEndGameOver': same((counter: string) => `REPLAY END - ${counter} (GAME OVER HERE)`),
  'replay.endHeading': same('GAME OVER - REPLAY END'),
  'replay.endScore': same((score: number) => `SCORE ${score}`),
  'replay.endStage': same((stage: number, finalStage: number) => `STAGE ${stage} / ${finalStage} (FINAL STAGE)`),

  // --- Ranking submission ----------------------------------------------------
  'submit.heading': same('YOU MADE THE TOP 10!'),
  'submit.namePlaceholder': same('NAME'),
  'submit.handlePlaceholder': same('@handle'),
  'submit.nameLabel': same('NAME'),
  'submit.handleLabel': same('X HANDLE'),
  'submit.skip': same('SKIP'),
  'submit.submit': same('SUBMIT'),
  'submit.ok': same('OK'),
  'submit.retry': same('RETRY'),
  'submit.title': same('TITLE'),
  'submit.useHandle': tr('USE X HANDLE INSTEAD', '名前のかわりに X のハンドルを使う'),
  'submit.kept': tr(
    (label: string, value: string) => `${label} KEPT: ${value}`,
    (label: string, value: string) => `入力済みの ${label}: ${value}`
  ),
  'submit.unavailable': tr('THIS RUN IS NO LONGER AVAILABLE TO SUBMIT.', 'このプレイはもう投稿できません'),
  'submit.needName': tr('ENTER A NAME OR X HANDLE.', '名前か X のハンドルを入力してください'),
  'submit.submitting': tr('SUBMITTING...', '送信中...'),
  'submit.accepted': tr('SUBMITTED.', '投稿しました'),
  'submit.acceptedPending': tr('SUBMITTED — PENDING VERIFICATION.', '投稿しました（検証待ち）'),
  'submit.notInContention': tr(
    'NOT CURRENTLY IN CONTENTION FOR THE TOP 10 — NOT SAVED.',
    'いまはトップ 10 に届かないため、保存されませんでした'
  ),
  'submit.queueFull': tr(
    'VERIFICATION QUEUE IS FULL RIGHT NOW — WAIT A MOMENT, THEN SUBMIT AGAIN.',
    '検証待ちがいっぱいです。少し待ってから、もう一度送信してください'
  ),
  'submit.rateLimited': tr(
    'TOO MANY SUBMISSIONS THIS HOUR — WAIT FOR THE RATE LIMIT TO RESET, THEN SUBMIT AGAIN.',
    'この 1 時間の投稿が上限に達しました。時間をおいて、もう一度送信してください'
  ),
  'submit.notAccepted': tr('NOT ACCEPTED.', '受け付けられませんでした'),
  // `error` is the server's own (English) reason, shown as it came.
  'submit.notAcceptedWith': tr(
    (error: string) => `NOT ACCEPTED (${error}).`,
    (error: string) => `受け付けられませんでした（${error}）`
  ),
  'submit.failed': tr('SUBMIT FAILED — YOU CAN TRY AGAIN.', '送信に失敗しました。もう一度試せます'),
  'submit.tooManyClaims': tr(
    (claims: number, max: number) => `TOO MANY AREA CLAIMS TO VERIFY (${claims} > ${max}) — THIS RUN CANNOT BE RANKED.`,
    (claims: number, max: number) => `確定の回数が多すぎて検証できません（${claims} > ${max}）。このプレイはランキングに載せられません`
  ),

  // --- Effects ---------------------------------------------------------------
  'fx.split': same('SPLIT!'),
  'fx.praiseNice': same('NICE!'),
  'fx.praiseGreat': same('GREAT!'),
  'fx.praiseAwesome': same('AWESOME!'),
  'fx.chain': same((chain: number) => `CHAIN x${chain}`),
  'fx.score': same((points: number) => `+${points}`),
  'fx.slowNote': same('x2'),
  'fx.bigClaim': same('BIG CLAIM'),
  'fx.closeCall': same((points: number) => `CLOSE CALL +${points}`),
  // The stage's title when it starts: STAGE n in the effects' face on both
  // pages, then the stage's name — a name, so it has its own Japanese.
  'fx.stageHeading': same((stage: number) => `STAGE ${stage}`),
  'stageTitle.warmUp': tr('WARM-UP', 'はじまり'),
  'stageTitle.fastPair': tr('FAST PAIR', '速い 2 匹'),
  'stageTitle.trio': tr('TRIO', '3 匹'),
  'stageTitle.slowSwarm': tr('SLOW SWARM', '遅い群れ'),
  'stageTitle.emberRush': tr('EMBER RUSH', 'エンバーの群れ'),
  'stageTitle.breather': tr('BREATHER', '息抜き'),
  'stageTitle.quartet': tr('QUARTET', '4 匹'),
  'stageTitle.fastFour': tr('FAST FOUR', '速い 4 匹'),
  'stageTitle.quintet': tr('QUINTET', '5 匹'),
  'stageTitle.fastFive': tr('FAST FIVE', '速い 5 匹'),
  'stageTitle.bigSwarm': tr('BIG SWARM', '大きな群れ'),
  'stageTitle.emberStorm': tr('EMBER STORM', 'エンバーの嵐'),
  'stageTitle.sextet': tr('SEXTET', '6 匹'),
  'stageTitle.fastSix': tr('FAST SIX', '速い 6 匹'),
  'stageTitle.final': tr('FINAL', '最終'),

  // --- Miss reasons ----------------------------------------------------------
  'miss.wisp': tr('WISP HIT YOUR LINE', 'ウィスプが線に触れた'),
  'miss.ember': tr('EMBER HIT YOU', 'エンバーにぶつかった'),
  'miss.blaze': tr('BLAZE HIT YOU', 'ブレイズにぶつかった'),
  'miss.igniter': tr('STOPPED TOO LONG', '立ち止まりすぎた'),

  // --- In-play hints ---------------------------------------------------------
  // `.key` reads for a keyboard, `.touch` for the on-screen buttons.
  'hint.draw.key': tr('HOLD SPACE + ARROW KEYS TO DRAW A LINE', 'Space を押しながら矢印キーで線を引こう'),
  'hint.draw.touch': tr('HOLD FAST + A DIRECTION TO DRAW A LINE', 'FAST を押しながら方向ボタンで線を引こう'),
  'hint.claimSide': tr('THE SIDE WITHOUT ENEMIES BECOMES YOURS', '敵のいない側が自分の陣地になる'),
  'hint.slow.key': tr('DRAW THE WHOLE LINE WITH SHIFT FOR DOUBLE POINTS', 'Shift を押したまま最後まで引くと点が 2 倍'),
  'hint.slow.touch': tr('DRAW THE WHOLE LINE WITH SLOW FOR DOUBLE POINTS', 'SLOW だけで最後まで引くと点が 2 倍'),
  'hint.split': tr('SPLIT THE WISPS WITH A LINE TO CLEAR AT ONCE', 'ウィスプを線で切り分けると一発クリア'),
  'hint.ember': tr('EMBER: PATROLS THE BORDER', 'エンバー: 枠の上を回ってくる'),
  'hint.blaze': tr('BLAZE: CLIMBS ONTO YOUR LINE', 'ブレイズ: 引いている線の上まで登ってくる'),
  'hint.igniter': tr('IGNITER: CHASES YOU WHEN YOU STOP ON A LINE', 'イグナイター: 線の途中で止まると追ってくる'),

  // --- HOW TO PLAY -----------------------------------------------------------
  'howTo.button': same('HOW TO PLAY'),
  'howTo.heading': same('HOW TO PLAY'),
  'howTo.closeButton': same('CLOSE'),
  'howTo.playWithHints': same('PLAY WITH HINTS'),
  'howTo.draw.key': tr('HOLD SPACE AND MOVE TO DRAW A LINE', 'Space を押しながら動くと線が引ける'),
  'howTo.draw.touch': tr('HOLD FAST AND MOVE TO DRAW A LINE', 'FAST を押しながら動くと線が引ける'),
  'howTo.close': tr('REACH THE BORDER AGAIN TO CLAIM THE AREA', '線を枠までつなぐと陣地になる'),
  'howTo.side': tr('YOU GET THE SIDE WITHOUT ENEMIES', '敵のいない側が自分の陣地'),
  'howTo.split': tr('SPLIT THE WISPS TO CLEAR AT ONCE', 'ウィスプを切り分けると一発クリア'),
  'howTo.goal': tr('FILL UP TO THE GOAL % TO CLEAR. ONE RUN IS 3 MINUTES', '目標の % まで囲むとクリア。1 プレイは 3 分'),
  'howTo.pause.key': tr('PRESS P OR ESC TO PAUSE', 'P か Esc キーで一時停止'),
  'howTo.pause.touch': tr('TAP PAUSE TO PAUSE', 'PAUSE を押すと一時停止'),
  'howTo.clearMark': same('CLEAR!'),

  // --- Touch controls --------------------------------------------------------
  'touch.slow': same('SLOW'),
  'touch.fast': same('FAST'),
} satisfies Record<string, Message<Text>>;

export type Messages = typeof messages;
export type MessageKey = keyof Messages;
