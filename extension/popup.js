/*
 * Homograph Defender — ポップアップ
 * 現在のタブのドメインを1文字ずつのブロックに分け、怪しい文字の一覧・各種の突き合わせ結果を表示する。
 * 文字列は createElement と textContent だけで組み立てる(innerHTML・eval は使わない)。
 */
(() => {
  'use strict';

  const D = globalThis.HDDetector;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function section(title, ...children) {
    const box = el('section', 'block');
    box.append(el('h2', null, title), ...children);
    return box;
  }

  function statusPanel(result) {
    const box = el('section', 'status ' + result.level);
    let head;
    if (result.level === 'safe') {
      head = '✓ 文字のなりすましはありません(英数字・ハイフン・ドットだけのドメイン)';
    } else {
      const n = result.suspicious.length;
      const what = result.onlyAsciiSymbols ? '標準外の記号' : 'ASCII以外の文字・異常な文字';
      head = '⚠ 危険度「' + result.levelLabel + '」: ' + (n ? what + 'を ' + n + ' 個検出' : 'Punycode の異常を検出');
    }
    box.append(el('p', 'status-head', head));
    if (result.level !== 'safe' && result.reasons[0]) box.append(el('p', 'status-text', result.reasons[0]));
    if (result.level === 'safe') box.append(el('p', 'status-text', '詐欺サイトかどうかなど、サイトそのものの安全性は判定していません。'));
    return box;
  }

  function charBlocks(result) {
    const wrap = el('div', 'blocks');
    wrap.setAttribute('dir', 'ltr');
    for (const c of result.chars) {
      const cls = ['blk', c.safe ? 'ok' : 'ng'];
      if (c.ch === '.' && c.safe) cls.push('dot');
      if (c.placeholder) cls.push('ph');
      const blk = el('div', cls.join(' '));
      blk.append(el('span', 'g', c.safe ? c.ch : D.displayText(c)), el('span', 'n', String(c.position)));
      blk.title = c.position + '文字目 ' + c.hex + ' ' + D.categoryLabel(c);
      wrap.append(blk);
    }
    return wrap;
  }

  function checkList(result) {
    const items = [];
    const add = (state, text) => items.push([state, text]);

    add(result.isPunycode ? 'ng' : 'ok', result.isPunycode ? 'Punycode（xn--）ドメインです' : 'Punycode（xn--）は使われていません');
    add(
      result.suspicious.length ? 'ng' : 'ok',
      result.suspicious.length ? 'ASCII以外・標準外の文字: ' + result.suspicious.length + ' 個' : 'ASCII以外の文字はありません',
    );

    const risky = result.labels.filter((l) => l.mixedScriptRisk);
    const mixedOk = result.labels.filter((l) => l.mixedScript && !l.mixedScriptRisk);
    const scriptNames = (l) => l.scripts.map((s) => D.scriptLabel(s)).join(' + ');
    if (risky.length) for (const l of risky) add('ng', '混合スクリプト「' + D.visibleText(l.unicode) + '」: ' + scriptNames(l));
    else if (mixedOk.length) for (const l of mixedOk) add('info', '「' + D.visibleText(l.unicode) + '」: ' + scriptNames(l) + '(日本語・中国語・韓国語との通常の組み合わせ)');
    else add('ok', '1つのラベルの中で文字体系は混ざっていません');

    if (result.lookalike && result.lookalike.strong) add('ng', '英字の「' + result.lookalike.text + '」に見えるなりすましの形です');
    else if (result.lookalike) add('info', '英字の「' + result.lookalike.text + '」と見分けにくい文字があります');
    else add('ok', '英字だけのドメインに見せかける形ではありません');

    add(
      result.hiddenCount ? 'ng' : 'ok',
      result.hiddenCount ? '見えない文字・制御文字・特殊スペース: ' + result.hiddenCount + ' 個' : '見えない文字・制御文字はありません',
    );

    if (result.checks.roundTrip === 'ok') add('ok', 'Punycode の解読→再変換が元の表記と一致');
    if (result.checks.roundTrip === 'ng') add('ng', result.checks.invalidPunycode ? 'Punycode として解読できないラベルがあります' : 'Punycode の解読→再変換が元の表記と一致しません');
    if (result.checks.browserMatch === 'ok') add('ok', 'ブラウザ自身の変換結果とも一致');
    if (result.checks.browserMatch === 'ng') add('ng', 'ブラウザ自身の変換結果と一致しません');
    if (result.userinfo != null) add('ng', '「@」より前は接続先ではありません(ユーザー名の欄を使った偽装)');

    const list = el('ul', 'checks');
    for (const [state, text] of items) {
      const li = el('li', state);
      li.append(el('span', 'mark', state === 'ok' ? '✓' : state === 'ng' ? '✕' : 'i'), el('span', null, text));
      list.append(li);
    }
    return list;
  }

  function charTable(result) {
    if (!result.suspicious.length) return el('p', 'empty', 'ASCII以外の文字・異常な文字はありません。');
    const table = el('table', 'chars');
    const head = el('tr');
    for (const h of ['No.', '文字', '位置', '文字体系', 'コードポイント', '備考']) head.append(el('th', null, h));
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    result.suspicious.forEach((c, i) => {
      const tr = el('tr');
      const chCell = el('td', 'ch');
      chCell.append(el('span', 'cell-ch' + (c.placeholder ? ' ph' : ''), D.displayText(c)));
      const notes = [];
      if (c.name) notes.push(c.name);
      if (c.lookalike) notes.push('「' + c.lookalike.text + '」に似ている');
      tr.append(
        el('td', 'num', String(i + 1)),
        chCell,
        el('td', 'pos', c.position + '文字目'),
        el('td', null, D.categoryLabel(c)),
        el('td', 'cp', c.hex),
        el('td', 'memo', notes.join(' / ') || '—'),
      );
      tbody.append(tr);
    });
    table.append(thead, tbody);
    return table;
  }

  function punycodeSection(result) {
    const children = [el('code', 'puny', result.ascii)];
    if (result.source === 'manual') {
      if (result.browserOpenable === false) children.push(el('p', 'sub', 'ブラウザでは開けない表記です(上は文字をそのまま Punycode にした値)'));
      else if (result.directAscii && result.directAscii.toLowerCase() !== result.ascii) {
        children.push(el('p', 'sub', '文字をそのまま Punycode にすると ' + result.directAscii + ' ですが、ブラウザは上の接続先に変換して開きます'));
      }
    }
    return section('実際の通信名（Punycode）', ...children);
  }

  function renderResult(result, caption) {
    const frag = document.createDocumentFragment();
    if (caption) frag.append(el('p', 'caption', caption));
    frag.append(statusPanel(result));
    frag.append(section('表示上のドメイン（1文字ずつ・下の数字は何文字目か）', charBlocks(result)));
    frag.append(punycodeSection(result));
    const reasonList = el('ul', 'reasons');
    for (const r of result.reasons) reasonList.append(el('li', null, r));
    if (result.reasons.length) frag.append(section('警告の理由', reasonList));
    frag.append(section('チェック結果', checkList(result)));
    frag.append(section('検出した文字（' + result.suspicious.length + '）', charTable(result)));
    if (result.notes && result.notes.length) {
      const notes = el('ul', 'notes');
      for (const n of result.notes) notes.append(el('li', null, n));
      frag.append(section('補足', notes));
    }
    return frag;
  }

  async function currentTab() {
    // ?tabId=N は検品用(拡張機能の中のページからしか開けない)
    const id = new URLSearchParams(location.search).get('tabId');
    if (id && /^\d+$/.test(id)) return chrome.tabs.get(Number(id));
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function showCurrent() {
    const main = document.getElementById('current');
    let tab = null;
    try {
      tab = await currentTab();
    } catch (e) {
      tab = null;
    }
    const result = tab && tab.url ? D.analyzeUrl(tab.url) : null;
    if (!result) {
      main.replaceChildren(el('p', 'notice', 'このページ(chrome:// や拡張機能のページなど)は検査の対象外です。http / https のページで使えます。下の欄に貼り付けて調べることもできます。'));
      return;
    }
    main.replaceChildren(renderResult(result, '現在のタブ: ' + D.visibleText(result.unicode)));
  }

  document.getElementById('manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const out = document.getElementById('manual-result');
    const value = document.getElementById('manual-input').value;
    const result = D.analyzeInput(value);
    if (!result) {
      out.replaceChildren(el('p', 'notice', 'ドメインを読み取れませんでした。https://example.com のような形で貼り付けてください。'));
      return;
    }
    out.replaceChildren(renderResult(result, '貼り付けたドメイン: ' + D.visibleText(result.host)));
  });

  showCurrent();
})();
