// 動画づくり側(run_job.py)との通しテスト用: Google側の代役をHTTPで立てる
const http = require('http'), fs = require('fs'), path = require('path');
const { load, world, rootDrive } = require('./mock');
const { products } = require('./products');
const api = load();
const A = f => fs.readFileSync(path.join(__dirname, '../assets', f));
world.now = new Date('2026-10-13T02:00:00Z');
world.fetch = url => { if (url.includes('/products.json')) return { body: { products } }; return { bytes: Buffer.from('x'), body: '', headers: { 'Content-Type': 'image/jpeg' } }; };
api.setup();
const root = rootDrive.folders[0];
const un = n => root.folders.find(f => f.name.includes(n)).folders.find(f => f.name === '未使用');
un('ハラマキ').add('wear1.jpg', 'image/jpeg', A('wear_placeholder.jpg'));
un('季節の暮らし').add('life.jpg', 'image/jpeg', A('wear_placeholder.jpg'));
un('毛布').add('実写_clip.mp4', 'video/mp4', fs.readFileSync(process.argv[2]));
api.table_('news').sh.appendRow(['年末年始のご案内', '12月26日 午前までのご注文は', '年内に発送いたします', '', '']);
api.makeNow();                       // お知らせ(告知型)
for (let i = 0; i < 5; i++) { world.props.PILLAR_IDX = String(i); if (i !== 2) api.makeNow(); }
console.log(api.table_('log').rows.map(r => r['柱'] + ':' + r['テンプレート'] + ':' + r['商品名']).join('\n'));
const reports = [];
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/img/')) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(A(path.basename(u.pathname))); }
  if (req.method === 'POST') { let b = ''; req.on('data', d => b += d); req.on('end', () => { const out = api.doPost({ postData: { contents: b } }); reports.push(JSON.parse(b)); // Apps Script と同じく 302 で返す
      res.writeHead(302, { Location: '/echo?d=' + encodeURIComponent(out.text) }); res.end(); }); return; }
  if (u.pathname === '/echo') { res.writeHead(200); return res.end(u.searchParams.get('d')); }
  if (u.pathname === '/state') { res.writeHead(200); return res.end(JSON.stringify({ rows: api.table_('log').rows.map(r => [r['状態'], r['動画URL']]), mails: world.mails.map(m => m.subject) })); }
  const out = api.doGet({ parameter: Object.fromEntries(u.searchParams) }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out.text);
}).listen(8765, () => { console.log('合言葉: ' + world.props.WEBAPP_KEY); });
