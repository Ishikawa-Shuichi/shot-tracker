/**
 * バスケ シュート確率記録 bot ― バックエンド (Google Apps Script)
 * ---------------------------------------------------------------
 * スプレッドシートをDBにした JSON API。
 * フロント(LIFFミニアプリ)から fetch(POST, text/plain) で呼び出す。
 *
 * デプロイ手順は README.md を参照。
 */

// ===== 設定 =====================================================
// 任意: 簡易トークン。空文字なら認証なし。フロントの API_TOKEN と一致させる。
var API_TOKEN = '';

// ホストのLINEユーザーID。この人だけ全員のランキング閲覧・代理記録・個人スポットの閲覧ができる。
var HOST_USER_ID = 'Ub47dc7fc4f136b8bd1551dbb2df86d68';

// 週間MVP自動投稿用: Messaging APIチャネルの「チャネルアクセストークン(長期)」。
// コード貼り替えで消えないよう、値は「プロジェクトの設定 → スクリプト プロパティ」に
// プロパティ名 LINE_TOKEN で保存する(ここに直接書いてもよいが、貼り替えのたびに消えるので非推奨)。
var LINE_CHANNEL_ACCESS_TOKEN = '';
function getLineToken_() {
  return PropertiesService.getScriptProperties().getProperty('LINE_TOKEN') || LINE_CHANNEL_ACCESS_TOKEN;
}

// シート名
var SHEET_SPOTS = 'Spots';
var SHEET_SHOTS = 'Shots';

// 「スリーポイントランキング」「推移のスリーポイント合計」は以下7スポット(共通のみ)の合計で計算する
var THREE_POINT_NAMES = ['左コーナー', '左ウイング', '左スロット', 'トップ', '右スロット', '右ウイング', '右コーナー'];
var THREE_POINT_SENTINEL = '__threepoint__'; // 推移タブでスポットIDの代わりに使う特別な値

// スポット一覧はめったに変わらないため、一定時間キャッシュして毎回の読み込みを省略する。
var SPOTS_CACHE_KEY = 'spots_raw_v1';
var SPOTS_CACHE_TTL_SEC = 300; // 5分

// チーム統計の重い集計結果(全ユーザー×全スポットの集計)も短時間キャッシュする。
// 個人の記録保存自体は即時反映されるので、チームランキングの表示だけがこの秒数分だけ遅れて更新される。
var TEAMAGG_CACHE_PREFIX = 'teamagg_v1_';
var TEAMAGG_CACHE_TTL_SEC = 30;

// Shots(全記録)シートの生データも短時間キャッシュする。記録の保存・更新・削除の直後は
// 必ずキャッシュを無効化するので、記録した本人にはズレなく即時反映される。
var SHOTS_CACHE_KEY = 'shots_raw_v1';
var SHOTS_CACHE_TTL_SEC = 20;

// 既定スポット(初回のみ自動投入)。x,y はコート図上の位置(0〜100%)。すべて共通(shared)スポット。
var DEFAULT_SPOTS = [
  { name: '左コーナー', x: 10, y: 18 },
  { name: '左ウイング', x: 22, y: 50 },
  { name: 'トップ',     x: 50, y: 68 },
  { name: '右ウイング', x: 78, y: 50 },
  { name: '右コーナー', x: 90, y: 18 }
];

