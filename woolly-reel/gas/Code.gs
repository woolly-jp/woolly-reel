/**
 * Woolly Instagram 自動投稿 — Google側の仕組み(Apps Script)
 *
 * やること:
 *   1. サイトの商品ページと同じ名前のフォルダを自動で作る
 *   2. 週2回、柱を順に回して「次の投稿」を組み立てる(商品・素材・文章)
 *   3. 動画づくり(GitHub側)に注文を渡し、できた動画を受け取る
 *   4. スタッフにメールで知らせ、確認画面の「投稿する」でInstagramに投稿する
 *   5. 失敗や確認忘れをメールで知らせる
 *
 * 最初に1回だけ setup を実行する。
 */

const ROOT_NAME = 'Woolly投稿素材';
const LIFE = '季節の暮らし';
const SUB = { unused: '未使用', next: '次に使う', used: '使用済み' };
const SHEETS = { conf: '設定', prod: '商品', log: '記録', facts: '素材の話', news: 'お知らせ' };
const HEAD = {
  conf: ['項目', '値', '説明'],
  prod: ['handle', '商品名', 'フォルダ名', 'フォルダID', '表示名', '色・種類', '価格', '在庫', '季節',
    '寄りの写真番号', '最終投稿日', '全体写真URL', '写真URL一覧', '商品ページURL', '説明'],
  log: ['ID', '作成日時', '柱', 'テンプレート', 'handle', '商品名', '状態', '動画URL', 'キャプション',
    '設定JSON', '素材ID', '確認URL', '通知日時', '投稿URL', 'メモ'],
  facts: ['テーマ', '事実(サイトに書いてある内容)', '使用日'],
  news: ['タイトル', '1行目', '2行目', '関連商品名', '使用日'],
};
const PILLARS = [
  { name: '商品紹介', template: 'slide' },
  { name: '季節の暮らし', template: 'zoom' },
  { name: '素材の話', template: 'notice' },
  { name: 'ものづくり', template: 'detail' },
  { name: '商品紹介', template: 'slide' },
];
// キャプションに入れない表現(健康効果の断定、根拠のない最上級)
const NG = [/免疫/, /治[るりっ]/, /改善/, /効[くき果能]/, /予防/, /冷え性/, /血行|血流/, /症/, /医[師療]/,
  /日本一|世界一|最高品質|ナンバーワン|No\.?\s?1/i];
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
const ST = { wait: '動画待ち', making: '作成中', review: '確認待ち', posting: '投稿中',
  processing: '処理待ち', posted: '投稿済み', skipped: '見送り', failed: '失敗' };

/* ───────── 共通の道具 ───────── */

function props_() { return PropertiesService.getScriptProperties(); }
function ss_() { return SpreadsheetApp.openById(props_().getProperty('SHEET_ID')); }

