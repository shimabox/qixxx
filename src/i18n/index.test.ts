import { afterEach, describe, expect, it } from 'vitest';
import { detectLocale, getLocale, setLocale, t, sentenceFontFamily } from './index';
import { messages } from './messages';
import { JA_TEXT_FONT_FAMILY } from '../config';

afterEach(() => setLocale('en'));

describe('detectLocale', () => {
  it('follows ?lang= first, whatever the browser languages say', () => {
    expect(detectLocale('?lang=ja', ['en-US'])).toBe('ja');
    expect(detectLocale('?lang=en', ['ja-JP'])).toBe('en');
    expect(detectLocale('?seed=1&lang=ja', [])).toBe('ja');
    expect(detectLocale('lang=ja', ['en'])).toBe('ja');
  });

  it('otherwise uses the first browser language: ja / ja-JP are Japanese, anything else English', () => {
    expect(detectLocale('', ['ja'])).toBe('ja');
    expect(detectLocale('', ['ja-JP', 'en-US'])).toBe('ja');
    expect(detectLocale('', ['en-US', 'ja-JP'])).toBe('en');
    expect(detectLocale('', [])).toBe('en');
    expect(detectLocale('?seed=3', ['fr-FR'])).toBe('en');
  });

  it('ignores a ?lang= value it does not know', () => {
    expect(detectLocale('?lang=fr', ['ja-JP'])).toBe('ja');
    expect(detectLocale('?lang=', ['en-US'])).toBe('en');
    expect(detectLocale('?lang=JA', ['en-US'])).toBe('en');
  });
});

describe('setLocale / getLocale / t', () => {
  it('is English by default', () => {
    expect(getLocale()).toBe('en');
    expect(t('title.start')).toBe('PRESS ANY KEY OR TAP TO START');
  });

  it('switches every lookup to the chosen language', () => {
    setLocale('ja');
    expect(getLocale()).toBe('ja');
    expect(t('title.start')).toBe('キーを押すかタップでスタート');
    expect(t('submit.notAcceptedWith', 'bad name')).toBe('受け付けられませんでした（bad name）');
    // Words that stay English in both languages.
    expect(t('hud.stage', 3)).toBe('STAGE 3');
    setLocale('en');
    expect(t('submit.notAcceptedWith', 'bad name')).toBe('NOT ACCEPTED (bad name).');
  });

  it('checks keys and arguments by type', () => {
    // @ts-expect-error: no such key
    expect(() => t('no.such.key')).toThrow();
    // @ts-expect-error: hud.stage takes the stage number
    t('hud.stage');
    // @ts-expect-error: title.start takes no argument
    t('title.start', 1);
    // @ts-expect-error: submit.kept takes two strings
    t('submit.kept', 1, 2);
    expect(t('hud.stage', 2)).toBe('STAGE 2');
  });

  it('gives the sentence font only in Japanese', () => {
    expect(sentenceFontFamily()).toBeNull();
    setLocale('ja');
    expect(sentenceFontFamily()).toBe(JA_TEXT_FONT_FAMILY);
  });
});

