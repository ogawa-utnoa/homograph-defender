/*
 * Homograph Defender — メールの中のリンクの判定(Gmail の画面とテストで共通。DOM には触れない)
 *
 * 1つのリンクについて、
 *   ・本当の行き先(Google・Outlook の転送用の URL は中身を取り出す)
 *   ・行き先のドメインの文字(detector.js で判定)
 *   ・表示の文字がドメインに見えるなら、その文字(生の文字のまま。見えない文字・全角も見つかる)
 *   ・表示の文字のドメインと、本当の行き先が違うか
 * を調べる。外部への問い合わせはしない(短縮 URL の先までは追わない)。
 */
(function (root) {
  'use strict';

  const D = root.HDDetector || (typeof require === 'function' ? require('./detector.js') : null);
  if (!D) throw new Error('HDDetector が読み込まれていません');

  const LEVEL_ORDER = { safe: 0, warning: 1, danger: 2 };
  const maxLevel = (a, b) => (LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b);

  // 転送用の URL(Gmail の google.com/url?q=… など)。中の本当の行き先を取り出す
  const WRAPPERS = [
    { name: 'Google の転送', test: (u) => /^(www\.)?google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url', params: ['q', 'url'] },
    { name: 'Outlook の安全リンク', test: (u) => /\.safelinks\.protection\.outlook\.com$/.test(u.hostname), params: ['url'] },
  ];

  function unwrap(href) {
    let url;
    try {
      url = new URL(href);
    } catch (e) {
      return null;
    }
    const via = [];
    for (let i = 0; i < 3; i++) {
      const w = WRAPPERS.find((x) => x.test(url));
      if (!w) break;
      const inner = w.params.map((p) => url.searchParams.get(p)).find((v) => v && /^https?:\/\//i.test(v));
      if (!inner) break;
      try {
        url = new URL(inner);
        via.push(w.name);
      } catch (e) {
        break;
      }
    }
    return { url, via };
  }

  // ドメインの最後の部分としてよく使われるもの(ファイル名「資料.pdf」などをドメインと取り違えないため)
  const TLD_RE = /^(com|net|org|info|biz|app|dev|io|ai|co|me|tv|xyz|online|site|shop|top|club|store|tech|cloud|page|link|live|news|blog|email|jobs|edu|gov|mil|int|mobi|pro|name|asia|tokyo|osaka|nagoya|[a-z]{2})$/;
  const FILE_EXT_RE = /^(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|png|jpg|jpeg|gif|txt|csv|html|htm|js|md|ts|py)$/;

  /**
   * 表示の文字がドメインや URL に見えるなら { raw: 生のホスト, normalized: 全角などをそろえたホスト } を返す。
   * 文章(半角スペースを含む)・メールアドレス・ファイル名は対象外
   */
  function hostInText(text) {
    const t = String(text == null ? '' : text).replace(/^[\t\n\r\f ]+|[\t\n\r\f ]+$/g, '');
    if (!t || t.length > 300 || /[\t\n\r\f ]/.test(t)) return null;
    const parts = D.extractHost(t);
    if (parts.userinfo !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null; // info@example.com のようなメールアドレス
    const raw = parts.host;
    if (!raw) return null;
    let normalized = raw;
    try {
      normalized = raw.normalize('NFKC');
    } catch (e) {
      /* noop */
    }
    normalized = normalized.toLowerCase().replace(/[。｡．]/g, '.');
    const labels = normalized.replace(/\.$/, '').split('.');
    if (labels.length < 2) return null;
    const tld = labels[labels.length - 1];
    if (!/\p{L}/u.test(labels.slice(0, -1).join(''))) return null;
    if (FILE_EXT_RE.test(tld)) return null;
    if (!TLD_RE.test(tld) && !/^xn--/.test(tld) && !/[^\x00-\x7f]/.test(tld)) return null;
    return { raw, normalized };
  }

  // 同じドメインか、片方がもう片方のサブドメインなら「同じ行き先」とみなす
  function related(a, b) {
    a = String(a).toLowerCase().replace(/\.$/, '');
    b = String(b).toLowerCase().replace(/\.$/, '');
    return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
  }

  const safeDecode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  };

  const isIp = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:.]+\]$/i.test(host);

  /**
   * 1つのリンクを調べる。
   * 戻り値: { ok, href, url, via, dest, text, textHost, textResult, mismatch, level, reasons }
   *   ok=false は http/https 以外(mailto: など)で、一覧にも出さない
   */
  function analyzeLink(href, text) {
    const out = { ok: false, href: String(href || ''), text: String(text == null ? '' : text), via: [], dest: null, textHost: null, textResult: null, mismatch: false, level: 'safe', reasons: [] };
    const un = unwrap(out.href);
    if (!un) return out;
    const { url, via } = un;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return out;
    out.ok = true;
    out.url = url;
    out.via = via;
    out.dest = D.analyzeUrl(url.href);
    if (!out.dest) {
      out.ok = false;
      return out;
    }

    // 行き先そのもの
    if (out.dest.level !== 'safe') {
      out.level = maxLevel(out.level, out.dest.level);
      out.reasons.push(...out.dest.reasons.filter((r) => !/^Punycode\(xn--\)のドメインです/.test(r)).slice(0, 2));
      if (out.dest.isPunycode) out.reasons.push('行き先は Punycode(xn--)のドメインです: ' + url.hostname);
    }
    if (url.username || url.password) {
      out.level = 'danger';
      out.reasons.unshift('行き先の「@」より前(' + D.visibleText(safeDecode(url.username)) + ')は接続先ではありません。本当の接続先は ' + url.hostname + ' です');
    }
    if (isIp(url.hostname)) {
      out.level = maxLevel(out.level, 'warning');
      out.reasons.push('行き先がドメインではなく IP アドレスです: ' + url.hostname);
    }

    // 表示の文字がドメインに見えるとき
    const th = hostInText(out.text);
    if (th) {
      out.textHost = th;
      const tr = D.analyzeInput(out.text);
      out.textResult = tr;
      if (tr) {
        if (tr.level !== 'safe') {
          out.level = maxLevel(out.level, tr.level);
          const first = tr.reasons.find((r) => !/^Punycode\(xn--\)のドメインです/.test(r));
          if (first) out.reasons.push('表示の文字: ' + first);
        }
        if (tr.browserOpenable === false) {
          out.level = 'danger';
          out.reasons.push('表示の文字はブラウザでは開けない形です(見た目だけのドメイン)');
        }
        const shown = tr.browserHost || th.normalized;
        if (shown && !related(shown, url.hostname)) {
          out.mismatch = true;
          const destShown = out.dest.unicode !== url.hostname ? out.dest.unicode + '(' + url.hostname + ')' : url.hostname;
          if (url.hostname.toLowerCase().startsWith(shown.toLowerCase() + '.')) {
            out.level = 'danger';
            out.reasons.unshift('表示は「' + D.visibleText(th.raw) + '」ですが、行き先は「' + D.visibleText(destShown) + '」で、その名前で始まる別のドメインです');
          } else {
            out.level = maxLevel(out.level, 'warning');
            out.reasons.unshift('表示は「' + D.visibleText(th.raw) + '」ですが、本当の行き先は「' + D.visibleText(destShown) + '」です');
          }
        }
      }
    }
    return out;
  }

  const api = Object.freeze({ analyzeLink, unwrap, hostInText, related, LEVEL_ORDER });
  root.HDLinks = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
