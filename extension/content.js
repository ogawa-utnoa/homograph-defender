/*
 * Homograph Defender — ページ最上部の警告バナー(content script)
 *
 * ・判定は content script の隔離された世界(isolated world)で行う。ページの JS は location や DOM の関数を差し替えられない
 * ・バナーは closed の Shadow DOM の中に作り、ページの CSS・JS から中身を参照・変更できないようにする
 * ・文字列は createElement と textContent だけで組み立てる(innerHTML・eval は使わない)
 * ・ページがバナーを外す・隠す・上に重ねる妨害には、見張り(MutationObserver と1秒ごとの見回り)で戻す
 * ・安全なページでは DOM に一切触れない
 */
(() => {
  'use strict';

  if (window.top !== window) return;
  const D = globalThis.HDDetector;
  if (!D || globalThis.__homographDefenderLoaded) return;
  globalThis.__homographDefenderLoaded = true;

  let result = null;
  try {
    result = D.analyzeUrl(location.href);
  } catch (e) {
    result = null;
  }

  // バッジを付け直してもらう(service worker は送信元の URL で判定し直すので、ここでは結果を送らない)
  try {
    const sent = chrome.runtime.sendMessage({ type: 'hd:page-checked' });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch (e) {
    /* 拡張機能の再読み込み直後など */
  }

  if (!result || result.level === 'safe') return;
  if (document.documentElement && document.documentElement.namespaceURI !== 'http://www.w3.org/1999/xhtml') return; // SVG・XML の文書には出さない

  // ---------------- 部品 ----------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function domainView(extraClass) {
    const box = el('div', 'url ' + extraClass);
    box.setAttribute('dir', 'ltr');
    for (const c of result.chars) {
      if (c.safe) {
        box.append(el('span', 'c', c.ch));
        continue;
      }
      const bad = el('span', 'c bad' + (c.placeholder ? ' ph' : ''), D.displayText(c));
      bad.title = c.position + '文字目 ' + c.hex + ' ' + D.categoryLabel(c);
      box.append(bad);
    }
    return box;
  }

  function headline() {
    if (result.onlyAsciiSymbols) return '⚠️ 警告: このサイトのURLには標準外の記号が含まれています！';
    if (!result.suspicious.length && result.isPunycode) return '⚠️ 警告: このサイトのURLは不正な Punycode（xn--）を使っています！';
    return '⚠️ 警告: このサイトのURLにはローマ字（ASCII）以外の文字が含まれています！';
  }

  // ---------------- 中身 ----------------
  const bar = el('div', 'bar');
  bar.setAttribute('role', 'alert');
  bar.setAttribute('lang', 'ja');

  const full = el('div', 'full');
  const head = el('div', 'head');
  head.append(el('p', 'title', headline()));
  const collapseBtn = el('button', 'btn', '折りたたむ ▲');
  collapseBtn.type = 'button';
  head.append(collapseBtn);
  full.append(head);

  const tags = el('div', 'tags');
  tags.append(el('span', 'tag', '危険度: ' + result.levelLabel));
  if (result.isPunycode) tags.append(el('span', 'tag', 'Punycodeドメインです'));
  if (result.suspicious.length) tags.append(el('span', 'tag', '怪しい文字 ' + result.suspicious.length + ' 個'));
  if (result.checks.mixedScriptRisk) tags.append(el('span', 'tag', '混合スクリプト'));
  if (result.hiddenCount) tags.append(el('span', 'tag', '見えない文字 ' + result.hiddenCount + ' 個'));
  for (const name of result.scriptsUsed.slice(0, 4)) tags.append(el('span', 'tag', name));
  full.append(tags);

  const urls = el('div', 'urls');
  const fieldMain = el('div', 'field main');
  fieldMain.append(el('div', 'cap', '表示上のドメイン（デコード後）'), domainView('big'));
  const fieldPuny = el('div', 'field puny');
  fieldPuny.append(el('div', 'cap', '実際の通信名（Punycode）'), el('code', 'puny-text', result.ascii));
  urls.append(fieldMain, fieldPuny);
  full.append(urls);

  if (result.lookalike && result.lookalike.strong) {
    const look = el('p', 'look');
    look.append('見た目は ', el('span', 'look-host', result.lookalike.text), ' ですが、別のサイトです。');
    full.append(look);
  }

  const reasons = el('ul', 'reasons');
  for (const r of result.reasons.slice(0, 4)) reasons.append(el('li', null, r));
  full.append(reasons);
  full.append(
    el('p', 'advice', 'このページでパスワード・カード番号・個人情報を入力しないでください。公式サイトはブックマークや公式アプリから開き直してください。'),
    el('p', 'note', 'Homograph Defender(拡張機能)の表示です。文字ごとの詳しい分析はツールバーのアイコンから確認できます。'),
  );

  const mini = el('div', 'mini');
  mini.hidden = true;
  mini.append(el('span', 'label', '⚠️ ASCII以外の文字を含むドメイン'), domainView('small'), el('code', 'puny-text', result.ascii), el('span', 'spacer'));
  const expandBtn = el('button', 'btn', '詳細を表示 ▼');
  expandBtn.type = 'button';
  mini.append(expandBtn);

  bar.append(el('div', 'stripe'), full, mini, el('div', 'stripe thin'));

  // 折りたたんでも細い帯は残す(警告を完全には消せない)。ページが作った合成クリックでは動かさない
  collapseBtn.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    full.hidden = true;
    mini.hidden = false;
    expandBtn.focus();
  });
  expandBtn.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    mini.hidden = true;
    full.hidden = false;
    collapseBtn.focus();
  });

  const style = el('style', null, CSS_TEXT());

  // ---------------- 外側の要素(ページの DOM に置く唯一の要素) ----------------
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  const host = document.createElement('hd-alert-' + suffix); // 名前を毎回変え、ページの CSS から狙い撃ちされにくくする
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.append(style, bar);

  // ページの CSS より強い「要素に直接付けた !important」で、外側の見た目を固定する
  const HOST_STYLE = [
    ['all', 'initial'],
    ['display', 'block'],
    ['position', 'fixed'],
    ['top', '0px'],
    ['left', '0px'],
    ['right', '0px'],
    ['bottom', 'auto'],
    ['width', '100%'],
    ['min-width', '0px'],
    ['max-width', 'none'],
    ['height', 'auto'],
    ['min-height', '0px'],
    ['max-height', 'none'],
    ['margin', '0px'],
    ['padding', '0px'],
    ['border', '0px none'],
    ['background', 'transparent'],
    ['overflow', 'visible'],
    ['z-index', '2147483647'],
    ['visibility', 'visible'],
    ['opacity', '1'],
    ['transform', 'none'],
    ['translate', 'none'],
    ['scale', 'none'],
    ['rotate', 'none'],
    ['filter', 'none'],
    ['clip-path', 'none'],
    ['mask', 'none'],
    ['pointer-events', 'auto'],
    ['contain', 'none'],
    ['zoom', '1'],
  ];
  let expectedStyle = null;
  function applyHostStyle() {
    host.removeAttribute('style');
    for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, 'important');
    expectedStyle = host.getAttribute('style');
  }

  // popover(manual)で最前面の層(top layer)に出す。ページの z-index では上に重ねられない
  const canPopover = typeof host.showPopover === 'function';
  host.setAttribute('popover', 'manual');
  let raising = false;
  let belowUs = new WeakSet();

  function isOpen() {
    if (!canPopover) return true;
    try {
      return host.matches(':popover-open');
    } catch (e) {
      return true;
    }
  }

  function topLayerElements() {
    const found = new Set();
    for (const selector of [':popover-open', ':modal', ':fullscreen']) {
      try {
        for (const node of document.querySelectorAll(selector)) if (node !== host) found.add(node);
      } catch (e) {
        /* 未対応のセレクタ */
      }
    }
    return found;
  }

  function rememberBelow() {
    belowUs = new WeakSet();
    for (const node of topLayerElements()) belowUs.add(node);
  }

  function show(forceToTop) {
    if (!canPopover || !host.isConnected) return;
    raising = true;
    try {
      if (forceToTop && isOpen()) host.hidePopover();
      if (!isOpen()) host.showPopover();
    } catch (e) {
      /* noop */
    }
    raising = false;
    rememberBelow();
  }

  function overlapsUs(node) {
    const a = host.getBoundingClientRect();
    const b = node.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top;
  }

  // 私たちより後に最前面へ出た要素(ダイアログ・ポップオーバー・全画面)がバナーに重なったら、もう一度いちばん上へ
  function raiseIfCovered() {
    for (const node of topLayerElements()) {
      if (!belowUs.has(node) && overlapsUs(node)) {
        show(true);
        return;
      }
    }
  }

  const observer = new MutationObserver(() => ensure());
  function observeTargets() {
    observer.disconnect();
    observer.observe(document, { childList: true });
    if (document.documentElement) observer.observe(document.documentElement, { childList: true });
    observer.observe(host, { attributes: true });
  }

  let burstStart = 0;
  let burstCount = 0;
  function ensure() {
    const now = Date.now();
    if (now - burstStart > 1000) {
      burstStart = now;
      burstCount = 0;
    }
    // 外す・戻すの応酬でページが固まらないよう、1秒に40回を超えたら残りは1秒ごとの見回りに任せる
    if (++burstCount > 40) return;
    const root = document.documentElement;
    if (!root) return;
    if (host.parentNode !== root) {
      root.appendChild(host);
      observeTargets();
    }
    for (const attr of Array.from(host.attributes)) {
      if (attr.name !== 'style' && attr.name !== 'popover') host.removeAttribute(attr.name); // hidden・inert・class など
    }
    if (host.getAttribute('popover') !== 'manual') host.setAttribute('popover', 'manual');
    if (host.getAttribute('style') !== expectedStyle) applyHostStyle();
    if (!isOpen()) show(false);
    observer.takeRecords(); // 自分の変更で起きた通知は捨てる
  }

  host.addEventListener('toggle', (e) => {
    if (!raising && e.newState === 'closed') setTimeout(ensure, 0);
  });
  document.addEventListener(
    'toggle',
    (e) => {
      if (e.target !== host && e.newState === 'open') setTimeout(() => e.target.isConnected && overlapsUs(e.target) && show(true), 0);
    },
    true,
  );
  document.addEventListener('fullscreenchange', () => setTimeout(() => document.fullscreenElement && show(true), 0), true);

  function mount() {
    if (!document.documentElement) return false;
    applyHostStyle();
    document.documentElement.appendChild(host);
    observeTargets();
    show(false);
    observer.takeRecords();
    return true;
  }

  if (!mount()) {
    // まだ <html> が無い瞬間に読み込まれたときは、できた時点で出す
    const wait = new MutationObserver(() => {
      if (mount()) wait.disconnect();
    });
    wait.observe(document, { childList: true });
  }

  // 解析が終わったら <html> の末尾へ移す(<head> より前に要素があると困るページへの配慮)
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      const root = document.documentElement;
      if (root && root.lastElementChild !== host) {
        root.appendChild(host);
        show(false);
        observer.takeRecords();
      }
    },
    { once: true },
  );

  setInterval(() => {
    burstCount = 0;
    ensure();
    raiseIfCovered();
  }, 1000);

  // ---------------- 見た目 ----------------
  function CSS_TEXT() {
    const mono = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Noto Sans Mono", "Hiragino Sans", monospace';
    return `
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.bar {
  display: block; margin: 0; padding: 0; direction: ltr; text-align: left;
  font-family: system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans JP", Meiryo, sans-serif;
  font-size: 14px; line-height: 1.5; font-weight: 400; font-style: normal; letter-spacing: normal; text-transform: none;
  color: #ffffff; background: #8b0000; box-shadow: 0 3px 14px rgba(0, 0, 0, 0.45);
}
.stripe { height: 8px; background: repeating-linear-gradient(-45deg, #ffd400 0 10px, #c40000 10px 20px); }
.stripe.thin { height: 4px; }
.full { padding: 10px 16px 12px; max-height: 70vh; overflow: auto; }
.head { display: flex; align-items: flex-start; gap: 12px; }
.title { flex: 1 1 auto; margin: 0; font-size: 18px; font-weight: 800; line-height: 1.4; color: #ffffff; }
.btn {
  flex: none; appearance: none; margin: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 700; line-height: 1.4;
  color: #ffffff; background: rgba(0, 0, 0, 0.28); border: 1px solid rgba(255, 255, 255, 0.8); border-radius: 4px; padding: 3px 10px; white-space: nowrap;
}
.btn:hover { background: rgba(0, 0, 0, 0.45); }
.btn:focus-visible { outline: 2px solid #ffd400; outline-offset: 2px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.tag { font-size: 12px; font-weight: 700; line-height: 1.7; padding: 0 8px; border-radius: 3px; background: #ffd400; color: #3d0000; }
.urls { display: flex; flex-wrap: wrap; gap: 10px 14px; margin-top: 10px; align-items: flex-end; }
.field { min-width: 0; }
.field.main { flex: 3 1 420px; }
.field.puny { flex: 2 1 260px; }
.cap { font-size: 12px; font-weight: 700; color: #ffd6d6; margin-bottom: 3px; }
.url {
  display: block; background: #ffffff; color: #1a1a1a; border-radius: 8px; padding: 6px 12px;
  font-family: ${mono}; font-size: 26px; font-weight: 500; line-height: 1.55; word-break: break-all; overflow-wrap: anywhere;
}
.c { unicode-bidi: isolate; }
.c.bad {
  display: inline-block; margin: 0 2px; padding: 0 3px; line-height: 1.2; vertical-align: baseline;
  background: #e00000; color: #ffffff; font-weight: 800; border: 3px solid #6d0000; border-radius: 4px;
}
.c.bad.ph { color: #ffeb3b; font-size: 0.55em; padding: 2px 4px; vertical-align: middle; }
.puny-text {
  display: block; background: #3b0000; color: #ffd400; border: 1px dashed rgba(255, 212, 0, 0.85); border-radius: 8px;
  padding: 9px 12px; font-family: ${mono}; font-size: 18px; line-height: 1.4; word-break: break-all;
}
.look { margin: 10px 0 0; font-size: 15px; font-weight: 800; }
.look-host { font-family: ${mono}; color: #ffd400; padding: 0 2px; }
.reasons { margin: 8px 0 0; padding: 0 0 0 20px; font-size: 13px; }
.reasons li { margin: 2px 0; }
.advice { margin: 8px 0 0; font-size: 14px; font-weight: 800; color: #fff3b0; }
.note { margin: 4px 0 0; font-size: 11px; color: #ffd6d6; }
.mini { display: flex; align-items: center; gap: 10px; padding: 5px 12px; }
.mini .label { font-weight: 800; font-size: 13px; white-space: nowrap; }
.mini .url { flex: 0 1 auto; min-width: 0; font-size: 15px; padding: 1px 8px; border-radius: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; word-break: normal; }
.mini .c.bad { border-width: 2px; margin: 0 1px; padding: 0 2px; }
.mini .puny-text { flex: 0 1 auto; min-width: 0; font-size: 12px; padding: 2px 8px; border-radius: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini .spacer { flex: 1 1 auto; }
@media (max-width: 640px) {
  .title { font-size: 15px; }
  .url { font-size: 20px; }
  .mini .label { display: none; }
}
`;
  }
})();