// ===== エントリポイント =========================================
function doGet(e) {
  // 動作確認用
  return json_({ ok: true, data: { status: 'alive', time: new Date().toISOString() } });
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    // LINEプラットフォームからのWebhook(週間MVP投稿用のグループID取得)。
    // アプリからの呼び出し(action形式)とはbodyの形が違うため、ここで振り分ける。
    if (body.events) return handleLineWebhook_(body);
    if (API_TOKEN && body.token !== API_TOKEN) {
      return json_({ ok: false, error: 'unauthorized' });
    }
    var action = body.action || '';
    var data;
    switch (action) {
      case 'init':        data = actionInit_(body); break;
      case 'getSpots':    data = { spots: getSpots_(String(body.userId || '')) }; break;
      case 'addSpot':     data = actionAddSpot_(body); break;
      case 'updateSpot':  data = actionUpdateSpot_(body); break;
      case 'deleteSpot':  data = actionDeleteSpot_(body); break;
      case 'recordShot':  data = actionRecordShot_(body); break;
      case 'updateShot':  data = actionUpdateShot_(body); break;
      case 'deleteShot':  data = actionDeleteShot_(body); break;
      case 'renameUser':  data = actionRenameUser_(body); break;
      case 'getMyStats':  data = actionGetMyStats_(body); break;
      case 'getTeamStats':data = actionGetTeamStats_(body); break;
      case 'getTrend':    data = actionGetTrend_(body); break;
      case 'getHistory':  data = actionGetHistory_(body); break;
      case 'getWeeklyRanking': data = actionGetWeeklyRanking_(body); break;
      default:
        return json_({ ok: false, error: 'unknown action: ' + action });
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ===== アクション ================================================

// 起動時にまとめて必要なデータを返す(往復回数を減らして高速化するため)
function actionInit_(body) {
  var userId = String(body.userId || '');
  var ym = currentYm_();
  var spots = getSpots_(userId); // 共通 + 自分の個人スポット
  var shots = getShots_();
  var isHost = !!userId && userId === HOST_USER_ID;
  var result = {
    spots: spots,
    ym: ym,
    serverTime: new Date().toISOString(),
    isHost: isHost,
    myStats: computeMyStats_(spots, shots, userId, 'month', ym),
    history: computeHistory_(spots, shots, userId, 20),
    streak: computeStreak_(shots, userId)
  };
  if (isHost) result.members = uniqueMembers_(shots);
  return result;
}

function actionAddSpot_(body) {
  var name = String(body.name || '').trim();
  if (!name) throw new Error('スポット名が空です');
  var x = clampNum_(body.x, 0, 100, 50);
  var y = clampNum_(body.y, 0, 100, 50);
  var userId = String(body.userId || '');
  if (!userId) throw new Error('userId が空です');
  var wantsShared = String(body.scope || 'personal') === 'shared';
  if (wantsShared && userId !== HOST_USER_ID) throw new Error('共通スポットの追加はホストのみ可能です');
  var scope = wantsShared ? 'shared' : 'personal';
  var ownerId = scope === 'personal' ? userId : '';

  var sh = getSheet_(SHEET_SPOTS);
  var id = Utilities.getUuid();
  var order = sh.getLastRow(); // ヘッダ含む行数 ≒ 追加順
  sh.appendRow([id, name, x, y, order, true, new Date().toISOString(), scope, ownerId]);
  invalidateSpotsCache_();
  return { spots: getSpots_(userId) };
}

function actionUpdateSpot_(body) {
  var id = String(body.spotId || '');
  var userId = String(body.userId || '');
  var sh = getSheet_(SHEET_SPOTS);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      assertSpotEditable_(rows[i], userId);
      if (body.name != null) sh.getRange(i + 1, 2).setValue(String(body.name).trim());
      if (body.x != null)    sh.getRange(i + 1, 3).setValue(clampNum_(body.x, 0, 100, rows[i][2]));
      if (body.y != null)    sh.getRange(i + 1, 4).setValue(clampNum_(body.y, 0, 100, rows[i][3]));
      invalidateSpotsCache_();
      return { spots: getSpots_(userId) };
    }
  }
  throw new Error('スポットが見つかりません');
}

function actionDeleteSpot_(body) {
  // 論理削除(active=false)。記録は残す。
  var id = String(body.spotId || '');
  var userId = String(body.userId || '');
  var sh = getSheet_(SHEET_SPOTS);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      assertSpotEditable_(rows[i], userId);
      sh.getRange(i + 1, 6).setValue(false);
      invalidateSpotsCache_();
      return { spots: getSpots_(userId) };
    }
  }
  throw new Error('スポットが見つかりません');
}

// 共通スポットはホストのみ、個人スポットは持ち主(またはホスト)のみ編集・削除できる
function assertSpotEditable_(row, userId) {
  var scope = row[7] ? String(row[7]) : 'shared';
  var ownerId = row[8] ? String(row[8]) : '';
  if (userId === HOST_USER_ID) return;
  if (scope === 'shared') throw new Error('共通スポットの編集・削除はホストのみ可能です');
  if (ownerId !== userId) throw new Error('このスポットを編集・削除する権限がありません');
}

function actionRecordShot_(body) {
  // actingUserId: 実際にLIFFを操作している人(=ホストなら代理記録が可能)
  // userId: この記録の持ち主(通常はactingUserIdと同じ。ホストの代理記録時のみ別人)
  var actingUserId = String(body.actingUserId || body.userId || '').trim();
  var userId = String(body.userId || '').trim();
  var displayName = String(body.displayName || '名無し').trim();
  if (!actingUserId) throw new Error('userId が空です');
  if (userId !== actingUserId && actingUserId !== HOST_USER_ID) {
    throw new Error('他の人の記録を追加する権限がありません');
  }
  var spotId = String(body.spotId || '').trim();
  var makes = Math.max(0, Math.floor(Number(body.makes)));
  var attempts = Math.max(0, Math.floor(Number(body.attempts)));
  if (!userId) throw new Error('userId が空です');
  if (!spotId) throw new Error('スポット未選択です');
  if (!(attempts > 0)) throw new Error('試投数は1以上にしてください');
  if (makes > attempts) throw new Error('メイク数が試投数を超えています');

  // 記録日: body.date(YYYY-MM-DD)があれば採用、なければ今日
  var dateStr = String(body.date || '').trim();
  var d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  var ym = ymOf_(d);

  // 通信リトライで同じ保存が二重実行されても記録が重複しないよう、
  // クライアントが発行したID(clientId)を記録IDに使い、既に存在すれば追記せず成功として返す(冪等化)。
  var clientId = String(body.clientId || '').trim();
  var id = clientId || Utilities.getUuid();
  if (clientId) {
    var existing = getShots_();
    for (var ei = 0; ei < existing.length; ei++) {
      if (existing[ei].id === clientId) {
        var spotsDup = getSpots_(actingUserId);
        var viewYmDup = String(body.viewYm || '') || null;
        return {
          id: clientId, ym: existing[ei].ym, duplicate: true,
          myStats: computeMyStats_(spotsDup, existing, actingUserId, 'month', viewYmDup),
          history: computeHistory_(spotsDup, existing, actingUserId, 20),
          streak: computeStreak_(existing, actingUserId)
        };
      }
    }
  }

  var sh = getSheet_(SHEET_SHOTS);
  sh.appendRow([
    id, new Date().toISOString(), ym, dateOf_(d),
    userId, displayName, spotId, makes, attempts
  ]);
  invalidateShotsCache_();

  var spots = getSpots_(actingUserId);
  var shots = getShots_();
  var viewYm = String(body.viewYm || '') || null;
  return {
    id: id, ym: ym,
    myStats: computeMyStats_(spots, shots, actingUserId, 'month', viewYm),
    history: computeHistory_(spots, shots, actingUserId, 20),
    streak: computeStreak_(shots, actingUserId)
  };
}

