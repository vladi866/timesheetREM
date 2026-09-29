'use strict';
/*
 * Headless tests for index.html (single-file timesheet app).
 *
 * Strategy: extract the two <script> blocks from index.html — the embedded
 * pdf-lib (real library, not a mock) and the app — and run them inside a
 * Node vm sandbox with a minimal stub DOM. Then drive the app's real
 * functions (buildDays, buildPdf, finalizeAndGenerate, removeReceipt) and
 * inspect the generated PDFs with pdf-lib itself:
 *   - page counts and page sizes
 *   - "Page k of M" labels and receipt-page text
 *   - embedded image XObjects (one per receipt page, none elsewhere)
 *   - the no-expenses output must be exactly the same 3 pages as the
 *     pre-feature version (structural equivalence against origin/main).
 *
 * Run:  node tests/test.js
 * Base for the "unchanged output" comparison can be overridden with
 * TIMESHEET_BASE=<git ref> (default: origin/main).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

let passed = 0, failed = 0;
function ok(cond, name, extra){
  if(cond){ passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function section(title){ console.log('\n== ' + title + ' =='); }

/* ---------------- extract script blocks ---------------- */
function extractScripts(html){
  const blocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while((m = re.exec(html))) blocks.push(m[1]);
  return blocks;
}

/* ---------------- stub DOM ---------------- */
function makeElement(id){
  const el = {
    id: id || '',
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    min: '', max: '',
    scrolls: 0,
    clicks: 0,
    classList: {
      add(){}, remove(){}, toggle(){}, contains(){ return false; }
    },
    setAttribute(){}, removeAttribute(){}, getAttribute(){ return null; },
    addEventListener(){}, removeEventListener(){},
    appendChild(){}, remove(){},
    focus(){},
    click(){ this.clicks++; },
    scrollIntoView(){ this.scrolls++; }
  };
  return el;
}

function makeDocument(){
  const byId = new Map();
  return {
    body: makeElement('body'),
    getElementById(id){
      if(!byId.has(id)) byId.set(id, makeElement(id));
      return byId.get(id);
    },
    querySelectorAll(){ return []; },
    createElement(){ return makeElement(''); }
  };
}

/* ---------------- vm harness ---------------- */
const FIXED_NOW = new Date('2026-09-29T12:00:00Z').getTime();

