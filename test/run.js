const assert = require('assert');
const { load, world, rootDrive } = require('./mock');
const { products } = require('./products');
const api = load();
let igCalls = [], aiCalls = 0, aiReply = null;
world.now = new Date('2026-10-13T02:00:00Z'); // 火曜 11:00 JST
world.fetch = (url, opt) => {
  if (url.includes('/products.json')) return { body: { products } };
  if (url.includes('api.anthropic.com')) { aiCalls++; return { body: { content: [{ type: 'text', text: JSON.stringify(aiReply(JSON.parse(opt.payload))) }] } }; }
  if (url.includes('drive.google.com/thumbnail') || url.includes('/img/')) return { bytes: Buffer.from('img'), body: '', headers: { 'Content-Type': 'image/jpeg' } };
  if (url.includes('graph.instagram.com')) { igCalls.push(url.split('?')[0].replace(/.*v26\.0\//, '') + (opt.method ? ' POST' : ' GET'));
    if (url.includes('refresh_access_token')) return { body: { access_token: 'NEW', expires_in: 5184000 } };
    if (url.includes('/me?')) return { body: { user_id: '1789', username: 'woolly.official', account_type: 'BUSINESS' } };
    if (/\/media$/.test(url)) { assert.strictEqual(opt.payload.media_type, 'REELS'); assert.ok(/^https:\/\/.+\.mp4$/.test(opt.payload.video_url)); return { body: { id: '555' } }; }
    if (url.includes('/555?')) return { body: { status_code: 'FINISHED' } };
    if (/media_publish$/.test(url)) return { body: { id: '999' } };
    if (url.includes('/999?')) return { body: { permalink: 'https://www.instagram.com/reel/abc/' } };
  }
  throw new Error('想定外のURL: ' + url);
};
const T = k => api.table_(k).rows;
const ok = m => console.log('  ✓ ' + m);

console.log('1. 準備とフォルダ');
api.setup();
const root = rootDrive.folders[0];
const names = root.folders.map(f => f.name);
assert.strictEqual(T('prod').length, 8);
assert.ok(names.includes('ウールとコットンのウォームソックス【オフホワイト】') && names.includes('ウールとコットンのウォームソックス【ブラック】'));
assert.ok(names.includes('メリノウールの冷えとりハラマキ 【チャコール】') && names.includes('季節の暮らし'));
assert.strictEqual(new Set(names).size, names.length);
root.folders.forEach(f => assert.deepStrictEqual(f.folders.map(x => x.name).sort(), ['使用済み', '未使用', '次に使う'].sort()));
const hara = T('prod').find(r => r.handle === 'whu-001-cl-f');
assert.deepStrictEqual([hara['表示名'], hara['色・種類'], hara['価格'], hara['季節']], ['メリノウールの冷えとりハラマキ', 'チャコール', '¥2,310', '秋冬']);
assert.strictEqual(T('prod').find(r => r.handle === 'wau-001-cl-f')['在庫'], false);
api.syncProducts(); assert.strictEqual(T('prod').length, 8); assert.strictEqual(root.folders.length, names.length);
assert.strictEqual(world.triggers.length, 2);
ok('商品8件のフォルダと3つの小フォルダ、重複名の区別、再同期で増えない');

console.log('2. 素材なし → ディテール型に切り替えて知らせる');
world.props.PILLAR_IDX = '0';
let id = api.makeNow();
let row = T('log').find(r => r.ID === id);
assert.strictEqual(row['テンプレート'], 'detail'); assert.ok(world.mails.some(m => m.subject.includes('素材がありません')));
assert.ok(row['メモ'].includes('AI未設定'));
ok('着用素材ゼロでも止まらず、メールで知らせる');

console.log('3. 柱を順に回す(AIあり、素材あり)');
world.props.ANTHROPIC_API_KEY = 'k'; world.props.PILLAR_IDX = '0';
const fHara = root.folders.find(f => f.name.includes('ハラマキ'));
const u = fHara.folders.find(f => f.name === '未使用');
const a = u.add('a.jpg', 'image/jpeg'), b = u.add('b.png', 'image/png'); u.add('memo.heic', 'image/heic');
const fBlanket = root.folders.find(f => f.name.includes('毛布'));
const vid = fBlanket.folders.find(f => f.name === '未使用').add('実写_広げる.mp4', 'video/mp4');
fBlanket.folders.find(f => f.name === '未使用').add('big.mov', 'video/quicktime', Buffer.alloc(31 * 1024 * 1024));
let sawImages = 0;
aiReply = req => { const c = req.messages[0].content; sawImages = c.filter(x => x.type === 'image').length;
  return { pick: 2, copy: 'お腹から、あたたかく。', caption: '朝の空気が冷たくなってきました。\nやわらかなメリノウールが包みます。\n\n商品名\nプロフィールのリンクからご覧いただけます\n\n#woolly #メリノウール', notice_title: 'ウールのこと', notice_lines: ['天然のエアコンと', '言われる素材です'] }; };
const ids = [], seen = [];
for (let i = 0; i < 5; i++) { id = api.makeNow(); ids.push(id); row = T('log').find(r => r.ID === id); const spec = JSON.parse(row['設定JSON']);
  seen.push(row['柱'] + ':' + row['テンプレート'] + ':' + row.handle);
  // 投稿済みにして次へ(最終投稿日を進める)
  const pt = api.table_('prod'); const pr = pt.rows.find(r => r.handle === row.handle); pr['最終投稿日'] = new Date(world.now.getTime() + i * 1000); pt.sh.getRange(pr._row, 1, 1, pt.head.length).setValues([pt.head.map(h => pr[h])]);
  if (i === 0) { assert.strictEqual(spec.files.wear_image.drive_id, vid.id, '動画が優先される'); assert.strictEqual(spec.config.ai_image, false, '実写_は札なし'); assert.strictEqual(sawImages, 0); }
  if (i === 1) { assert.strictEqual(spec.config.template, 'zoom'); assert.strictEqual(spec.files.wear_image.drive_id, b.id, 'AIが2番を選ぶ'); assert.strictEqual(sawImages, 3); assert.strictEqual(spec.config.ai_image, true); }
  if (i === 2) { assert.deepStrictEqual(spec.config.notice_lines, ['天然のエアコンと', '言われる素材です']); assert.ok(!spec.files.wear_image); }
  if (i === 3) { assert.ok(spec.files.detail_image.url.includes('detail')); }
}
console.log('    ' + seen.join('\n    '));
assert.deepStrictEqual(seen.map(s => s.split(':')[1]), ['slide', 'zoom', 'notice', 'detail', 'slide']);
assert.ok(!seen.some(s => s.includes('wau-001')), '在庫切れは選ばない');
assert.strictEqual(world.props.PILLAR_IDX, '0');
ok('5つの柱が順に回る、動画優先、AIのトンマナ選択、HEICと30MB超は対象外、在庫切れ除外');

console.log('4. 動画づくりとの受け渡し');
const key = world.props.WEBAPP_KEY;
assert.strictEqual(JSON.parse(api.doGet({ parameter: { action: 'peek', key: 'x' } }).text).error, 'forbidden');
const pending = JSON.parse(api.doGet({ parameter: { action: 'peek', key } }).text).pending; assert.strictEqual(pending, 6);
const job = JSON.parse(api.doGet({ parameter: { action: 'job', key } }).text);
assert.ok(job.id && /^\d{8}-[0-9a-f]{40}\.mp4$/.test(job.file_name) && job.config.template);
assert.strictEqual(JSON.parse(api.doGet({ parameter: { action: 'peek', key } }).text).pending, 5);
const fileRes = JSON.parse(api.doGet({ parameter: { action: 'file', key, id: a.id } }).text); assert.strictEqual(fileRes.name, 'a.jpg');
world.mails.length = 0;
api.doPost({ postData: { contents: JSON.stringify({ key, action: 'done', id: ids[1], video_url: 'https://u.github.io/woolly-reel/v/x.mp4' }) } });
assert.ok(world.mails[0].subject.includes('投稿候補ができました') && world.mails[0].body.includes('?t=' + ids[1]));
assert.strictEqual(api.doGet({ parameter: { t: ids[1] } }).token, ids[1]);
ok('合言葉なしは拒否、注文の受け渡し、完了でスタッフにメール');

console.log('5. 投稿する');
let r = api.publish(ids[1], 'テスト'); assert.ok(!r.ok && r.message.includes('未設定'));
assert.strictEqual(api.getReview(ids[1]).state, '確認待ち');
world.props.IG_TOKEN = 'T'; api.testInstagram(); assert.strictEqual(world.props.IG_USER_ID, '1789');
r = api.publish(ids[1], '免疫力が上がります'); assert.ok(!r.ok && r.message.includes('使えない表現'));
igCalls = [];
r = api.publish(ids[1], 'やわらかなメリノウール。\n#woolly'); assert.ok(r.ok, r.message);
assert.deepStrictEqual(igCalls, ['1789/media POST', '555 GET', '1789/media_publish POST', '999 GET']);
const rv = api.getReview(ids[1]); assert.strictEqual(rv.state, '投稿済み'); assert.strictEqual(rv.permalink, 'https://www.instagram.com/reel/abc/');
assert.strictEqual(b.parent.name, '使用済み'); assert.strictEqual(b.parent.parent, fHara); assert.strictEqual(a.parent.name, '未使用');
r = api.publish(ids[1], 'もう一度'); assert.ok(!r.ok, '二重投稿しない');
ok('未接続と禁止表現は止める、Instagramへの4手順、素材を使用済みへ、二重投稿なし');

console.log('6. 見送る → 別の素材で作り直し');
api.doPost({ postData: { contents: JSON.stringify({ key, action: 'done', id: ids[0], video_url: 'https://u.github.io/woolly-reel/v/y.mp4' }) } });
const before = T('log').length;
r = api.skip(ids[0]); assert.ok(r.ok);
const remake = T('log')[before]; assert.strictEqual(remake['テンプレート'], 'slide'); assert.notStrictEqual(remake['素材ID'], vid.id); assert.ok(remake['メモ'].includes('見送りの作り直し'));
assert.strictEqual(vid.parent.name, '未使用');
ok('見送った素材を避けて作り直す(素材は未使用に残る)');

console.log('7. 失敗の通知、催促、接続の自動延長、お知らせの差し込み');
world.mails.length = 0;
api.doPost({ postData: { contents: JSON.stringify({ key, action: 'failed', id: ids[3], error: 'cannot identify image file' }) } });
assert.ok(world.mails[0].subject.includes('動画を作れませんでした') && world.mails[0].to.includes('owner@example.com'));
api.doPost({ postData: { contents: JSON.stringify({ key, action: 'done', id: ids[4], video_url: 'https://u.github.io/woolly-reel/v/z.mp4' }) } });
world.now = new Date(world.now.getTime() + 26 * 3600000); world.mails.length = 0; igCalls = [];
api.dailyChores();
assert.ok(world.mails.some(m => m.subject.includes('確認をお願いします'))); assert.strictEqual(world.props.IG_TOKEN, 'NEW');
assert.ok(world.mails.some(m => m.body.includes('動画がまだできていません')));
world.mails.length = 0; api.dailyChores(); assert.ok(!world.mails.some(m => m.subject.includes('確認をお願いします')), '催促は1回だけ');
api.table_('news').sh.appendRow(['年末年始のご案内', '12月26日 午前までのご注文は', '年内に発送いたします', '毛布', '']);
const pi = world.props.PILLAR_IDX; id = api.makeNow(); row = T('log').find(x => x.ID === id); const sp = JSON.parse(row['設定JSON']);
assert.strictEqual(row['柱'], 'お知らせ'); assert.strictEqual(sp.config.notice_title, '年末年始のご案内'); assert.ok(row['商品名'].includes('毛布')); assert.strictEqual(world.props.PILLAR_IDX, pi);
const nid2 = api.makeNow(); assert.notStrictEqual(T('log').find(x => x.ID === nid2)['柱'], 'お知らせ', 'お知らせは1回だけ');
api.doPost({ postData: { contents: JSON.stringify({ key, action: 'done', id, video_url: 'https://u.github.io/woolly-reel/v/n.mp4' }) } });
const nb = T('log').length; assert.ok(api.skip(id).ok); assert.strictEqual(T('log')[nb]['柱'], 'お知らせ', '見送りの作り直しもお知らせ');
world.now = new Date('2026-10-14T02:00:00Z'); const n0 = T('log').length; api.scheduledCreate(); assert.strictEqual(T('log').length, n0, '水曜は作らない');
world.now = new Date('2026-10-16T02:00:00Z'); api.scheduledCreate(); assert.strictEqual(T('log').length, n0 + 1, '金曜は作る');
ok('失敗メール、催促は1回、接続の延長、お知らせ優先、火・金だけ作成');
console.log('\nすべて通りました');