function actionUpdateShot_(body) {
  var id = String(body.shotId || '');
  var actingUserId = String(body.actingUserId || body.userId || '');
  var sh = getSheet_(SHEET_SHOTS);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== id) continue;
    var ownerId = String(rows[i][4]);
    if (ownerId !== actingUserId && actingUserId !== HOST_USER_ID) throw new Error('この記録を編集する権限がありません');

    var makes = body.makes != null ? Math.max(0, Math.floor(Number(body.makes))) : Number(rows[i][7]);
    var attempts = body.attempts != null ? Math.max(0, Math.floor(Number(body.attempts))) : Number(rows[i][8]);
    if (!(attempts > 0)) throw new Error('試投数は1以上にしてください');
    if (makes > attempts) throw new Error('メイク数が試投数を超えています');

    if (body.date) {
      var d = new Date(String(body.date) + 'T00:00:00');
      sh.getRange(i + 1, 3).setValue(ymOf_(d));
      sh.getRange(i + 1, 4).setValue(dateOf_(d));
    }
    sh.getRange(i + 1, 8).setValue(makes);
    sh.getRange(i + 1, 9).setValue(attempts);
    invalidateShotsCache_();

    var spots = getSpots_(actingUserId);
    var shots = getShots_();
    var viewYm = String(body.viewYm || '') || null;
    return {
      id: id,
      myStats: computeMyStats_(spots, shots, actingUserId, 'month', viewYm),
      history: computeHistory_(spots, shots, actingUserId, 20),
      streak: computeStreak_(shots, actingUserId)
    };
  }
  throw new Error('記録が見つかりません');
}

function actionDeleteShot_(body) {
  var id = String(body.shotId || '');
  var actingUserId = String(body.actingUserId || body.userId || '');
  var sh = getSheet_(SHEET_SHOTS);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== id) continue;
    var ownerId = String(rows[i][4]);
    if (ownerId !== actingUserId && actingUserId !== HOST_USER_ID) throw new Error('この記録を削除する権限がありません');
    sh.deleteRow(i + 1);
    invalidateShotsCache_();

    var spots = getSpots_(actingUserId);
    var shots = getShots_();
    var viewYm = String(body.viewYm || '') || null;
    return {
      id: id,
      myStats: computeMyStats_(spots, shots, actingUserId, 'month', viewYm),
      history: computeHistory_(spots, shots, actingUserId, 20),
      streak: computeStreak_(shots, actingUserId)
    };
  }
  // 見つからない場合は「既に削除済み」(通信リトライによる二重実行など)とみなし、成功として最新の統計を返す
  var spotsGone = getSpots_(actingUserId);
  var shotsGone = getShots_();
  var viewYmGone = String(body.viewYm || '') || null;
  return {
    id: id, alreadyDeleted: true,
    myStats: computeMyStats_(spotsGone, shotsGone, actingUserId, 'month', viewYmGone),
    history: computeHistory_(spotsGone, shotsGone, actingUserId, 20),
    streak: computeStreak_(shotsGone, actingUserId)
  };
}

function actionRenameUser_(body) {
  var userId = String(body.userId || '');
  var newName = String(body.displayName || '').trim();
  if (!userId) throw new Error('userId が空です');
  if (!newName) throw new Error('表示名が空です');
  var sh = getSheet_(SHEET_SHOTS);
  var rows = sh.getDataRange().getValues();
  var updated = 0;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][4]) === userId) {
      sh.getRange(i + 1, 6).setValue(newName);
      updated++;
    }
  }
  if (updated > 0) invalidateShotsCache_();
  return { updated: updated, displayName: newName };
}

function actionGetMyStats_(body) {
  var requesterId = String(body.userId || '');
  var targetUserId = String(body.targetUserId || '') || requesterId;
  if (targetUserId !== requesterId && requesterId !== HOST_USER_ID) {
    throw new Error('この統計を見る権限がありません');
  }
  // granularity: 'month'(既定) | 'week' | 'day'。period が空なら全期間。
  // 後方互換のため period 未指定時は ym を使う。
  var granularity = String(body.granularity || 'month');
  var period = body.period != null ? (String(body.period) || null) : (String(body.ym || '') || null);
  return computeMyStats_(getSpots_(targetUserId), getShots_(), targetUserId, granularity, period);
}

