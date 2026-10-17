/*
 * Homograph Defender — Gmail の中のリンクの検査(content script・mail.google.com だけ)
 *
 * 開いたメールの本文(div.a3s)にあるリンクを自動で調べ、
 *   ・メールの上に「リンクの一覧と本当の行き先」の欄を出す
 *   ・危険・注意のリンクは赤(注意は茶)の枠で囲み、横に本当の行き先を出す
 *   ・どのリンクも、マウスを乗せると本当の行き先と判定を出す
 * 読むのはリンクの行き先と表示の文字だけ。外部へは何も送らず、保存もしない。
 * 文字列は createElement と textContent だけで組み立てる(innerHTML・eval は使わない)。
 */
(() => {
  'use strict';

  if (window.top !== window) return;
  const D = globalThis.HDDetector;
  const L = globalThis.HDLinks;
  if (!D || !L || globalThis.__homographDefenderGmail) return;
  globalThis.__homographDefenderGmail = true;

  const BODY_SELECTOR = 'div.a3s';
  const SUFFIX = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  const COLORS = { danger: '#C62828', warning: '#9A5B00', safe: '#2E7D32' };
  const LEVEL_TEXT = { danger: '危険', warning: '注意', safe: '問題なし' };

  const ownHosts = new WeakSet();
  const bodyState = new WeakMap(); // 本文 → 状態 { sig, panel, body, items, expanded, showAll, hadFlag }
  const panels = new Map(); // 欄の外側の要素 → 状態(1通に欄は1つ。本文が作り直されても引き継ぐ)
  const linkCache = new WeakMap(); // a → { href, text, info }
  const flags = new WeakMap(); // a → { part, level }
  const flagToLink = new WeakMap(); // 横の印 → a

  // ---------------- 部品 ----------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function makePart(kind) {
    const host = document.createElement('hd-' + kind + '-' + SUFFIX);
    ownHosts.add(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const box = el('div', 'root');
    shadow.append(el('style', null, cssText()), box);
    return { host, box };
  }

  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function shownText(info) {
    const t = info.text.replace(/^[\t\n\r\f ]+|[\t\n\r\f ]+$/g, '').replace(/[\t\n\r\f ]+/g, ' ');
    return t ? D.visibleText(t) : '';
  }

  // 行き先のドメインを1文字ずつ並べ、怪しい文字だけ赤くする
  function hostView(info) {
    const box = el('span', 'host');
    box.setAttribute('dir', 'ltr');
    let run = '';
    const flush = () => {
      if (run) box.append(document.createTextNode(run));
      run = '';
    };
    for (const c of info.dest.chars) {
      if (c.safe) {
        run += c.ch;
        continue;
      }
      flush();
      const bad = el('span', 'bad' + (c.placeholder ? ' ph' : ''), D.displayText(c));
      bad.title = c.position + '文字目 ' + c.hex + ' ' + D.categoryLabel(c);
      box.append(bad);
    }
    flush();
    return box;
  }

  function urlView(info, pathMax) {
    const u = info.url;
    const box = el('span', 'u');
    box.setAttribute('dir', 'ltr');
    box.append(u.protocol + '//', hostView(info));
    const rest = (u.port ? ':' + u.port : '') + u.pathname + u.search + u.hash;
    if (rest && rest !== '/') box.append(document.createTextNode(cut(D.visibleText(decodeSafe(rest)), pathMax)));
    return box;
  }

  function decodeSafe(s) {
    try {
      return decodeURI(s);
    } catch (e) {
      return s;
    }
  }

  // ---------------- 調べる ----------------
  function infoFor(a) {
    const text = a.textContent || '';
    const cached = linkCache.get(a);
    if (cached && cached.href === a.href && cached.text === text) return cached.info;
    let info;
    try {
      info = L.analyzeLink(a.href, text);
    } catch (e) {
      info = { ok: false };
    }
    info.image = !text.trim() && !!a.querySelector('img');
    linkCache.set(a, { href: a.href, text, info });
    return info;
  }

  function scan() {
    for (const body of document.querySelectorAll(BODY_SELECTOR)) {
      try {
        processBody(body);
      } catch (e) {
        /* 1通の失敗で全体を止めない */
      }
    }
    // 本文が消えた欄(Gmail が本文を作り直した・別のメールへ移った)は片付ける
    for (const [host, st] of panels) {
      if (!st.body || !st.body.isConnected || !st.panel || st.panel.host !== host) {
        host.remove();
        panels.delete(host);
      }
    }
  }

  function processBody(body) {
    if (!body.parentNode) return;
    if (body.parentElement && body.parentElement.closest(BODY_SELECTOR)) return; // 入れ子の本文は外側でまとめて扱う
    let st = bodyState.get(body);
    if (!st) {
      // Gmail は本文の要素を作り直すことがある。同じ場所に前の欄が残っていれば、それを引き継ぐ(開閉の状態も)
      const prev = Array.from(body.parentNode.children).find((n) => panels.has(n));
      st = prev ? panels.get(prev) : { sig: null, panel: null, body: null, items: [], expanded: false, showAll: false, hadFlag: false };
      st.sig = null;
      bodyState.set(body, st);
    }
    st.body = body;
    const anchors = Array.from(body.querySelectorAll('a[href]'));
    const items = [];
    for (const a of anchors) {
      const info = infoFor(a);
      if (!info.ok) continue;
      items.push({ a, info });
    }
    const sig = items.map((i) => i.info.level + i.a.href).join('\n');
    for (const item of items) if (item.info.level !== 'safe') flagLink(item.a, item.info);
    if (st.sig === sig && (!st.panel || (st.panel.host.isConnected && st.panel.host.nextSibling === body))) return;
    st.sig = sig;
    st.items = items;
    renderPanel(st);
  }

  // ---------------- 危険・注意のリンクの横の印 ----------------
  function flagLink(a, info) {
    let f = flags.get(a);
    if (f && f.level === info.level && f.part.host.isConnected && a.nextSibling === f.part.host) return;
    if (!f) {
      f = { part: makePart('flag'), level: null };
      flags.set(a, f);
      flagToLink.set(f.part.host, a);
    }
    f.level = info.level;
    const chip = el('span', 'flag ' + info.level);
    chip.append(el('span', null, '⚠ ' + LEVEL_TEXT[info.level] + ': 本当の行き先 '), hostView(info));
    if (info.dest.unicode !== info.url.hostname) chip.append(el('span', 'asc', ' (' + info.url.hostname + ')'));
    f.part.box.replaceChildren(chip);
    if (a.nextSibling !== f.part.host) a.after(f.part.host);
    a.style.setProperty('outline', '2px solid ' + COLORS[info.level], 'important');
    a.style.setProperty('outline-offset', '1px', 'important');
  }

  // ---------------- メールの上の欄 ----------------
  function renderPanel(st) {
    const body = st.body;
    const items = st.items;
    if (!body || !body.parentNode) return;
    if (!items.length) {
      if (st.panel) {
        st.panel.host.remove();
        panels.delete(st.panel.host);
        st.panel = null;
      }
      return;
    }
    const danger = items.filter((i) => i.info.level === 'danger').length;
    const warning = items.filter((i) => i.info.level === 'warning').length;
    const flagged = danger + warning;
    if (!st.panel) st.panel = makePart('panel');
    panels.set(st.panel.host, st);
    if (flagged && !st.hadFlag) st.expanded = true; // 危険・注意が見つかったら一覧を開いておく
    st.hadFlag = flagged > 0;

    const domains = new Set(items.map((i) => i.info.url.hostname));
    const level = danger ? 'danger' : flagged ? 'warning' : 'safe';
    const panel = el('div', 'panel ' + level);

    const head = el('button', 'head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(st.expanded));
    let sum;
    if (flagged) {
      const parts = [];
      if (danger) parts.push('危険 ' + danger + ' 件');
      if (warning) parts.push('注意 ' + warning + ' 件');
      sum = '⚠ このメールのリンク ' + items.length + ' 件のうち、' + parts.join('・');
    } else {
      sum = '✓ このメールのリンク ' + items.length + ' 件: 行き先は英数字のドメインで、表示との食い違いもありません(' + domains.size + ' ドメイン)';
    }
    head.append(el('span', 'sum', sum), el('span', 'brand', 'Homograph Defender'), el('span', 'tog', st.expanded ? '閉じる ▲' : '一覧 ▼'));
    head.addEventListener('click', () => {
      st.expanded = !st.expanded;
      renderPanel(st);
    });
    panel.append(head);

    if (st.expanded) {
      const order = { danger: 0, warning: 1, safe: 2 };
      const sorted = items.slice().sort((x, y) => order[x.info.level] - order[y.info.level]);
      const visible = flagged && !st.showAll ? sorted.filter((i) => i.info.level !== 'safe') : sorted;
      const list = el('ul', 'list');
      for (const { a, info } of visible) list.append(rowFor(a, info));
      panel.append(list);
      if (visible.length < sorted.length) {
        const more = el('button', 'more', 'ほかのリンク ' + (sorted.length - visible.length) + ' 件も表示');
        more.type = 'button';
        more.addEventListener('click', () => {
          st.showAll = true;
          renderPanel(st);
        });
        panel.append(more);
      }
    }
    st.panel.box.replaceChildren(panel);
    if (st.panel.host.parentNode !== body.parentNode || st.panel.host.nextSibling !== body) body.parentNode.insertBefore(st.panel.host, body);
    // 同じメールに欄が2つ以上あれば、1つにする
    for (const n of Array.from(body.parentNode.children)) {
      if (n !== st.panel.host && panels.has(n)) {
        n.remove();
        panels.delete(n);
      }
    }
  }

  function rowFor(a, info) {
    const row = el('li', 'row ' + info.level);
    row.title = info.url.href;
    row.append(el('span', 'm', info.level === 'safe' ? '✓' : info.level === 'danger' ? '✕' : '!'));
    const main = el('div', 'main');
    const label = info.image ? '(画像のリンク)' : shownText(info) ? '「' + cut(shownText(info), 60) + '」' : '(文字のないリンク)';
    main.append(el('div', 't', '表示: ' + label));
    const dest = el('div', 'd');
    dest.append(el('span', 'k', '行き先: '), urlView(info, 70));
    main.append(dest);
    if (info.via.length) main.append(el('div', 'v', info.via.join('・') + 'を外した行き先です'));
    if (info.level !== 'safe') for (const r of info.reasons.slice(0, 2)) main.append(el('div', 'r', r));
    row.append(main);
    row.addEventListener('click', () => {
      a.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const before = a.style.getPropertyValue('box-shadow');
      a.style.setProperty('box-shadow', '0 0 0 4px #1a56db', 'important');
      setTimeout(() => {
        if (before) a.style.setProperty('box-shadow', before);
        else a.style.removeProperty('box-shadow');
      }, 1600);
    });
    return row;
  }

  // ---------------- マウスを乗せたときの説明 ----------------
  let card = null;
  let cardFor = null;
  let hideTimer = 0;

  function showCard(a, info) {
    clearTimeout(hideTimer);
    if (!card) {
      card = makePart('card');
      const h = card.host.style;
      for (const [k, v] of [['all', 'initial'], ['position', 'fixed'], ['z-index', '2147483646'], ['pointer-events', 'none'], ['display', 'block'], ['left', '0px'], ['top', '0px']]) h.setProperty(k, v, 'important');
    }
    cardFor = a;
    const box = el('div', 'card ' + info.level);
    box.append(el('div', 'ch', info.level === 'safe' ? '✓ 文字のなりすましはありません' : '⚠ ' + LEVEL_TEXT[info.level] + ': このリンクに気をつけてください'));
    const body = el('div', 'cb');
    const label = info.image ? '(画像のリンク)' : shownText(info) ? '「' + cut(shownText(info), 80) + '」' : '(文字のないリンク)';
    body.append(el('div', 'lbl', '表示の文字'), el('div', 'txt', label));
    body.append(el('div', 'lbl', '本当の行き先'));
    const dest = el('div', 'dest');
    dest.append(urlView(info, 160));
    body.append(dest);
    if (info.dest.unicode !== info.url.hostname) body.append(el('div', 'sub', '実際の通信名: ' + info.url.hostname));
    if (info.via.length) body.append(el('div', 'sub', info.via.join('・') + 'を外した行き先です'));
    if (info.reasons.length) {
      const ul = el('ul');
      for (const r of info.reasons.slice(0, 3)) ul.append(el('li', null, r));
      body.append(ul);
    }
    body.append(el('div', 'brand', 'Homograph Defender(端末内で判定)'));
    box.append(body);
    card.box.replaceChildren(box);
    if (!card.host.isConnected) document.documentElement.appendChild(card.host);

    const r = a.getBoundingClientRect();
    const cr = card.host.getBoundingClientRect();
    let top = r.bottom + 8;
    if (top + cr.height > window.innerHeight - 8) top = Math.max(8, r.top - cr.height - 8);
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - cr.width - 8));
    card.host.style.setProperty('left', left + 'px', 'important');
    card.host.style.setProperty('top', top + 'px', 'important');
    card.host.style.setProperty('visibility', 'visible', 'important');
  }

  function hideCard() {
    if (card) card.host.style.setProperty('visibility', 'hidden', 'important');
    cardFor = null;
  }

  function linkFromEvent(e) {
    const t = e.target;
    if (!(t instanceof Element)) return null;
    if (ownHosts.has(t)) return flagToLink.get(t) || null;
    const a = t.closest('a[href]');
    if (!a || !a.closest(BODY_SELECTOR)) return null;
    return a;
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      const a = linkFromEvent(e);
      if (!a) return;
      const cached = linkCache.get(a);
      if (!cached || !cached.info.ok) return;
      showCard(a, cached.info);
    },
    true,
  );
  document.addEventListener(
    'mouseout',
    (e) => {
      if (!cardFor) return;
      const from = linkFromEvent(e);
      if (from !== cardFor) return;
      const to = e.relatedTarget;
      if (to instanceof Node && (cardFor.contains(to) || (flags.get(cardFor) && flags.get(cardFor).part.host === to))) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideCard, 150);
    },
    true,
  );
  window.addEventListener('scroll', hideCard, true);
  window.addEventListener('blur', hideCard);

  // ---------------- 見張り(Gmail は画面を書き換え続けるので、まとめて 0.3 秒ごとに調べる) ----------------
  let timer = 0;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      scan();
    }, 300);
  };
  // リンクの行き先(href)だけがあとから書き換わることもあるので、それも見張る
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  schedule();

  // ---------------- 見た目 ----------------
  function cssText() {
    return `
:host { all: initial; }
* { box-sizing: border-box; }
.root { display: contents; }
.panel, .card, .flag {
  font-family: system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans JP", Meiryo, sans-serif;
  letter-spacing: normal; text-transform: none; text-align: left; direction: ltr;
}
.u, .host, .asc { font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Noto Sans Mono", monospace; }
.host .bad { display: inline-block; margin: 0 1px; padding: 0 2px; line-height: 1.25; background: #e00000; color: #fff; border: 2px solid #6d0000; border-radius: 3px; font-weight: 800; }
.host .bad.ph { color: #ffeb3b; font-size: 0.8em; }

.panel { display: block; margin: 0 0 12px; border: 1px solid #dadce0; border-radius: 8px; background: #fff; color: #1f2328; font-size: 13px; line-height: 1.5; overflow: hidden; }
.head { display: flex; align-items: center; gap: 10px; width: 100%; margin: 0; padding: 7px 12px; border: 0; background: transparent; color: inherit; font: inherit; font-weight: 700; text-align: left; cursor: pointer; }
.panel.danger .head { background: ${COLORS.danger}; color: #fff; }
.panel.warning .head { background: ${COLORS.warning}; color: #fff; }
.panel.safe .head .sum::first-letter { color: ${COLORS.safe}; }
.head .sum { flex: 1 1 auto; }
.head .brand { flex: none; font-size: 11px; font-weight: 400; opacity: 0.85; }
.head .tog { flex: none; font-size: 12px; font-weight: 700; border: 1px solid currentColor; border-radius: 4px; padding: 0 8px; white-space: nowrap; }
.head:focus-visible, .more:focus-visible { outline: 2px solid #1a56db; outline-offset: -2px; }
.list { list-style: none; margin: 0; padding: 0; }
.row { display: flex; gap: 8px; padding: 7px 12px; border-top: 1px solid #eef0f2; cursor: pointer; }
.row:hover { background: #f6f8fa; }
.row .m { flex: none; width: 16px; font-weight: 800; text-align: center; }
.row.danger .m, .row.danger .r { color: ${COLORS.danger}; }
.row.warning .m, .row.warning .r { color: ${COLORS.warning}; }
.row.safe .m { color: ${COLORS.safe}; }
.row .main { min-width: 0; flex: 1 1 auto; }
.row .t { color: #5f6670; font-size: 12px; word-break: break-all; }
.row .d { word-break: break-all; }
.row .k { color: #5f6670; font-size: 12px; }
.row .u { font-size: 13px; color: #1f2328; }
.row .v { color: #5f6670; font-size: 11px; }
.row .r { font-size: 12px; font-weight: 700; }
.more { display: block; width: 100%; margin: 0; padding: 6px 12px; border: 0; border-top: 1px solid #eef0f2; background: #fff; color: #1a56db; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }

.flag { display: inline-block; margin: 0 0 0 4px; padding: 0 6px; border-radius: 4px; color: #fff; font-size: 12px; font-weight: 700; line-height: 1.7; vertical-align: baseline; white-space: nowrap; }
.flag.danger { background: ${COLORS.danger}; }
.flag.warning { background: ${COLORS.warning}; }
.flag .host { font-weight: 700; }
.flag .host .bad { background: #fff; color: ${COLORS.danger}; border-color: #fff; }
.flag .asc { font-weight: 400; opacity: 0.9; }

.card { width: max-content; max-width: min(460px, calc(100vw - 16px)); background: #fff; color: #1f2328; border: 1px solid #c4c8cd; border-radius: 8px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18); font-size: 13px; line-height: 1.55; overflow: hidden; }
.card .ch { padding: 6px 12px; color: #fff; font-weight: 800; }
.card.danger .ch { background: ${COLORS.danger}; }
.card.warning .ch { background: ${COLORS.warning}; }
.card.safe .ch { background: ${COLORS.safe}; }
.card .cb { padding: 4px 12px 10px; }
.card .lbl { margin-top: 6px; color: #5f6670; font-size: 11px; font-weight: 700; }
.card .txt { word-break: break-all; }
.card .dest { word-break: break-all; }
.card .u { font-size: 14px; }
.card .sub { color: #5f6670; font-size: 12px; word-break: break-all; }
.card ul { margin: 6px 0 0; padding-left: 18px; font-size: 12px; }
.card .brand { margin-top: 6px; color: #8a9099; font-size: 10px; }
`;
  }
})();
