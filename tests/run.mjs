// Homograph Defender の自動検品。ログイン・外部通信なし(テスト用のドメインはすべて Playwright の route で手元のページを返す)
// 1) punycode.js / detector.js / links.js の単体テスト(RFC 3492 の試験値・Node の IDNA 変換との突き合わせ・各種の文字・メールのリンク)
// 2) ソースの静的検査(innerHTML・eval・外部通信が無いこと、manifest の権限)
// 3) Chromium に拡張を読み込み、バッジ・バナー・折りたたみ・妨害への耐性・ポップアップ・Gmail のリンク検査を通しで確かめる
// 実行: npm test   (画面の写しは tests/output/*.png)
// ブラウザ: npx playwright-core install chromium で入る Chromium を使う。別の Chromium を使うときは CHROME_PATH を指定
import path from "node:path";
import fs from "node:fs";
import url from "node:url";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "tests/output");
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
const P = require(path.join(EXT, "punycode.js"));
const D = require(path.join(EXT, "detector.js"));
const LK = require(path.join(EXT, "links.js"));

const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  — " + extra : ""}`);
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const throwsCode = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code || e.name;
  }
};

// ================= 1) 単体テスト =================
{
  // RFC 3492 7.1 の試験値
  const RFC = [
    ["他们为什么不说中文", "ihqwcrb4cv8a8dqg056pqjye"],
    ["他們爲什麽不說中文", "ihqwctvzc91f659drss3x8bo0yb"],
    ["Pročprostěnemluvíčesky", "Proprostnemluvesky-uyb24dma41a"],
    ["למההםפשוטלאמדבריםעברית", "4dbcagdahymbxekheh6e0a7fei0b"],
    ["почемужеонинеговорятпорусски", "b1abfaaepdrnnbgefbadotcwatmq2g4l"],
    ["PorquénopuedensimplementehablarenEspañol", "PorqunopuedensimplementehablarenEspaol-fmd56a"],
    ["TạisaohọkhôngthểchỉnóitiếngViệt", "TisaohkhngthchnitingVit-kjcr8268qyxafd2f1b9g"],
    ["なぜみんな日本語を話してくれないのか", "n8jok5ay5dzabd5bym9f0cm5685rrjetr6pdxa"],
    ["3年B組金八先生", "3B-ww4c5e180e575a65lsy2b"],
    ["安室奈美恵-with-SUPER-MONKEYS", "-with-SUPER-MONKEYS-pc58ag80a8qai00g7n9n"],
    ["Hello-Another-Way-それぞれの場所", "Hello-Another-Way--fc4qua05auwb3674vfr0b"],
    ["ひとつ屋根の下2", "2-u9tlzr9756bt3uc0v"],
    ["MajiでKoiする5秒前", "MajiKoi5-783gue6qz075azm5e"],
    ["パフィーdeルンバ", "de-jg4avhby1noc0d"],
    ["そのスピードで", "d9juau41awczczp"],
    ["-> $1.00 <-", "-> $1.00 <--"],
  ];
  let encOk = 0;
  let decOk = 0;
  for (const [u, a] of RFC) {
    if (P.encode(u) === a) encOk++;
    else ok(`RFC encode ${u}`, false, P.encode(u));
    if (P.decode(a) === u) decOk++;
    else ok(`RFC decode ${a}`, false, P.decode(a));
  }
  eq("RFC 3492 の試験値: encode が全件一致", encOk, RFC.length);
  eq("RFC 3492 の試験値: decode が全件一致", decOk, RFC.length);
  ok("decode は大文字の Punycode も読める", P.decode("B1ABFAAEPDRNNBGEFBADOTCWATMQ2G4L") === "почемужеонинеговорятпорусски");

  // Node(ICU/ada)の IDNA 変換と突き合わせる
  const samples = ["pаypal", "αpple", "аpple", "аррӏе", "bücher", "mañana", "日本語", "例え", "テスト", "☃-⌘", "ドメイン名例", "مثال", "δοκιμή", "испытание", "उदाहरण", "실험", "ไทย"];
  let idnaOk = 0;
  for (const s of samples) {
    const expect = url.domainToASCII(s + ".com");
    const mine = P.toASCII(s + ".com");
    if (expect === mine) idnaOk++;
    else ok(`IDNA 突き合わせ ${s}`, false, `${mine} vs ${expect}`);
  }
  eq("Node の IDNA 変換と toASCII が一致", idnaOk, samples.length);

  // ランダムな文字列で 往復(decode(encode(x)) === x) と Node との一致を確かめる
  const pools = [
    [0x61, 0x7a], [0x30, 0x39], [0xe0, 0xff], [0x100, 0x17f], [0x3b1, 0x3c9], [0x430, 0x44f], [0x5d0, 0x5ea],
    [0x627, 0x64a], [0x3041, 0x3096], [0x30a1, 0x30fa], [0x4e00, 0x4fff], [0xac00, 0xad00], [0x1f600, 0x1f64f],
  ];
  let seed = 20261015;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  let rt = 0;
  let nodeSame = 0;
  let nodeCompared = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    let s = "";
    const len = 1 + rnd(14);
    for (let j = 0; j < len; j++) {
      const [a, b] = pools[rnd(pools.length)];
      s += String.fromCodePoint(a + rnd(b - a + 1));
    }
    if (P.decode(P.encode(s)) === s) rt++;
    // Node は IDNA の置き換え(ſ→s・ĳ→ij など)をしてから変換するので、置き換え後の文字列どうしで比べる
    const expect = url.domainToASCII(s);
    if (expect && expect.startsWith("xn--") && !expect.includes(".")) {
      const mapped = url.domainToUnicode(expect);
      nodeCompared++;
      if (expect === "xn--" + P.encode(mapped) && P.decode(expect.slice(4)) === mapped) nodeSame++;
    }
  }
  eq(`ランダム ${N} 件: decode(encode(x)) が元に戻る`, rt, N);
  ok(`ランダム: Node の IDNA と一致(${nodeSame}/${nodeCompared} 件)`, nodeCompared > 1000 && nodeSame === nodeCompared, `${nodeSame}/${nodeCompared}`);

  // 不正な Punycode は寛容に読まず、例外で止める
  eq("decode: 区切りの前に非 ASCII → 例外", throwsCode(() => P.decode("ab€-x")), "not-basic");
  eq("decode: 使えない記号 → 例外", throwsCode(() => P.decode("ab-!!")), "bad-digit");
  eq("decode: 途中で終わる → 例外", throwsCode(() => P.decode("ab-z")), "truncated");
  eq("decode: 桁あふれ → 例外", throwsCode(() => P.decode("99999999999999")), "overflow");
  eq("decodeLabel: 例外にせず error を返す", P.decodeLabel("xn--ab-!!").error, "bad-digit");

  // ---- detector ----
  const pp = D.analyzeHost("xn--pypal-4ve.com");
  eq("pаypal: デコード結果", pp.unicode, "pаypal.com");
  eq("pаypal: 危険度 高", pp.level, "danger");
  eq("pаypal: 怪しい文字は2文字目のキリル文字 U+0430", pp.suspicious.map((c) => [c.position, c.script, c.hex, c.lookalike && c.lookalike.text]), [[2, "Cyrillic", "U+0430", "a"]]);
  eq("pаypal: 文字体系の表示", D.categoryLabel(pp.suspicious[0]), "キリル文字 (Cyrillic)");
  eq("pаypal: 見た目は paypal.com", pp.lookalike, { text: "paypal.com", strong: true });
  eq("pаypal: 混合スクリプト・往復・ブラウザ一致", [pp.checks.mixedScriptRisk, pp.checks.roundTrip, pp.checks.browserMatch], [true, "ok", "ok"]);
  ok("pаypal: 理由に Punycode と通信名", pp.reasons.some((r) => r.includes("xn--pypal-4ve.com")));

  const ap = D.analyzeHost("xn--pple-zld.com");
  eq("αpple: ギリシャ文字 U+03B1 が1文字目", [ap.unicode, ap.level, ap.suspicious[0].position, ap.suspicious[0].script, ap.suspicious[0].hex], ["αpple.com", "danger", 1, "Greek", "U+03B1"]);

  const whole = D.analyzeHost("xn--80ak6aa92e.com");
  eq("аррӏе(全部キリル文字): 混合ではないが apple.com に見える → 高", [whole.unicode, whole.checks.mixedScriptRisk, whole.lookalike && whole.lookalike.text, whole.level], ["аррӏе.com", false, "apple.com", "danger"]);

  const jp = D.analyzeHost("xn--wgv71a119e.jp");
  eq("日本語.jp: 注意(赤い警告は出す)", [jp.unicode, jp.level, jp.suspicious.length, jp.lookalike], ["日本語.jp", "warning", 3, null]);
  const jpMix = D.analyzeHost(url.domainToASCII("utnoaテスト.jp"));
  eq("ラテン文字+カタカナは通常の組み合わせ(混合スクリプトの危険にしない)", [jpMix.checks.mixedScript, jpMix.checks.mixedScriptRisk, jpMix.level], [true, false, "warning"]);

  eq("example.com: 安全", [D.analyzeHost("example.com").level, D.analyzeHost("example.com").suspicious.length], ["safe", 0]);
  eq("ハイフン・数字・大文字も安全", D.analyzeHost("Sub-Domain.Example-1.CO.JP").level, "safe");
  eq("http://[::1]:8080/ は安全(IPv6)", D.analyzeUrl("http://[::1]:8080/").level, "safe");
  eq("_dmarc.example.com: 標準外の記号 → 注意", [D.analyzeHost("_dmarc.example.com").level, D.analyzeHost("_dmarc.example.com").onlyAsciiSymbols], ["warning", true]);
  eq("chrome:// は対象外", D.analyzeUrl("chrome://extensions/"), null);
  eq("file:// は対象外", D.analyzeUrl("file:///tmp/a.html"), null);
  eq("xn--abc-(中身が ASCII だけ)は不正", [D.analyzeHost("xn--abc-.com").checks.invalidPunycode, D.analyzeHost("xn--abc-.com").level], [true, "danger"]);
  eq("xn--ab-!! は不正", D.analyzeHost("xn--ab-!!.com").checks.invalidPunycode, true);

  // 不可視・特殊文字の網羅
  const CASES = [
    ["​", "invisible", "[不可視: U+200B]"],
    ["‌", "invisible", "[不可視: U+200C]"],
    ["‍", "invisible", "[不可視: U+200D]"],
    ["⁠", "invisible", "[不可視: U+2060]"],
    ["﻿", "invisible", "[不可視: U+FEFF]"],
    ["­", "invisible", "[不可視: U+00AD]"],
    ["ㅤ", "invisible", "[不可視: U+3164]"],
    ["⠀", "invisible", "[不可視: U+2800]"],
    ["‮", "bidi", "[双方向制御: U+202E]"],
    ["⁦", "bidi", "[双方向制御: U+2066]"],
    ["‏", "bidi", "[双方向制御: U+200F]"],
    ["️", "variation", "[不可視: U+FE0F]"],
    ["\u{E0100}", "variation", "[不可視: U+E0100]"],
    ["\u{E0041}", "tag", "[不可視: U+E0041]"],
    [" ", "space", "[空白: U+00A0]"],
    ["　", "space", "[空白: U+3000]"],
    [" ", "space", "[空白: U+2009]"],
    ["\u0007", "control", "[制御: U+0007]"],
    ["\u0085", "control", "[制御: U+0085]"],
    ["́", "combining", "◌́"],
    ["\u{1D429}", "math", "\u{1D429}"],
    ["ℓ", "letterlike", "ℓ"],
    ["ｐ", "fullwidth", "ｐ"],
    ["ⓐ", "enclosed", "ⓐ"],
    ["²", "modifier", "²"],
    ["ⅼ", "numberForm", "ⅼ"],
    ["ﬁ", "ligature", "ﬁ"],
    ["∕", "punctLookalike", "∕"],
    ["。", "punctLookalike", "。"],
    ["‐", "punctLookalike", "‐"],
    ["", "privateUse", "[私用: U+E000]"],
    ["\uD800", "surrogate", "[不正: U+D800]"],
    ["͸", "unassigned", "[未割当: U+0378]"],
    ["☃", "symbol", "☃"],
  ];
  let caseOk = 0;
  for (const [ch, cat, shown] of CASES) {
    const info = D.classifyChar(ch);
    if (info.category === cat && D.displayText(info) === shown && !info.safe) caseOk++;
    else ok(`分類 ${info.hex}`, false, `${info.category} ${D.displayText(info)} want ${cat} ${shown}`);
  }
  eq(`特殊文字 ${CASES.length} 種の分類と表示`, caseOk, CASES.length);
  eq("見た目の候補: 𝐩→p ℓ→l ｐ→p ⅼ→l ı→i", ["\u{1D429}", "ℓ", "ｐ", "ⅼ", "ı"].map((c) => D.lookalikeOf(c).text), ["p", "l", "p", "l", "i"]);

  // 貼り付け検査(ブラウザが正規化する前の生の文字列)
  const zw = D.analyzeInput("https://pay​pal.com/login");
  eq("貼り付け: pay[ZWSP]pal.com → 不可視を検出・ブラウザでは paypal.com", [zw.level, zw.hiddenCount, zw.suspicious[0].placeholder, zw.browserHost, zw.lookalike.text], ["danger", 1, "[不可視: U+200B]", "paypal.com", "paypal.com"]);
  const rlo = D.analyzeInput("moc.‮lapyap.example");
  eq("貼り付け: RLO → 双方向制御を検出・ブラウザでは開けない", [rlo.level, rlo.suspicious[0].category, rlo.browserOpenable, rlo.lookalike], ["danger", "bidi", false, null]);
  ok("理由の文には RLO そのものを入れない", rlo.reasons.every((r) => !r.includes("‮")));
  const fw = D.analyzeInput("ｐａｙｐａｌ.com");
  eq("貼り付け: 全角 → 高・paypal.com に見える", [fw.level, fw.lookalike.text, fw.browserHost], ["danger", "paypal.com", "paypal.com"]);
  const at = D.analyzeInput("https://paypal.com@evil.example/");
  eq("貼り付け: paypal.com@evil.example → 接続先は evil.example", [at.level, at.host, at.userinfo], ["danger", "evil.example", "paypal.com"]);
  const slash = D.analyzeInput("google.com∕login.evil.example");
  eq("貼り付け: スラッシュに似た文字 → パスに見せかけた偽装", [slash.level, slash.lookalike.text], ["danger", "google.com/login.evil.example"]);
  eq("貼り付け: %E2%80%8B も解読して検査", D.analyzeInput("pay%E2%80%8Bpal.com").hiddenCount, 1);
  eq("貼り付け: ポートとパスを外す", D.extractHost("https://user@xn--pypal-4ve.com:8443/a?b#c"), { host: "xn--pypal-4ve.com", userinfo: "user", port: "8443" });

  // ---- メールの中のリンク(links.js) ----
  const lk = (h, t) => {
    const r = LK.analyzeLink(h, t);
    return r.ok ? [r.level, r.url.hostname, r.mismatch] : ["skip"];
  };
  eq("リンク: 行き先がキリル文字の xn-- → 危険", lk("https://xn--pypal-4ve.com/login", "こちら"), ["danger", "xn--pypal-4ve.com", false]);
  eq("リンク: 表示 paypal.com・行き先 evil.example → 注意(食い違い)", lk("https://evil.example/login", "paypal.com"), ["warning", "evil.example", true]);
  eq("リンク: 行き先が表示の名前で始まる別ドメイン → 危険", lk("https://paypal.com.evil.example/", "https://paypal.com/"), ["danger", "paypal.com.evil.example", true]);
  eq("リンク: 表示 example.com・行き先 www.example.com → 問題なし", lk("https://www.example.com/news", "example.com"), ["safe", "www.example.com", false]);
  eq("リンク: Google の転送(google.com/url?q=)の中身を判定", [LK.analyzeLink("https://www.google.com/url?q=https://xn--pple-zld.com/&sa=D", "Apple").via, lk("https://www.google.com/url?q=https://xn--pple-zld.com/&sa=D", "Apple")], [["Google の転送"], ["danger", "xn--pple-zld.com", false]]);
  eq("リンク: Outlook の安全リンクの中身を判定", lk("https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fxn--pypal-4ve.com%2F&data=1", "link"), ["danger", "xn--pypal-4ve.com", false]);
  eq("リンク: 表示の文字にゼロ幅スペース → 危険", lk("https://example.com/", "pay\u200Bpal.com")[0], "danger");
  eq("リンク: 表示の文字が全角 → 危険", lk("https://example.com/", "ｐａｙｐａｌ.com")[0], "danger");
  eq("リンク: 行き先の「@」の偽装 → 危険", lk("https://paypal.com@evil.example/", "ログイン"), ["danger", "evil.example", false]);
  eq("リンク: 行き先が IP アドレス → 注意", lk("http://192.168.0.10/login", "ログイン"), ["warning", "192.168.0.10", false]);
  eq("リンク: mailto は対象外", lk("mailto:info@example.com", "info@example.com"), ["skip"]);
  eq("リンク: ファイル名(資料.pdf)はドメイン扱いしない", lk("https://example.com/a.pdf", "資料.pdf"), ["safe", "example.com", false]);
  eq("リンク: 文章(半角スペース入り)はドメイン扱いしない", lk("https://example.com/", "詳しくは example.com へ"), ["safe", "example.com", false]);

  // ---- 点検(Claude Security 2026-10-17)で見つかった3件の回帰 ----
  eq("リンク: google.evil.com/url?q= は Google の転送として外さない", [LK.analyzeLink("https://google.evil.com/url?q=https://www.paypal.com/signin", "www.paypal.com").via, lk("https://google.evil.com/url?q=https://www.paypal.com/signin", "www.paypal.com")], [[], ["warning", "google.evil.com", true]]);
  eq("リンク: www.google.evil.com/url?q= も Google の転送として外さない", LK.analyzeLink("https://www.google.evil.com/url?q=https://www.paypal.com/", "link").url.hostname, "www.google.evil.com");
  eq("リンク: google.co.jp/url?q= は Google の転送として外す", LK.analyzeLink("https://www.google.co.jp/url?q=https://example.com/", "link").via, ["Google の転送"]);
  {
    const spaces = "x" + " \n".repeat(50000) + "x";
    const t0 = performance.now();
    const r = LK.analyzeLink("http://1.2.3.4/", spaces);
    const ms = performance.now() - t0;
    ok("リンク: 長い空白の並びの表示の文字でも止まらない(200ms 未満)", ms < 200 && r.ok && r.textHost === null, `${Math.round(ms)}ms`);
    eq("空白の除去: 前後のタブ・改行・スペースだけを外す", [D.trimWs("\t\n a b \r\f"), D.trimWs("   "), D.trimWs(""), D.trimWs(null)], ["a b", "", "", ""]);
  }
  {
    const longHost = Array.from({ length: 200000 }, () => "a").join(".") + ".com";
    const t0 = performance.now();
    const r = D.analyzeUrl("http://" + longHost + "/");
    const ms = performance.now() - t0;
    ok("ホスト名: とても長いホスト名でも止まらず危険にする(500ms 未満)", ms < 500 && r && r.level === "danger" && r.tooLong === true && r.chars.length <= 253, `${Math.round(ms)}ms level=${r && r.level}`);
    const normal = D.analyzeHost("example.com");
    eq("ホスト名: ふつうの長さは今までどおり", [normal.level, normal.tooLong, normal.labels.length], ["safe", false, 2]);
    const max = Array.from({ length: 63 }, () => "a").join("") + "." + Array.from({ length: 63 }, () => "b").join("") + "." + Array.from({ length: 63 }, () => "c").join("") + "." + Array.from({ length: 57 }, () => "d").join("") + ".com";
    eq("ホスト名: 253 文字ちょうどは長すぎに入れない", [max.length, D.analyzeHost(max).tooLong], [253, false]);
  }
}