// ホスト以外は「自分の順位」だけ、ホストは全員分(個人スポット含む)を見られる。
// 確率ランキング・合計本数ランキング・合計メイク数ランキングの3種類。
function actionGetTeamStats_(body) {
  var ym = String(body.ym || '') || null;
  var requestUserId = String(body.userId || '');
  var isHost = !!requestUserId && requestUserId === HOST_USER_ID;
  var spotId = String(body.spotId || ''); // '' = 合計(全スポット)

  var agg = getTeamAggregate_(ym); // 重い集計部分は短時間キャッシュ済み
  var allSpots = agg.allSpots;
  var allUsers = agg.allUsers;

  var pctRanked = allUsers.filter(function (u) { return attemptsOf_(u, spotId) > 0; })
    .sort(function (a, b) { return pctOf_(b, spotId) - pctOf_(a, spotId); });
  // 左右コーナー・ウイング・スロット・トップの7スポット合計で見るスリーポイントランキング
  var threePointRanked = allUsers.filter(function (u) { return u.threePoint.attempts > 0; })
    .sort(function (a, b) { return b.threePoint.pct - a.threePoint.pct; });
  // 本数ランキングはマイページ(個人スポット)分も含めた総試投数
  var countRanked = allUsers.filter(function (u) { return u.totalAttemptsAll > 0; })
    .sort(function (a, b) { return b.totalAttemptsAll - a.totalAttemptsAll; });

  // 「フリースロー」という名前のスポットがあれば、そのスポット専用のランキングを別枠で用意する
  var freeThrowSpot = null;
  for (var fi = 0; fi < allSpots.length; fi++) { if (allSpots[fi].name === 'フリースロー') { freeThrowSpot = allSpots[fi]; break; } }
  var ftId = freeThrowSpot ? freeThrowSpot.id : '';
  var ftRanked = freeThrowSpot
    ? allUsers.filter(function (u) { return attemptsOf_(u, ftId) > 0; }).sort(function (a, b) { return pctOf_(b, ftId) - pctOf_(a, ftId); })
    : [];

  if (isHost) {
    var spotsMetaAll = allSpots.map(function (s) { return { spotId: s.id, name: s.name, scope: s.scope, ownerId: s.ownerId }; });
    return {
      ym: ym, spots: spotsMetaAll, users: allUsers,
      pctRanking: pctRanked.map(function (u) {
        var s = spotStatOf_(u, spotId);
        return { userId: u.userId, name: u.name, makes: spotId ? s.makes : u.total.makes, attempts: attemptsOf_(u, spotId), pct: pctOf_(u, spotId) };
      }),
      threePointRanking: threePointRanked.map(function (u) {
        return { userId: u.userId, name: u.name, makes: u.threePoint.makes, attempts: u.threePoint.attempts, pct: u.threePoint.pct };
      }),
      countRanking: countRanked.map(function (u) {
        return { userId: u.userId, name: u.name, attempts: u.totalAttemptsAll };
      }),
      freeThrowSpotId: ftId || null,
      freeThrowRanking: ftRanked.map(function (u) {
        var s = spotStatOf_(u, ftId);
        return { userId: u.userId, name: u.name, makes: s.makes, attempts: s.attempts, pct: s.pct };
      })
    };
  }

  // ホスト以外には共通スポットの名前だけ返す(個人スポットの存在を他人に見せない)。
  // シュート本数ランキングだけは全員分を公開し、それ以外は「自分の順位」と「1位の人」だけ見せる
  // (確率が低い人でも始めやすいように、細かい順位までは他人に見せない措置)。
  var spotsMetaShared = allSpots.filter(function (s) { return s.scope !== 'personal'; })
    .map(function (s) { return { spotId: s.id, name: s.name }; });
  return {
    ym: ym, spots: spotsMetaShared,
    // 表示に使うのは名前と本数だけなので、LINEユーザーIDは渡さない
    countRanking: countRanked.map(function (u) {
      return { name: u.name, attempts: u.totalAttemptsAll };
    }),
    pctRank: rankSummary_(pctRanked, requestUserId, function (u) {
      var s = spotStatOf_(u, spotId);
      return { makes: spotId ? s.makes : u.total.makes, attempts: attemptsOf_(u, spotId), pct: pctOf_(u, spotId) };
    }),
    threePointRank: rankSummary_(threePointRanked, requestUserId, function (u) {
      return { makes: u.threePoint.makes, attempts: u.threePoint.attempts, pct: u.threePoint.pct };
    }),
    freeThrowSpotId: ftId || null,
    freeThrowRank: freeThrowSpot ? rankSummary_(ftRanked, requestUserId, function (u) {
      var s = spotStatOf_(u, ftId);
      return { makes: s.makes, attempts: s.attempts, pct: s.pct };
    }) : { mine: null, top: null }
  };
}

