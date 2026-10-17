/*
 * Homograph Defender — service worker
 *
 * タブの URL が変わるたびにホスト名を調べ、ツールバーのアイコンにバッジを付ける。
 *   安全(a-z 0-9 - . だけ)… 緑の「✓」
 *   ASCII 以外・Punycode・不可視文字などを検出 … 赤の「!」
 * バッジはブラウザの枠(ページの外)に出るので、訪問先のページからは消せない。最後の頼りになる表示。
 * 判定はローカルの detector.js だけで行い、外部へは何も送らない。
 */
importScripts('punycode.js', 'detector.js');

const D = self.HDDetector;

const BADGE = {
  danger: { text: '!', color: '#C62828' },
  warning: { text: '!', color: '#C62828' },
  safe: { text: '✓', color: '#2E7D32' },
};
const NAME = 'Homograph Defender';

function titleFor(result) {
  if (result.level === 'safe') return NAME + ': 文字のなりすましなし(' + result.host + ' は英数字・ハイフン・ドットだけです。サイトそのものの安全性は判定していません)';
  const head = NAME + ': 危険度「' + result.levelLabel + '」 ' + D.visibleText(result.unicode);
  const body = result.reasons.slice(0, 3).map((r) => '・' + r).join('\n');
  return (head + '\n' + body).slice(0, 600);
}

async function updateTab(tabId, url) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  let result = null;
  try {
    result = url ? D.analyzeUrl(url) : null;
  } catch (e) {
    result = null;
  }
  try {
    if (!result) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: NAME + '(このページは検査の対象外です)' });
      return;
    }
    const badge = BADGE[result.level];
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' });
    await chrome.action.setBadgeText({ tabId, text: badge.text });
    await chrome.action.setTitle({ tabId, title: titleFor(result) });
  } catch (e) {
    // タブが閉じられた・差し替えられた等。次のイベントで付け直す
  }
}

async function refreshAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => updateTab(t.id, t.url)));
  } catch (e) {
    /* noop */
  }
}

// ページを移動するとタブごとのバッジはブラウザが消すので、URL の確定時と読み込み完了時の両方で付け直す
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status) updateTab(tabId, tab.url);
});

// 先読みしたページへの切り替えなどでタブが差し替わったとき
chrome.tabs.onReplaced.addListener(async (addedTabId) => {
  try {
    const tab = await chrome.tabs.get(addedTabId);
    updateTab(tab.id, tab.url);
  } catch (e) {
    /* noop */
  }
});

chrome.runtime.onInstalled.addListener(refreshAllTabs);
chrome.runtime.onStartup.addListener(refreshAllTabs);

// content script からの「ページを開いた」の知らせ。中身は信用せず、ブラウザが付ける送信元の URL で判定し直す
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (!message || message.type !== 'hd:page-checked') return false;
  if (!sender.tab || sender.frameId !== 0) return false;
  if (sender.documentLifecycle && sender.documentLifecycle !== 'active') return false;
  updateTab(sender.tab.id, sender.url).then(() => sendResponse({ ok: true }));
  return true;
});
