// index.html のインラインスクリプトをNode上で実際に動かすための最小限の画面(DOM)・通信・LIFFの偽物。
// 通信は偽のサーバー(handlers)が応答し、1件ごとに応答までの時間を変えられる(応答順の入れ替わりを再現するため)。
process.env.TZ = 'Asia/Tokyo';
const fs = require('fs');
const vm = require('vm');

function makeClassList() {
  const s = new Set();
  return { _s: s, add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c),
    toggle(c, on) { if (on === undefined) on = !s.has(c); on ? s.add(c) : s.delete(c); return on; } };
}
function makeEl(tag, id) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: id || '', _listeners: {}, _children: [], dataset: {}, style: {},
    value: '', textContent: '', checked: false, disabled: false, options: [], classList: makeClassList(),
    // innerHTML = '' は本物の画面では子要素を全部消す。履歴リストのように「毎回作り直す」描画の結果を検証できるよう、_children も空にする
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = v; if (v === '') this._children.length = 0; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this._children.push(c); if (this.tagName === 'SELECT' && c.tagName === 'OPTION') { this.options.push(c); if (this.options.length === 1 && !this.value) this.value = c.value; } return c; },
    // 本物の画面では子要素(コートのsvg等)が存在するので、nullではなく空の要素を返す
    querySelectorAll() { return []; }, querySelector(sel) { return (this._q = this._q || {})[sel] || (this._q[sel] = makeEl('div')); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    getContext() { return {}; }, remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, blur() {}, click() {},
  };
  return el;
}
const SELECT_IDS = new Set(['ymSel', 'myStatsWho', 'trendSpotSel', 'trendWho', 'trendSituationSel', 'teamSpotSel', 'teamSpotSelMe', 'teamUserSel', 'proxySel', 'teamLiveSituationSel']);

function makeClient(opts) {
  opts = opts || {};
  const els = new Map();
  const document = {
    readyState: 'complete',
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(SELECT_IDS.has(id) ? 'select' : 'div', id)); return els.get(id); },
    createElement(tag) { return makeEl(tag); },
    querySelectorAll() { return []; },
    querySelector(sel) { if (sel === 'nav button.active') return { dataset: { tab: client.activeTab } }; return null; },
    addEventListener() {}, body: makeEl('body'), documentElement: makeEl('html'),
  };
  // 初期値: 選択肢の既定値(HTMLのoption初期値と同じ)
  document.getElementById('myStatsWho').value = 'me';
  document.getElementById('trendWho').value = 'me';
  document.getElementById('trendSituationSel').value = '__live__';

  const store = new Map(Object.entries(opts.localStorage || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i], get length() { return store.size; },
  };

  const calls = [];                 // 送られたリクエストの記録 {action, body, t}
  const handlers = {};              // action -> (body) => data | throw {network:true} | throw {app:'msg'}
  const delays = [];                // 次に来るリクエストに割り当てる応答までの時間(ms)。空なら既定値
  const DEFAULT_DELAY = 5;
  let t0 = Date.now();
  async function fetch(url, init) {
    const body = JSON.parse(init.body);
    const delay = delays.length ? delays.shift() : DEFAULT_DELAY;
    calls.push({ action: body.action, body, t: Date.now() - t0 });
    await new Promise((r) => setTimeout(r, delay));
    const h = handlers[body.action];
    if (!h) return { json: async () => ({ ok: false, error: 'no handler: ' + body.action }) };
    try {
      const data = h(body);
      return { json: async () => ({ ok: true, data }) };
    } catch (e) {
      if (e && e.network) { const err = new TypeError('Failed to fetch'); throw err; }
      // GoogleのエラーページのようにJSONでない返事(throw {html:404} で再現)
      if (e && e.html) return { status: e.html, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } };
      return { json: async () => ({ ok: false, error: (e && e.app) || String(e) }) };
    }
  }

  const toasts = [];
  const win = {
    addEventListener() {}, removeEventListener() {}, location: { href: 'https://example.test/', search: '' },
    navigator: { vibrate() {} }, confirm: () => true, prompt: () => null, alert() {},
    liff: opts.liff === undefined ? { init: async () => {}, isLoggedIn: () => true, login() {}, getProfile: async () => ({ userId: opts.userId || 'Uself', displayName: opts.displayName || '自分' }) } : opts.liff,
  };
  const ctx = {
    console, document, localStorage, sessionStorage: localStorage, fetch, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, Set, Map,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    AbortController, navigator: win.navigator, confirm: win.confirm, prompt: win.prompt, alert: win.alert, location: win.location,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  ctx.window = ctx; Object.assign(ctx, { addEventListener() {}, removeEventListener() {}, liff: win.liff });
  vm.createContext(ctx);
  const client = { ctx, els, document, localStorage, store, calls, handlers, delays, toasts, activeTab: 'record',
    el: (id) => document.getElementById(id),
    run(code) { return vm.runInContext(code, ctx); },
    fire(id, type) { const l = (document.getElementById(id)._listeners[type || 'click'] || []); return Promise.all(l.map((f) => f({ preventDefault() {}, target: document.getElementById(id), touches: [{ clientX: 0, clientY: 0 }] }))); },
    reset() { calls.length = 0; t0 = Date.now(); },
  };
  return client;
}
function loadScript(client, path) {
  const code = fs.readFileSync(path, 'utf8');
  vm.runInContext(code, client.ctx, { filename: 'index_inline.js' });
}
const flush = (ms) => new Promise((r) => setTimeout(r, ms || 30));
module.exports = { makeClient, loadScript, flush };