function actionGetTrend_(body) {
  // 指定スポットの推移。granularity: 'day' | 'week' | 'month'(既定)。
  // targetUserId 指定で個人、空ならチーム合算(チーム合算・他人の推移はホストのみ閲覧可)。
  // spotId が THREE_POINT_SENTINEL の場合は、スリーポイント7スポットの合計で集計する。
  var spotId = String(body.spotId || '');
  var requesterId = String(body.userId || '');
  var targetUserId = String(body.targetUserId || '') || null;
  var isHost = !!requesterId && requesterId === HOST_USER_ID;
  if (!isHost && targetUserId !== requesterId) {
    throw new Error('この推移を見る権限がありません');
  }
  var granularity = String(body.granularity || 'month');

  var threePointIds = null;
  if (spotId === THREE_POINT_SENTINEL) {
    var allSpots = getSpots_(null, true);
    threePointIds = {};
    allSpots.filter(function (sp) { return sp.scope !== 'personal' && THREE_POINT_NAMES.indexOf(sp.name) !== -1; })
      .forEach(function (sp) { threePointIds[sp.id] = true; });
  }

  var shots = getShots_();
  var byKey = {};
  shots.forEach(function (s) {
    var matches = threePointIds ? !!threePointIds[s.spotId] : (s.spotId === spotId);
    if (!matches) return;
    if (targetUserId && s.userId !== targetUserId) return;
    var key = granularity === 'day' ? s.date : granularity === 'week' ? weekKeyOf_(s.date) : s.ym;
    var b = byKey[key] || (byKey[key] = { makes: 0, attempts: 0 });
    b.makes += s.makes; b.attempts += s.attempts;
  });
  var points = Object.keys(byKey).sort().map(function (key) {
    var b = byKey[key];
    return { key: key, makes: b.makes, attempts: b.attempts, pct: pct_(b.makes, b.attempts) };
  });
  return { spotId: spotId, userId: targetUserId, granularity: granularity, points: points };
}

function actionGetHistory_(body) {
  var requesterId = String(body.userId || '');
  var targetUserId = String(body.targetUserId || '') || requesterId;
  if (targetUserId !== requesterId && requesterId !== HOST_USER_ID) {
    throw new Error('この履歴を見る権限がありません');
  }
  var limit = Math.min(200, Math.max(1, Math.floor(Number(body.limit) || 50)));
  return { items: computeHistory_(getSpots_(targetUserId), getShots_(), targetUserId, limit) };
}

// ===== 集計ロジック(使い回し用) ==================================

function computeMyStats_(spots, shots, userId, granularity, period) {
  // granularity: 'month'(既定) | 'week' | 'day'。period が空/nullなら全期間。
  // week指定時は period(任意の日付)が属する週の月曜日キーに正規化して比較する。
  var targetKey = null;
  if (period) {
    targetKey = granularity === 'week' ? weekKeyOf_(period) : period;
  }
  var bySpot = {};
  shots.forEach(function (s) {
    if (s.userId !== userId) return;
    if (targetKey) {
      var key = granularity === 'day' ? s.date : granularity === 'week' ? weekKeyOf_(s.date) : s.ym;
      if (key !== targetKey) return;
    }
    var b = bySpot[s.spotId] || (bySpot[s.spotId] = { makes: 0, attempts: 0 });
    b.makes += s.makes; b.attempts += s.attempts;
  });
  var stats = spots.map(function (sp) {
    var b = bySpot[sp.id] || { makes: 0, attempts: 0 };
    return { spotId: sp.id, name: sp.name, scope: sp.scope, makes: b.makes, attempts: b.attempts, pct: pct_(b.makes, b.attempts) };
  });
  var tot = stats.reduce(function (a, s) { a.makes += s.makes; a.attempts += s.attempts; return a; }, { makes: 0, attempts: 0 });
  return { granularity: granularity, period: period, spots: stats, total: { makes: tot.makes, attempts: tot.attempts, pct: pct_(tot.makes, tot.attempts) } };
}

function computeHistory_(spots, shots, userId, limit) {
  var spotName = {}; spots.forEach(function (s) { spotName[s.id] = s.name; });
  var mine = shots.filter(function (s) { return s.userId === userId; });
  mine.sort(function (a, b) { return a.ts < b.ts ? 1 : -1; }); // 新しい順
  return mine.slice(0, limit).map(function (s) {
    return { id: s.id, date: s.date, ym: s.ym, spotId: s.spotId, spot: spotName[s.spotId] || '(削除済)', makes: s.makes, attempts: s.attempts, pct: pct_(s.makes, s.attempts) };
  });
}

// 連続練習日数: 今日から(今日まだ記録していなければ昨日から)さかのぼり、記録のある日が何日続いているか
function computeStreak_(shots, userId) {
  var days = {};
  shots.forEach(function (s) { if (s.userId === userId) days[s.date] = true; });
  var cur = new Date();
  if (!days[dateOf_(cur)]) cur.setDate(cur.getDate() - 1); // 今日まだ打っていなくても昨日までの連続は生きている
  var streak = 0;
  while (days[dateOf_(cur)]) { streak++; cur.setDate(cur.getDate() - 1); }
  return streak;
}

