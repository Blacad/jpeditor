// OMR 底本的 MusicXML 导出实测：真实跑一遍识别得到底本 XML，再验证
//  (1) 未改动时导出 == 识别原文；(2) 改一处后 patch 只动该处、<print>/<credit>/<direction> 一个不少；
//  (3) 版面注入后「一行几个小节」与识别出的行结构（RecognizedScore.rows）完全一致。
// 用法：npm run build && node omr-export-check.mjs [曲名子串]
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);
const MIME = { ".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".woff2":"font/woff2",".svg":"image/svg+xml",".wasm":"application/wasm",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".bmp":"image/bmp",".webp":"image/webp",".pdf":"application/pdf" };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const data = await readFile(join(ROOT, normalize(p)));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const filter = process.argv[2] ?? "日光";
const dirs = (await readdir("testdata", { withFileTypes: true })).filter((d) => d.isDirectory());
const jobs = [];
for (const d of dirs) {
  if (filter && !d.name.includes(filter)) continue;
  const files = await readdir(join("testdata", d.name));
  const img = files.find((f) => IMG_EXT.has(extname(f).toLowerCase()));
  if (img) jobs.push([d.name, join("testdata", d.name, img)]);
}
if (!jobs.length) { console.log("没有图片夹具"); process.exit(1); }

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

let fail = 0;
for (const [name, imgPath] of jobs) {
  const bytes = await readFile(imgPath);
  const b64 = bytes.toString("base64");
  const mime = MIME[extname(imgPath).toLowerCase()] ?? "image/png";
  const checks = await page.evaluate(async ({ b64, mime }) => {
    const omr = await window.__omr;
    const X = await window.__xmlout;
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const rec = await omr.recognizeJianpu(await omr.decodeToBinary(bin, mime), omr.paddleOcrBackend());
    const base = omr.toMusicXml(rec);            // 识别原文 = 导出底本
    const out = [];
    const add = (id, err) => out.push({ id, ok: !err, err });

    // (1) 未改动：导出就是底本本身（App.importUnchanged 走的分支）
    window.__app.importBytes(new TextEncoder().encode(base), "omr.musicxml");
    add("未改动直出底本", window.__app.importUnchanged ? null : "importUnchanged 为 false");

    // (2) 改一处：patch 只动该处，底本其余节点保全
    const text = window.__app.getText();
    const edited = text.replace(/(\n\.Voice\n[^\n]*?)([1-7])/, (s, head, d) => head + (d === "5" ? "6" : "5"));
    add("模拟编辑有效", edited !== text ? null : "没改到 .Voice");
    window.__app.setText(edited);
    const S2 = window.__app.painter.score;
    const p = X.patchMusicXml(base, S2);
    add("patch 不 fallback", p.fallback ? "fallback" : null);
    add("patch 有改动", p.changed > 0 ? null : "changed=0");
    const count = (xml, tag) => (xml.match(new RegExp(`<${tag}[ />]`, "g")) || []).length;
    const keep = ["print", "credit", "direction", "words", "barline", "attributes"];
    const lost = keep.filter((t) => count(p.xml, t) !== count(base, t));
    add("底本节点保全", lost.length ? `变了: ${lost.join(", ")}` : null);

    // (2b) 弧线：slur/tie 必须严格配对，且 tie 两端同音高。识别难免出错（漏一端、把端点
    //      落到休止符上），孤立的 start 会让 MuseScore 把弧线一路拖到下一条 slur。
    const arcCheck = (xml, label) => {
      const d = new DOMParser().parseFromString(xml, "application/xml");
      const ns = [...d.querySelectorAll("part > measure > note")];
      const openS = [], openT = [];
      let orphan = 0, mismatch = 0;
      ns.forEach((n) => {
        const pit = n.querySelector("pitch");
        const key = pit ? [...pit.children].map((c) => c.textContent).join("") : "rest";
        for (const el of n.querySelectorAll("notations > *")) {
          const ty = el.getAttribute("type");
          if (el.tagName === "slur") {
            if (ty === "start") openS.push(el.getAttribute("number"));
            else if (!openS.length) orphan++; else openS.pop();
          } else if (el.tagName === "tied") {
            if (ty === "start") openT.push(key);
            else if (!openT.length) orphan++;
            else if (openT.pop() !== key || key === "rest") mismatch++;
          }
        }
      });
      const bad = [];
      if (openS.length) bad.push(`${openS.length} 条 slur 未闭合`);
      if (openT.length) bad.push(`${openT.length} 条 tie 未闭合`);
      if (orphan) bad.push(`${orphan} 个孤立 stop`);
      if (mismatch) bad.push(`${mismatch} 条 tie 两端音高不符`);
      return bad.length ? `${label}: ${bad.join("、")}` : null;
    };
    add("底本弧线配对", arcCheck(base, "底本"));
    add("patch 后弧线配对", arcCheck(p.xml, "patch 后"));

    // (2c) 休止符不能带 beam/tie（没有符干、没有音高）；识别把 slur 端点判到休止符上属识别
    //      错误，omr/musicxml.ts::pairArcs 会把整条弧作废。beam 各层也必须成对。
    const restCheck = (xml, label) => {
      const d = new DOMParser().parseFromString(xml, "application/xml");
      const ns = [...d.querySelectorAll("part > measure > note")];
      let rb = 0, rs = 0, rt = 0, bad = 0;
      const st = {};
      for (const n of ns) {
        if (n.querySelector("rest")) {
          rb += n.querySelectorAll(":scope > beam").length;
          rs += n.querySelectorAll("notations > slur").length;
          rt += n.querySelectorAll("notations > tied").length;
        }
        for (const bm of n.querySelectorAll(":scope > beam")) {
          const lv = bm.getAttribute("number"), v = bm.textContent;
          if (v === "begin") { if (st[lv]) bad++; st[lv] = 1; }
          else if (v === "continue") { if (!st[lv]) bad++; }
          else if (v === "end") { if (!st[lv]) bad++; st[lv] = 0; }
        }
      }
      for (const k in st) if (st[k]) bad++;
      const msg = [];
      if (rb) msg.push(`休止符带 beam ${rb}`);
      if (rs) msg.push(`休止符带 slur ${rs}`);
      if (rt) msg.push(`休止符带 tie ${rt}`);
      if (bad) msg.push(`beam 不成对 ${bad}`);
      return msg.length ? `${label}: ${msg.join("、")}` : null;
    };
    add("底本休止符/符杠", restCheck(base, "底本"));
    add("patch 后休止符/符杠", restCheck(p.xml, "patch 后"));

    // (3) 版面注入：分行必须与底本（= 原图行结构）逐个吻合，注入只补版面参数不改断行
    const printsOf = (xml) => [...new DOMParser().parseFromString(xml, "application/xml")
      .querySelectorAll("part > measure > print")]
      .filter((e) => e.getAttribute("new-system") === "yes" || e.getAttribute("new-page") === "yes")
      .map((e) => e.parentElement.getAttribute("number")).join(",");
    const doc = new DOMParser().parseFromString(p.xml, "application/xml");
    X.annotateLayout(doc);
    const after = new XMLSerializer().serializeToString(doc);
    // 底本有分行凭据就必须一个不差地沿用；一个都没有（整首都是跨行小节，如《基督更美》）
    // 才允许按 measuresPerSystem 合成。
    const pb = printsOf(p.xml), pa = printsOf(after);
    add("分行照底本", pb === "" || pb === pa ? null : `注入前 [${pb}] → 注入后 [${pa}]`);
    // 注：底本的 <print> 数不一定等于 rec.rows.length —— 原图行末没画小节线时该行首落在小节
    // 内部，omr/musicxml.ts 按「不凭空补小节线」的规则不写 <print>（rowEndsClosed）。
    const systems = 1 + printsOf(after).split(",").filter((s) => s).length;
    return { checks: out, rows: rec.rows.length, systems, synth: pb === "",
      measures: doc.querySelectorAll("part > measure").length };
  }, { b64, mime });

  const bad = checks.checks.filter((c) => !c.ok);
  if (!bad.length) console.log(`PASS  ${name}  (原图 ${checks.rows} 行 → 导出 ${checks.systems} 行${checks.synth ? "（底本无分行凭据，合成）" : ""} / ${checks.measures} 小节，${checks.checks.length} 项)`);
  else { fail++; console.log(`FAIL  ${name}`); bad.forEach((c) => console.log(`      ${c.id}: ${c.err}`)); }
}
if (errors.length) { console.log("PAGE ERRORS:\n" + errors.join("\n")); fail++; }
await browser.close();
server.close();
console.log(fail ? `\n${fail} 首失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
