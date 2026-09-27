// 使い方: node gas_tests.js <Code.gsのパス>
const { makeEnv } = require('./gas_harness.js');
const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}
const A = 'Uaaaa', B = 'Ubbbb', HOST = 'Ub47dc7fc4f136b8bd1551dbb2df86d68';

function setup() {
  const env = makeEnv();
  const { ctx } = env;
  const spots = ctx.getSheet_(ctx.SHEET_SPOTS); // ヘッダ+既定スポットが自動で入る
  // 既定スポットは消して、テスト用を入れ直す
  spots._data.splice(1);
  spots.appendRow(['s-lc', '左コーナー', 10, 18, 0, true, '2026-08-01T00:00:00Z', 'shared', '', '']);
  spots.appendRow(['s-top', 'トップ', 50, 68, 1, true, '2026-08-01T00:00:00Z', 'shared', '', '']);
  spots.appendRow(['s-ft', 'フリースロー', 50, 40, 2, true, '2026-08-01T00:00:00Z', 'shared', '', '']);
  spots.appendRow(['s-myA', 'Aの練習', 30, 30, 3, true, '2026-08-01T00:00:00Z', 'personal', A, 'HO,チェック']);
  const range = ctx.festDateRange_();
  const shots = ctx.getSheet_(ctx.SHEET_SHOTS);
  const rows = [
    ['r1', '2026-09-01T10:00:00.000Z', '2026-09', '2026-09-01', A, 'Aさん', 's-lc', 5, 10, ''],
    ['r2', '2026-09-02T10:00:00.000Z', '2026-09', '2026-09-02', A, 'Aさん', 's-top', 7, 10, ''],
    ['r3', '2026-09-03T10:00:00.000Z', '2026-09', '2026-09-03', B, 'Bさん', 's-lc', 3, 10, ''],
    ['r4', '2026-09-04T10:00:00.000Z', '2026-09', '2026-09-04', A, 'Aさん', 's-lc', 2, 5, 'HO'],
    ['r5', '2026-09-05T10:00:00.000Z', '2026-09', '2026-09-05', A, 'Aさん', 's-myA', 4, 8, 'チェック'],
    ['r6', '2026-08-20T10:00:00.000Z', '2026-08', '2026-08-20', B, 'Bさん', 's-top', 6, 10, ''],
    ['r7', range.monday + 'T01:00:00.000Z', range.monday.slice(0, 7), range.monday, B, 'Bさん', 's-ft', 9, 10, ''],
  ];
  rows.forEach((r) => shots.appendRow(r));
  return { env, ctx, spots, shots, range };
}
function counts(env) { return Object.assign({}, env.counters); }
function diff(a, b) { const o = {}; Object.keys(b).forEach((k) => { o[k] = b[k] - a[k]; }); return o; }
function freshReadShots(ctx) { // 旧方式と同じ「シートを読み直した結果」
  return ctx.shotsFromRows_(ctx.normalizeShotRows_(ctx.getSheet_(ctx.SHEET_SHOTS).getDataRange().getValues()));
}

test('自動変換の再現: ym/date列は日付型で保存される(本番と同じ条件で検証するため)', () => {
  const { shots } = setup();
  assert.ok(shots._data[1][2] instanceof Date && shots._data[1][3] instanceof Date);
});

test('updateShot: 対象の行だけが変わり、他人の行は変わらない', () => {
  const { ctx, shots } = setup();
  const before = shots._data.map((r) => r.slice());
  ctx.actionUpdateShot_({ shotId: 'r2', actingUserId: A, makes: 9, attempts: 12, viewYm: '2026-09' });
  const s = freshReadShots(ctx);
  const r2 = s.find((x) => x.id === 'r2');
  assert.strictEqual(r2.makes, 9); assert.strictEqual(r2.attempts, 12);
  assert.strictEqual(r2.date, '2026-09-02'); assert.strictEqual(r2.ym, '2026-09'); assert.strictEqual(r2.situation, '');
  [1, 3, 4, 5, 6, 7].forEach((idx) => assert.deepStrictEqual(shots._data[idx].map(String), before[idx].map(String), '行' + idx + 'が変わった'));
});