// 記録が存在する全ユーザーの一覧(ホストの代理記録の対象選択に使用)
function uniqueMembers_(shots) {
  var map = {}; var order = [];
  shots.forEach(function (s) {
    if (!(s.userId in map)) order.push(s.userId);
    map[s.userId] = s.displayName;
  });
  return order.map(function (uid) { return { userId: uid, name: map[uid] }; });
}

function spotStatOf_(u, spotId) {
  if (!spotId) return { makes: u.total.makes, attempts: u.total.attempts, pct: u.total.pct };
  for (var i = 0; i < u.spots.length; i++) {
    if (u.spots[i].spotId === spotId) return u.spots[i];
  }
  return { makes: 0, attempts: 0, pct: 0 };
}
function pctOf_(u, spotId) { return spotId ? spotStatOf_(u, spotId).pct : u.total.pct; }
function attemptsOf_(u, spotId) { return spotId ? spotStatOf_(u, spotId).attempts : u.total.attempts; }

// 非ホスト向け: 「自分の順位」と「1位の人」だけを返す(他の人の細かい順位は見せない)
function rankSummary_(rankedList, userId, extraFn) {
  var mine = null;
  for (var i = 0; i < rankedList.length; i++) {
    if (rankedList[i].userId === userId) {
      var extra = extraFn(rankedList[i]);
      mine = { rank: i + 1, total: rankedList.length };
      for (var k in extra) mine[k] = extra[k];
      break;
    }
  }
  var top = null;
  if (rankedList.length) {
    var t = rankedList[0];
    var te = extraFn(t);
    top = { name: t.name };
    for (var k2 in te) top[k2] = te[k2];
  }
  return { mine: mine, top: top };
}

// ===== データ層 ==================================================

// viewerUserId: この人から見える範囲(共通 + 自分の個人スポット)に絞る。
// includeAllPersonal=true なら全員分の個人スポットも含める(ホストの集計・代理記録用)。
function getSpots_(viewerUserId, includeAllPersonal) {
  var rows = getSpotsRawRows_();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;
    if (r[5] === false || r[5] === 'FALSE') continue; // active=false は除外
    var scope = r[7] ? String(r[7]) : 'shared';
    var ownerId = r[8] ? String(r[8]) : '';
    if (scope === 'personal' && !includeAllPersonal) {
      if (!viewerUserId || ownerId !== viewerUserId) continue; // 他人の個人スポットは見せない
    }
    out.push({ id: String(r[0]), name: String(r[1]), x: Number(r[2]), y: Number(r[3]), order: Number(r[4]), scope: scope, ownerId: ownerId });
  }
  out.sort(function (a, b) { return a.order - b.order; });
  return out;
}

// Spotsシートの生データをキャッシュから取得(なければ読み込んでキャッシュに保存)。
// 全ユーザー共通のキャッシュ1本で済むよう、フィルタ前の生の行データをそのまま保存する。
function getSpotsRawRows_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(SPOTS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 壊れていたら読み直す */ }
  }
  var sh = getSheet_(SHEET_SPOTS);
  var rows = sh.getDataRange().getValues();
  try { cache.put(SPOTS_CACHE_KEY, JSON.stringify(rows), SPOTS_CACHE_TTL_SEC); } catch (e) { /* サイズ超過などは無視して読み込みは継続 */ }
  return rows;
}

// スポットの追加・編集・削除の直後に呼び、古いキャッシュを消して次回すぐ最新化されるようにする
function invalidateSpotsCache_() {
  CacheService.getScriptCache().remove(SPOTS_CACHE_KEY);
}

