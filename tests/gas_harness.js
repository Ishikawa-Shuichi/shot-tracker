// Code.gs をNode上で動かすための模擬GAS環境。本番のスプレッドシートには一切触れない。
// 再現するもの: シート(読み書き・行削除・日付っぽい文字列の日付型への自動変換)、CacheService、LockService、
// Utilities.formatDate(Asia/Tokyo)、Session。呼び出し回数を数えて「読み込み・書き込みの往復が何回か」を検証できる。
process.env.TZ = 'Asia/Tokyo';
const fs = require('fs');
const vm = require('vm');

function jstParts(d) {
  const t = new Date(d.getTime() + 9 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), H: t.getUTCHours(), M: t.getUTCMinutes() };
}
const pad = (n) => String(n).padStart(2, '0');

// スプレッドシートの自動変換を再現: 'YYYY-MM-DD' / 'YYYY-MM' の文字列は日付型(JSTの0時)として保存される
function autoConvert(v) {
  if (typeof v !== 'string') return v;
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600 * 1000);
  m = v.match(/^(\d{4})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, 1) - 9 * 3600 * 1000);
  return v;
}
const cloneCell = (v) => (v instanceof Date ? new Date(v.getTime()) : v);

// opts.now: '2026-10-18T21:45:00+09:00' のように渡すと、Code.gs内の「引数なしの new Date()」がその時刻を返す
// (日付に依存する処理=フェス週・週次投稿などを、任意の日のつもりで検証するため)。引数ありの new Date(y,m,d) は本物のまま。
function makeEnv(opts) {
  opts = opts || {};
  const counters = { getValues: 0, setValue: 0, setValues: 0, appendRow: 0, deleteRow: 0 };
  const sheets = {};
  function makeSheet(name) {
    const data = [];
    const sheet = {
      _data: data,
      getDataRange() {
        return { getValues() { counters.getValues++; const w = Math.max(0, ...data.map((r) => r.length)); return data.map((r) => { const c = r.map(cloneCell); while (c.length < w) c.push(''); return c; }); } };
      },
      getRange(row, col, numRows, numCols) {
        numRows = numRows || 1; numCols = numCols || 1;
        return {
          setValue(v) { counters.setValue++; while (data.length < row) data.push([]); data[row - 1][col - 1] = autoConvert(v); },
          setValues(vals) {
            counters.setValues++;
            if (vals.length !== numRows || vals.some((r) => r.length !== numCols)) throw new Error('setValues: 範囲と配列の大きさが一致しません');
            for (let i = 0; i < numRows; i++) { while (data.length < row + i) data.push([]); for (let j = 0; j < numCols; j++) data[row - 1 + i][col - 1 + j] = autoConvert(vals[i][j]); }
          },
          getValues() { counters.getValues++; const out = []; for (let i = 0; i < numRows; i++) { const r = data[row - 1 + i] || []; out.push(Array.from({ length: numCols }, (_, j) => cloneCell(r[col - 1 + j] ?? ''))); } return out; },
        };
      },
      appendRow(arr) { counters.appendRow++; data.push(arr.map(autoConvert)); },
      deleteRow(n) { counters.deleteRow++; if (n < 1 || n > data.length) throw new Error('deleteRow: 範囲外 ' + n); data.splice(n - 1, 1); },
    };
    return sheet;
  }
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };
  const cacheStore = new Map();
  const cache = {
    get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
    put: (k, v) => { if (String(v).length > 100000) throw new Error('cache: 100KB超'); cacheStore.set(k, String(v)); },
    getAll: (ks) => { const o = {}; ks.forEach((k) => { if (cacheStore.has(k)) o[k] = cacheStore.get(k); }); return o; },
    putAll: (o) => { Object.keys(o).forEach((k) => cache.put(k, o[k])); },
    remove: (k) => cacheStore.delete(k),
    removeAll: (ks) => ks.forEach((k) => cacheStore.delete(k)),
  };
  const lockState = { held: false, acquired: 0 };
  const lock = {
    waitLock() { if (lockState.held) throw new Error('lock: 二重取得(解放漏れ)'); lockState.held = true; lockState.acquired++; },
    releaseLock() { lockState.held = false; },
  };
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => lock },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    Utilities: {
      getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
      formatDate(d, tz, fmt) {
        const p = jstParts(d);
        if (fmt === 'yyyy-MM-dd') return p.y + '-' + pad(p.m) + '-' + pad(p.d);
        if (fmt === 'yyyy-MM') return p.y + '-' + pad(p.m);
        throw new Error('formatDate: 未対応の書式 ' + fmt);
      },
    },
    ContentService: { createTextOutput: (s) => ({ setMimeType() { return s; } }), MimeType: { JSON: 'json' } },
    Logger: { log() {} },
    UrlFetchApp: { fetch() { throw new Error('テストでは外部通信しない'); } },
  };
  if (opts.now) {
    const fixed = new Date(opts.now).getTime();
    class FakeDate extends Date {
      constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
      static now() { return fixed; }
    }
    ctx.Date = FakeDate;
  }
  vm.createContext(ctx);
  const code = fs.readFileSync(process.argv[2], 'utf8');
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  return { ctx, sheets, counters, cacheStore, lockState, ss };
}
module.exports = { makeEnv, autoConvert };