function loadApp(html){
  const blocks = extractScripts(html);
  if(blocks.length !== 2) throw new Error('expected 2 script blocks, got ' + blocks.length);
  const [pdfLibSrc, appSrc] = blocks;

  const documentStub = makeDocument();
  const calls = { confirm: 0, alert: 0, confirmReply: true };

  // Deterministic clock so PDF CreationDate/ModDate is stable between runs.
  class FixedDate extends Date {
    constructor(...a){ super(...(a.length ? a : [FIXED_NOW])); }
    static now(){ return FIXED_NOW; }
  }

  // NOTE: pass only non-intrinsic globals. Injecting outer-realm intrinsics
  // (Array, Object, Uint8Array…) breaks pdf-lib's instanceof checks, because
  // literals created inside the vm use the vm's own intrinsics.
  const ctx = {
    console, setTimeout, clearTimeout,
    TextEncoder, TextDecoder,
    atob: (s)=>Buffer.from(s, 'base64').toString('latin1'),
    btoa: (s)=>Buffer.from(s, 'latin1').toString('base64'),
    Date: FixedDate,
    Blob: class BlobStub { constructor(parts, opts){ this.parts = parts; this.type = (opts&&opts.type)||''; } },
    URL: { createObjectURL(){ return 'blob:stub'; }, revokeObjectURL(){} },
    navigator: {},
    location: { href: '' },
    document: documentStub,
    alert(){ calls.alert++; },
    __calls: calls
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  ctx.window.confirm = ()=>{ calls.confirm++; return calls.confirmReply; };

  vm.runInContext(pdfLibSrc, ctx, {filename: 'pdf-lib.js'});

  // Export shim: `const`/`let` bindings don't land on the vm global, so the
  // app script itself hands us references. typeof guards keep this working
  // for the pre-feature source where the new identifiers don't exist.
  const shim = `;globalThis.__app = {` + [
    'state','buildDays','effectiveDays','computeTotals','periodRangeText',
    'buildPdf','finalizeAndGenerate','renderSummary','removeReceipt',
    'receiptCardHtml','receiptThumbsHtml','defaultReceiptStatus',
    'MAX_RECEIPTS','MAX_RECEIPT_EDGE','RECEIPT_JPEG_QUALITY'
  ].map(n => `${n}: typeof ${n}!=='undefined' ? ${n} : undefined`).join(',') +
    `, getSteps: ()=>steps, jumpToSummary: ()=>{ stepIndex = steps.indexOf('summary'); } };`;

  vm.runInContext(appSrc + shim, ctx, {filename: 'app.js'});
  if(!ctx.PDFLib) throw new Error('PDFLib did not load in sandbox');
  return { ctx, app: ctx.__app, PDFLib: ctx.PDFLib, document: documentStub, calls };
}

/* ---------------- scenario helper ---------------- */
function fillBasicTimesheet(app, opts){
  opts = opts || {};
  const s = app.state;
  s.name = opts.name || 'Test User';
  s.startDate = '2025-09-15';   // Monday
  s.periodMode = 'twoWeeks';
  s.workedWeekends = false;
  s.wageLevel = 'M';
  app.buildDays();
  if(opts.expenses != null) s.days[0].expenses = String(opts.expenses);
  if(opts.job) s.days[0].jobAddress = opts.job;
}

/* ---------------- PDF inspection helpers ---------------- */
function tryInflate(bytes){
  const b = Buffer.from(bytes);
  if(b.length > 2 && b[0] === 0x78) { try { return zlib.inflateSync(b); } catch(e){} }
  return b;
}
function unescapePdfString(s){
  return s.replace(/\\([()\\])/g, '$1');
}
/* Concatenated text (all Tj strings) drawn on a page. */
function pageText(PDFLib, doc, page){
  const { PDFName, PDFArray } = PDFLib;
  const raw = doc.context.lookup(page.node.get(PDFName.of('Contents')));
  const streams = raw instanceof PDFArray
    ? raw.asArray().map(r => doc.context.lookup(r)) : [raw];
  let out = '';
  for(const s of streams) out += tryInflate(s.getContents()).toString('latin1') + '\n';
  const texts = [];
  // pdf-lib 1.17.1 writes WinAnsi text as hex strings: <4E414D453A> Tj
  const reHex = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
  let m;
  while((m = reHex.exec(out))){
    const hex = m[1].replace(/\s+/g, '');
    let s = '';
    for(let i=0; i+1 < hex.length; i+=2) s += String.fromCharCode(parseInt(hex.substr(i,2),16));
    texts.push(s);
  }
  // …and literal strings: (text) Tj
  const re = /\(((?:[^()\\]|\\[\s\S])*)\)\s*Tj/g;
  while((m = re.exec(out))) texts.push(unescapePdfString(m[1]));
  return texts.join('\n');
}
/* Image XObjects referenced by a page (subtype /Image only). */
function pageImages(PDFLib, doc, page){
  const { PDFName, PDFDict } = PDFLib;
  const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
  if(!res) return [];
  const xoRef = res.get(PDFName.of('XObject'));
  if(!xoRef) return [];
  const xo = doc.context.lookup(xoRef);
  if(!(xo instanceof PDFDict)) return [];
  return xo.keys()
    .map(k => doc.context.lookup(xo.get(k)))
    .filter(o => o && o.dict && String(o.dict.get(PDFName.of('Subtype'))) === '/Image');
}
function pageSizes(doc){
  return doc.getPages().map(p => {
    const sz = p.getSize();
    return `${Math.round(sz.width)}x${Math.round(sz.height)}`;
  });
}
function receiptFixture(name, stateMount){
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', name));
  return {
    name: name,
    dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'),
    w: stateMount.w, h: stateMount.h, bytes: buf.length
  };
}

/* ================= tests ================= */
(async function main(){
  const currentHtml = fs.readFileSync(INDEX, 'utf8');
  const baseRef = process.env.TIMESHEET_BASE || 'origin/main';
  let baseHtml = null;
  try { baseHtml = execSync(`git show ${baseRef}:index.html`, {cwd: ROOT, maxBuffer: 8*1024*1024}).toString('utf8'); }
  catch(e){ console.log('  (no base ref available: ' + baseRef + ')'); }

  /* ---------- 1. No expenses → card hidden, output unchanged ---------- */
  section('no expenses: card hidden, PDF is the original 3 pages');
  {
    const A = loadApp(currentHtml);
    fillBasicTimesheet(A.app, {job: 'H-1234'});
    // summary screen render: receipts card must not appear
    A.app.jumpToSummary();
    const mainEl = A.document.getElementById('main');
    A.app.renderSummary(mainEl, A.document.getElementById('footer'));
    ok(!mainEl.innerHTML.includes('receiptsCard'), 'receipts card hidden when expenses = 0');
    ok(!mainEl.innerHTML.includes('Expense receipts'), 'no "Expense receipts" heading');

    const bytes = await A.app.buildPdf();
    const doc = await A.PDFLib.PDFDocument.load(bytes);
    ok(doc.getPageCount() === 3, 'PDF has 3 pages', 'got ' + doc.getPageCount());
    ok(JSON.stringify(pageSizes(doc)) === JSON.stringify(['612x792','612x792','792x612']),
       'page sizes portrait, portrait, landscape', pageSizes(doc).join(','));

    const p0 = pageText(A.PDFLib, doc, doc.getPage(0));
    const p1 = pageText(A.PDFLib, doc, doc.getPage(1));
    const p2 = pageText(A.PDFLib, doc, doc.getPage(2));
    ok(p0.includes('Page 1 of 3'), 'week 1 labeled "Page 1 of 3"');
    ok(p1.includes('Page 2 of 3'), 'week 2 labeled "Page 2 of 3"');
    ok(!p2.includes('Page 3 of 3') && !/Page \d+ of \d+/.test(p2), 'summary page prints no page label');
    ok(doc.getPages().every(pg => pageImages(A.PDFLib, doc, pg).length === 0), 'no image XObjects anywhere');
    ok(!p0.includes('EXPENSE RECEIPT') && !p1.includes('EXPENSE RECEIPT'), 'no receipt headers on timesheet pages');

    // exact same output as the pre-feature version
    if(baseHtml && baseHtml !== currentHtml){
      const B = loadApp(baseHtml);
      fillBasicTimesheet(B.app, {job: 'H-1234'});
      const oldBytes = await B.app.buildPdf();
      const oldDoc = await B.PDFLib.PDFDocument.load(oldBytes);
      ok(oldDoc.getPageCount() === 3, 'base version also builds 3 pages');
      const samePages = doc.getPageCount() === oldDoc.getPageCount();
      let sameContent = samePages;
      let sameImages = samePages;
      for(let i=0; i<3 && samePages; i++){
        if(pageText(A.PDFLib, doc, doc.getPage(i)) !== pageText(B.PDFLib, oldDoc, oldDoc.getPage(i))) sameContent = false;
        if(pageSizes(doc)[i] !== pageSizes(oldDoc)[i]) sameContent = false;
        if(pageImages(A.PDFLib, doc, doc.getPage(i)).length !== pageImages(B.PDFLib, oldDoc, oldDoc.getPage(i)).length) sameImages = false;
      }
      ok(sameContent, 'page content identical to pre-feature output');
      ok(sameImages, 'image sets identical to pre-feature output');
      ok(Buffer.from(bytes).equals(Buffer.from(oldBytes)), 'PDF bytes identical to pre-feature output');
    }
  }

  /* ---------- 2. Expenses + 2 receipts → 4 pages, collated together ---------- */
  section('expenses + 2 receipts: one collated receipt sheet and combined total');
  {
    const A = loadApp(currentHtml);
    fillBasicTimesheet(A.app, {job: 'H-1234', expenses: 123.45});
    A.app.state.receipts.push(
      receiptFixture('receipt1.jpg', {w: 900, h: 600}),
      receiptFixture('receipt2.jpg', {w: 600, h: 900})
    );
    A.app.jumpToSummary();
    const mainEl = A.document.getElementById('main');
    A.app.renderSummary(mainEl, A.document.getElementById('footer'));
    ok(mainEl.innerHTML.includes('id="receiptsCard"'), 'receipts card shown when expenses > 0');
    ok(mainEl.innerHTML.includes('accept="image/*"') && mainEl.innerHTML.includes('multiple'), 'file input allows multiple images');
    const doc = await A.PDFLib.PDFDocument.load(await A.app.buildPdf());
    ok(doc.getPageCount() === 4, 'PDF has one combined receipt sheet');
    const receiptText = pageText(A.PDFLib, doc, doc.getPage(3));
    ok(receiptText.includes('EXPENSE RECEIPTS'), 'combined receipt sheet heading');
    ok(receiptText.includes('Receipt 1') && receiptText.includes('Receipt 2'), 'both receipts labeled on same sheet');
    ok(receiptText.includes('TOTAL EXPENSES FOR THIS PAY PERIOD: $123.45'), 'combined expense total at bottom of final sheet');
    ok(pageImages(A.PDFLib, doc, doc.getPage(3)).length === 2, 'both receipt images embedded on same page');
  }

  /* ---------- 3. Generate gate: confirm() when expenses but no receipts ---------- */
  section('generate gate: confirm on expenses with no receipts');
  {
    // OK → no PDF, scroll back to the receipts card
    const A = loadApp(currentHtml);
    fillBasicTimesheet(A.app, {job: 'H-1234', expenses: 50});
    A.app.jumpToSummary();
    A.calls.confirmReply = true;
    const card = A.document.getElementById('receiptsCard');   // pre-touch so the stub exists
    A.document.getElementById('main').innerHTML = '<sentinel>';
    await A.app.finalizeAndGenerate();
    ok(A.calls.confirm === 1, 'confirm() asked once');
    ok(card.scrolls === 1, 'OK scrolls to the receipts card');
    ok(!A.ctx.window.__pdfBlob, 'OK does not generate a PDF');
    ok(A.document.getElementById('main').innerHTML === '<sentinel>', 'OK leaves the review screen in place');

    // Cancel → generate anyway, without receipts
    const B = loadApp(currentHtml);
    fillBasicTimesheet(B.app, {job: 'H-1234', expenses: 50});
    B.app.jumpToSummary();
    B.calls.confirmReply = false;
    await B.app.finalizeAndGenerate();
    ok(B.calls.confirm === 1, 'confirm() asked once (cancel path)');
    ok(!!B.ctx.window.__pdfBlob, 'Cancel generates the PDF');
    ok(B.document.getElementById('main').innerHTML.includes('Timesheet ready'), 'Cancel lands on the done screen');
    const bDoc = await B.PDFLib.PDFDocument.load(await B.app.buildPdf());
    ok(bDoc.getPageCount() === 3, 'PDF generated without receipts stays 3 pages');

    // No expenses → never asked
    const C = loadApp(currentHtml);
    fillBasicTimesheet(C.app, {job: 'H-1234'});
    C.app.jumpToSummary();
    await C.app.finalizeAndGenerate();
    ok(C.calls.confirm === 0, 'no confirm when expenses = 0');
    ok(!!C.ctx.window.__pdfBlob, 'no-expense PDF generates directly');
  }

  /* ---------- 4. removeReceipt ---------- */
  section('removeReceipt');
  {
    const A = loadApp(currentHtml);
    fillBasicTimesheet(A.app, {expenses: 10});
    A.app.state.receipts.push(
      receiptFixture('receipt1.jpg', {w: 900, h: 600}),
      receiptFixture('receipt2.jpg', {w: 600, h: 900})
    );
    A.app.removeReceipt(0);
    ok(A.app.state.receipts.length === 1, 'splice removes one receipt');
    ok(A.app.state.receipts[0].name === 'receipt2.jpg', 'the right receipt was removed');
    const thumbs = A.document.getElementById('receiptThumbs').innerHTML;
    ok(thumbs.includes('receipt2.jpg') && !thumbs.includes('receipt1.jpg'), 'thumbnails re-render after remove');
    ok(A.document.getElementById('receiptStatus').textContent.includes('1 of 12'), 'status updates after remove');
  }

  /* ---------- 5. source-level checks for the parts a browser must run ---------- */
  section('source checks (file input, downscale pipeline, cap)');
  {
    const hiddenCss = /\.visually-hidden-input\{([^}]*)\}/s.exec(currentHtml);
    ok(!!hiddenCss && /clip\s*:\s*rect\(0\s+0\s+0\s+0\)/.test(hiddenCss[1]),
       'hidden input uses clip');
    ok(!!hiddenCss && /opacity\s*:\s*0/.test(hiddenCss[1]),
       'hidden input uses opacity');
    ok(!!hiddenCss && !/display\s*:\s*none/.test(hiddenCss[1]),
       'hidden input is NOT display:none (iOS)');
    ok(/<label[^>]*class="add-receipts-btn"[^>]*for="receiptInput"/.test(currentHtml),
       'big-button label targets the file input');
    ok(currentHtml.includes('const MAX_RECEIPTS = 12;'), '12-photo cap constant');
    ok(currentHtml.includes('MAX_RECEIPT_EDGE = 1400'), '1400px long-edge cap');
    ok(currentHtml.includes("toDataURL('image/jpeg', RECEIPT_JPEG_QUALITY)"), 'canvas re-encodes to JPEG');
    ok(currentHtml.includes('RECEIPT_JPEG_QUALITY = 0.82'), 'JPEG quality 0.82');
    ok(/FileReader/.test(currentHtml) && currentHtml.includes('readAsDataURL'), 'photos read with FileReader');
    ok(currentHtml.includes('doc.embedJpg(receipt.dataUrl)'), 'receipt photos embedded via embedJpg on the data URL');
    ok(/catch\(e\)\{\s*failed\.push/.test(currentHtml), 'decode failures collected, not fatal');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