// チーム統計用の重い集計(全ユーザー×全スポットの内訳・スリーポイント合計)をym単位で短時間キャッシュする。
// spotId(スポット別確率の絞り込み)は軽い処理なのでキャッシュ対象に含めず、呼び出し側でその都度計算する。
function getTeamAggregate_(ym) {
  var cache = CacheService.getScriptCache();
  var key = TEAMAGG_CACHE_PREFIX + (ym || 'all');
  var cached = cache.get(key);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 壊れていたら読み直す */ }
  }

  var allSpots = getSpots_(null, true); // 共通+全員の個人スポット
  var scopeOf = {}; allSpots.forEach(function (sp) { scopeOf[sp.id] = sp.scope; });
  var shots = getShots_();
  var byUser = {}; // userId -> {name, spots:{spotId:{m,a}}, total}
  shots.forEach(function (s) {
    if (ym && s.ym !== ym) return;
    var u = byUser[s.userId] || (byUser[s.userId] = { userId: s.userId, name: s.displayName, spots: {}, tm: 0, ta: 0, taAll: 0 });
    u.name = s.displayName || u.name; // 最新表示名で上書き
    var b = u.spots[s.spotId] || (u.spots[s.spotId] = { makes: 0, attempts: 0 });
    b.makes += s.makes; b.attempts += s.attempts;
    u.taAll += s.attempts; // 本数ランキング用: マイページ(個人スポット)分も合算する
    // 確率系ランキング(総合確率など)には個人スポットを含めない(他の人と比較できないため)
    if (scopeOf[s.spotId] !== 'personal') { u.tm += s.makes; u.ta += s.attempts; }
  });
  var threePointSpotIds = allSpots.filter(function (sp) { return sp.scope !== 'personal' && THREE_POINT_NAMES.indexOf(sp.name) !== -1; })
    .map(function (sp) { return sp.id; });

  var allUsers = Object.keys(byUser).map(function (uid) {
    var u = byUser[uid];
    var spotStats = allSpots.map(function (sp) {
      var b = u.spots[sp.id] || { makes: 0, attempts: 0 };
      return { spotId: sp.id, makes: b.makes, attempts: b.attempts, pct: pct_(b.makes, b.attempts) };
    });
    var tpm = 0, tpa = 0;
    threePointSpotIds.forEach(function (sid) {
      var b = u.spots[sid] || { makes: 0, attempts: 0 };
      tpm += b.makes; tpa += b.attempts;
    });
    return {
      userId: u.userId, name: u.name, spots: spotStats, totalAttemptsAll: u.taAll,
      total: { makes: u.tm, attempts: u.ta, pct: pct_(u.tm, u.ta) },
      threePoint: { makes: tpm, attempts: tpa, pct: pct_(tpm, tpa) }
    };
  });

  var result = { allSpots: allSpots, allUsers: allUsers };
  try { cache.put(key, JSON.stringify(result), TEAMAGG_CACHE_TTL_SEC); } catch (e) { /* サイズ超過などは無視(キャッシュなしで動作継続) */ }
  return result;
}

function getShots_() {
  var rows = getShotsRawRows_();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;
    out.push({
      // getShotsRawRows_ が返す行は ts/ym/date を既に正規化済みの文字列にしているので String() で十分
      id: String(r[0]), ts: String(r[1]), ym: String(r[2]), date: String(r[3]),
      userId: String(r[4]), displayName: String(r[5]), spotId: String(r[6]),
      makes: Number(r[7]) || 0, attempts: Number(r[8]) || 0
    });
  }
  return out;
}

// Shotsシートの生データをキャッシュから取得(なければ読み込んでキャッシュに保存)。
// キャッシュはJSON化するため、保存前にDate型のセル(ts/ym/date列)を正しい文字列形式へ正規化しておく
// (そうしないとキャッシュ経由で読んだときに元がDate型だったかどうかの区別が失われてしまうため)。
function getShotsRawRows_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(SHOTS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 壊れていたら読み直す */ }
  }
  var sh = getSheet_(SHEET_SHOTS);
  var rows = sh.getDataRange().getValues();
  var normalized = rows.map(function (r, idx) {
    if (idx === 0) return r; // ヘッダ行はそのまま
    var copy = r.slice();
    copy[1] = textCell_(r[1]);
    copy[2] = ymCell_(r[2]);
    copy[3] = dateCell_(r[3]);
    return copy;
  });
  try { cache.put(SHOTS_CACHE_KEY, JSON.stringify(normalized), SHOTS_CACHE_TTL_SEC); } catch (e) { /* サイズ超過などは無視して読み込みは継続 */ }
  return normalized;
}

// 記録の保存・更新・削除・表示名変更の直後に呼び、古いキャッシュを消して次回すぐ最新化されるようにする
function invalidateShotsCache_() {
  CacheService.getScriptCache().remove(SHOTS_CACHE_KEY);
}

// スプレッドシートが "2026-07" のような文字列を日付型に自動変換してしまうことがあるため、
// 読み出し時に Date 型なら正しい書式へ戻す(保存済みの値がどちらの型でも安全に読める)。
function isDateCell_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
function textCell_(v) { return isDateCell_(v) ? v.toISOString() : String(v); }
function ymCell_(v)   { return isDateCell_(v) ? ymOf_(v)   : String(v); }
function dateCell_(v) { return isDateCell_(v) ? dateOf_(v) : String(v); }

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (name === SHEET_SPOTS) {
      sh.appendRow(['id', 'name', 'x', 'y', 'order', 'active', 'createdAt', 'scope', 'ownerId']);
      DEFAULT_SPOTS.forEach(function (s, idx) {
        sh.appendRow([Utilities.getUuid(), s.name, s.x, s.y, idx, true, new Date().toISOString(), 'shared', '']);
      });
    } else if (name === SHEET_SHOTS) {
      sh.appendRow(['id', 'timestamp', 'ym', 'date', 'userId', 'displayName', 'spotId', 'makes', 'attempts']);
    }
  }
  return sh;
}

// ===== ユーティリティ ============================================

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function pct_(m, a) { return a > 0 ? Math.round((m / a) * 1000) / 10 : 0; } // 小数1桁の%

function currentYm_() { return ymOf_(new Date()); }