// The sentences that are Japanese in Japanese, exactly as the design lists
// them. Every other key reads the same in both languages.
const JAPANESE_SENTENCES: Record<string, string | ((...args: never[]) => string)> = {
  'title.start': 'キーを押すかタップでスタート',
  'stageClear.next': 'キーかタップで次のステージへ',
  'gameOver.hintRetry': 'キーか盤面のタップでもう一度',
  'gameOver.hintSubmission': 'SUBMIT か SKIP で続行',
  'ranking.notice':
    'X のハンドルは自己申告で、本人確認はしていません。スコアは投稿後に検査されることがあり、無効と分かった記録は削除されます。',
  'ranking.loading': '読み込み中...',
  'ranking.loadFailed': 'ランキングを読み込めませんでした',
  'ranking.empty': 'まだ記録がありません',
  'replay.unsupported': 'この記録は今のバージョンでは再生できません',
  'replay.loadFailed': 'リプレイを読み込めませんでした',
  'replay.loading': 'リプレイを読み込み中...',
  'replay.playbackFailed': 'このリプレイは再生できませんでした',
  'submit.useHandle': '名前のかわりに X のハンドルを使う',
  'submit.kept': '入力済みの {label}: {value}',
  'submit.unavailable': 'このプレイはもう投稿できません',
  'submit.needName': '名前か X のハンドルを入力してください',
  'submit.submitting': '送信中...',
  'submit.accepted': '投稿しました',
  'submit.acceptedPending': '投稿しました（検証待ち）',
  'submit.notInContention': 'いまはトップ 10 に届かないため、保存されませんでした',
  'submit.queueFull': '検証待ちがいっぱいです。少し待ってから、もう一度送信してください',
  'submit.rateLimited': 'この 1 時間の投稿が上限に達しました。時間をおいて、もう一度送信してください',
  'submit.notAccepted': '受け付けられませんでした',
  'submit.notAcceptedWith': '受け付けられませんでした（{error}）',
  'submit.failed': '送信に失敗しました。もう一度試せます',
  'submit.tooManyClaims': '確定の回数が多すぎて検証できません（{claims} > {max}）。このプレイはランキングに載せられません',
  'miss.wisp': 'ウィスプが線に触れた',
  'miss.ember': 'エンバーにぶつかった',
  'miss.blaze': 'ブレイズにぶつかった',
  'miss.igniter': '立ち止まりすぎた',
  'hint.draw.key': 'Space を押しながら矢印キーで線を引こう',
  'hint.draw.touch': 'FAST を押しながら方向ボタンで線を引こう',
  'hint.claimSide': '敵のいない側が自分の陣地になる',
  'hint.slow.key': 'Z を押したまま最後まで引くと点が 2 倍',
  'hint.slow.touch': 'SLOW だけで最後まで引くと点が 2 倍',
  'hint.split': 'ウィスプを線で切り分けると一発クリア',
  'hint.ember': 'エンバー: 枠の上を回ってくる',
  'hint.blaze': 'ブレイズ: 引いている線の上まで登ってくる',
  'hint.igniter': 'イグナイター: 線の途中で止まると追ってくる',
  'howTo.draw.key': 'Space を押しながら動くと線が引ける',
  'howTo.draw.touch': 'FAST を押しながら動くと線が引ける',
  'howTo.close': '線を枠までつなぐと陣地になる',
  'howTo.side': '敵のいない側が自分の陣地',
  'howTo.split': 'ウィスプを切り分けると一発クリア',
  'howTo.goal': '目標の % まで囲むとクリア。1 プレイは 3 分',
  'howTo.pause.key': 'P か Esc キーで一時停止',
  'howTo.pause.touch': 'PAUSE を押すと一時停止',
  'pause.hint.key': 'P か Esc キーで再開',
  'pause.hint.touch': 'RESUME を押すと再開',
};

// Placeholder arguments for the keys that take them: each `{name}` of the
// design's table is filled with its own name, so the template reads back.
const TEMPLATE_ARGS: Record<string, unknown[]> = {
  'submit.kept': ['{label}', '{value}'],
  'submit.notAcceptedWith': ['{error}'],
  'submit.tooManyClaims': ['{claims}', '{max}'],
};

// Sample arguments for every other key that takes some.
function sampleArgs(fn: (...args: never[]) => string): unknown[] {
  return Array.from({ length: fn.length }, (_, i) => i + 7);
}

type AnyText = string | ((...args: unknown[]) => string);

function render(value: AnyText, args: unknown[]): string {
  return typeof value === 'function' ? value(...args) : value;
}

