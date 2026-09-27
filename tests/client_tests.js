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
  c.handlers.init = () => initData(opts.isHost);
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

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