function ymOf_(d) {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  return Utilities.formatDate(d, tz, 'yyyy-MM');
}
function dateOf_(d) {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}
// 'YYYY-MM-DD' の日付が属する週の月曜日を 'YYYY-MM-DD' で返す
function weekKeyOf_(dateStr) {
  var parts = dateStr.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var day = d.getDay(); // 0=日 .. 6=土
  var diffToMonday = (day === 0) ? -6 : (1 - day);
  d.setDate(d.getDate() + diffToMonday);
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function clampNum_(v, min, max, dflt) {
  var n = Number(v);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** 手動実行用: シートを初期化(既定スポット投入)。メニューやエディタから一度実行してもよい。 */
function setup() {
  getSheet_(SHEET_SPOTS);
  getSheet_(SHEET_SHOTS);
  Logger.log('初期化完了');
}

// ===== 週間MVP自動投稿(個別チャットへ) ============================

// LINE Webhook: 現状グループIDの取得以外には使っていないが、将来グループ投稿に戻す場合に備えて残す。
function handleLineWebhook_(body) {
  try {
    (body.events || []).forEach(function (ev) {
      var src = ev.source || {};
      if (src.type === 'group' && src.groupId) {
        PropertiesService.getScriptProperties().setProperty('LINE_GROUP_ID', src.groupId);
      }
    });
  } catch (err) { /* Webhookは常に200を返す */ }
  return json_({ ok: true });
}

/** 手動実行用: 毎週日曜20時台に weeklyMvpPost を自動実行するトリガーを設定する(一度だけ実行) */
function setupWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'weeklyMvpPost') ScriptApp.deleteTrigger(t);
  });
  // atHour+nearMinuteで21:45に近い時刻を狙う(GASの時刻トリガーは分単位の完全な指定はできないため、目安)
  ScriptApp.newTrigger('weeklyMvpPost').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(21).nearMinute(45).create();
  Logger.log('毎週日曜21:45頃の自動投稿トリガーを設定しました');
}

// 今週(月曜〜今日)のシュート本数ランキングを、メンバー1人ずつに個別メッセージで送る。
// (グループ投稿ではなく個別チャットに送ることで、各自のトーク履歴の上位に来るようにする)
// 確率は含めない(本数だけなら誰でも上位を狙える)。今週の記録がなければ何もしない。
// 注意: LINEの仕様上、botを「友だち追加」していない人には個別メッセージは届かない。
// 今週(月曜〜今日)のユーザーごとの本数を集計する(投稿・閲覧の両方から使う共通ロジック)
function computeWeeklyRanking_() {
  var today = dateOf_(new Date());
  var monday = weekKeyOf_(today);
  var shots = getShots_();
  var byUser = {}; // userId -> {name, attempts}
  var teamTotal = 0;
  shots.forEach(function (s) {
    if (s.date < monday || s.date > today) return;
    var u = byUser[s.userId] || (byUser[s.userId] = { name: s.displayName, attempts: 0 });
    u.name = s.displayName || u.name;
    u.attempts += s.attempts;
    teamTotal += s.attempts;
  });
  var ranked = Object.keys(byUser).map(function (uid) { return { userId: uid, name: byUser[uid].name, attempts: byUser[uid].attempts }; })
    .sort(function (a, b) { return b.attempts - a.attempts; });
  return { weekStart: monday, today: today, ranked: ranked, teamTotal: teamTotal };
}

// 「見るだけ」用(通知は送らない)。今週のランキングをアプリ側から確認したいときに使う。
function actionGetWeeklyRanking_(body) {
  var r = computeWeeklyRanking_();
  return { weekStart: r.weekStart, today: r.today, teamTotal: r.teamTotal, ranked: r.ranked };
}

function weeklyMvpPost() {
  var r = computeWeeklyRanking_();
  var ranked = r.ranked;
  var teamTotal = r.teamTotal;
  if (!ranked.length) return;

  var medals = ['🥇', '🥈', '🥉'];
  var rankingLines = ['📣 今週のシュート本数ランキング'];
  ranked.slice(0, 3).forEach(function (u, i) { rankingLines.push(medals[i] + ' ' + u.name + ' ' + u.attempts + '本'); });
  rankingLines.push('');
  rankingLines.push('チーム合計: ' + teamTotal + '本');
  var rankingText = rankingLines.join('\n');

  // 個人向けメッセージには順位を入れない(下位の人にとってやる気を削ぐ要因になるため、
  // 自分の本数だけを前向きに伝える。ランキング上位3人の名前は全員共通で見えるが、それ以外の順位は出さない)
  var failed = [];
  ranked.forEach(function (u) {
    var personal = 'あなたは今週 ' + u.attempts + '本 シュートを打ちました！';
    var text = rankingText + '\n\n' + personal + '\n今週もお疲れさまでした！🏀';
    if (!pushLineMessageTo_(u.userId, text)) failed.push(u.name);
  });
  if (failed.length) Logger.log('送信できなかった人(未フォロー等): ' + failed.join(', '));
}

function pushLineMessageTo_(to, text) {
  var token = getLineToken_();
  if (!token) { Logger.log('LINE_TOKEN未設定のため送信しません'); return false; }
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('送信失敗(' + to + '): ' + res.getContentText());
    return false;
  }
  return true;
}