test('updateShot: 書き込みは1回・シートの全行読み込みも1回だけ(以前は書き込み最大6回・読み込み2回)', () => {
  const { env, ctx } = setup();
  ctx.getShots_(); // キャッシュを温める(本番の通常状態)
  const c0 = counts(env);
  ctx.actionUpdateShot_({ shotId: 'r2', actingUserId: A, makes: 9, attempts: 12, date: '2026-09-06', situation: 'HO', viewYm: '2026-09' });
  const d = diff(c0, counts(env));
  assert.strictEqual(d.setValues + d.setValue, 1, '書き込み回数=' + (d.setValues + d.setValue));
  const shotReads = d.getValues; // Spotsはキャッシュ済みなので、ここに数えられるのはShotsの読み込み(+FestParticipants)
  assert.ok(shotReads <= 2, 'getValues回数=' + shotReads + '(Shots1回+FestParticipants最大1回の想定)');
});

test('updateShot: 返り値は「書いた後にシートを読み直して計算した値」と完全に一致する', () => {
  const { ctx } = setup();
  const res = ctx.actionUpdateShot_({ shotId: 'r1', actingUserId: A, makes: 1, attempts: 10, date: '2026-09-10', viewYm: '2026-09' });
  const fresh = freshReadShots(ctx);
  const spots = ctx.getSpots_(A);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res.myStats)), JSON.parse(JSON.stringify(ctx.computeMyStats_(spots, fresh, A, 'month', '2026-09'))));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res.history)), JSON.parse(JSON.stringify(ctx.computeHistory_(spots, fresh, A, 20))));
  assert.strictEqual(res.streak, ctx.computeStreak_(fresh, A));
});

test('updateShot: キャッシュには書いた後のデータが入り、次の読み込みはシートを読まない', () => {
  const { env, ctx } = setup();
  ctx.actionUpdateShot_({ shotId: 'r3', actingUserId: B, makes: 8, attempts: 10, viewYm: '2026-09' });
  const c0 = counts(env);
  const s = ctx.getShots_();
  assert.strictEqual(diff(c0, counts(env)).getValues, 0, 'シートを読み直した');
  assert.strictEqual(s.find((x) => x.id === 'r3').makes, 8);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), JSON.parse(JSON.stringify(freshReadShots(ctx))));
});

test('updateShot: 他人の記録は編集できず、何も書かれず、ロックは解放される', () => {
  const { env, ctx } = setup();
  const c0 = counts(env);
  assert.throws(() => ctx.actionUpdateShot_({ shotId: 'r3', actingUserId: A, makes: 1, attempts: 10 }), /権限/);
  const d = diff(c0, counts(env));
  assert.strictEqual(d.setValue + d.setValues, 0);
  assert.strictEqual(env.lockState.held, false, 'ロックが解放されていない');
});

test('updateShot: ホストは他人の記録を編集できる(代理記録の修正)', () => {
  const { ctx } = setup();
  ctx.actionUpdateShot_({ shotId: 'r3', actingUserId: HOST, makes: 4, attempts: 10 });
  assert.strictEqual(freshReadShots(ctx).find((x) => x.id === 'r3').makes, 4);
});

test('updateShot: 存在しないIDはエラーでロックは解放される', () => {
  const { env, ctx } = setup();
  assert.throws(() => ctx.actionUpdateShot_({ shotId: 'nope', actingUserId: A, makes: 1, attempts: 2 }), /見つかりません/);
  assert.strictEqual(env.lockState.held, false);
});

test('updateShot: 入力エラー(メイク>試投)は何も書かない', () => {
  const { env, ctx } = setup();
  const c0 = counts(env);
  assert.throws(() => ctx.actionUpdateShot_({ shotId: 'r1', actingUserId: A, makes: 11, attempts: 10 }), /超えています/);
  assert.strictEqual(diff(c0, counts(env)).setValues, 0);
});

test('updateShot: date/situation未指定なら元の値を保つ', () => {
  const { ctx } = setup();
  ctx.actionUpdateShot_({ shotId: 'r4', actingUserId: A, makes: 3, attempts: 5 });
  const r4 = freshReadShots(ctx).find((x) => x.id === 'r4');
  assert.strictEqual(r4.situation, 'HO'); assert.strictEqual(r4.date, '2026-09-04');
});

test('deleteShot: 対象の行だけが消え、キャッシュも消えた状態になる', () => {
  const { env, ctx } = setup();
  ctx.getShots_();
  const res = ctx.actionDeleteShot_({ shotId: 'r2', actingUserId: A, viewYm: '2026-09' });
  const c0 = counts(env);
  const s = ctx.getShots_();
  assert.strictEqual(diff(c0, counts(env)).getValues, 0, 'シートを読み直した');
  assert.ok(!s.some((x) => x.id === 'r2'));
  assert.strictEqual(s.length, 6);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), JSON.parse(JSON.stringify(freshReadShots(ctx))));
  assert.ok(!res.alreadyDeleted);
});