describe('messages', () => {
  const entries = Object.entries(messages) as Array<[string, { en: AnyText; ja: AnyText }]>;

  it('has an English and a Japanese text for every key, neither empty, both strings for the same arguments', () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const [key, entry] of entries) {
      expect(typeof entry.en, key).toBe(typeof entry.ja);
      const args = TEMPLATE_ARGS[key] ?? (typeof entry.en === 'function' ? sampleArgs(entry.en) : []);
      for (const value of [entry.en, entry.ja]) {
        const text = render(value, args);
        expect(typeof text, key).toBe('string');
        expect(text.length, key).toBeGreaterThan(0);
      }
    }
  });

  it('has exactly the listed sentences in Japanese, every other key the same as English', () => {
    for (const key of Object.keys(JAPANESE_SENTENCES)) expect(Object.keys(messages), key).toContain(key);
    for (const [key, entry] of entries) {
      const args = TEMPLATE_ARGS[key] ?? (typeof entry.en === 'function' ? sampleArgs(entry.en) : []);
      const ja = render(entry.ja, args);
      if (key in JAPANESE_SENTENCES) {
        expect(ja, key).toBe(JAPANESE_SENTENCES[key]);
        expect(ja, key).not.toBe(render(entry.en, args));
      } else {
        expect(ja, key).toBe(render(entry.en, args));
      }
    }
  });

  it('keeps the English sentences as they were', () => {
    expect(t('ranking.notice')).toBe(
      'X handles are self-reported — ownership is not verified. Scores may be checked after posting, and entries found invalid may be removed.'
    );
    expect(t('submit.kept', 'NAME', 'abc')).toBe('NAME KEPT: abc');
    expect(t('submit.tooManyClaims', 5, 4)).toBe('TOO MANY AREA CLAIMS TO VERIFY (5 > 4) — THIS RUN CANNOT BE RANKED.');
    expect(t('miss.wisp')).toBe('WISP HIT YOUR LINE');
    expect(t('miss.ember')).toBe('EMBER HIT YOU');
    expect(t('miss.blaze')).toBe('BLAZE HIT YOU');
    expect(t('miss.igniter')).toBe('STOPPED TOO LONG');
  });

  it('has the hints and HOW TO PLAY sentences in English as designed', () => {
    const english: Record<string, string> = {
      'hint.draw.key': 'HOLD SPACE + ARROW KEYS TO DRAW A LINE',
      'hint.draw.touch': 'HOLD FAST + A DIRECTION TO DRAW A LINE',
      'hint.claimSide': 'THE SIDE WITHOUT ENEMIES BECOMES YOURS',
      'hint.slow.key': 'DRAW THE WHOLE LINE WITH Z FOR DOUBLE POINTS',
      'hint.slow.touch': 'DRAW THE WHOLE LINE WITH SLOW FOR DOUBLE POINTS',
      'hint.split': 'SPLIT THE WISPS WITH A LINE TO CLEAR AT ONCE',
      'hint.ember': 'EMBER: PATROLS THE BORDER',
      'hint.blaze': 'BLAZE: CLIMBS ONTO YOUR LINE',
      'hint.igniter': 'IGNITER: CHASES YOU WHEN YOU STOP ON A LINE',
      'howTo.draw.key': 'HOLD SPACE AND MOVE TO DRAW A LINE',
      'howTo.draw.touch': 'HOLD FAST AND MOVE TO DRAW A LINE',
      'howTo.close': 'REACH THE BORDER AGAIN TO CLAIM THE AREA',
      'howTo.side': 'YOU GET THE SIDE WITHOUT ENEMIES',
      'howTo.split': 'SPLIT THE WISPS TO CLEAR AT ONCE',
      'howTo.goal': 'FILL UP TO THE GOAL % TO CLEAR. ONE RUN IS 3 MINUTES',
      'howTo.pause.key': 'PRESS P OR ESC TO PAUSE',
      'howTo.pause.touch': 'TAP PAUSE TO PAUSE',
    };
    for (const [key, text] of Object.entries(english)) {
      expect((messages as Record<string, { en: unknown }>)[key]?.en, key).toBe(text);
    }
    // The button and the heading stay English.
    setLocale('ja');
    expect(t('howTo.button')).toBe('HOW TO PLAY');
    expect(t('howTo.heading')).toBe('HOW TO PLAY');
    expect(t('howTo.closeButton')).toBe('CLOSE');
    expect(t('howTo.playWithHints')).toBe('PLAY WITH HINTS');
  });

  it('has the pause and the sound toggle as designed', () => {
    expect(messages['pause.hint.key'].en).toBe('PRESS P OR ESC TO RESUME');
    expect(messages['pause.hint.touch'].en).toBe('TAP RESUME TO CONTINUE');
    // The heading and the buttons stay English.
    setLocale('ja');
    expect(t('pause.title')).toBe('PAUSED');
    expect(t('pause.resume')).toBe('RESUME');
    expect(t('pause.button')).toBe('PAUSE');
    expect(t('sound.off')).toBe('SOUND: OFF');
    expect(t('sound.on')).toBe('SOUND: ON');
  });
});
