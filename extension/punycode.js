/*
 * Homograph Defender — Punycode(RFC 3492)の変換
 *
 * 外部ライブラリを使わず、拡張機能の中だけで完結する。
 * 不正な入力は寛容に読み替えず、必ず PunycodeError で止める(呼び出し側で「不正なPunycode」として警告する)。
 * service worker(importScripts)・content script・popup・Node(テスト)で同じファイルを使う。
 */
(function (root) {
  'use strict';

  const BASE = 36;
  const T_MIN = 1;
  const T_MAX = 26;
  const SKEW = 38;
  const DAMP = 700;
  const INITIAL_BIAS = 72;
  const INITIAL_N = 0x80;
  const DELIMITER = '-';
  const MAX_INT = 0x7fffffff;
  const ACE_PREFIX = 'xn--';
  // ラベルは本来63文字まで。手入力の検査で巨大な文字列を渡されても固まらないよう上限を置く
  const MAX_INPUT = 1024;

  class PunycodeError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'PunycodeError';
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new PunycodeError(code, message);
  }

  function adapt(delta, numPoints, firstTime) {
    let k = 0;
    delta = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    while (delta > ((BASE - T_MIN) * T_MAX) >> 1) {
      delta = Math.floor(delta / (BASE - T_MIN));
      k += BASE;
    }
    return Math.floor(k + ((BASE - T_MIN + 1) * delta) / (delta + SKEW));
  }

  function threshold(k, bias) {
    if (k <= bias) return T_MIN;
    if (k >= bias + T_MAX) return T_MAX;
    return k - bias;
  }

  // 0-25 = a-z(大文字も可)、26-35 = 0-9。それ以外は BASE(=不正)
  function basicToDigit(c) {
    if (c >= 0x30 && c <= 0x39) return c - 0x30 + 26;
    if (c >= 0x41 && c <= 0x5a) return c - 0x41;
    if (c >= 0x61 && c <= 0x7a) return c - 0x61;
    return BASE;
  }

  function digitToBasic(d) {
    return d < 26 ? d + 0x61 : d - 26 + 0x30;
  }

  /** Punycode の文字列(xn-- を除いた部分)を Unicode 文字列へ戻す */
  function decode(input) {
    if (typeof input !== 'string') fail('type', 'decode: 文字列ではありません');
    if (input.length > MAX_INPUT) fail('too-long', 'decode: 入力が長すぎます');

    const output = [];
    let n = INITIAL_N;
    let i = 0;
    let bias = INITIAL_BIAS;

    let basic = input.lastIndexOf(DELIMITER);
    if (basic < 0) basic = 0;
    for (let j = 0; j < basic; j++) {
      const c = input.charCodeAt(j);
      if (c >= 0x80) fail('not-basic', 'decode: 区切りより前に ASCII 以外の文字があります');
      output.push(c);
    }

    let pos = basic > 0 ? basic + 1 : 0;
    while (pos < input.length) {
      const oldi = i;
      let w = 1;
      for (let k = BASE; ; k += BASE) {
        if (pos >= input.length) fail('truncated', 'decode: 途中で終わっています');
        const digit = basicToDigit(input.charCodeAt(pos++));
        if (digit >= BASE) fail('bad-digit', 'decode: Punycode に使えない文字があります');
        if (digit > Math.floor((MAX_INT - i) / w)) fail('overflow', 'decode: 桁あふれ');
        i += digit * w;
        const t = threshold(k, bias);
        if (digit < t) break;
        if (w > Math.floor(MAX_INT / (BASE - t))) fail('overflow', 'decode: 桁あふれ');
        w *= BASE - t;
      }
      const length = output.length + 1;
      bias = adapt(i - oldi, length, oldi === 0);
      if (Math.floor(i / length) > MAX_INT - n) fail('overflow', 'decode: 桁あふれ');
      n += Math.floor(i / length);
      i %= length;
      if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) fail('bad-code-point', 'decode: 存在しない文字番号になります');
      output.splice(i, 0, n);
      i++;
    }
    return String.fromCodePoint(...output);
  }

  /** Unicode 文字列を Punycode(xn-- を除いた部分)へ変換する */
  function encode(input) {
    if (typeof input !== 'string') fail('type', 'encode: 文字列ではありません');
    const cps = Array.from(input, (ch) => ch.codePointAt(0));
    if (cps.length > MAX_INPUT) fail('too-long', 'encode: 入力が長すぎます');

    const output = [];
    for (const c of cps) if (c < 0x80) output.push(String.fromCharCode(c));
    const basicLength = output.length;
    let handled = basicLength;
    if (basicLength > 0) output.push(DELIMITER);

    let n = INITIAL_N;
    let delta = 0;
    let bias = INITIAL_BIAS;
    while (handled < cps.length) {
      let m = MAX_INT;
      for (const c of cps) if (c >= n && c < m) m = c;
      if (m - n > Math.floor((MAX_INT - delta) / (handled + 1))) fail('overflow', 'encode: 桁あふれ');
      delta += (m - n) * (handled + 1);
      n = m;
      for (const c of cps) {
        if (c < n && ++delta > MAX_INT) fail('overflow', 'encode: 桁あふれ');
        if (c === n) {
          let q = delta;
          for (let k = BASE; ; k += BASE) {
            const t = threshold(k, bias);
            if (q < t) break;
            output.push(String.fromCharCode(digitToBasic(t + ((q - t) % (BASE - t)))));
            q = Math.floor((q - t) / (BASE - t));
          }
          output.push(String.fromCharCode(digitToBasic(q)));
          bias = adapt(delta, handled + 1, handled === basicLength);
          delta = 0;
          handled++;
        }
      }
      delta++;
      n++;
    }
    return output.join('');
  }

  function isAceLabel(label) {
    return typeof label === 'string' && label.slice(0, 4).toLowerCase() === ACE_PREFIX;
  }

  /**
   * ドメインの1ラベルを調べる。xn-- で始まれば解読し、失敗しても例外にせず error に理由を入れて返す。
   * 戻り値: { ascii, unicode, isPunycode, error }
   */
  function decodeLabel(label) {
    if (!isAceLabel(label)) return { ascii: label, unicode: label, isPunycode: false, error: null };
    try {
      return { ascii: label, unicode: decode(label.slice(4)), isPunycode: true, error: null };
    } catch (e) {
      return { ascii: label, unicode: label, isPunycode: true, error: e instanceof PunycodeError ? e.code : 'invalid' };
    }
  }

  /** ドメイン全体を Unicode 表記へ(不正なラベルがあれば例外) */
  function toUnicode(domain) {
    return String(domain)
      .split('.')
      .map((label) => (isAceLabel(label) ? decode(label.slice(4)) : label))
      .join('.');
  }

  /**
   * ドメイン全体を ASCII 表記へ。ASCII 以外を含むラベルだけ xn-- + encode にする。
   * IDNA の正規化(大文字→小文字・全角→半角など)はしない。ブラウザの解釈は URL で別に確かめる。
   */
  function toASCII(domain) {
    return String(domain)
      .split('.')
      .map((label) => (/[^\x00-\x7f]/.test(label) ? ACE_PREFIX + encode(label) : label))
      .join('.');
  }

  const api = Object.freeze({ decode, encode, decodeLabel, toUnicode, toASCII, isAceLabel, PunycodeError, ACE_PREFIX });

  root.HDPunycode = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