test('deleteShot: 既に消えている記録は成功扱い(再送で二重に消さない)', () => {
  const { env, ctx } = setup();
  const c0 = counts(env);
  const res = ctx.actionDeleteShot_({ shotId: 'gone', actingUserId: A });
  assert.strictEqual(res.alreadyDeleted, true);
  assert.strictEqual(diff(c0, counts(env)).deleteRow, 0);
  assert.strictEqual(env.lockState.held, false);
});

test('deleteShot: 他人の記録は消せず、ロックは解放される', () => {
  const { env, ctx } = setup();
  assert.throws(() => ctx.actionDeleteShot_({ shotId: 'r3', actingUserId: A }), /権限/);
  assert.strictEqual(freshReadShots(ctx).length, 7);
  assert.strictEqual(env.lockState.held, false);
});

test('renameUser: その人の表示名だけが全部変わり、書き込みは1回だけ', () => {
  const { env, ctx } = setup();
  const c0 = counts(env);
  const res = ctx.actionRenameUser_({ userId: A, displayName: '新しいA' });
  const d = diff(c0, counts(env));
  assert.strictEqual(res.updated, 4);
  assert.strictEqual(d.setValue + d.setValues, 1, '書き込み回数=' + (d.setValue + d.setValues));
  const s = freshReadShots(ctx);
  s.filter((x) => x.userId === A).forEach((x) => assert.strictEqual(x.displayName, '新しいA'));
  s.filter((x) => x.userId === B).forEach((x) => assert.strictEqual(x.displayName, 'Bさん'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.getShots_())), JSON.parse(JSON.stringify(s)));
});

test('renameUser: 日付列の値を壊さない(表示名の列だけ書く)', () => {
  const { ctx, shots } = setup();
  const before = shots._data.map((r) => [r[2], r[3]].map((v) => (v instanceof Date ? v.getTime() : v)));
  ctx.actionRenameUser_({ userId: B, displayName: 'B2' });
  shots._data.forEach((r, i) => assert.deepStrictEqual([r[2], r[3]].map((v) => (v instanceof Date ? v.getTime() : v)), before[i]));
});

test('エクストラ参加者: 週キーが日付型に自動変換されていても数えられる(8月の不具合の修正)', () => {
  const { ctx, range } = setup();
  const fp = ctx.getSheet_(ctx.SHEET_FEST_PARTICIPANTS);
  fp.appendRow([range.monday, A, 'Aさん', new Date().toISOString()]);
  fp.appendRow(['2026-01-05', B, 'Bさん', new Date().toISOString()]); // 別の週は数えない
  assert.ok(fp._data[1][0] instanceof Date, '前提: 週キーが日付型になっている');
  assert.notStrictEqual(String(fp._data[1][0]), range.monday, '前提: 修正前の比較(String)では一致しない');
  const ps = ctx.festExtraParticipants_();
  assert.strictEqual(ps.length, 1); assert.strictEqual(ps[0].userId, A);
});

test('エクストラ参加者: 週キーが文字列のまま保存されている場合も数えられる', () => {
  const { ctx, range } = setup();
  const fp = ctx.getSheet_(ctx.SHEET_FEST_PARTICIPANTS);
  fp._data.push([range.monday, B, 'Bさん', 'x']); // 自動変換されなかったケース
  assert.strictEqual(ctx.festExtraParticipants_().length, 1);
});

test('キャッシュに入らない大きさなら古いキャッシュを必ず消す', () => {
  const { env, ctx } = setup();
  ctx.getShots_();
  assert.ok(env.cacheStore.size > 0);
  const huge = [['h']];
  for (let i = 0; i < 30000; i++) huge.push(['x' + i, 't', '2026-09', '2026-09-01', A, 'あいうえおかきくけこ', 's-lc', 1, 1, '']);
  const ok = ctx.putShotsCache_(huge);
  assert.strictEqual(ok, false);
  assert.strictEqual(env.cacheStore.get(ctx.SHOTS_CACHE_KEY) || null, null, 'メタキーが残っている');
});

test('recordShot(既存・未変更)が新しいロック関数と衝突しない', () => {
  const { ctx } = setup();
  const res = ctx.actionRecordShot_({ actingUserId: A, userId: A, displayName: 'Aさん', spotId: 's-lc', makes: 3, attempts: 4, date: '2026-09-07', clientId: 'c-new', viewYm: '2026-09' });
  assert.ok(res.id === 'c-new');
  ctx.actionUpdateShot_({ shotId: 'c-new', actingUserId: A, makes: 4, attempts: 4 });
  assert.strictEqual(freshReadShots(ctx).find((x) => x.id === 'c-new').makes, 4);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
