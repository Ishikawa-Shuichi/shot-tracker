// 使い方: node client_tests.js <index_inline.js>
const { makeClient, loadScript, flush } = require('./client_harness.js');
const assert = require('assert');
const SCRIPT = process.argv[2];
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e)); }
}
const ME = 'Uself', X = 'Ux', Y = 'Uy', YM = '2026-09';
const SPOTS = [
  { id: 's1', name: '左コーナー', x: 10, y: 18, order: 0, scope: 'shared', ownerId: '', situations: [] },
  { id: 's2', name: 'トップ', x: 50, y: 68, order: 1, scope: 'shared', ownerId: '', situations: [] },
  { id: 'p1', name: 'マイ練習', x: 30, y: 30, order: 2, scope: 'personal', ownerId: ME, situations: ['HO'] },
];
function stats(period, spotVals, granularity) { // spotVals: {spotId:[makes,attempts]}
  const spots = SPOTS.map((sp) => { const v = spotVals[sp.id] || [0, 0]; return { spotId: sp.id, name: sp.name, scope: sp.scope, makes: v[0], attempts: v[1], pct: v[1] ? Math.round(v[0] / v[1] * 1000) / 10 : 0, live: { unlocked: false, ever: false }, situations: null }; });
  const tm = spots.reduce((a, s) => a + s.makes, 0), ta = spots.reduce((a, s) => a + s.attempts, 0);
  return { granularity: granularity || 'month', period, spots, situations: [], hasLiveRecords: false, weekAttempts: ta, total: { makes: tm, attempts: ta, pct: ta ? Math.round(tm / ta * 1000) / 10 : 0 } };
}
function fest(sunday) { return { enabled: true, name: 'シュートフェス', range: { monday: '2026-09-21', sunday: sunday || '2026-09-27' }, isSunday: true, isOver: false, tiers: [1000, 2000, 3000], tierReached: 2, rawTotal: 2500, displayTotal: 2500, multiplierApplied: false, myContribution: 100, mode: 'double', extra: null }; }
const HIST = [
  { id: 'h1', date: '2026-09-20', ym: YM, spotId: 's1', spot: '左コーナー', makes: 4, attempts: 10, pct: 40, situation: '' },
  { id: 'h2', date: '2026-09-19', ym: YM, spotId: 's2', spot: 'トップ', makes: 6, attempts: 10, pct: 60, situation: '' },
];
function initData(isHost) {
  return { spots: SPOTS, ym: YM, serverTime: new Date().toISOString(), isHost: !!isHost, myStats: stats(YM, { s1: [4, 10], s2: [6, 10] }),
    history: JSON.parse(JSON.stringify(HIST)), streak: 2, bestStreak: 5, myTrophies: [], trophyTotal: 34, trophyFamilies: [], myGoal: { weeklyGoal: 0, public: false },
    myLevel: { num: 3, tier: 'green', next: 307 }, members: [{ userId: ME, name: '自分' }, { userId: X, name: 'Xさん' }, { userId: Y, name: 'Yさん' }], fest: fest() };
}
async function boot(opts) {
  opts = opts || {};
  const c = makeClient({ userId: ME, localStorage: opts.localStorage });
  c.handlers.init = (b) => { const d = initData(opts.isHost); return opts.patchInit ? opts.patchInit(d, b) : d; };
  c.handlers.getMyStats = (b) => {
    const who = b.targetUserId || ME;
    const period = b.granularity && b.granularity !== 'month' ? b.period : (b.ym || null);
    const base = who === X ? { s1: [1, 10] } : who === Y ? { s1: [9, 10] } : who === '__team__' ? { s1: [50, 100] } : { s1: [4, 10], s2: [6, 10] };
    return stats(period, base, b.granularity);
  };
  c.handlers.getHistory = (b) => ({ items: b.targetUserId === X ? [{ id: 'x1', date: '2026-09-18', ym: YM, spotId: 's1', spot: '左コーナー', makes: 1, attempts: 10, pct: 10, situation: '' }] : JSON.parse(JSON.stringify(HIST)) });
  c.handlers.getTrend = (b) => ({ points: [{ key: '2026-09', makes: b.targetUserId === X ? 1 : 4, attempts: 10, pct: b.targetUserId === X ? 10 : 40 }] });
  loadScript(c, SCRIPT);
  await flush(60);
  return c;
}
const myTotal = (c) => c.el('myTotal').textContent;
const myStatsHtml = (c) => c.el('myStats').innerHTML;
const n = (c, action) => c.calls.filter((x) => x.action === action).length;

