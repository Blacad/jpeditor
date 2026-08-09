// 校验 testdata 下各 .jpwabc GT 能被编辑器正常解析/排版：报页数与控制台错误。
// 用法: node check-gt.mjs [歌谱名子串...]
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
const ROOT = join(process.cwd(), "dist"), TESTDATA = join(process.cwd(), "testdata");
const MIME = { ".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".woff2":"font/woff2",".svg":"image/svg+xml",".wasm":"application/wasm" };
const server = createServer(async (req,res)=>{ try{ let p=decodeURIComponent((req.url??"/").split("?")[0]); if(p==="/")p="/index.html"; const d=await readFile(join(ROOT,normalize(p))); res.writeHead(200,{"content-type":MIME[extname(p)]??"application/octet-stream"}); res.end(d);}catch{res.writeHead(404);res.end("x");}});
await new Promise(r=>server.listen(0,r));
const port=server.address().port;
const filters = process.argv.slice(2);
const decode = (b)=> b[0]===0xff&&b[1]===0xfe ? Buffer.from(b.slice(2)).toString("utf16le") : b.toString("utf8");
const browser = await chromium.launch({channel:"msedge",headless:true});
const page = await browser.newPage({viewport:{width:1200,height:800}});
let errs = [];
page.on("console", m=>{ if(m.type()==="error") errs.push(m.text()); });
page.on("pageerror", e=>errs.push("pageerror: "+e.message));
await page.goto(`http://localhost:${port}/`,{waitUntil:"networkidle"});
await page.waitForTimeout(500);
for (const d of (await readdir(TESTDATA,{withFileTypes:true})).filter(x=>x.isDirectory())) {
  if (filters.length && !filters.some(f=>d.name.includes(f))) continue;
  const files = await readdir(join(TESTDATA,d.name));
  const gt = files.find(f=>f.endsWith(".jpwabc"));
  if (!gt) { console.log("—  ", d.name, "(无 GT)"); continue; }
  const text = decode(await readFile(join(TESTDATA,d.name,gt)));
  errs = [];
  const r = await page.evaluate(async (t)=>{
    window.__app.setText(t);
    await new Promise(r=>setTimeout(r,300));
    return { pages: document.querySelectorAll("#score-pane svg.score-page").length,
             lines: (window.__app.getText().match(/\$\(/g)||[]).length };
  }, text);
  const bad = errs.filter(e=>!/favicon/.test(e));
  console.log(bad.length?"✗":"✓", d.name, `页=${r.pages} 排版行=${r.lines}`, bad.join(" | "));
}
await browser.close(); server.close();
