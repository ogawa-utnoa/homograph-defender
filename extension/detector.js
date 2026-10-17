/*
 * Homograph Defender — 文字の判定(service worker・content script・popup・テストで共通)
 *
 * 安全とみなすのはホスト名の標準文字 a-z / A-Z / 0-9 / ハイフン / ドット だけ。
 * それ以外は1文字でも「怪しい文字」として、文字体系・種類・コードポイント・似ている英字を調べる。
 * xn-- のラベルは必ず解読してから1文字ずつ調べ、解読→再変換・ブラウザの変換とも突き合わせる。
 * 判定はすべてこのファイルの中で完結し、外部への通信はしない。
 */
(function (root) {
  'use strict';

  const P = root.HDPunycode || (typeof require === 'function' ? require('./punycode.js') : null);
  if (!P) throw new Error('HDPunycode が読み込まれていません');

  // 古いエンジンで未対応のプロパティがあっても全体が止まらないよう、1つずつ作る
  const re = (src, flags) => {
    try {
      return new RegExp(src, flags || 'u');
    } catch (e) {
      return null;
    }
  };
  const has = (r, ch) => !!r && r.test(ch);

  const RE = {
    bidi: re('^\\p{Bidi_Control}$'),
    variation: re('^\\p{Variation_Selector}$'),
    ignorable: re('^\\p{Default_Ignorable_Code_Point}$'),
    format: re('^\\p{Cf}$'),
    space: re('^[\\p{Zs}\\p{Zl}\\p{Zp}]$'),
    control: re('^\\p{Cc}$'),
    surrogate: re('^\\p{Cs}$'),
    privateUse: re('^\\p{Co}$'),
    noncharacter: re('^\\p{Noncharacter_Code_Point}$'),
    unassigned: re('^\\p{Cn}$'),
    mark: re('^\\p{M}$'),
    letter: re('^\\p{L}$'),
    letterOrNumber: re('^[\\p{L}\\p{N}]$'),
    dash: re('^\\p{Dash}$'),
    punctOrSymbol: re('^[\\p{P}\\p{S}]$'),
    common: re('^\\p{Script=Common}$'),
    inherited: re('^\\p{Script=Inherited}$'),
    marks: re('\\p{M}', 'gu'),
  };

  // 文字体系(Unicode の Script)。上から順に調べる
  const SCRIPTS = [
    ['Latin', 'ラテン文字'], ['Greek', 'ギリシャ文字'], ['Cyrillic', 'キリル文字'], ['Armenian', 'アルメニア文字'],
    ['Hebrew', 'ヘブライ文字'], ['Arabic', 'アラビア文字'], ['Syriac', 'シリア文字'], ['Thaana', 'ターナ文字'],
    ['Nko', 'ンコ文字'], ['Samaritan', 'サマリア文字'], ['Mandaic', 'マンダ文字'],
    ['Devanagari', 'デーヴァナーガリー文字'], ['Bengali', 'ベンガル文字'], ['Gurmukhi', 'グルムキー文字'],
    ['Gujarati', 'グジャラート文字'], ['Oriya', 'オリヤー文字'], ['Tamil', 'タミル文字'], ['Telugu', 'テルグ文字'],
    ['Kannada', 'カンナダ文字'], ['Malayalam', 'マラヤーラム文字'], ['Sinhala', 'シンハラ文字'],
    ['Thai', 'タイ文字'], ['Lao', 'ラオ文字'], ['Tibetan', 'チベット文字'], ['Myanmar', 'ミャンマー文字'],
    ['Georgian', 'ジョージア文字'], ['Hangul', 'ハングル'], ['Ethiopic', 'エチオピア文字'], ['Cherokee', 'チェロキー文字'],
    ['Canadian_Aboriginal', 'カナダ先住民音節文字'], ['Ogham', 'オガム文字'], ['Runic', 'ルーン文字'],
    ['Tagalog', 'タガログ文字'], ['Khmer', 'クメール文字'], ['Mongolian', 'モンゴル文字'], ['Limbu', 'リンブ文字'],
    ['Tai_Le', 'タイ・レ文字'], ['Buginese', 'ブギス文字'], ['Balinese', 'バリ文字'], ['Sundanese', 'スンダ文字'],
    ['Lepcha', 'レプチャ文字'], ['Ol_Chiki', 'オルチキ文字'], ['Vai', 'ヴァイ文字'], ['Bamum', 'バムン文字'],
    ['Lisu', 'リス文字'], ['Javanese', 'ジャワ文字'], ['Cham', 'チャム文字'], ['Tai_Viet', 'タイ・ヴィエト文字'],
    ['Meetei_Mayek', 'メイテイ文字'], ['Hiragana', 'ひらがな'], ['Katakana', 'カタカナ'], ['Bopomofo', '注音字母'],
    ['Han', '漢字'], ['Yi', 'イ文字'], ['Coptic', 'コプト文字'], ['Glagolitic', 'グラゴル文字'], ['Tifinagh', 'ティフィナグ文字'],
    ['Gothic', 'ゴート文字'], ['Old_Italic', '古イタリア文字'], ['Deseret', 'デザレット文字'], ['Osage', 'オセージ文字'],
    ['Adlam', 'アドラム文字'], ['Braille', '点字'],
  ];
  const SCRIPT_RES = SCRIPTS.map(([name]) => ({ name, re: re('^\\p{Script=' + name + '}$') })).filter((s) => s.re);
  const SCRIPT_JA = new Map(SCRIPTS);
  SCRIPT_JA.set('Common', '共通文字');
  SCRIPT_JA.set('Inherited', '継承文字');
  SCRIPT_JA.set('Unknown', '不明');

  const CATEGORY = {
    ascii: ['標準の英数字', 'ASCII'],
    asciiSymbol: ['ASCII記号(ホスト名では標準外)', 'ASCII Symbol'],
    bidi: ['双方向テキスト制御文字', 'Bidi Control'],
    variation: ['異体字セレクタ', 'Variation Selector'],
    tag: ['タグ文字', 'Tag'],
    control: ['制御文字', 'Control'],
    invisible: ['不可視文字', 'Invisible / Format'],
    space: ['特殊スペース', 'Space Separator'],
    surrogate: ['不正なサロゲート', 'Lone Surrogate'],
    privateUse: ['私用領域の文字', 'Private Use'],
    noncharacter: ['非文字', 'Noncharacter'],
    unassigned: ['未割り当ての文字', 'Unassigned'],
    combining: ['結合文字', 'Combining Mark'],
    math: ['数学用英数字記号', 'Mathematical Alphanumeric'],
    letterlike: ['文字様記号', 'Letterlike Symbol'],
    fullwidth: ['全角・半角形', 'Halfwidth / Fullwidth Form'],
    enclosed: ['囲み英数字', 'Enclosed Alphanumeric'],
    modifier: ['上付き・下付き・修飾文字', 'Superscript / Subscript / Modifier'],
    numberForm: ['数字の形(ローマ数字など)', 'Number Form'],
    ligature: ['合字', 'Ligature'],
    punctLookalike: ['区切り記号に似た文字', 'Lookalike Punctuation'],
    symbol: ['記号', 'Symbol / Punctuation'],
    other: ['その他', 'Other'],
  };

  // 画面では見えないので [不可視: U+200B] のように置き換えて見せる種類
  const PLACEHOLDER = {
    bidi: '双方向制御',
    variation: '不可視',
    tag: '不可視',
    invisible: '不可視',
    space: '空白',
    control: '制御',
    surrogate: '不正',
    privateUse: '私用',
    noncharacter: '非文字',
    unassigned: '未割当',
  };
  const HIDDEN = new Set(['bidi', 'variation', 'tag', 'invisible', 'space', 'control']);

  // 正しい国際化ドメイン名には現れない(IDNA で禁止・変換される)ので、見つけたら危険度「高」にする種類
  const DANGER_CATEGORIES = new Set([
    'bidi', 'variation', 'tag', 'control', 'invisible', 'space', 'surrogate', 'privateUse', 'noncharacter',
    'unassigned', 'math', 'letterlike', 'fullwidth', 'enclosed', 'modifier', 'numberForm', 'ligature', 'punctLookalike',
  ]);

  const RANGES = {
    math: [[0x1d400, 0x1d7ff]],
    letterlike: [[0x2100, 0x214f]],
    fullwidth: [[0xff00, 0xffef]],
    enclosed: [[0x2460, 0x24ff], [0x2776, 0x2793], [0x3200, 0x32ff], [0x1f100, 0x1f1ff]],
    modifier: [[0x00aa, 0x00aa], [0x00b2, 0x00b3], [0x00b9, 0x00ba], [0x02b0, 0x02ff], [0x1d2c, 0x1d6a], [0x1d9b, 0x1dbf], [0x2070, 0x209f], [0x2c7c, 0x2c7d], [0xa700, 0xa721]],
    numberForm: [[0x2150, 0x218f]],
    ligature: [[0xfb00, 0xfb4f]],
  };
  const RANGE_ORDER = ['math', 'letterlike', 'fullwidth', 'enclosed', 'modifier', 'numberForm', 'ligature'];
  const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

  // 見た目は空白だが Default_Ignorable に入っていない文字
  const EXTRA_INVISIBLE = new Set([0x2800]);

  // 英字・数字・区切り記号に見える文字(Unicode の confusables から、ドメインの偽装でよく使われるものを抜粋)
  const CONFUSABLES = new Map([
    // キリル文字
    [0x0430, 'a'], [0x0435, 'e'], [0x043e, 'o'], [0x0440, 'p'], [0x0441, 'c'], [0x0443, 'y'], [0x0445, 'x'],
    [0x0455, 's'], [0x0456, 'i'], [0x0458, 'j'], [0x04bb, 'h'], [0x0501, 'd'], [0x051b, 'q'], [0x051d, 'w'],
    [0x04cf, 'l'], [0x04af, 'y'], [0x0475, 'v'], [0x0433, 'r'],
    // ギリシャ文字
    [0x03b1, 'a'], [0x03bf, 'o'], [0x03bd, 'v'], [0x03c1, 'p'], [0x03b9, 'i'], [0x03ba, 'k'], [0x03c5, 'u'],
    [0x03b3, 'y'], [0x03b7, 'n'], [0x03f2, 'c'], [0x03f3, 'j'], [0x03c9, 'w'],
    // アルメニア文字
    [0x0585, 'o'], [0x057d, 'u'], [0x0581, 'g'], [0x0570, 'h'], [0x0578, 'n'], [0x0566, 'q'],
    // ラテン文字の拡張・IPA・小型大文字
    [0x0131, 'i'], [0x0237, 'j'], [0x0251, 'a'], [0x0261, 'g'], [0x0269, 'i'], [0x026a, 'i'], [0x01c0, 'l'],
    [0x017f, 'f'], [0x1d00, 'a'], [0x1d04, 'c'], [0x1d0f, 'o'], [0x1d1c, 'u'], [0x1d20, 'v'], [0x1d21, 'w'], [0x1d22, 'z'],
    // ハイフンに見える文字
    [0x2010, '-'], [0x2011, '-'], [0x2012, '-'], [0x2013, '-'], [0x2014, '-'], [0x2015, '-'], [0x2212, '-'],
    [0x02d7, '-'], [0x2043, '-'], [0xfe58, '-'], [0xfe63, '-'], [0xff0d, '-'],
    // ドットに見える文字
    [0x2024, '.'], [0x3002, '.'], [0xff0e, '.'], [0xff61, '.'], [0x00b7, '.'], [0x30fb, '.'], [0x0701, '.'],
    [0x0702, '.'], [0xa4f8, '.'], [0x0660, '.'], [0x06f0, '.'], [0x2219, '.'], [0x22c5, '.'],
    // スラッシュに見える文字(「google.com∕login.example」のようにパスへ見せかける)
    [0x2215, '/'], [0x2044, '/'], [0xff0f, '/'], [0x29f8, '/'], [0x2571, '/'], [0x3033, '/'],
  ]);
  const LOOKALIKE_PUNCT = new Set([...CONFUSABLES].filter(([, v]) => /^[.\-/]$/.test(v)).map(([k]) => k));

  const KNOWN_NAMES = new Map([
    [0x00a0, 'NO-BREAK SPACE(改行しないスペース)'],
    [0x00ad, 'SOFT HYPHEN(ソフトハイフン)'],
    [0x034f, 'COMBINING GRAPHEME JOINER'],
    [0x061c, 'ARABIC LETTER MARK'],
    [0x115f, 'HANGUL CHOSEONG FILLER(ハングルの空白)'],
    [0x1160, 'HANGUL JUNGSEONG FILLER(ハングルの空白)'],
    [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
    [0x2000, 'EN QUAD'], [0x2001, 'EM QUAD'], [0x2002, 'EN SPACE'], [0x2003, 'EM SPACE'],
    [0x2004, 'THREE-PER-EM SPACE'], [0x2005, 'FOUR-PER-EM SPACE'], [0x2006, 'SIX-PER-EM SPACE'],
    [0x2007, 'FIGURE SPACE'], [0x2008, 'PUNCTUATION SPACE'], [0x2009, 'THIN SPACE'], [0x200a, 'HAIR SPACE'],
    [0x200b, 'ZERO WIDTH SPACE(ゼロ幅スペース)'],
    [0x200c, 'ZERO WIDTH NON-JOINER(ゼロ幅非接合子)'],
    [0x200d, 'ZERO WIDTH JOINER(ゼロ幅接合子)'],
    [0x200e, 'LEFT-TO-RIGHT MARK'],
    [0x200f, 'RIGHT-TO-LEFT MARK'],
    [0x2028, 'LINE SEPARATOR'],
    [0x2029, 'PARAGRAPH SEPARATOR'],
    [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
    [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
    [0x202c, 'POP DIRECTIONAL FORMATTING'],
    [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
    [0x202e, 'RIGHT-TO-LEFT OVERRIDE(以降の文字の並びを左右反転)'],
    [0x202f, 'NARROW NO-BREAK SPACE'],
    [0x205f, 'MEDIUM MATHEMATICAL SPACE'],
    [0x2060, 'WORD JOINER'],
    [0x2061, 'FUNCTION APPLICATION'], [0x2062, 'INVISIBLE TIMES'], [0x2063, 'INVISIBLE SEPARATOR'], [0x2064, 'INVISIBLE PLUS'],
    [0x2066, 'LEFT-TO-RIGHT ISOLATE'], [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
    [0x2068, 'FIRST STRONG ISOLATE'], [0x2069, 'POP DIRECTIONAL ISOLATE'],
    [0x2800, 'BRAILLE PATTERN BLANK(点字の空白)'],
    [0x3000, 'IDEOGRAPHIC SPACE(全角スペース)'],
    [0x3164, 'HANGUL FILLER(ハングルの空白)'],
    [0xfeff, 'ZERO WIDTH NO-BREAK SPACE / BOM'],
    [0xffa0, 'HALFWIDTH HANGUL FILLER'],
    [0x2010, 'HYPHEN'], [0x2011, 'NON-BREAKING HYPHEN'], [0x2012, 'FIGURE DASH'], [0x2013, 'EN DASH'],
    [0x2014, 'EM DASH'], [0x2212, 'MINUS SIGN'],
    [0x2024, 'ONE DOT LEADER'], [0x3002, 'IDEOGRAPHIC FULL STOP(句点)'], [0xff0e, 'FULLWIDTH FULL STOP'],
    [0xff61, 'HALFWIDTH IDEOGRAPHIC FULL STOP'],
    [0x2215, 'DIVISION SLASH'], [0x2044, 'FRACTION SLASH'], [0xff0f, 'FULLWIDTH SOLIDUS'],
  ]);

  function nameOf(cp) {
    if (KNOWN_NAMES.has(cp)) return KNOWN_NAMES.get(cp);
    if (cp >= 0xfe00 && cp <= 0xfe0f) return 'VARIATION SELECTOR-' + (cp - 0xfe00 + 1);
    if (cp >= 0xe0100 && cp <= 0xe01ef) return 'VARIATION SELECTOR-' + (cp - 0xe0100 + 17);
    if (cp === 0xe0001) return 'LANGUAGE TAG';
    if (cp === 0xe007f) return 'CANCEL TAG';
    if (cp >= 0xe0020 && cp <= 0xe007e) return 'TAG ' + String.fromCharCode(cp - 0xe0000);
    return null;
  }

  const hex = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

  function isSafeAscii(cp) {
    return (
      (cp >= 0x61 && cp <= 0x7a) || // a-z
      (cp >= 0x41 && cp <= 0x5a) || // A-Z(ブラウザは小文字にそろえる)
      (cp >= 0x30 && cp <= 0x39) || // 0-9
      cp === 0x2d || // -
      cp === 0x2e // .
    );
  }

  function scriptOf(ch) {
    for (const s of SCRIPT_RES) if (s.re.test(ch)) return s.name;
    if (has(RE.inherited, ch)) return 'Inherited';
    if (has(RE.common, ch)) return 'Common';
    return 'Unknown';
  }

  /** 見た目が似ている英数字・記号を返す。{ text, kind: confusable | compat | diacritic } か null */
  function lookalikeOf(ch) {
    const lower = ch.toLowerCase();
    const cp = lower.codePointAt(0);
    if (Array.from(lower).length === 1 && CONFUSABLES.has(cp)) return { text: CONFUSABLES.get(cp), kind: 'confusable' };
    let nfkc = ch;
    try {
      nfkc = ch.normalize('NFKC').toLowerCase();
    } catch (e) {
      /* 不正なサロゲートなど */
    }
    if (nfkc !== ch && /^[a-z0-9.\-/]+$/.test(nfkc)) return { text: nfkc, kind: 'compat' };
    if (RE.marks) {
      const base = nfkc.normalize('NFD').replace(RE.marks, '');
      if (base !== ch && /^[a-z0-9]+$/.test(base)) return { text: base, kind: 'diacritic' };
    }
    return null;
  }

  /** 1文字を分類する */
  function classifyChar(ch) {
    const cp = ch.codePointAt(0);
    const info = {
      ch,
      cp,
      hex: hex(cp),
      safe: false,
      category: 'other',
      script: null,
      hidden: false,
      placeholder: null,
      name: nameOf(cp),
      lookalike: null,
    };
    const setCategory = (category) => {
      info.category = category;
      info.hidden = HIDDEN.has(category);
      if (PLACEHOLDER[category]) info.placeholder = '[' + PLACEHOLDER[category] + ': ' + info.hex + ']';
      return info;
    };

    if (cp < 0x80) {
      if (isSafeAscii(cp)) {
        info.safe = true;
        info.category = 'ascii';
        info.script = /[a-z]/i.test(ch) ? 'Latin' : 'Common';
        return info;
      }
      if (cp < 0x20 || cp === 0x7f) return setCategory('control');
      if (cp === 0x20) return setCategory('space');
      info.script = 'Common';
      return setCategory('asciiSymbol');
    }

    info.script = scriptOf(ch);
    info.lookalike = lookalikeOf(ch);
    if (has(RE.bidi, ch)) return setCategory('bidi');
    if (has(RE.variation, ch)) return setCategory('variation');
    if (cp >= 0xe0000 && cp <= 0xe007f) return setCategory('tag');
    if (has(RE.control, ch)) return setCategory('control');
    if (has(RE.ignorable, ch) || has(RE.format, ch) || EXTRA_INVISIBLE.has(cp)) return setCategory('invisible');
    if (has(RE.space, ch)) return setCategory('space');
    if (has(RE.surrogate, ch)) return setCategory('surrogate');
    if (has(RE.privateUse, ch)) return setCategory('privateUse');
    if (has(RE.noncharacter, ch)) return setCategory('noncharacter');
    if (has(RE.unassigned, ch)) return setCategory('unassigned');
    if (has(RE.mark, ch)) return setCategory('combining');
    for (const key of RANGE_ORDER) if (inRanges(cp, RANGES[key])) return setCategory(key);
    if (has(RE.letterOrNumber, ch)) return setCategory('script');
    if (LOOKALIKE_PUNCT.has(cp) || has(RE.dash, ch)) return setCategory('punctLookalike');
    if (has(RE.punctOrSymbol, ch)) return setCategory('symbol');
    return setCategory('other');
  }

  function scriptLabel(name) {
    const ja = SCRIPT_JA.get(name) || name;
    return ja + ' (' + String(name).replace(/_/g, ' ') + ')';
  }

  /** 画面の「文字体系」欄に出す文字列 */
  function categoryLabel(info) {
    if (info.category === 'script') return scriptLabel(info.script || 'Unknown');
    const [ja, en] = CATEGORY[info.category] || CATEGORY.other;
    const base = ja + ' (' + en + ')';
    if (info.script && !['Common', 'Inherited', 'Unknown'].includes(info.script) && info.category !== 'ascii') {
      return base + ' / ' + (SCRIPT_JA.get(info.script) || info.script);
    }
    return base;
  }

  /** 文章に埋め込むとき用。見えない文字・双方向制御を [不可視: U+XXXX] に置き換え、表示の並びが崩れないようにする */
  function visibleText(text) {
    let out = '';
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x20 && cp < 0x7f) {
        out += ch;
        continue;
      }
      const info = classifyChar(ch);
      out += info.placeholder || ch;
    }
    return out;
  }

  /** 画面に出す文字(見えない文字はプレースホルダ、結合文字は ◌ に載せる) */
  function displayText(info) {
    if (info.placeholder) return info.placeholder;
    if (info.category === 'combining') return '◌' + info.ch;
    return info.ch;
  }

  const RESTRICTIVE_SETS = [
    ['Latin', 'Han', 'Hiragana', 'Katakana'],
    ['Latin', 'Han', 'Bopomofo'],
    ['Latin', 'Han', 'Hangul'],
  ];
  // UTS #39 の Highly Restrictive に当たるか(日本語・中国語・韓国語とラテン文字の組み合わせは通常の混在とみなす)
  function isHighlyRestrictive(scripts) {
    if (scripts.length <= 1) return true;
    return RESTRICTIVE_SETS.some((set) => scripts.every((s) => set.includes(s)));
  }

  /** 文字の並びを「見た目」に置き換える。英数字・ドット・ハイフン・スラッシュだけになれば、その文字列を返す */
  function skeletonOf(chars) {
    let text = '';
    let changed = false;
    let strong = false;
    // 双方向制御があると表示上の並びが入れ替わるので、見た目の文字列は出さない(別の理由で警告する)
    if (chars.some((c) => c.category === 'bidi')) return null;
    for (const c of chars) {
      if (c.safe) {
        text += c.ch.toLowerCase();
        continue;
      }
      changed = true;
      if (c.hidden && c.category !== 'space') {
        strong = true; // 見えない文字は見た目に何も出ない
        continue;
      }
      if (c.category === 'space') {
        text += ' ';
        continue;
      }
      if (c.category === 'combining') continue; // 前の文字に載るだけ
      if (c.lookalike) {
        text += c.lookalike.text;
        if (c.lookalike.kind !== 'diacritic') strong = true;
        continue;
      }
      text += c.ch;
    }
    if (!changed || !/^[a-z0-9.\-/]+$/.test(text) || !/[a-z0-9]/.test(text)) return null;
    return { text, strong };
  }

  function browserHostOf(text) {
    if (typeof URL !== 'function') return { available: false, ok: false, host: null };
    try {
      const u = new URL('http://' + text + '/');
      return { available: true, ok: true, host: u.hostname };
    } catch (e) {
      return { available: true, ok: false, host: null };
    }
  }

  const LEVEL_ORDER = { safe: 0, warning: 1, danger: 2 };
  const LEVEL_LABEL = { safe: 'なりすましなし', warning: '注意', danger: '高' };

  /**
   * ホスト名を調べる。
   * options.source: 'browser'(タブの URL から取った、ブラウザが正規化済みの値)| 'manual'(貼り付けられた生の文字列)
   */
  function analyzeHost(input, options) {
    const opts = options || {};
    const source = opts.source === 'manual' ? 'manual' : 'browser';
    const host = String(input == null ? '' : input);
    const isIpLiteral = /^\[[0-9a-fA-F:.]+\]$/.test(host);

    const labels = host.split('.').map((raw, index) => {
      const d = P.decodeLabel(raw);
      const label = {
        index,
        raw,
        ascii: raw,
        unicode: d.unicode,
        isPunycode: d.isPunycode,
        error: d.error,
        roundTrip: null,
        scripts: [],
        mixedScript: false,
        mixedScriptRisk: false,
        lookalike: null,
      };
      if (d.isPunycode && !d.error) {
        if (!/[^\x00-\x7f]/.test(d.unicode)) {
          label.error = 'ascii-only'; // xn-- なのに中身が ASCII だけ = 正しい国際化ドメイン名ではない
          label.unicode = raw;
        } else {
          try {
            label.roundTrip = P.encode(d.unicode).toLowerCase() === raw.slice(4).toLowerCase();
          } catch (e) {
            label.roundTrip = false;
          }
        }
      }
      if (!d.isPunycode && /[^\x00-\x7f]/.test(raw)) {
        try {
          label.ascii = P.ACE_PREFIX + P.encode(raw);
        } catch (e) {
          label.ascii = raw;
        }
      }
      return label;
    });

    const unicode = labels.map((l) => l.unicode).join('.');
    const chars = [];
    let labelIndex = 0;
    let position = 0;
    for (const ch of unicode) {
      const info = isIpLiteral ? Object.assign(classifyChar('a'), { ch, cp: ch.codePointAt(0), hex: hex(ch.codePointAt(0)), script: 'Common' }) : classifyChar(ch);
      info.index = position;
      info.position = position + 1;
      info.labelIndex = labelIndex;
      position++;
      chars.push(info);
      if (ch === '.') labelIndex++;
    }

    for (const label of labels) {
      const own = chars.filter((c) => c.labelIndex === label.index && c.ch !== '.');
      for (const c of own) {
        let s = null;
        if (c.safe && /[a-z]/i.test(c.ch)) s = 'Latin';
        else if (!c.safe && has(RE.letter, c.ch)) s = c.script;
        if (s && !['Common', 'Inherited', 'Unknown'].includes(s) && !label.scripts.includes(s)) label.scripts.push(s);
      }
      label.mixedScript = label.scripts.length > 1;
      label.mixedScriptRisk = !isHighlyRestrictive(label.scripts);
      label.lookalike = skeletonOf(own);
    }

    const suspicious = chars.filter((c) => !c.safe);
    const hiddenChars = suspicious.filter((c) => c.hidden);
    const isPunycode = labels.some((l) => l.isPunycode);
    const invalidLabels = labels.filter((l) => l.error);
    const roundTripNg = labels.filter((l) => l.roundTrip === false);
    const riskyLabels = labels.filter((l) => l.mixedScriptRisk);
    const lookalikeLabels = labels.filter((l) => l.lookalike);

    // ホスト全体の見た目(各ラベルの見た目をつなぐ)
    let lookalike = null;
    if (lookalikeLabels.length) {
      const text = labels.map((l) => (l.lookalike ? l.lookalike.text : l.unicode.toLowerCase())).join('.');
      const strong = lookalikeLabels.some((l) => l.lookalike.strong);
      if (/^[a-z0-9.\-/]+$/.test(text)) lookalike = { text, strong };
    }

    // ブラウザの変換との突き合わせ(タブの URL を調べるときだけ)
    let browserMatch = null;
    let browserHost = null;
    if (source === 'browser' && isPunycode && !invalidLabels.length && !isIpLiteral) {
      const b = browserHostOf(unicode);
      if (b.available) {
        browserHost = b.host;
        browserMatch = b.ok && b.host === host.toLowerCase();
      }
    }

    const ascii = labels.map((l) => l.ascii).join('.');
    const dangerChars = suspicious.filter((c) => DANGER_CATEGORIES.has(c.category));
    const danger =
      invalidLabels.length > 0 ||
      roundTripNg.length > 0 ||
      browserMatch === false ||
      riskyLabels.length > 0 ||
      hiddenChars.length > 0 ||
      dangerChars.length > 0 ||
      lookalikeLabels.some((l) => l.lookalike.strong);
    const level = danger ? 'danger' : suspicious.length || isPunycode ? 'warning' : 'safe';

    const scriptsUsed = [];
    for (const c of suspicious) {
      const label = c.category === 'script' ? SCRIPT_JA.get(c.script) || c.script : CATEGORY[c.category][0];
      if (!scriptsUsed.includes(label)) scriptsUsed.push(label);
    }

    const reasons = [];
    if (lookalike && lookalike.strong) reasons.push('英字のドメイン「' + lookalike.text + '」に見せかけた偽のドメインの可能性があります');
    else {
      for (const l of lookalikeLabels.filter((x) => x.lookalike.strong)) {
        reasons.push('「' + visibleText(l.unicode) + '」は英字の「' + l.lookalike.text + '」に見えるよう作られている可能性があります');
      }
    }
    if (suspicious.some((c) => c.category === 'bidi')) {
      reasons.push('文字の並びを入れ替える双方向制御文字が含まれています。画面上の並びと実際の並びが違います');
    }
    if (hiddenChars.length) reasons.push('見えない文字・制御文字・特殊スペースが ' + hiddenChars.length + ' 個含まれています');
    for (const l of riskyLabels) {
      reasons.push('「' + visibleText(l.unicode) + '」の中で ' + l.scripts.map((s) => SCRIPT_JA.get(s) || s).join(' と ') + ' が混在しています(混合スクリプト)');
    }
    for (const l of invalidLabels) reasons.push('「' + visibleText(l.raw) + '」は Punycode として正しくありません(解読できない形式)');
    for (const l of roundTripNg) reasons.push('「' + visibleText(l.raw) + '」を解読して再変換すると元に戻りません');
    if (browserMatch === false) reasons.push('ブラウザの変換結果と一致しません(' + (browserHost || '変換できない') + ')');
    if (suspicious.length) {
      const onlyAsciiSymbols = suspicious.every((c) => c.category === 'asciiSymbol');
      reasons.push(
        (onlyAsciiSymbols ? 'ホスト名に標準外の記号が ' : 'ASCII 以外の文字が ') + suspicious.length + ' 個含まれています(' + scriptsUsed.join('・') + ')',
      );
    }
    if (isPunycode) reasons.push('Punycode(xn--)のドメインです。実際の通信名は ' + ascii + ' です');
    if (lookalike && !lookalike.strong) reasons.push('英字の「' + lookalike.text + '」と見分けにくい文字を含みます');

    return {
      input: host,
      source,
      host,
      unicode,
      ascii,
      isPunycode,
      isIpLiteral,
      labels,
      chars,
      suspicious,
      hiddenCount: hiddenChars.length,
      scriptsUsed,
      lookalike,
      checks: {
        punycode: isPunycode,
        invalidPunycode: invalidLabels.length > 0,
        roundTrip: labels.some((l) => l.isPunycode) ? (roundTripNg.length || invalidLabels.length ? 'ng' : 'ok') : 'na',
        browserMatch: browserMatch === null ? 'na' : browserMatch ? 'ok' : 'ng',
        mixedScriptRisk: riskyLabels.length > 0,
        mixedScript: labels.some((l) => l.mixedScript),
      },
      browserHost,
      level,
      levelLabel: LEVEL_LABEL[level],
      onlyAsciiSymbols: suspicious.length > 0 && suspicious.every((c) => c.category === 'asciiSymbol'),
      reasons,
      notes: [],
    };
  }

  /** タブの URL を調べる。http / https 以外は null */
  function analyzeUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    const result = analyzeHost(u.hostname, { source: 'browser' });
    result.url = u.href;
    return result;
  }

  /**
   * 貼り付けられた文字列からホスト部分を、ブラウザの正規化を通さずに取り出す
   * (URL に通すと見えない文字が消えてしまい、見落とすため)
   */
  function extractHost(text) {
    let s = String(text == null ? '' : text).replace(/^[\t\n\r\f ]+|[\t\n\r\f ]+$/g, '');
    if (s.length > 2048) s = s.slice(0, 2048);
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '');
    const end = s.search(/[/?#\\]/);
    if (end >= 0) s = s.slice(0, end);
    let userinfo = null;
    const at = s.lastIndexOf('@');
    if (at >= 0) {
      userinfo = s.slice(0, at);
      s = s.slice(at + 1);
    }
    let port = null;
    if (s.startsWith('[')) {
      const m = /^(\[[^\]]*\])(?::(\d*))?$/.exec(s);
      if (m) {
        s = m[1];
        port = m[2] || null;
      }
    } else {
      const m = /:(\d*)$/.exec(s);
      if (m) {
        port = m[1];
        s = s.slice(0, m.index);
      }
    }
    return { host: s, userinfo, port };
  }

  /** ポップアップの「貼り付けて検査」用 */
  function analyzeInput(text) {
    const parts = extractHost(text);
    let host = parts.host;
    const notes = [];
    if (/%[0-9a-f]{2}/i.test(host)) {
      try {
        const decoded = decodeURIComponent(host);
        if (decoded !== host) {
          notes.push('パーセントエンコード(%xx)を元の文字に戻してから検査しました');
          host = decoded;
        }
      } catch (e) {
        notes.push('パーセントエンコード(%xx)が壊れています');
      }
    }
    if (!host) return null;

    const result = analyzeHost(host, { source: 'manual' });
    const b = browserHostOf(host);
    result.browserOpenable = b.available ? b.ok : null;
    result.browserHost = b.ok ? b.host : null;
    if (b.ok && b.host !== result.ascii.toLowerCase()) {
      notes.push('ブラウザはこの表記を「' + b.host + '」として開きます(ブラウザが見えない文字の除去・全角→半角・文字の正規化をするため)');
    } else if (b.available && !b.ok) {
      notes.push('ブラウザはこのアドレスを開けません(使えない文字を含むため)。メールや画面に表示するための偽の表記に使われる形です');
    }
    if (parts.userinfo !== null) {
      result.reasons.unshift('「@」より前の「' + visibleText(parts.userinfo) + '」は接続先ではありません。実際の接続先は「' + visibleText(host) + '」です');
      result.level = 'danger';
      result.levelLabel = LEVEL_LABEL.danger;
    }
    // 「実際の通信名」はブラウザが本当に接続する先。文字をそのまま Punycode にした値は directAscii に残す
    result.directAscii = result.ascii;
    if (b.ok) result.ascii = b.host;
    result.userinfo = parts.userinfo;
    result.port = parts.port;
    result.notes = notes;
    return result;
  }

  const api = Object.freeze({
    analyzeHost,
    analyzeUrl,
    analyzeInput,
    extractHost,
    classifyChar,
    lookalikeOf,
    categoryLabel,
    displayText,
    visibleText,
    scriptLabel,
    LEVEL_ORDER,
    LEVEL_LABEL,
  });

  root.HDDetector = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