(async () => {
  await test('起動: 自分・月の統計が入り、じぶんタブの合計が描かれている', async () => {
    const c = await boot();
    assert.strictEqual(c.ctx.state.myStats.period, YM);
    assert.strictEqual(myTotal(c), '合計 10/20 (50%)');
  });

  await test('じぶんタブ(自分・月): 通信を待たずに手元の値で即描画される', async () => {
    const c = await boot();
    c.el('myTotal').textContent = '(消した)';
    c.delays.push(500); // 最新化の応答は遅い
    c.run('loadMyView()');
    assert.strictEqual(myTotal(c), '合計 10/20 (50%)', '同期的に描かれていない');
  });

  await test('ホストが初めて見る人: 前の人の数字を残さず「読み込み中」→届いたらその人の数字', async () => {
    const c = await boot({ isHost: true });
    c.run('fillMyStatsWhoSelector()');
    c.el('myStatsWho').value = X;
    c.delays.push(80);
    c.run('loadMyView()');
    assert.ok(/読み込み中/.test(myStatsHtml(c)), '読み込み中になっていない: ' + myStatsHtml(c));
    assert.strictEqual(myTotal(c), '', '前の人の合計が残っている');
    await flush(150);
    assert.strictEqual(myTotal(c), '合計 1/10 (10%)');
  });

  await test('応答順の入れ替わり: X→Yと切り替え、Xの応答が後から届いてもYの表示のまま', async () => {
    const c = await boot({ isHost: true });
    c.el('myStatsWho').value = X; c.delays.push(200); c.run('loadMyView()');
    c.el('myStatsWho').value = Y; c.delays.push(20); c.run('loadMyView()');
    await flush(300);
    assert.strictEqual(myTotal(c), '合計 9/10 (90%)', 'Xの古い応答で上書きされた');
  });

  await test('2回目以降は控えで即表示(通信を待たない)', async () => {
    const c = await boot({ isHost: true });
    c.el('myStatsWho').value = X; c.run('loadMyView()'); await flush(60);
    c.el('myStatsWho').value = 'me'; c.run('loadMyView()'); await flush(60);
    c.el('myStatsWho').value = X; c.delays.push(500); c.run('loadMyView()');
    assert.strictEqual(myTotal(c), '合計 1/10 (10%)', '控えで即表示されていない');
  });

  await test('週表示中に記録の応答が来ても、週表示を自分・月で上書きしない', async () => {
    const c = await boot();
    c.run("state.myGranularity='week'"); c.el('myPeriodDate').value = '2026-09-24';
    c.handlers.getMyStats = (b) => stats(b.granularity === 'week' ? b.period : b.ym, b.granularity === 'week' ? { s1: [2, 4] } : { s1: [4, 10], s2: [6, 10] }, b.granularity);
    c.run('loadMyView()'); await flush(60);
    assert.strictEqual(myTotal(c), '合計 2/4 (50%)');
    c.run("applyMyStats(" + JSON.stringify(stats(YM, { s1: [5, 11], s2: [6, 10] })) + ")");
    assert.strictEqual(myTotal(c), '合計 2/4 (50%)', '週表示が上書きされた');
    assert.strictEqual(c.ctx.state.myStats.total.attempts, 21, '自分・月の状態は更新されるべき');
  });

  await test('月を切り替えた後に届いた前の月の応答は使わない', async () => {
    const c = await boot();
    c.run("state.ym='2026-08'");
    c.run("applyMyStats(" + JSON.stringify(stats('2026-09', { s1: [99, 100] })) + ")");
    assert.notStrictEqual(c.ctx.state.myStats.total.makes, 99);
  });

  await test('確率への足し引きの規則: 共通スポットのシチュエーション記録・別の月は数えず、マイスポットのシチュエーションは数える', async () => {
    const c = await boot();
    const s = JSON.parse(JSON.stringify(stats(YM, { s1: [4, 10] })));
    c.ctx.__s = s;
    assert.strictEqual(c.run("addRecToStats(__s, {spotId:'s1', makes:1, attempts:2, ym:'2026-09', situation:'HO'}, 1)"), false);
    assert.strictEqual(c.run("addRecToStats(__s, {spotId:'s1', makes:1, attempts:2, ym:'2026-08', situation:''}, 1)"), false);
    assert.strictEqual(c.run("addRecToStats(__s, {spotId:'p1', makes:1, attempts:2, ym:'2026-09', situation:'HO'}, 1)"), true);
    assert.strictEqual(c.run("addRecToStats(__s, {spotId:'s1', makes:1, attempts:2, ym:'2026-09', situation:''}, 1)"), true);
    assert.strictEqual(s.total.attempts, 14); assert.strictEqual(s.spots[0].attempts, 12); assert.strictEqual(s.spots[2].attempts, 2);
  });

  await test('フェスの即時反映: 倍になるのは日曜の日付の記録だけ', async () => {
    const c = await boot();
    const before = c.ctx.state.fest.displayTotal;
    c.run("applyOptimisticFest({date:'2026-09-24', attempts:10, userId:'Uself'})");
    assert.strictEqual(c.ctx.state.fest.displayTotal - before, 10, '平日の記録が倍になった');
    c.run("applyOptimisticFest({date:'2026-09-27', attempts:10, userId:'Uself'})");
    assert.strictEqual(c.ctx.state.fest.displayTotal - before, 30, '日曜の記録が倍になっていない');
  });

  await test('送信済み記録の編集: その場で閉じて反映し、通信は裏で(完了を待たない)', async () => {
    const c = await boot();
    c.handlers.updateShot = (b) => ({ id: b.shotId, myStats: stats(YM, { s1: [8, 10], s2: [6, 10] }), history: HIST.map((h) => (h.id === 'h1' ? Object.assign({}, h, { makes: 8, pct: 80 }) : h)), streak: 2, fest: fest() });
    c.run("openEditShot(state.historyItems[0])");
    c.run("rec = {makes: 8, attempts: 10}");
    c.el('recSheetBg').classList.add('open');
    c.delays.push(300);
    const p = c.fire('recSave');
    assert.ok(!c.el('recSheetBg').classList.contains('open'), '通信を待たずに閉じていない');
    assert.strictEqual(c.ctx.state.myStats.total.makes, 14, '確率に即時反映されていない(10→14)');
    assert.strictEqual(c.ctx.state.historyItems[0].makes, 8);
    await p; await flush(400);
    assert.strictEqual(n(c, 'updateShot'), 1);
    assert.strictEqual(c.ctx.state.myStats.total.makes, 14);
  });

  await test('同じ記録を続けて2回編集: 送信は操作した順番どおり(2回目は1回目の完了後)', async () => {
    const c = await boot();
    const got = [];
    c.handlers.updateShot = (b) => { got.push(b.makes); return { id: b.shotId, myStats: stats(YM, { s1: [b.makes, 10], s2: [6, 10] }), history: HIST, streak: 2, fest: fest() }; };
    c.run("openEditShot(state.historyItems[0]); rec = {makes: 7, attempts: 10}");
    c.delays.push(200); c.fire('recSave');
    c.run("openEditShot(state.historyItems[0]); rec = {makes: 3, attempts: 10}");
    c.delays.push(10); c.fire('recSave');
    await flush(400);
    assert.deepStrictEqual(got, [7, 3], '送信順が入れ替わった: ' + JSON.stringify(got));
    const t = c.calls.filter((x) => x.action === 'updateShot').map((x) => x.t);
    assert.ok(t[1] >= t[0] + 150, '2回目が1回目の完了前に送られた');
  });

  await test('編集中に電波が切れた: 未送信キューに入り、履歴に「未送信」の印', async () => {
    const c = await boot();
    c.handlers.updateShot = () => { throw { network: true }; };
    c.run("openEditShot(state.historyItems[0]); rec = {makes: 2, attempts: 10}");
    await c.fire('recSave'); await flush(200);
    assert.strictEqual(c.ctx.state.pendingOps.length, 1);
    assert.strictEqual(c.ctx.state.pendingOps[0].action, 'updateShot');
    assert.strictEqual(c.ctx.state.historyItems[0].pendingEdit, true);
  });

  await test('編集がサーバーに拒否された: 正しい値に戻すため全体を取り直す', async () => {
    const c = await boot();
    c.handlers.updateShot = () => { throw { app: 'この記録を編集する権限がありません' }; };
    c.reset();
    c.run("openEditShot(state.historyItems[0]); rec = {makes: 9, attempts: 10}");
    await c.fire('recSave'); await flush(200);
    assert.ok(n(c, 'getMyStats') >= 1 && n(c, 'getHistory') >= 1, '取り直していない');
    assert.strictEqual(c.ctx.state.myStats.total.makes, 10, '拒否後に正しい値に戻っていない');
  });

  await test('送信済み記録の削除: その場で履歴から消え、確率から引かれ、削除は裏で送る', async () => {
    const c = await boot();
    c.handlers.deleteShot = (b) => ({ id: b.shotId, myStats: stats(YM, { s2: [6, 10] }), history: HIST.slice(1), streak: 1, fest: fest() });
    c.run("openEditShot(state.historyItems[0])");
    c.delays.push(300);
    c.fire('recDeleteBtn');
    assert.strictEqual(c.ctx.state.historyItems.length, 1, '履歴から即座に消えていない');
    assert.strictEqual(c.ctx.state.myStats.total.attempts, 10, '確率から即座に引かれていない');
    await flush(400);
    assert.strictEqual(n(c, 'deleteShot'), 1);
  });

  await test('月の切替: 月に関係のない「最近の記録」は取り直さない。前に見た月は控えで即コート反映', async () => {
    const c = await boot();
    c.run("state.ym='2026-08'; onYmChanged()"); await flush(60);   // 8月を1回見る(控えができる)
    c.run("state.ym='2026-09'; onYmChanged()"); await flush(60);
    c.reset();
    c.delays.push(500);
    c.run("state.ym='2026-08'; onYmChanged()");
    assert.strictEqual(c.ctx.state.myStats.period, '2026-08', '控えで即反映されていない');
    await flush(600);
    assert.strictEqual(n(c, 'getHistory'), 0, '履歴を取り直した');
    assert.strictEqual(n(c, 'getMyStats'), 1);
  });

  await test('推移: 初回は「読み込み中」、2回目は控えで即表示。古い応答で上書きしない', async () => {
    const c = await boot({ isHost: true });
    c.el('trendSpotSel').value = 's1';
    c.delays.push(80); c.run('loadTrend()');
    assert.ok(/読み込み中/.test(c.el('trendTable').innerHTML));
    await flush(150);
    assert.ok(!/読み込み中/.test(c.el('trendTable').innerHTML));
    c.el('trendWho').value = X; c.delays.push(200); c.run('loadTrend()');
    c.el('trendWho').value = 'me'; c.delays.push(500); c.run('loadTrend()');
    assert.strictEqual(c.ctx.state.trendPoints[0].pct, 40, '自分の推移が控えで即表示されていない');
    await flush(300);
    assert.strictEqual(c.ctx.state.trendPoints[0].pct, 40, 'Xの古い応答で上書きされた');
  });

  await test('推移の先読み: 控えが無ければ1回だけ取り、あれば取らない', async () => {
    const c = await boot();
    c.el('trendSpotSel').value = 's1';
    c.reset(); await c.run('prefetchTrendIfMissing()');
    assert.strictEqual(n(c, 'getTrend'), 1);
    c.reset(); await c.run('prefetchTrendIfMissing()');
    assert.strictEqual(n(c, 'getTrend'), 0);
  });

  await test('代理記録の相手切替: 統計と履歴を並行して取り、揃うまでコートに自分の数字を出さない', async () => {
    const c = await boot({ isHost: true });
    c.reset();
    c.delays.push(100, 100);
    c.run("state.recordingAs = {userId:'Ux', name:'Xさん'}");
    const p = c.run('switchProxyTarget()');
    await flush(20);
    assert.strictEqual(n(c, 'getMyStats') + n(c, 'getHistory'), 2, '並行して送られていない');
    assert.strictEqual(c.run('state.proxyStats'), null, '相手の統計が無いのに何か入っている');
    assert.ok(/読み込み中/.test(c.el('histCount').textContent), '履歴が読み込み中になっていない');
    await p;
    assert.strictEqual(c.ctx.state.proxyStats.total.makes, 1);
    assert.strictEqual(c.ctx.state.historyItems[0].id, 'x1');
  });

  await test('代理記録: 控えの相手の統計はライブ解放の判定に使わない', async () => {
    const c = await boot({ isHost: true });
    c.run("state.recordingAs = {userId:'Ux', name:'Xさん'}; state.proxyStats = {spots:[], __fromCache:true}; state.proxyStatsUserId='Ux'");
    assert.strictEqual(c.run('liveStatsSource()'), null);
    c.run("state.proxyStats.__fromCache = false");
    assert.ok(c.run('liveStatsSource()'));
  });

  await test('控えの件数上限: 81件目を書くと一番古いものから消える', async () => {
    const c = await boot();
    const baseKeys = JSON.parse(c.localStorage.getItem('tabCacheIndex_v1') || '[]').length;
    for (let i = 0; i < 90; i++) c.run("writeTabCache('k" + i + "', {v:" + i + "})");
    const idx = JSON.parse(c.localStorage.getItem('tabCacheIndex_v1'));
    assert.strictEqual(idx.length, 80);
    assert.strictEqual(c.localStorage.getItem('tabCache_v1_k0'), null, '古い控えが消えていない');
    assert.ok(c.localStorage.getItem('tabCache_v1_k89'));
    assert.ok(baseKeys >= 0);
  });

  await test('控えの履歴ではライブ解放の即時判定をしない(誤発火防止)', async () => {
    // 演出が実際に出る(解放画面が開く)かどうかで判定する。前提として、最新の履歴なら演出が出る条件を作る
    const mk = async (fresh) => {
      const c = await boot();
      const today = c.run('todayStr()'), ym = today.slice(0, 7);
      c.run("state.historyItems = [{id:'hh', date:'" + today + "', ym:'" + ym + "', spotId:'s1', spot:'左コーナー', makes:25, attempts:29, pct:86, situation:''}]");
      c.run('state.historyFresh = ' + fresh);
      c.run("predictLiveUnlock({situation:'', spotName:'左コーナー', ym:'" + ym + "', date:'" + today + "', userId:'Uself', spotId:'s1', makes:1, attempts:1, clientId:'c1'})");
      return c.el('unlockBg').classList.contains('open');
    };
    assert.strictEqual(await mk(true), true, '前提: 最新の履歴なら演出が出るはず');
    assert.strictEqual(await mk(false), false, '控えの履歴で演出が出た');
  });

  await test('編集前の値が取れない異常時でも、削除・編集は必ず送信される(画面からだけ消えて送られない、を防ぐ)', async () => {
    const c = await boot();
    c.handlers.deleteShot = (b) => ({ id: b.shotId, myStats: stats(YM, { s2: [6, 10] }), history: HIST.slice(1), streak: 1, fest: fest() });
    c.handlers.updateShot = (b) => ({ id: b.shotId, myStats: stats(YM, { s1: [4, 10], s2: [6, 10] }), history: HIST, streak: 2, fest: fest() });
    c.run("openEditShot(state.historyItems[0]); state.editingItem = null");
    await c.fire('recDeleteBtn'); await flush(100);
    assert.strictEqual(n(c, 'deleteShot'), 1, '削除が送信されなかった');
    c.run("openEditShot(state.historyItems[0]); state.editingItem = null; rec = {makes: 3, attempts: 10}");
    await c.fire('recSave'); await flush(100);
    assert.strictEqual(n(c, 'updateShot'), 1, '編集が送信されなかった');
  });

  await test('編集の保存を二度押し: 送信は1回・画面への反映も1回だけ', async () => {
    const c = await boot();
    c.handlers.updateShot = (b) => ({ id: b.shotId, myStats: stats(YM, { s1: [8, 10], s2: [6, 10] }), history: HIST, streak: 2, fest: fest() });
    c.run("openEditShot(state.historyItems[0]); rec = {makes: 8, attempts: 10}");
    c.delays.push(300, 300);
    c.fire('recSave'); c.fire('recSave');
    assert.strictEqual(c.ctx.state.myStats.total.makes, 14, '差分が二重に反映された(10→14のはず)');
    await flush(700);
    assert.strictEqual(n(c, 'updateShot'), 1, '二度送られた');
  });

  await test('削除を二度押し: 送信は1回・確率から引くのも1回だけ(未送信記録の取り消しでも同じ)', async () => {
    const c = await boot();
    c.handlers.deleteShot = (b) => ({ id: b.shotId, myStats: stats(YM, { s2: [6, 10] }), history: HIST.slice(1), streak: 1, fest: fest() });
    c.run("openEditShot(state.historyItems[0])");
    c.delays.push(300, 300);
    c.fire('recDeleteBtn'); c.fire('recDeleteBtn');
    assert.strictEqual(c.ctx.state.myStats.total.attempts, 10, '二重に引かれた(20→10のはず)');
    await flush(700);
    assert.strictEqual(n(c, 'deleteShot'), 1, '二度送られた');
    // 未送信記録の取り消し: 1回目でキューから消え、2回目が「送信済みの削除」として送られてしまわないこと
    c.reset();
    c.run("state.pendingShots.push({clientId:'pp1', userId:'Uself', spotId:'s1', spotName:'左コーナー', makes:2, attempts:5, date:'2026-09-25', ym:'2026-09', situation:''}); applyOptimisticShot(state.pendingShots[state.pendingShots.length-1])");
    const before = c.ctx.state.myStats.total.attempts;
    c.run("openEditShot({id:'pp1', spotId:'s1', spot:'左コーナー', makes:2, attempts:5, date:'2026-09-25', ym:'2026-09', situation:'', pending:true})");
    c.fire('recDeleteBtn'); c.fire('recDeleteBtn');
    await flush(100);
    assert.strictEqual(c.ctx.state.myStats.total.attempts, before - 5, '未送信記録の取り消しが二重に引かれた');
    assert.strictEqual(n(c, 'deleteShot'), 0, '未送信記録の削除がサーバーに送られた');
  });

  // ---- 初回案内(まだ1本も記録していない人に、最初の1記録をその場で終えてもらう) ----
  const FT = { id: 's3', name: 'フリースロー', x: 50, y: 40, order: 5, scope: 'shared', ownerId: '', situations: [] };
  const firstRun = (d) => { d.spots = SPOTS.concat([FT]); d.history = []; d.myStats = stats(YM, {}); d.streak = 0; return d; };
  const lastChips = (c) => c.el('firstRunChips')._children.slice(-6);
  const tapChip = (chip) => chip._listeners.click[0]({ preventDefault() {} });

  await test('初回案内: 履歴0件の人には「フリースロー」で5本の案内が出て、入った数をタップすると記録シートが5本/3本で開く', async () => {
    const c = await boot({ patchInit: firstRun });
    assert.ok(!c.el('firstRunCard').classList.contains('hidden'), '初回案内が出ていない');
    assert.ok(/フリースロー/.test(c.el('firstRunDesc').textContent), c.el('firstRunDesc').textContent);
    const chips = lastChips(c);
    assert.strictEqual(chips.length, 6);
    assert.strictEqual(chips[3].textContent, '3本');
    tapChip(chips[3]);
    assert.ok(c.el('recSheetBg').classList.contains('open'), '記録シートが開いていない');
    assert.ok(/フリースロー/.test(c.el('recSpotName').textContent), c.el('recSpotName').textContent);
    assert.strictEqual(String(c.el('valAttempts').textContent), '5');
    assert.strictEqual(String(c.el('valMakes').textContent), '3');
  });

  await test('初回案内: 「フリースロー」という名前のスポットが無ければ共通スポットの先頭を使う', async () => {
    const c = await boot({ patchInit: (d) => { d.history = []; return d; } });
    assert.ok(!c.el('firstRunCard').classList.contains('hidden'));
    assert.ok(/左コーナー/.test(c.el('firstRunDesc').textContent), c.el('firstRunDesc').textContent);
  });

  await test('初回案内: 記録がある人・ホストには出ない', async () => {
    const c1 = await boot();
    assert.ok(c1.el('firstRunCard').classList.contains('hidden'), '記録がある人に出ている');
    const c2 = await boot({ isHost: true, patchInit: (d) => { d.history = []; return d; } });
    assert.ok(c2.el('firstRunCard').classList.contains('hidden'), 'ホストに出ている');
  });

  await test('初回案内: 1本目を保存した瞬間に案内が消え、はじめての記録として祝う(サーバー応答を待たない・応答後も戻らない)', async () => {
    const c = await boot({ patchInit: firstRun });
    c.handlers.recordShot = (b) => ({ id: b.clientId, myStats: stats(YM, { s3: [3, 5] }), history: [{ id: b.clientId, date: b.date, ym: YM, spotId: 's3', spot: 'フリースロー', makes: 3, attempts: 5, pct: 60, situation: '' }], streak: 1 });
    tapChip(lastChips(c)[3]);
    c.delays.push(500);
    c.fire('recSave');
    assert.ok(c.el('firstRunCard').classList.contains('hidden'), '保存直後に案内が消えていない');
    assert.ok(/はじめての記録/.test(c.el('toast').textContent), c.el('toast').textContent);
    await flush(700);
    assert.ok(c.el('firstRunCard').classList.contains('hidden'), 'サーバー応答後に案内が戻った');
    assert.strictEqual(n(c, 'recordShot'), 1);
    assert.strictEqual(c.calls.find((x) => x.action === 'recordShot').body.attempts, 5);
  });

  // ---- フェスのカウントダウン(開催前も「次の山」が見える) ----
  const nextFest = { name: 'シュートフェス', monday: '2026-10-19', sunday: '2026-10-25', daysUntil: 17, tiers: [1000, 2000, 3000] };
  await test('フェス開催前: カードに「次のシュートフェス・あと17日・10/19(月)〜10/25(日)」が出て、メーターは隠れる。開催中の値が来たら戻る', async () => {
    const c = await boot({ patchInit: (d) => { d.fest = { enabled: false, next: nextFest }; return d; } });
    assert.ok(!c.el('festCard').classList.contains('hidden'), 'カードが隠れている');
    assert.strictEqual(c.el('festTierBadge').textContent, 'あと17日');
    assert.strictEqual(c.el('festSub').textContent, '10/19(月)〜10/25(日)');
    assert.ok(c.el('festMeterWrap').classList.contains('hidden'), 'メーターが見えている');
    assert.ok(/3000/.test(c.el('festNextBody').textContent));
    c.run('applyFestStatus(' + JSON.stringify(fest()) + ')');
    assert.ok(!c.el('festMeterWrap').classList.contains('hidden'), '開催中なのにメーターが隠れたまま');
    assert.ok(c.el('festNextBody').classList.contains('hidden'));
    assert.strictEqual(c.el('festTierBadge').textContent, '2/3段階');
  });

  await test('フェス終了後: 結果と一緒に「次回は◯/◯〜」が出る。前日は「明日から！」。nextも無ければカード自体を隠す', async () => {
    const c = await boot({ patchInit: (d) => { d.fest = Object.assign(fest(), { isSunday: false, isOver: true, next: nextFest }); return d; } });
    assert.ok(/次回は 10\/19\(月\)〜10\/25\(日\)/.test(c.el('festSub').textContent), c.el('festSub').textContent);
    c.run('applyFestStatus({enabled:false, next:' + JSON.stringify(Object.assign({}, nextFest, { daysUntil: 1 })) + '})');
    assert.strictEqual(c.el('festTierBadge').textContent, '明日から！');
    c.run('applyFestStatus({enabled:false})');
    assert.ok(c.el('festCard').classList.contains('hidden'));
  });

  // ---- Google側の一時的な不調(doGetの返事が混ざる・エラーページ)で記録を失わない ----
  const DOGET = () => ({ status: 'alive', time: '2026-10-08T07:07:30.817Z', version: '2026-10-02a' });
  const okRecord = (b) => ({ id: b.clientId, myStats: stats(YM, { s1: [4, 10], s2: [9, 15] }), history: [{ id: b.clientId, date: b.date, ym: YM, spotId: 's2', spot: 'トップ', makes: 3, attempts: 5, pct: 60, situation: '' }].concat(HIST), streak: 3 });
  function saveOne(c) { c.run("openRecord(state.spots[1], {attempts:5, makes:3})"); return c.fire('recSave'); }

  await test('不調1: 保存の返事にdoGetの返事が混ざっても、同じclientIdでやり直して保存され、エラー表示もキュー残りも無い', async () => {
    const c = await boot();
    let k = 0;
    c.handlers.recordShot = (b) => (k++ === 0 ? DOGET() : okRecord(b));
    saveOne(c);
    await flush(150);
    const sent = c.calls.filter((x) => x.action === 'recordShot');
    assert.strictEqual(sent.length, 2, '再試行していない: ' + sent.length);
    assert.strictEqual(sent[0].body.clientId, sent[1].body.clientId, 'やり直しで別の記録として送っている');
    assert.ok(!/保存できませんでした/.test(c.el('toast').textContent), c.el('toast').textContent);
    assert.strictEqual(c.ctx.state.pendingShots.length, 0);
    assert.strictEqual(c.ctx.state.historyItems[0].id, sent[0].body.clientId);
  });

  await test('不調2: 何度やってもdoGetの返事なら、記録は消さずに未送信キューへ回す', async () => {
    const c = await boot();
    c.handlers.recordShot = () => DOGET();
    saveOne(c);
    await flush(150);
    assert.strictEqual(c.ctx.state.pendingShots.length, 1, '記録が消えた');
    assert.ok(/未送信/.test(c.el('toast').textContent), c.el('toast').textContent);
  });

  await test('不調3: エラーページ(JSONでない返事)も通信エラー扱いで再試行され、保存される', async () => {
    const c = await boot();
    let k = 0;
    c.handlers.recordShot = (b) => { if (k++ === 0) throw { html: 404 }; return okRecord(b); };
    saveOne(c);
    await flush(150);
    assert.strictEqual(n(c, 'recordShot'), 2);
    assert.strictEqual(c.ctx.state.pendingShots.length, 0);
    assert.ok(!/保存できませんでした/.test(c.el('toast').textContent), c.el('toast').textContent);
  });

  await test('不調4: 未送信キューの自動送信でdoGetの返事が来ても、キューから消さない(以前は「送信しました」と出して消えていた)', async () => {
    const c = await boot();
    c.handlers.recordShot = () => DOGET();
    c.run("state.pendingShots.push({clientId:'pq1', actingUserId:'Uself', userId:'Uself', displayName:'自分', spotId:'s1', spotName:'左コーナー', makes:2, attempts:5, date:'2026-09-25', ym:'2026-09', situation:''})");
    c.reset();
    await c.run('trySyncPending()');
    assert.strictEqual(n(c, 'recordShot'), 1);
    assert.strictEqual(c.ctx.state.pendingShots.length, 1, '未送信の記録が消えた');
    assert.ok(!/送信しました/.test(c.el('toast').textContent), c.el('toast').textContent);
  });

  await test('照合: 未送信キューの記録がサーバーの履歴に既にあれば(確認の返事だけ届かなかった)、キューから外し、確率に二重に足さない', async () => {
    const pend = { clientId: 'c-dup', actingUserId: ME, userId: ME, displayName: '自分', spotId: 's1', spotName: '左コーナー', makes: 2, attempts: 5, date: '2026-09-25', ym: YM, situation: '' };
    const c = await boot({
      localStorage: { pendingShots_v1: JSON.stringify([pend]) },
      patchInit: (d) => { d.history = [{ id: 'c-dup', date: '2026-09-25', ym: YM, spotId: 's1', spot: '左コーナー', makes: 2, attempts: 5, pct: 40, situation: '' }].concat(d.history); return d; },
    });
    assert.strictEqual(c.ctx.state.pendingShots.length, 0, 'キューに残っている');
    assert.strictEqual(c.ctx.state.myStats.total.attempts, 20, '二重に足された: ' + c.ctx.state.myStats.total.attempts);
    assert.strictEqual(n(c, 'recordShot'), 0, '保存済みの記録をもう一度送った');
  });

  // ---- 初めて開いた端末(前回の控えが無い): サーバーの返事を待たずに記録できる ----
  async function bootSlow(opts) { // 最初のinitの返事を遅らせて起動する(返事が来る前の状態を見るため)
    opts = opts || {};
    const c = makeClient({ userId: ME, localStorage: opts.localStorage });
    c.handlers.init = (b) => { const d = initData(false); if (opts.initFail) throw { network: true }; return opts.patchInit ? opts.patchInit(d, b) : d; };
    c.handlers.getMyStats = () => stats(YM, {});
    c.handlers.getHistory = () => ({ items: [] });
    c.delays.push(opts.initDelay == null ? 600 : opts.initDelay);
    loadScript(c, SCRIPT);
    await flush(60);
    return c;
  }
  const noHistory = (d) => { d.history = []; d.myStats = stats(YM, {}); d.streak = 0; return d; };

  await test('初回の端末: 起動データの返事が来る前でも、内蔵の共通スポット8つでコートが描かれ、初回案内が出る', async () => {
    const c = await bootSlow({ patchInit: noHistory });
    assert.strictEqual(c.ctx.state.bootstrapping, true, '内蔵スポットで仮表示になっていない');
    assert.strictEqual(c.ctx.state.spots.length, 8);
    assert.ok(c.ctx.state.spots.some((s) => s.name === 'フリースロー'));
    assert.ok(c.el('courtWrap')._children.length >= 8, 'コートにスポットが描かれていない: ' + c.el('courtWrap')._children.length);
    assert.ok(!c.el('firstRunCard').classList.contains('hidden'), '初回案内が出ていない');
    assert.ok(/フリースロー/.test(c.el('firstRunDesc').textContent));
  });

  await test('初回の端末: 返事を待たずに1本目を記録でき、記録は返事を待たずに送られる。返事が届いたら本物のスポットに置き換わる', async () => {
    const c = await bootSlow({ patchInit: noHistory, initDelay: 800 });
    c.handlers.recordShot = (b) => ({ id: b.clientId, myStats: stats(YM, { s1: [3, 5] }), history: [{ id: b.clientId, date: b.date, ym: YM, spotId: 's1', spot: '左コーナー', makes: 3, attempts: 5, pct: 60, situation: '' }], streak: 1 });
    c.run("openRecord(state.spots.filter(function(s){return s.name==='フリースロー';})[0], {attempts:5, makes:3})");
    c.fire('recSave');
    await flush(50);
    assert.ok(c.ctx.state.bootstrapping, 'まだ返事前のはず');
    assert.strictEqual(n(c, 'recordShot'), 1, '返事を待たずに送られていない');
    const sent = c.calls.find((x) => x.action === 'recordShot').body;
    assert.strictEqual(sent.spotName, 'フリースロー');
    assert.strictEqual(sent.spotId, '185a2225-041b-4cc4-95fd-166c0f0e946c');
    assert.ok(c.el('firstRunCard').classList.contains('hidden'), '保存後も初回案内が出ている');
    await flush(900);
    assert.strictEqual(c.ctx.state.bootstrapping, false);
    assert.strictEqual(c.ctx.state.spots.length, 3, '本物のスポットに置き換わっていない');
  });

  await test('初回の端末: 起動データの取得が失敗しても、エラー画面にせず内蔵スポットのまま記録でき、記録は未送信キューに入る', async () => {
    const c = await bootSlow({ initFail: true, initDelay: 5 });
    await flush(250);
    assert.ok(!c.el('loadErrorBg').classList.contains('open'), '記録できるのにエラー画面が出ている');
    assert.strictEqual(c.ctx.state.bootstrapping, true);
    c.handlers.recordShot = () => { throw { network: true }; };
    c.run("openRecord(state.spots[0], {attempts:5, makes:2})");
    c.fire('recSave');
    await flush(250);
    assert.strictEqual(c.ctx.state.pendingShots.length, 1, '未送信キューに入っていない');
  });

  await test('送信中の記録: 返事待ちの間に起動データ(その記録を含まない)が届いても、確率と履歴から消えず「送信中」と出る。返事が来たら普通の行になる', async () => {
    const c = await boot();
    c.handlers.recordShot = (b) => ({ id: b.clientId, myStats: stats(YM, { s1: [7, 15], s2: [6, 10] }), history: [{ id: b.clientId, date: b.date, ym: YM, spotId: 's1', spot: '左コーナー', makes: 3, attempts: 5, pct: 60, situation: '' }].concat(HIST), streak: 3 });
    c.delays.push(800);
    c.run("openRecord(state.spots[0], {attempts:5, makes:3})");
    c.el('recDate').value = '2026-09-25'; // 表示中の月(YM)の日付にする(実行日が別の月だと確率に数えられないため)
    c.fire('recSave');
    await flush(40);
    assert.strictEqual(c.ctx.state.myStats.total.attempts, 25);
    c.run('applyBootData(' + JSON.stringify(initData()) + ')'); // 記録を含まない起動データが、返事待ちの間に届く
    assert.strictEqual(c.ctx.state.myStats.total.attempts, 25, '送信中の記録が確率から消えた: ' + c.ctx.state.myStats.total.attempts);
    assert.ok(/送信中/.test(c.el('historyList')._children.map((x) => x.innerHTML).join('')), '履歴に「送信中」が出ていない');
    await flush(900);
    assert.ok(!/送信中/.test(c.el('historyList')._children.map((x) => x.innerHTML).join('')), '返事が来たのに送信中のまま');
    assert.strictEqual(Object.keys(c.ctx.state.inFlight).length, 0);
  });

  await test('保存直後の履歴: 返事を待つ間は「送信中」の行がすぐ出て、通信できなければ「未送信」の行に切り替わる(以前は何も出なかった)', async () => {
    const c = await boot();
    const rows = () => c.el('historyList')._children.map((x) => x.innerHTML).join('');
    c.handlers.recordShot = () => { throw { network: true }; };
    c.delays.push(100);
    c.run("openRecord(state.spots[0], {attempts:5, makes:3})");
    c.el('recDate').value = '2026-09-25';
    c.fire('recSave');
    await flush(20);
    assert.ok(/送信中/.test(rows()), '保存直後に履歴へ出ていない: ' + rows().slice(0, 120));
    await flush(500);
    assert.ok(/未送信/.test(rows()) && !/送信中/.test(rows()), '未送信に切り替わっていない: ' + rows().slice(0, 160));
    assert.strictEqual(c.ctx.state.pendingShots.length, 1);
  });

  // ---- 利用状況(開いた事実・待ち時間)を次の起動データ取得にまとめて送る ----
  await test('利用状況: 開いた事実がinitに載って送られ、サーバーが受け取った件数だけ端末から消える。古いサーバー(件数を返さない)なら残して次回また送る', async () => {
    let seen = null;
    const c = await boot({ patchInit: (d, b) => { seen = b; d.usageAccepted = (b.usage || []).length; return d; } });
    assert.ok(seen && Array.isArray(seen.usage) && seen.usage.some((u) => u.k === 'open' && u.v === c.run('APP_VERSION')), JSON.stringify(seen));
    assert.strictEqual(c.run('usageQueue.length'), 0, '届いたのに端末に残っている');
    const c2 = await boot({ patchInit: (d) => d });
    assert.ok(c2.run('usageQueue.length') >= 1, '届いたか分からないのに消した');
  });

  await test('利用状況: 開いている間の通信の秒数と成否が集計され、次に開いた時に「前回分」としてまとめて送られる', async () => {
    const c1 = await boot({ patchInit: (d) => d });
    c1.handlers.getHistory = () => { throw { network: true }; };
    await c1.run("api('getHistory', {userId:'Uself', targetUserId:'Uself', limit:20}).catch(function(){})");
    const cur = JSON.parse(c1.store.get('usageCurrent_v1'));
    assert.ok(cur.calls.init && cur.calls.init.ok >= 1, 'initの成功が記録されていない');
    assert.ok(cur.calls.getHistory && cur.calls.getHistory.fail === 1 && cur.calls.getHistory.retried === 1, JSON.stringify(cur.calls));
    assert.ok(typeof cur.freshMs === 'number', '最新データが届くまでの秒数が記録されていない');
    let seen = null;
    const c2 = await boot({ localStorage: Object.fromEntries(c1.store), patchInit: (d, b) => { seen = b; d.usageAccepted = (b.usage || []).length; return d; } });
    const sums = seen.usage.filter((u) => u.k === 'sum');
    assert.strictEqual(sums.length, 1, '前回分の集計が送られていない: ' + JSON.stringify(seen.usage.map((u) => u.k)));
    assert.ok(sums[0].calls.getHistory.fail === 1);
    assert.ok(c2.run('usageQueue.length') === 0);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