// ================= 2) 静的検査 =================
{
  const files = ["punycode.js", "detector.js", "links.js", "gmail.js", "background.js", "content.js", "popup.js", "popup.html"];
  const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(EXT, f), "utf8")]));
  const banned = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /\beval\s*\(/, /new\s+Function\s*\(/, /document\.write/, /setTimeout\s*\(\s*['"`]/];
  const network = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /EventSource/, /importScripts\s*\(\s*['"]https?:/];
  const hits = (patterns) => files.flatMap((f) => patterns.filter((p) => p.test(src[f])).map((p) => `${f}: ${p}`));
  eq("innerHTML・eval などを使っていない", hits(banned), []);
  eq("外部通信のコードが無い", hits(network), []);
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  eq("manifest: MV3", manifest.manifest_version, 3);
  eq("manifest: 権限は tabs だけ", manifest.permissions, ["tabs"]);
  eq("manifest: Gmail 用の content script は mail.google.com だけ(権限は増えない)", manifest.content_scripts.map((c) => c.matches), [["http://*/*", "https://*/*"], ["https://mail.google.com/*"]]);
  eq("manifest: host_permissions・web_accessible_resources・externally_connectable なし", [manifest.host_permissions, manifest.web_accessible_resources, manifest.externally_connectable], [undefined, undefined, undefined]);
  ok("manifest: 説明は132文字以内", [...manifest.description].length <= 132, String([...manifest.description].length));
  ok("manifest: 拡張機能のページは connect-src 'none'", manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));
  for (const size of [16, 32, 48, 128]) ok(`アイコン ${size}px がある`, fs.existsSync(path.join(EXT, `icons/icon${size}.png`)));
}

// ================= 3) Chrome に読み込んで通しで確かめる =================
// 拡張機能を読み込めるのは、新しい headless の Chromium(channel: "chromium")か、CHROME_PATH で渡した Chromium
const browserOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chromium" };

const PAGE = (title, extra = "") => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f4f6f8}header{background:#1d4ed8;color:#fff;padding:18px 24px;font-size:22px;font-weight:700}
main{max-width:420px;margin:60px auto;background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.08)}
label{display:block;margin:12px 0 4px}input{width:100%;padding:10px;font-size:16px;box-sizing:border-box}button{margin-top:18px;width:100%;padding:12px;font-size:16px;background:#1d4ed8;color:#fff;border:0;border-radius:8px}
</style></head><body><header>${title}</header><main><h2>ログイン</h2><label>メールアドレス</label><input><label>パスワード</label><input type="password"><button>ログイン</button></main>${extra}</body></html>`;

// バナーを外す・隠す・上に重ねる、をページ側から試みる
const TAMPER = `<div id="cover" popover="manual" style="position:fixed;inset:0 0 auto 0;height:240px;margin:0;border:0;background:#16a34a;color:#fff;font-size:28px;padding:20px">✓ このサイトは安全です(ページが重ねた偽の表示)</div>
<script>
const isOurs = (e) => e.localName.startsWith('hd-alert-');
setTimeout(() => {
  const st = document.createElement('style');
  st.textContent = '[popover]:not(#cover){display:none!important;opacity:0!important;visibility:hidden!important} html>*:not(head):not(body){display:none!important}';
  document.head.append(st);
  const t = setInterval(() => {
    for (const e of [...document.documentElement.children]) if (isOurs(e)) { try { e.hidePopover(); } catch (x) {} e.setAttribute('hidden', ''); e.style.display = 'none'; e.remove(); }
  }, 5);
  setTimeout(() => clearInterval(t), 1200);
}, 600);
setTimeout(() => document.getElementById('cover').showPopover(), 2000);
</script>`;

// Gmail の画面の写し(本物の Gmail で確かめた並び: div.adn.ads > div.gs > div > div.ii.gt > div.a3s.aiL)
const GMAIL_MSG = (inner) => `<div class="adn ads"><div class="gs"><h2 class="hP">お知らせ</h2><div><div class="ii gt"><div class="a3s aiL">${inner}</div></div></div></div></div>`;
const GMAIL = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Gmail</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#f6f8fc}.adn{background:#fff;margin:16px auto;max-width:860px;padding:20px 28px;border-radius:16px}.a3s{font-size:14px;line-height:1.6;color:#222}.hP{font-size:22px;font-weight:400;margin:0 0 14px}</style></head>
<body><div role="main" id="main">${GMAIL_MSG(`<p>いつもご利用ありがとうございます。アカウントの確認が必要です。</p>
<p><a id="l1" href="https://xn--pypal-4ve.com/login" data-saferedirecturl="https://www.google.com/url?q=https://xn--pypal-4ve.com/login">こちらからログイン</a>してください。</p>
<p>公式サイト: <a id="l2" href="https://evil.example/verify">https://www.paypal.com/</a></p>
<p><a id="l3" href="https://www.google.com/url?q=https://xn--pple-zld.com/id&amp;sa=D">Apple ID を確認する</a></p>
<p>お知らせ: <a id="l4" href="https://example.com/news">example.com</a> / お問い合わせ: <a href="mailto:info@example.com">info@example.com</a></p>
<p><a id="l5" href="https://example.com/"><img alt="" width="120" height="30" style="background:#ddd;display:inline-block"></a></p>
<p>あとで行き先が変わるリンク: <a id="l6" href="https://example.com/wait">案内</a></p>`)}</div>
<script>
const ORIG = document.querySelector('.a3s').innerHTML;
const rerender = () => { const old = document.querySelector('.a3s'); const fresh = document.createElement('div'); fresh.className = 'a3s aiL'; fresh.innerHTML = ORIG; old.replaceWith(fresh); };
setTimeout(rerender, 1800);
setTimeout(rerender, 2600);
setTimeout(() => document.getElementById('l6').setAttribute('href', 'https://xn--80ak6aa92e.com/'), 3400);
setTimeout(() => { document.getElementById('main').insertAdjacentHTML('beforeend', ${JSON.stringify(GMAIL_MSG('<p>次回の予定です。<a id="s1" href="https://example.com/schedule">予定を見る</a> <a id="s2" href="https://www.example.org/">www.example.org</a></p>'))}); }, 1200);</script>
</body></html>`;

const SITES = {
  "xn--pypal-4ve.com": PAGE("PayPal(テスト用の偽ページ)"),
  "xn--pple-zld.com": PAGE("Apple(テスト用の偽ページ)"),
  "xn--80ak6aa92e.com": PAGE("Apple(全部キリル文字のテスト用ページ)"),
  "xn--wgv71a119e.jp": PAGE("日本語ドメインのテスト用ページ"),
  "example.com": PAGE("Example(安全なテスト用ページ)"),
  "xn--pypal-4ve.net": PAGE("妨害テスト", TAMPER),
  "mail.google.com": GMAIL,
};

const ctx = await chromium.launchPersistentContext("", {
  ...browserOptions,
  headless: true,
  locale: "ja-JP",
  viewport: { width: 1280, height: 720 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const pageErrors = [];
try {
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; i < 30 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 300));
    sw = ctx.serviceWorkers()[0];
  }
  ok("拡張機能が読み込まれ、service worker が動いている", !!sw);
  const extId = sw.url().split("/")[2];

  await ctx.route(
    (u) => Object.prototype.hasOwnProperty.call(SITES, u.hostname),
    (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: SITES[new URL(route.request().url()).hostname] }),
  );

  const badgeOf = (host) =>
    sw.evaluate(async (pattern) => {
      const [t] = await chrome.tabs.query({ url: pattern });
      if (!t) return null;
      return {
        id: t.id,
        text: await chrome.action.getBadgeText({ tabId: t.id }),
        color: await chrome.action.getBadgeBackgroundColor({ tabId: t.id }),
        title: await chrome.action.getTitle({ tabId: t.id }),
      };
    }, `https://${host}/*`);
  const bannerOf = (page) =>
    page.evaluate(() => {
      const h = [...document.documentElement.children].find((e) => e.localName.startsWith("hd-alert-"));
      if (!h) return null;
      const r = h.getBoundingClientRect();
      const top = document.elementFromPoint(640, 6);
      return { open: h.matches(":popover-open"), height: Math.round(r.height), shadowVisible: h.shadowRoot !== null, display: getComputedStyle(h).display, onTop: top === h, attrs: [...h.attributes].map((a) => a.name) };
    });
  const open = async (host) => {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(`${host}: ${e.message}`));
    await page.goto(`https://${host}/login`, { waitUntil: "load" });
    await page.waitForTimeout(700);
    return page;
  };

  // --- キリル文字の pаypal ---
  const pp = await open("xn--pypal-4ve.com");
  const ppBadge = await badgeOf("xn--pypal-4ve.com");
  eq("pаypal: バッジは赤の「!」", [ppBadge && ppBadge.text, ppBadge && ppBadge.color], ["!", [198, 40, 40, 255]]);
  ok("pаypal: ツールチップに危険度と理由", ppBadge && ppBadge.title.includes("危険度「高」") && ppBadge.title.includes("paypal.com"), ppBadge && ppBadge.title);
  const ppBanner = await bannerOf(pp);
  ok("pаypal: バナーが最前面の層に出ている", ppBanner && ppBanner.open && ppBanner.onTop && ppBanner.height > 120, JSON.stringify(ppBanner));
  ok("pаypal: Shadow DOM は closed(ページから中身を参照できない)", ppBanner && ppBanner.shadowVisible === false);
  await pp.screenshot({ path: path.join(OUT, "1-paypal-banner.png") });

  // 折りたたみ: closed の Shadow DOM の中のボタンを CDP で探し、本物のマウス操作で押す
  const cdp = await ctx.newCDPSession(pp);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const buttons = [];
  const walk = (n, inside) => {
    const ours = inside || (n.localName || "").startsWith("hd-alert-");
    if (ours && n.nodeName === "BUTTON") buttons.push(n);
    for (const c of n.children || []) walk(c, ours);
    for (const s of n.shadowRoots || []) walk(s, ours);
  };
  walk(root, false);
  ok("バナーのボタンが closed の Shadow DOM の中にある", buttons.length === 2, String(buttons.length));
  const box = await cdp.send("DOM.getBoxModel", { backendNodeId: buttons[0].backendNodeId });
  const q = box.model.content;
  await pp.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
  await pp.waitForTimeout(300);
  const folded = await bannerOf(pp);
  ok("折りたたむと細い帯だけ残る(消えはしない)", folded && folded.open && folded.height > 20 && folded.height < 60, JSON.stringify(folded));
  await pp.screenshot({ path: path.join(OUT, "2-paypal-folded.png"), clip: { x: 0, y: 0, width: 1280, height: 120 } });

  // --- ギリシャ文字・全部キリル文字・日本語・安全 ---
  const gr = await open("xn--pple-zld.com");
  eq("αpple: バッジは赤の「!」", (await badgeOf("xn--pple-zld.com")).text, "!");
  ok("αpple: バナーが出る", !!(await bannerOf(gr)));
  await gr.screenshot({ path: path.join(OUT, "3-apple-greek.png"), clip: { x: 0, y: 0, width: 1280, height: 320 } });

  const wh = await open("xn--80ak6aa92e.com");
  eq("аррӏе: バッジは赤の「!」", (await badgeOf("xn--80ak6aa92e.com")).text, "!");
  await wh.screenshot({ path: path.join(OUT, "4-apple-cyrillic.png"), clip: { x: 0, y: 0, width: 1280, height: 320 } });

  const jpPage = await open("xn--wgv71a119e.jp");
  const jpBadge = await badgeOf("xn--wgv71a119e.jp");
  ok("日本語.jp: 赤の「!」・危険度「注意」", jpBadge && jpBadge.text === "!" && jpBadge.title.includes("危険度「注意」"), jpBadge && jpBadge.title);
  ok("日本語.jp: バナーが出る", !!(await bannerOf(jpPage)));
  await jpPage.screenshot({ path: path.join(OUT, "5-japanese.png"), clip: { x: 0, y: 0, width: 1280, height: 320 } });

  const safe = await open("example.com");
  const safeBadge = await badgeOf("example.com");
  eq("example.com: バッジは緑の「✓」", [safeBadge && safeBadge.text, safeBadge && safeBadge.color], ["✓", [46, 125, 50, 255]]);
  eq("example.com: バナーは出さない(DOM に触れない)", await bannerOf(safe), null);

  // --- 妨害への耐性 ---
  const tp = await open("xn--pypal-4ve.net");
  await tp.waitForTimeout(3300);
  const after = await bannerOf(tp);
  ok("妨害: 外す・hidden・display:none・CSS の !important・hidePopover・偽の表示を重ねる、のあともバナーが最前面", after && after.open && after.onTop && after.display === "block", JSON.stringify(after));
  eq("妨害: ページが付けた属性は外れている", after && after.attrs.sort(), ["popover", "style"]);
  await tp.screenshot({ path: path.join(OUT, "6-tamper.png"), clip: { x: 0, y: 0, width: 1280, height: 320 } });

  // --- ポップアップ ---
  const popup = await ctx.newPage();
  popup.on("pageerror", (e) => pageErrors.push(`popup: ${e.message}`));
  await popup.setViewportSize({ width: 500, height: 900 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${ppBadge.id}`);
  await popup.waitForSelector(".status");
  const pv = await popup.evaluate(() => ({
    status: document.querySelector(".status").className,
    blocks: document.querySelectorAll("#current .blk").length,
    bad: [...document.querySelectorAll("#current .blk.ng .g")].map((e) => e.textContent),
    rows: [...document.querySelectorAll("#current table.chars tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent)),
    checksNg: document.querySelectorAll("#current .checks li.ng").length,
    width: getComputedStyle(document.body).width,
    anim: getComputedStyle(document.querySelector("#current .blk.ng")).animationName,
  }));
  eq("ポップアップ: 危険の表示", pv.status, "status danger");
  eq("ポップアップ: 10文字のブロックのうち1つが異常", [pv.blocks, pv.bad], [10, ["а"]]);
  eq("ポップアップ: 一覧の1行目", pv.rows[0], ["1", "а", "2文字目", "キリル文字 (Cyrillic)", "U+0430", "「a」に似ている"]);
  ok("ポップアップ: CSS が効いている(CSP で止まっていない)", pv.width === "500px" && pv.anim.includes("hd-pulse"), JSON.stringify([pv.width, pv.anim]));
  await popup.screenshot({ path: path.join(OUT, "7-popup.png"), fullPage: true });

  await popup.fill("#manual-input", "https://pay​pal.com/login");
  await popup.click('#manual-form button[type="submit"]');
  const mz = await popup.evaluate(() => ({
    ph: [...document.querySelectorAll("#manual-result .blk.ng .g")].map((e) => e.textContent),
    notes: document.querySelector("#manual-result .notes") && document.querySelector("#manual-result .notes").textContent,
  }));
  eq("ポップアップ(貼り付け): ゼロ幅スペースを赤いプレースホルダで表示", mz.ph, ["[不可視: U+200B]"]);
  ok("ポップアップ(貼り付け): ブラウザでは paypal.com になると補足", (mz.notes || "").includes("paypal.com"), mz.notes);
  await popup.locator("#manual-result").screenshot({ path: path.join(OUT, "8-popup-zwsp.png") });

  await popup.fill("#manual-input", "moc.‮lapyap.example");
  await popup.click('#manual-form button[type="submit"]');
  eq("ポップアップ(貼り付け): RLO を表示", await popup.evaluate(() => [...document.querySelectorAll("#manual-result .blk.ng .g")].map((e) => e.textContent)), ["[双方向制御: U+202E]"]);

  // --- Gmail の中のリンク ---
  const gm = await ctx.newPage();
  gm.on("pageerror", (e) => pageErrors.push(`gmail: ${e.message}`));
  await gm.goto("https://mail.google.com/mail/u/0/#inbox/abc", { waitUntil: "load" });
  await gm.waitForTimeout(4400);
  const parts = await gm.evaluate(() => {
    const all = [...document.querySelectorAll("*")].filter((e) => e.localName.startsWith("hd-"));
    const kind = (k) => all.filter((e) => e.localName.startsWith("hd-" + k + "-"));
    const outline = (id) => { const cs = getComputedStyle(document.getElementById(id)); return cs.outlineStyle === "none" ? "none" : cs.outlineColor; };
    return { panels: kind("panel").length, flags: kind("flag").length, banner: kind("alert").length, outlines: ["l1", "l2", "l3", "l4"].map(outline), flagAfter: ["l1", "l2", "l3"].map((id) => (document.getElementById(id).nextSibling || {}).localName || "").map((n) => n.startsWith("hd-flag-")) };
  });
  eq("Gmail: 本文が2回作り直されても、メール2通に欄は1つずつ", parts.panels, 2);
  eq("Gmail: 危険・注意のリンク4つ(あとで行き先が変わった1つを含む)の横に印", [parts.flags, parts.flagAfter], [4, [true, true, true]]);
  eq("Gmail: 危険のリンクは赤・注意は茶の枠、問題なしは枠なし", parts.outlines, ["rgb(198, 40, 40)", "rgb(154, 91, 0)", "rgb(198, 40, 40)", "none"]);
  eq("Gmail: mail.google.com ではページ上部の警告は出さない", parts.banner, 0);
  const shadowText = async (prefix) => {
    const c = await ctx.newCDPSession(gm);
    const { root } = await c.send("DOM.getDocument", { depth: -1, pierce: true });
    const out = [];
    const texts = (n) => (n.nodeType === 3 ? n.nodeValue : "") + (n.children || []).map(texts).join("") + (n.shadowRoots || []).map(texts).join("");
    const walk = (n) => {
      if ((n.localName || "").startsWith(prefix)) out.push(texts(n).replace(/\s+/g, " "));
      (n.children || []).forEach(walk);
      (n.shadowRoots || []).forEach(walk);
    };
    walk(root);
    await c.detach();
    return out;
  };
  const panelTexts = await shadowText("hd-panel-");
  ok("Gmail: 1通目の欄は「リンク 6 件のうち、危険 3 件・注意 1 件」と行き先の一覧", /リンク 6 件のうち、危険 3 件・注意 1 件/.test(panelTexts[0] || "") && /xn--pypal-4ve\.com|pаypal\.com/.test(panelTexts[0]) && /Google の転送を外した行き先です/.test(panelTexts[0]), (panelTexts[0] || "").slice(0, 300));
  ok("Gmail: 2通目の欄は「問題なし」で畳んである", /✓ このメールのリンク 2 件/.test(panelTexts[1] || "") && !/行き先:/.test(panelTexts[1] || ""), panelTexts[1]);
  await gm.screenshot({ path: path.join(OUT, "9-gmail.png") });
  await gm.hover("#l2");
  await gm.waitForTimeout(300);
  const cardTexts = await shadowText("hd-card-");
  ok("Gmail: マウスを乗せると本当の行き先と理由を出す", /本当の行き先/.test(cardTexts[0] || "") && /evil\.example/.test(cardTexts[0]) && /表示は「www\.paypal\.com」ですが/.test(cardTexts[0]), cardTexts[0]);
  await gm.screenshot({ path: path.join(OUT, "10-gmail-hover.png") });
  await gm.hover("#l4");
  await gm.waitForTimeout(300);
  ok("Gmail: 問題のないリンクにも行き先を出す", /文字のなりすましはありません/.test((await shadowText("hd-card-"))[0] || ""));

  const other = await ctx.newPage();
  await other.goto(`chrome-extension://${extId}/popup.html?tabId=999999`);
  await other.waitForSelector("#current .notice");
  ok("ポップアップ: 対象外のタブでは案内を出す", true);
} finally {
  eq("ページ・ポップアップで JS のエラーが出ていない", pageErrors, []);
  await ctx.close();
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