function table_(key) {
  const sh = ss_().getSheetByName(SHEETS[key]);
  const v = sh.getDataRange().getValues();
  const head = v[0];
  const rows = v.slice(1).map(function (r, i) {
    const o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
  return { sh: sh, head: head, rows: rows };
}

function saveRow_(t, o) {
  t.sh.getRange(o._row, 1, 1, t.head.length)
    .setValues([t.head.map(function (h) { return o[h] === undefined ? '' : o[h]; })]);
}

function addRow_(key, o) {
  ss_().getSheetByName(SHEETS[key])
    .appendRow(HEAD[key].map(function (h) { return o[h] === undefined ? '' : o[h]; }));
}

function conf_() {
  const m = {};
  table_('conf').rows.forEach(function (r) { m[r['項目']] = String(r['値']).trim(); });
  return m;
}

function emails_(c, withOwner) {
  const list = (c['スタッフのメール'] || '').split(/[,\s、]+/).filter(String);
  if (withOwner || !list.length) (c['管理者のメール'] || '').split(/[,\s、]+/).filter(String).forEach(function (a) { list.push(a); });
  return list.filter(function (a, i) { return list.indexOf(a) === i; });
}

function notify_(subject, body, withOwner) {
  const to = emails_(conf_(), withOwner);
  if (!to.length) { Logger.log('メールの宛先が未設定: ' + subject); return; }
  MailApp.sendEmail(to.join(','), '【Woolly投稿】' + subject, body);
}

function now_() { return new Date(); }
function today_() { return Utilities.formatDate(now_(), 'Asia/Tokyo', 'yyyy/MM/dd'); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function strip_(html) { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
function yen_(n) { return '¥' + String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function ensureSub_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function reviewBase_(c) { return c['確認画面URL'] || ScriptApp.getService().getUrl(); }

/* ───────── 最初の準備 ───────── */

/** 最初に1回だけ実行する。フォルダ、管理シート、定期実行をすべて用意する */
function setup() {
  const p = props_();
  let root;
  if (p.getProperty('ROOT_ID')) root = DriveApp.getFolderById(p.getProperty('ROOT_ID'));
  else { root = DriveApp.createFolder(ROOT_NAME); p.setProperty('ROOT_ID', root.getId()); }

  if (!p.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('Woolly自動投稿 管理シート');
    p.setProperty('SHEET_ID', ss.getId());
    DriveApp.getFileById(ss.getId()).moveTo(root);
    Object.keys(SHEETS).forEach(function (k, i) {
      const sh = i === 0 ? ss.getSheets()[0].setName(SHEETS[k]) : ss.insertSheet(SHEETS[k]);
      sh.getRange(1, 1, 1, HEAD[k].length).setValues([HEAD[k]]);
      sh.setFrozenRows(1);
    });
    const me = Session.getActiveUser().getEmail();
    [
      ['スタッフのメール', '', '投稿の確認メールを受け取る人。複数はカンマ区切り'],
      ['管理者のメール', me, '失敗の通知を一緒に受け取る人'],
      ['投稿曜日', '火,金', '投稿候補を作る曜日'],
      ['サイトURL', 'https://woolly.co.jp', '商品情報を読むサイト'],
      ['ブランド名', 'Woolly', '動画に入れる名前'],
      ['基本ハッシュタグ', '#woolly #ウーリー #メリノウール', '毎回入れるハッシュタグ'],
      ['AIモデル', 'claude-haiku-4-5-20251001', '文章づくりに使うモデル'],
      ['Instagram API版', 'v26.0', '通常は変更不要'],
      ['確認画面URL', '', 'ウェブアプリとして公開したあとのURL(…/exec)'],
    ].forEach(function (r) { ss.getSheetByName(SHEETS.conf).appendRow(r); });
    [
      ['産地', '毛布は、毛布の産地である大阪・忠岡町の工場でつくっています', ''],
      ['素材', 'ウールは「天然のエアコン」と言われる素材です', ''],
    ].forEach(function (r) { ss.getSheetByName(SHEETS.facts).appendRow(r); });
  }
  if (!p.getProperty('WEBAPP_KEY')) {
    p.setProperty('WEBAPP_KEY', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  }
  const life = ensureSub_(root, LIFE);
  Object.keys(SUB).forEach(function (k) { ensureSub_(life, SUB[k]); });
  p.setProperty('LIFE_ID', life.getId());

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scheduledCreate').timeBased().everyDays(1).atHour(11).create();
  ScriptApp.newTrigger('dailyChores').timeBased().everyDays(1).atHour(9).create();

  const n = syncProducts();
  Logger.log('準備ができました。商品フォルダ: ' + n + '件');
  Logger.log('素材フォルダ: ' + root.getUrl());
  Logger.log('管理シート: ' + ss_().getUrl());
  Logger.log('合言葉(GitHubの WEBAPP_KEY に入れる): ' + p.getProperty('WEBAPP_KEY'));
}

/* ───────── 商品ページとフォルダの同期 ───────── */

function folderNames_(products) {
  const count = {};
  products.forEach(function (p) { count[p.title] = (count[p.title] || 0) + 1; });
  const used = {};
  const out = {};
  products.forEach(function (p) {
    const m = p.title.match(/\s*[【\[]([^】\]]+)[】\]]\s*/);
    let display = p.title, variant = '', folder = p.title;
    if (m) { display = p.title.replace(m[0], '').trim(); variant = m[1].trim(); }
    if (count[p.title] > 1) {
      const vt = ((p.variants && p.variants[0] && p.variants[0].title) || '').trim().split(/\s+/);
      const suffix = vt[vt.length - 1] || p.handle;
      folder = p.title + '【' + suffix + '】';
      if (!variant) variant = suffix;
    }
    if (used[folder]) folder = p.title + '(' + p.handle + ')';
    used[folder] = true;
    out[p.handle] = { folder: folder, display: display, variant: variant };
  });
  return out;
}

function guessSeason_(title) {
  return /毛布|ブランケット|ハラマキ|腹巻|ウォーム|レッグウォーマー|レギンス/.test(title) ? '秋冬' : '通年';
}

/** サイトの商品ページを読み、フォルダと「商品」シートをそろえる(毎朝自動で実行) */
function syncProducts() {
  const c = conf_();
  const site = c['サイトURL'].replace(/\/$/, '');
  let all = [];
  for (let page = 1; page <= 10; page++) {
    const res = UrlFetchApp.fetch(site + '/products.json?limit=250&page=' + page, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('商品一覧を取得できません(' + res.getResponseCode() + ')');
    const ps = JSON.parse(res.getContentText()).products || [];
    all = all.concat(ps);
    if (ps.length < 250) break;
  }
  const names = folderNames_(all);
  const t = table_('prod');
  const root = DriveApp.getFolderById(props_().getProperty('ROOT_ID'));
  const byHandle = {};
  t.rows.forEach(function (r) { byHandle[r.handle] = r; });

  all.forEach(function (p) {
    const info = names[p.handle];
    let r = byHandle[p.handle];
    const isNew = !r;
    if (isNew) r = { handle: p.handle, '季節': guessSeason_(p.title), '寄りの写真番号': 2, '最終投稿日': '' };
    if (!r['フォルダID']) {
      const f = ensureSub_(root, info.folder);
      Object.keys(SUB).forEach(function (k) { ensureSub_(f, SUB[k]); });
      r['フォルダID'] = f.getId();
      r['フォルダ名'] = info.folder;
    }
    const prices = (p.variants || []).map(function (v) { return Number(v.price); }).filter(function (x) { return !isNaN(x); });
    const imgs = (p.images || []).map(function (i) { return i.src; });
    r['商品名'] = p.title;
    r['表示名'] = info.display;
    r['色・種類'] = info.variant;
    r['価格'] = prices.length ? yen_(Math.min.apply(null, prices)) : '';
    r['在庫'] = (p.variants || []).some(function (v) { return v.available; });
    r['全体写真URL'] = imgs[0] || '';
    r['写真URL一覧'] = imgs.join('\n');
    r['商品ページURL'] = site + '/products/' + p.handle;
    r['説明'] = strip_(p.body_html).slice(0, 600);
    if (isNew) addRow_('prod', r); else saveRow_(t, r);
  });
  const live = {};
  all.forEach(function (p) { live[p.handle] = true; });
  t.rows.forEach(function (r) {
    if (!live[r.handle] && isTrue_(r['在庫'])) { r['在庫'] = false; saveRow_(t, r); }
  });
  return all.length;
}

/* ───────── 素材を選ぶ ───────── */

function isVideo_(f) { return /^video\//.test(f.getMimeType()); }

function listFiles_(folder) {
  const out = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const mt = f.getMimeType();
    if (/^image\/(jpeg|png|webp)$/.test(mt) || /^video\//.test(mt)) out.push(f);
  }
  out.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
  return out;
}

/**
 * フォルダから着用素材を選ぶ。
 * 「次に使う」が最優先、次に動画、残りは候補(最大6枚)を返してAIがトンマナで選ぶ。
 */
function pickWear_(folderId, exclude) {
  const f = DriveApp.getFolderById(folderId);
  const ok = function (x) { return exclude.indexOf(x.getId()) < 0 && (!isVideo_(x) || x.getSize() <= MAX_VIDEO_BYTES); };
  const next = listFiles_(ensureSub_(f, SUB.next)).filter(ok);
  if (next.length) return { file: next[0] };
  const unused = listFiles_(ensureSub_(f, SUB.unused)).filter(ok);
  if (!unused.length) return null;
  const vids = unused.filter(isVideo_);
  if (vids.length) return { file: vids[0] };
  if (unused.length === 1) return { file: unused[0] };
  return { cands: unused.slice(0, 6) };
}

function seasonScore_(s) {
  const m = Number(Utilities.formatDate(now_(), 'Asia/Tokyo', 'M'));
  const cold = m >= 10 || m <= 3;
  if (s === '秋冬') return cold ? 2 : 0;
  if (s === '春夏') return cold ? 0 : 2;
  return 1;
}

/** 在庫があり、季節に合い、最後の投稿から一番日が空いている順に並べる */
function rankProducts_(avoid) {
  const rows = table_('prod').rows.filter(function (r) { return isTrue_(r['在庫']) && r['フォルダID']; });
  const inSeason = rows.filter(function (r) { return seasonScore_(r['季節']) > 0; });
  const pool = inSeason.length ? inSeason : rows;
  const time = function (r) { return r['最終投稿日'] ? new Date(r['最終投稿日']).getTime() : 0; };
  pool.sort(function (a, b) {
    const av = avoid.indexOf(a.handle) >= 0 ? 1 : 0, bv = avoid.indexOf(b.handle) >= 0 ? 1 : 0;
    return (av - bv) || (seasonScore_(b['季節']) - seasonScore_(a['季節'])) || (time(a) - time(b));
  });
  return pool;
}

function driveImage_(file) {
  // AIに見せる用の小さめの画像
  try {
    const res = UrlFetchApp.fetch('https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    const type = String(res.getHeaders()['Content-Type'] || '');
    if (res.getResponseCode() === 200 && /^image\//.test(type)) {
      return { media_type: type.split(';')[0], data: Utilities.base64Encode(res.getContent()) };
    }
  } catch (e) { /* 下の方法に切り替える */ }
  if (file.getSize() < 4 * 1024 * 1024) {
    return { media_type: file.getMimeType(), data: Utilities.base64Encode(file.getBlob().getBytes()) };
  }
  return null;
}

function webImage_(url) {
  try {
    const res = UrlFetchApp.fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'width=800', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const type = String(res.getHeaders()['Content-Type'] || 'image/jpeg').split(';')[0];
    return { media_type: type, data: Utilities.base64Encode(res.getContent()) };
  } catch (e) { return null; }
}

/* ───────── 文章をつくる(AI) ───────── */

function ngHits_(text) {
  return NG.filter(function (re) { return re.test(text); }).map(function (re) { return String(re); });
}

function claude_(c, content) {
  const key = props_().getProperty('ANTHROPIC_API_KEY');
  if (!key) return null;
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: c['AIモデル'], max_tokens: 1200, messages: [{ role: 'user', content: content }] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('AIの呼び出しに失敗(' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  const text = JSON.parse(res.getContentText()).content
    .filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AIの返事を読めませんでした');
  return JSON.parse(m[0]);
}

const RULES = [
  'あなたはウール専門ブランド「Woolly」のInstagram担当です。次のルールを必ず守ってください。',
  '・やさしく、暮らしに寄り添う語り口。売り込みの強い言葉や煽る表現は使わない。',
  '・健康への効果は書かない(免疫、治る、改善、効く、予防、冷え性、血行 などは禁止)。あたたかさ、着心地、肌ざわりの表現にとどめる。',
  '・「日本一」「最高品質」など根拠のない最上級は使わない。',
  '・下の「事実」に書かれていない効果、数字、産地、素材は書かない。価格は書かない。',
  '・絵文字は使っても1〜2個まで。',
  '・caption の構成: 1行目で場面や季節の実感 → 2〜4文の本文(事実を1つ入れる) → 空行 → 商品名 → 「プロフィールのリンクからご覧いただけます」 → 空行 → ハッシュタグ5〜8個(基本ハッシュタグを含める)。',
].join('\n');

/**
 * 動画に載せるひとこと、キャプション、(候補が複数あれば)着用素材の選択をAIに頼む。
 * AIが使えないときは、控えめな定型文にする。
 */
function writeText_(c, job) {
  const p = job.product;
  const facts = [
    '商品名: ' + (p ? p['商品名'] : '(なし)'),
    '商品説明: ' + (p ? p['説明'] : ''),
    job.fact ? 'テーマ: ' + job.fact : '',
    job.news ? 'お知らせ: ' + job.news.title + ' / ' + job.news.lines.join(' ') : '',
    '柱: ' + job.pillar,
    '今日: ' + today_(),
    '基本ハッシュタグ: ' + c['基本ハッシュタグ'],
  ].filter(String).join('\n');

  const want = { caption: 'Instagramのキャプション' };
  if (job.template === 'notice' && !job.news) {
    want.notice_title = '画面に大きく出す見出し(12文字以内)';
    want.notice_lines = '見出しの下に出す2行(各16文字以内)の配列。テーマの事実だけを書く';
  } else if (job.template !== 'notice') {
    want.copy = '動画に重ねるひとこと(15文字以内、句点で終える)';
  }
  const content = [];
  const cands = job.cands || [];
  if (cands.length) {
    want.pick = '実物写真と色味・明るさが最も近く、落ち着いた自然光のトーンに合う候補の番号(1始まり)';
    const base = p && webImage_(p['全体写真URL']);
    if (base) {
      content.push({ type: 'text', text: '実物写真:' });
      content.push({ type: 'image', source: { type: 'base64', media_type: base.media_type, data: base.data } });
    }
    cands.forEach(function (f, i) {
      const img = driveImage_(f);
      if (!img) return;
      content.push({ type: 'text', text: '候補' + (i + 1) + ':' });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    });
  }
  content.push({
    type: 'text',
    text: RULES + '\n\n【事実】\n' + facts + '\n\n次のキーを持つJSONだけを返してください:\n' + JSON.stringify(want, null, 1),
  });

  const name = p ? p['表示名'] : '';
  const fallback = {
    pick: 1,
    copy: 'あたたかく、心地よく。',
    caption: (name ? name + '\n' : '') + 'プロフィールのリンクからご覧いただけます\n\n' + c['基本ハッシュタグ'],
    notice_title: job.fact ? String(job.factTheme || 'Woollyの話').slice(0, 12) : '',
    notice_lines: job.fact ? [String(job.fact).slice(0, 16), String(job.fact).slice(16, 32)].filter(String) : [],
  };
  let out = null, note = '';
  try {
    out = claude_(c, content);
    if (out) {
      const check = function (o) { return ngHits_([o.caption, o.copy, o.notice_title, (o.notice_lines || []).join(' ')].join(' ')); };
      if (check(out).length) {
        content.push({ type: 'text', text: '前回の案には禁止表現が含まれていました。禁止表現を一切使わずに書き直してください。' });
        out = claude_(c, content);
      }
      if (check(out).length) note = '要確認: 健康効果などの表現が残っている可能性があります';
    } else {
      note = 'AI未設定のため定型文です';
    }
  } catch (e) {
    note = 'AIが使えなかったため定型文です(' + e.message + ')';
    out = null;
  }
  const r = Object.assign({}, fallback, out || {});
  r.pick = Math.min(Math.max(1, parseInt(r.pick, 10) || 1), Math.max(1, cands.length));
  r.note = note;
  return r;
}

/* ───────── 次の投稿を組み立てる ───────── */

function recentHandles_() {
  const rows = table_('log').rows;
  return rows.slice(-2).map(function (r) { return r.handle; }).filter(String);
}

/**
 * 投稿候補を1つ組み立てて「記録」に追加する。
 * opt: { pillarIdx, excludeMaterials[], avoidHandles[], news{row,title,lines,related}, memo }
 */
function createJob_(opt) {
  const c = conf_();
  const pillar = PILLARS[opt.pillarIdx % PILLARS.length];
  const excl = opt.excludeMaterials || [];
  const ranked = rankProducts_((opt.avoidHandles || []).concat(recentHandles_()));
  if (!ranked.length) throw new Error('投稿できる商品がありません(在庫と「商品」シートを確認してください)');

  const job = { pillar: opt.news ? 'お知らせ' : pillar.name, template: opt.news ? 'notice' : pillar.template, memo: opt.memo || '' };
  let wear = null;

  if (job.template === 'slide' || job.template === 'zoom') {
    if (job.template === 'zoom') {
      wear = pickWear_(props_().getProperty('LIFE_ID'), excl);
      if (wear) job.product = ranked[0];
    }
    for (let i = 0; !wear && i < ranked.length; i++) {
      wear = pickWear_(ranked[i]['フォルダID'], excl);
      if (wear) job.product = ranked[i];
    }
    if (!wear) {
      // 着用素材がひとつもない → 実物写真だけで作れるディテール型に切り替えて知らせる
      job.template = 'detail';
      job.memo = (job.memo + ' 着用素材がないためディテール型に変更').trim();
      notify_('素材がありません', '「未使用」フォルダに着用素材がないため、今回は実物写真だけで作りました。\n着用の画像や動画を追加してください。\n' +
        DriveApp.getFolderById(props_().getProperty('ROOT_ID')).getUrl(), false);
    }
  }
  if (job.template === 'detail') {
    job.product = ranked.filter(function (r) { return String(r['写真URL一覧']).split('\n').filter(String).length >= 2; })[0] || ranked[0];
  }
  if (job.template === 'notice') {
    if (opt.news) {
      job.news = opt.news;
      job.product = ranked.filter(function (r) { return opt.news.related && String(r['商品名']).indexOf(opt.news.related) >= 0; })[0] || ranked[0];
    } else {
      const ft = table_('facts');
      const facts = ft.rows.filter(function (r) { return r['事実(サイトに書いてある内容)']; });
      if (!facts.length) throw new Error('「素材の話」シートが空です');
      facts.sort(function (a, b) { return (a['使用日'] ? new Date(a['使用日']).getTime() : 0) - (b['使用日'] ? new Date(b['使用日']).getTime() : 0); });
      job.fact = facts[0]['事実(サイトに書いてある内容)'];
      job.factTheme = facts[0]['テーマ'];
      job.factRow = facts[0]._row;
      job.product = ranked[0];
    }
  }

  job.cands = wear && wear.cands ? wear.cands : [];
  const text = writeText_(c, job);
  const wearFile = wear ? (wear.file || wear.cands[text.pick - 1] || wear.cands[0]) : null;
  const p = job.product;
  const imgs = String(p['写真URL一覧']).split('\n').filter(String);
  const detailNo = Math.min(Math.max(1, parseInt(p['寄りの写真番号'], 10) || 2), imgs.length);

  const config = {
    template: job.template, brand: c['ブランド名'] || 'Woolly',
    name: p['表示名'], variant: p['色・種類'], price: p['価格'], copy: text.copy,
    ai_image: wearFile ? !/^実写/.test(wearFile.getName()) : false,
  };
  const files = { product_image: { url: p['全体写真URL'] } };
  if (wearFile) files.wear_image = { drive_id: wearFile.getId() };
  if (job.template === 'detail') files.detail_image = { url: imgs[detailNo - 1] || imgs[0] };
  if (job.template === 'notice') {
    config.notice_title = job.news ? job.news.title : text.notice_title;
    config.notice_lines = [].concat(job.news ? job.news.lines : (text.notice_lines || [])).map(String).slice(0, 3);
  }

  const id = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
  const stamp = Utilities.formatDate(now_(), 'Asia/Tokyo', 'yyyyMMdd');
  addRow_('log', {
    'ID': id, '作成日時': now_(), '柱': job.pillar, 'テンプレート': job.template,
    'handle': p.handle, '商品名': p['商品名'], '状態': ST.wait, 'キャプション': text.caption,
    '設定JSON': JSON.stringify({ file_name: stamp + '-' + id + '.mp4', config: config, files: files,
      pillarIdx: opt.pillarIdx, factRow: job.factRow || '', newsRow: opt.news ? opt.news.row : '' }),
    '素材ID': wearFile ? wearFile.getId() : '',
    '確認URL': reviewBase_(c) + '?t=' + id,
    'メモ': [job.memo, text.note].filter(String).join(' / '),
  });
  return id;
}

/** 「お知らせ」シートの1行を読む。row を省くと、まだ使っていない最初の行 */
function news_(row) {
  const t = table_('news');
  const r = t.rows.filter(function (x) { return row ? x._row === row : (x['タイトル'] && !x['使用日']); })[0];
  if (!r || !r['タイトル']) return null;
  return { row: r._row, title: String(r['タイトル']), lines: [r['1行目'], r['2行目']].filter(String).map(String), related: String(r['関連商品名'] || '') };
}

/** 毎日11時に動く。投稿曜日なら、次の柱で投稿候補を作る */
function scheduledCreate() {
  try {
    const c = conf_();
    const day = '日月火水木金土'.charAt(Number(Utilities.formatDate(now_(), 'Asia/Tokyo', 'u')) % 7);
    if ((c['投稿曜日'] || '').indexOf(day) < 0) return;
    makeNow();
  } catch (e) {
    notify_('投稿候補を作れませんでした', String(e && e.stack || e), true);
  }
}

/** 曜日に関係なく、いますぐ投稿候補を1つ作る(動作チェック用にも使う) */
function makeNow() {
  const p = props_();
  const news = news_();
  const idx = Number(p.getProperty('PILLAR_IDX') || 0);
  const id = createJob_({ pillarIdx: idx, news: news });
  // お知らせは1回だけ差し込む(柱の順番は進めない)
  if (news) table_('news').sh.getRange(news.row, 5).setValue(now_());
  else p.setProperty('PILLAR_IDX', String((idx + 1) % PILLARS.length));
  return id;
}

/* ───────── 動画づくり(GitHub側)とのやりとり ───────── */

function findJob_(id) {
  const t = table_('log');
  const r = t.rows.filter(function (x) { return x['ID'] === id; })[0];
  return r ? { t: t, r: r, spec: JSON.parse(r['設定JSON'] || '{}') } : null;
}

function doGet(e) {
  const q = (e && e.parameter) || {};
  if (!q.action) {
    const tpl = HtmlService.createTemplateFromFile('Review');
    tpl.token = q.t || '';
    return tpl.evaluate().setTitle('Woolly 投稿の確認').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  if (q.key !== props_().getProperty('WEBAPP_KEY')) return json_({ error: 'forbidden' });
  if (q.action === 'peek') {
    return json_({ pending: table_('log').rows.filter(function (r) { return r['状態'] === ST.wait; }).length });
  }
  if (q.action === 'job') {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const t = table_('log');
      const r = t.rows.filter(function (x) { return x['状態'] === ST.wait; })[0];
      if (!r) return json_({});
      r['状態'] = ST.making;
      saveRow_(t, r);
      const spec = JSON.parse(r['設定JSON']);
      return json_({ id: r['ID'], file_name: spec.file_name, config: spec.config, files: spec.files });
    } finally { lock.releaseLock(); }
  }
  if (q.action === 'file') {
    try {
      const f = DriveApp.getFileById(q.id);
      if (f.getSize() > MAX_VIDEO_BYTES) return json_({ error: 'ファイルが大きすぎます(30MBまで)' });
      return json_({ name: f.getName(), mime: f.getMimeType(), b64: Utilities.base64Encode(f.getBlob().getBytes()) });
    } catch (err) { return json_({ error: String(err) }); }
  }
  return json_({ error: 'unknown action' });
}

function doPost(e) {
  let d = {};
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad request' }); }
  if (d.key !== props_().getProperty('WEBAPP_KEY')) return json_({ error: 'forbidden' });
  const j = findJob_(d.id);
  if (!j) return json_({ error: 'not found' });
  if (d.action === 'done') {
    j.r['動画URL'] = d.video_url;
    j.r['状態'] = ST.review;
    j.r['通知日時'] = now_();
    saveRow_(j.t, j.r);
    notify_('投稿候補ができました(' + j.r['柱'] + ')',
      '投稿候補ができました。動画とキャプションを確認して、OKなら「投稿する」を押してください。\n\n' +
      '柱: ' + j.r['柱'] + '\n商品: ' + j.r['商品名'] + '\n\n確認画面:\n' + j.r['確認URL'] + '\n\n' +
      '※動画が表示されるまで、数分かかることがあります。', false);
    return json_({ ok: true });
  }
  if (d.action === 'failed') {
    j.r['状態'] = ST.failed;
    j.r['メモ'] = (j.r['メモ'] + ' / 動画を作れませんでした: ' + String(d.error || '').slice(0, 300)).replace(/^ \/ /, '');
    saveRow_(j.t, j.r);
    notify_('動画を作れませんでした', '商品: ' + j.r['商品名'] + '\n\nよくある原因: 画像の形式(JPEGかPNGにする)、動画が長すぎる・大きすぎる。\n' +
      '素材を入れ直すと、次の回で作り直されます。\n\n詳細:\n' + d.error, true);
    return json_({ ok: true });
  }
  return json_({ error: 'unknown action' });
}

/* ───────── 確認画面から呼ばれる処理 ───────── */

function getReview(token) {
  const j = findJob_(token);
  if (!j) return { state: 'なし' };
  return { state: j.r['状態'], pillar: j.r['柱'], product: j.r['商品名'], video: j.r['動画URL'],
    caption: j.r['キャプション'], memo: j.r['メモ'], permalink: j.r['投稿URL'] };
}

function ig_(c, method, path, params) {
  const token = props_().getProperty('IG_TOKEN');
  if (!token) throw new Error('Instagramとの接続が未設定です');
  const base = 'https://graph.instagram.com/' + (c['Instagram API版'] || 'v26.0') + '/' + path;
  const p = Object.assign({ access_token: token }, params || {});
  const qs = Object.keys(p).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
  const res = method === 'get'
    ? UrlFetchApp.fetch(base + '?' + qs, { muteHttpExceptions: true })
    : UrlFetchApp.fetch(base, { method: 'post', payload: p, muteHttpExceptions: true });
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300 || body.error) {
    throw new Error('Instagram: ' + ((body.error && body.error.message) || res.getContentText().slice(0, 300)));
  }
  return body;
}

function finishPublish_(c, j, containerId) {
  const igId = props_().getProperty('IG_USER_ID');
  const media = ig_(c, 'post', igId + '/media_publish', { creation_id: containerId });
  let link = '';
  try { link = ig_(c, 'get', media.id, { fields: 'permalink' }).permalink || ''; } catch (e) { /* 取得できなくても投稿は成功 */ }
  j.r['状態'] = ST.posted;
  j.r['投稿URL'] = link || media.id;
  saveRow_(j.t, j.r);

  // 使った素材を「使用済み」へ。商品の最終投稿日、ネタの使用日を記録
  const pt = table_('prod');
  const pr = pt.rows.filter(function (x) { return x.handle === j.r.handle; })[0];
  if (pr) { pr['最終投稿日'] = now_(); saveRow_(pt, pr); }
  if (j.r['素材ID']) {
    try {
      const f = DriveApp.getFileById(j.r['素材ID']);
      const parent = f.getParents().next();
      const home = parent.getName() === SUB.used ? null : parent.getParents().next();
      if (home) f.moveTo(ensureSub_(home, SUB.used));
    } catch (e) { Logger.log('素材を移動できませんでした: ' + e); }
  }
  if (j.spec.factRow) table_('facts').sh.getRange(j.spec.factRow, 3).setValue(now_());
  return link;
}

/** 「投稿する」ボタン */
function publish(token, caption) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let j;
  try {
    j = findJob_(token);
    if (!j) return { ok: false, message: '投稿候補が見つかりません' };
    if (j.r['状態'] !== ST.review) return { ok: false, message: 'この投稿は「' + j.r['状態'] + '」です' };
    const hits = ngHits_(caption);
    if (hits.length) return { ok: false, message: 'キャプションに使えない表現があります。直してからもう一度押してください: ' + hits.join(' ') };
    j.r['状態'] = ST.posting;
    j.r['キャプション'] = caption;
    saveRow_(j.t, j.r);
  } finally { lock.releaseLock(); }

  const c = conf_();
  try {
    const igId = props_().getProperty('IG_USER_ID');
    if (!igId) throw new Error('Instagramとの接続が未設定です');
    const box = ig_(c, 'post', igId + '/media', { media_type: 'REELS', video_url: j.r['動画URL'], caption: caption, share_to_feed: 'true' });
    for (let i = 0; i < 24; i++) {  // 最長4分ほど待つ
      Utilities.sleep(10000);
      const st = ig_(c, 'get', box.id, { fields: 'status_code,status' });
      if (st.status_code === 'FINISHED') {
        const link = finishPublish_(c, j, box.id);
        return { ok: true, message: '投稿しました', permalink: link };
      }
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('動画を受け付けてもらえませんでした: ' + (st.status || st.status_code));
    }
    // まだ処理中 → あとで自動的に仕上げる
    j.r['状態'] = ST.processing;
    j.r['メモ'] = (j.r['メモ'] + ' / container:' + box.id).replace(/^ \/ /, '');
    saveRow_(j.t, j.r);
    ScriptApp.newTrigger('finishPending').timeBased().after(5 * 60 * 1000).create();
    return { ok: true, message: 'Instagram側で処理中です。数分後に自動で投稿されます' };
  } catch (e) {
    j.r['状態'] = ST.review;
    saveRow_(j.t, j.r);
    notify_('投稿に失敗しました', '商品: ' + j.r['商品名'] + '\n原因: ' + e.message +
      '\n\n確認画面からもう一度「投稿する」を押せます:\n' + j.r['確認URL'] +
      '\n\n「接続」に関するエラーが続くときは、管理担当が手順書の「Instagramの再接続」を行ってください。', true);
    return { ok: false, message: '投稿に失敗しました: ' + e.message };
  }
}

/** Instagram側の処理が長引いた投稿を仕上げる */
function finishPending() {
  const c = conf_();
  const t = table_('log');
  t.rows.filter(function (r) { return r['状態'] === ST.processing; }).forEach(function (r) {
    const m = String(r['メモ']).match(/container:(\d+)/);
    const j = { t: t, r: r, spec: JSON.parse(r['設定JSON'] || '{}') };
    try {
      const st = ig_(c, 'get', m[1], { fields: 'status_code,status' });
      if (st.status_code === 'FINISHED') finishPublish_(c, j, m[1]);
      else if (st.status_code !== 'IN_PROGRESS') throw new Error(st.status || st.status_code);
    } catch (e) {
      r['状態'] = ST.review;
      saveRow_(t, r);
      notify_('投稿に失敗しました', '商品: ' + r['商品名'] + '\n原因: ' + e.message + '\n\n確認画面:\n' + r['確認URL'], true);
    }
  });
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'finishPending') ScriptApp.deleteTrigger(tr);
  });
}

/** 「見送る」ボタン。別の素材で作り直す */
function skip(token) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const j = findJob_(token);
    if (!j) return { ok: false, message: '投稿候補が見つかりません' };
    if (j.r['状態'] !== ST.review) return { ok: false, message: 'この投稿は「' + j.r['状態'] + '」です' };
    j.r['状態'] = ST.skipped;
    saveRow_(j.t, j.r);
    // 同じ柱で見送った素材は、今回の作り直しでは使わない
    const skipped = j.t.rows.filter(function (r) { return r['状態'] === ST.skipped && r['素材ID']; }).slice(-6).map(function (r) { return r['素材ID']; });
    try {
      createJob_({ pillarIdx: Number(j.spec.pillarIdx || 0), excludeMaterials: skipped,
        avoidHandles: j.r['素材ID'] ? [] : [j.r.handle], memo: '見送りの作り直し',
        news: j.spec.newsRow ? news_(Number(j.spec.newsRow)) : null });
      return { ok: true, message: '見送りました。別の素材で作り直します(最長2時間ほどでメールが届きます)' };
    } catch (e) {
      return { ok: true, message: '見送りました。作り直しはできませんでした: ' + e.message };
    }
  } finally { lock.releaseLock(); }
}

/* ───────── 毎朝の見回り ───────── */

function dailyChores() {
  const errors = [];
  try { syncProducts(); } catch (e) { errors.push('商品の同期: ' + e.message); }
  try { refreshToken_(); } catch (e) { errors.push('Instagramの接続更新: ' + e.message + '(手順書の「Instagramの再接続」を行ってください)'); }
  try {
    const t = table_('log');
    const hours = function (d) { return d ? (now_().getTime() - new Date(d).getTime()) / 3600000 : 0; };
    t.rows.forEach(function (r) {
      if (r['状態'] === ST.review && hours(r['通知日時']) > 20 && String(r['メモ']).indexOf('催促済み') < 0) {
        notify_('確認をお願いします(まだボタンが押されていません)', '商品: ' + r['商品名'] + '\n確認画面:\n' + r['確認URL'], false);
        r['メモ'] = (r['メモ'] + ' / 催促済み').replace(/^ \/ /, '');
        saveRow_(t, r);
      }
      if ((r['状態'] === ST.wait || r['状態'] === ST.making) && hours(r['作成日時']) > 6 && String(r['メモ']).indexOf('遅延通知済み') < 0) {
        errors.push('動画がまだできていません(' + r['商品名'] + ')。GitHubの「Actions」が止まっていないか確認してください');
        r['状態'] = ST.wait;
        r['メモ'] = (r['メモ'] + ' / 遅延通知済み').replace(/^ \/ /, '');
        saveRow_(t, r);
      }
    });
  } catch (e) { errors.push('見回り: ' + e.message); }
  if (errors.length) notify_('確認が必要なことがあります', errors.join('\n\n'), true);
}

/** Instagramの接続は約60日で切れるため、週1回自動で延長する */
function refreshToken_() {
  const p = props_();
  const token = p.getProperty('IG_TOKEN');
  if (!token) return;
  const at = Number(p.getProperty('IG_TOKEN_AT') || 0);
  if (now_().getTime() - at < 7 * 24 * 3600 * 1000) return;
  const res = UrlFetchApp.fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' +
    encodeURIComponent(token), { muteHttpExceptions: true });
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200 || !body.access_token) throw new Error((body.error && body.error.message) || '更新できませんでした');
  p.setProperty('IG_TOKEN', body.access_token);
  p.setProperty('IG_TOKEN_AT', String(now_().getTime()));
}

/* ───────── 接続の設定と動作チェック用 ───────── */

/** Instagramの接続を確かめ、アカウント番号を保存する(スクリプト プロパティ IG_TOKEN を入れたあとに実行) */
function testInstagram() {
  const me = ig_(conf_(), 'get', 'me', { fields: 'user_id,username,account_type' });
  props_().setProperty('IG_USER_ID', String(me.user_id || me.id));
  props_().setProperty('IG_TOKEN_AT', String(now_().getTime() - 6 * 24 * 3600 * 1000));
  Logger.log('接続できました: @' + me.username + '(' + me.account_type + ')');
}

/** AIの接続を確かめる(スクリプト プロパティ ANTHROPIC_API_KEY を入れたあとに実行) */
function testAI() {
  const out = claude_(conf_(), [{ type: 'text', text: '次のJSONだけを返してください: {"ok": true}' }]);
  Logger.log(out ? 'AIに接続できました' : 'ANTHROPIC_API_KEY が未設定です');
}

/** メールが届くか確かめる */
function testMail() { notify_('テスト', 'このメールが届けば、通知の設定はできています。', true); }
