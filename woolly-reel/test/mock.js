// Apps Script の代わりになる、メモリ上の簡易な環境(テスト専用)
const vm = require('vm'), fs = require('fs'), path = require('path');
let seq = 0;
const nid = p => p + (++seq);
class File { constructor(name, mime, bytes, parent) { this.id = nid('file'); this.name = name; this.mime = mime; this.bytes = bytes; this.parent = parent; this.created = new Date(Date.now() + seq * 1000); }
  getId() { return this.id; } getName() { return this.name; } getMimeType() { return this.mime; } getSize() { return this.bytes.length; }
  getDateCreated() { return this.created; } getBlob() { return { getBytes: () => this.bytes }; }
  getParents() { const p = this.parent; let d = false; return { hasNext: () => !d, next: () => { d = true; return p; } }; }
  moveTo(f) { this.parent.files = this.parent.files.filter(x => x !== this); f.files.push(this); this.parent = f; return this; } }
class Folder { constructor(name, parent) { this.id = nid('folder'); this.name = name; this.parent = parent; this.folders = []; this.files = []; }
  getId() { return this.id; } getName() { return this.name; } getUrl() { return 'https://drive.example/' + this.id; }
  createFolder(n) { const f = new Folder(n, this); this.folders.push(f); world.byId[f.id] = f; return f; }
  getFoldersByName(n) { const l = this.folders.filter(f => f.name === n); let i = 0; return { hasNext: () => i < l.length, next: () => l[i++] }; }
  getFiles() { const l = this.files.slice(); let i = 0; return { hasNext: () => i < l.length, next: () => l[i++] }; }
  getParents() { const p = this.parent; let d = false; return { hasNext: () => !d, next: () => { d = true; return p; } }; }
  add(name, mime, bytes) { const f = new File(name, mime, bytes || Buffer.from('x'), this); this.files.push(f); world.byId[f.id] = f; return f; } }
class Sheet { constructor(name) { this.name = name; this.data = []; }
  setName(n) { this.name = n; return this; } setFrozenRows() {} getLastRow() { return this.data.length; }
  appendRow(r) { this.data.push(r.slice()); }
  getDataRange() { return { getValues: () => this.data.map(r => r.slice()) }; }
  getRange(r, c, nr, nc) { const s = this; nr = nr || 1; nc = nc || 1; return {
    setValues(v) { for (let i = 0; i < nr; i++) { while (s.data.length < r + i) s.data.push([]); for (let j = 0; j < nc; j++) s.data[r - 1 + i][c - 1 + j] = v[i][j]; } },
    setValue(v) { this.setValues([[v]]); } }; } }
class SS { constructor() { this.id = nid('ss'); this.sheets = [new Sheet('Sheet1')]; }
  getId() { return this.id; } getUrl() { return 'https://sheets.example/' + this.id; } getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; } insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; } }
const world = { byId: {}, props: {}, mails: [], triggers: [], fetch: null, now: null };
const rootDrive = new Folder('マイドライブ', null);
function load() {
  const ctx = {
    console, Buffer, JSON, Math, Date, Object, String, Number, parseInt, encodeURIComponent, RegExp, Array,
    Logger: { log: (...a) => world.log && console.log('  [log]', ...a) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => world.props[k] === undefined ? null : world.props[k], setProperty: (k, v) => { world.props[k] = String(v); } }) },
    SpreadsheetApp: { create: () => { const s = new SS(); world.byId[s.id] = s; rootDrive.add('管理シート', 'sheet').ss = s; world.byId[s.id + ':file'] = rootDrive.files[rootDrive.files.length - 1]; return s; }, openById: id => world.byId[id] },
    DriveApp: { createFolder: n => rootDrive.createFolder(n), getFolderById: id => world.byId[id], getFileById: id => { const f = world.byId[id + ':file'] || world.byId[id]; if (!f) throw new Error('ファイルがありません'); return f; } },
    Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    MailApp: { sendEmail: (to, subject, body) => world.mails.push({ to, subject, body }) },
    ScriptApp: { getProjectTriggers: () => world.triggers, deleteTrigger: t => { world.triggers = world.triggers.filter(x => x !== t); },
      newTrigger: fn => { const t = { fn, getHandlerFunction: () => fn }; const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, after: () => b, create: () => { world.triggers.push(t); return t; } }; return b; },
      getOAuthToken: () => 'tok', getService: () => ({ getUrl: () => world.webapp || 'https://script.example/exec' }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => require('crypto').randomUUID(), base64Encode: b => Buffer.from(b).toString('base64'), sleep() {},
      formatDate: (d, tz, f) => { const j = new Date(d.getTime() + 9 * 3600000); const p = n => String(n).padStart(2, '0');
        return { 'yyyy/MM/dd': `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())}`, 'yyyyMMdd': `${j.getUTCFullYear()}${p(j.getUTCMonth() + 1)}${p(j.getUTCDate())}`,
          'M': String(j.getUTCMonth() + 1), 'u': String(j.getUTCDay() || 7) }[f]; } },
    UrlFetchApp: { fetch: (url, opt) => { const r = world.fetch(url, opt || {}); const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return { getResponseCode: () => r.code || 200, getContentText: () => body, getContent: () => r.bytes || Buffer.from(body), getHeaders: () => r.headers || {} }; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    HtmlService: { createTemplateFromFile: () => ({ evaluate() { const o = { html: true, token: this.token, setTitle: () => o, addMetaTag: () => o }; return o; } }) },
  };
  vm.createContext(ctx);
  let src = fs.readFileSync(path.join(__dirname, '../gas/Code.gs'), 'utf8');
  src = src.replace('function now_() { return new Date(); }', 'function now_() { return __world.now || new Date(); }');
  ctx.__world = world;
  vm.runInContext(src + '\n;this.__api = { setup, syncProducts, makeNow, scheduledCreate, doGet, doPost, getReview, publish, skip, dailyChores, finishPending, testInstagram, table_, folderNames_, ngHits_, PILLARS };', ctx);
  return ctx.__api;
}
module.exports = { load, world, rootDrive };
