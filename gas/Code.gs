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
var SHEET_GOALS = 'Goals';
var SHEET_FEST_PARTICIPANTS = 'FestParticipants';

// ===== チーム共同ゴール(シュートフェス) ============================
// 期間限定(1週間)のチーム協力イベント。上限は設けない(頑張るほど得をする設計を貫く)。
// 3段階の目標を、シチュエーション・スポットを問わず全員の全記録の合計本数で判定する。
var FEST_ENABLED = true; // 開催そのものを止めたい月だけfalseにする(通常はtrueのまま自動運用)
var FEST_NAME = 'シュートフェス';
var FEST_TIERS = [1000, 2000, 3000];
var FEST_EXTRA_PER_PERSON = 100; // エクストラミッション: 参加表明した人数 × この本数が追加目標
var FEST_SUNDAY_MULTIPLIER = 2;  // 3段階目未達のまま日曜を迎えた場合、その日の本数を何倍で加算するか
// フェス期間中は通知量を絞る(いったん停止)。フェス終了後はfalseに戻す想定
var NOTIFY_LIVE_UNLOCK_PAUSED = true;
var NOTIFY_TROPHY_GATEWAY_ONLY = true; // trueなら「3日連続」以外のチーム初獲得は通知しない

// 一斉配信(トロフィー・ライブ解放・フェス通知)の対象から常に外す人。
// テストアカウント・運営(ホスト)自身・辞退者は無料メッセージ枠を消費する必要がないため。
var BROADCAST_EXCLUDED_USER_IDS = [
  'U6882c6acc6c7e206fd4baefad8af74e3', // テスト中
  HOST_USER_ID,                        // 柊一(運営)
  'Ued2c31e2ef57dbac6865029d145fdda8'  // 祥吾
];
function broadcastTargets_(memberMap, excludeUserId) {
  return Object.keys(memberMap).filter(function (uid) {
    if (uid === excludeUserId) return false; // 今回の当人(達成者本人)には送らない
    if (uid.indexOf('proxy-') === 0) return false; // 代理記録用の仮メンバーはLINEに存在しない
    if (BROADCAST_EXCLUDED_USER_IDS.indexOf(uid) !== -1) return false;
    return true;
  });
}

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
      case 'getSpots':    data = { spots: getSpots_(String(body.userId || ''), String(body.userId || '') === HOST_USER_ID) }; break;
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
      case 'setGoal':     data = actionSetGoal_(body); break;
      case 'getAllLicenses': data = actionGetAllLicenses_(body); break;
      case 'registerMember': data = actionRegisterMember_(body); break;
      case 'getFestStatus': data = actionGetFestStatus_(body); break;
      case 'festParticipate': data = actionFestParticipate_(body); break;
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
  var isHost = !!userId && userId === HOST_USER_ID;
  // ホストには全員分の個人スポットも渡す(代理記録時に相手のマイスポットへ記録できるように)。
  // クライアント側は ownerId を見て「いま記録している対象者の分」だけを表示する。
  var spots = isHost ? getSpots_(userId, true) : getSpots_(userId);
  // 自分の統計に他人の個人スポットが混ざらないよう、集計には自分に見える分だけを使う
  var spotsMine = isHost
    ? spots.filter(function (sp) { return sp.scope !== 'personal' || sp.ownerId === userId; })
    : spots;
  var shots = getShots_();
  var result = {
    spots: spots,
    ym: ym,
    serverTime: new Date().toISOString(),
    isHost: isHost,
    myStats: computeMyStats_(spotsMine, shots, userId, 'month', ym),
    history: computeHistory_(spots, shots, userId, 20),
    streak: computeStreak_(shots, userId),
    myTrophies: getMyTrophies_(userId),
    trophyTotal: TROPHY_DEFS.length,
    myGoal: getMyGoal_(userId),
    // 仲間のライセンス閲覧(誰でも誰の分でも見られる)用の選択肢として、ホスト以外にも渡す
    members: allMembers_(shots),
    fest: getFestStatus_(userId, shots)
  };
  return result;
}

// 記録がある人 + ホストが作成したproxyメンバー(まだ記録が1本も無くても選択肢に出す)
function allMembers_(shots) {
  var members = uniqueMembers_(shots || getShots_());
  var seen = {};
  members.forEach(function (m) { seen[m.userId] = true; });
  getKnownUsers_().forEach(function (m) {
    if (m.userId.indexOf('proxy-') === 0 && !seen[m.userId]) { members.push(m); seen[m.userId] = true; }
  });
  return members;
}

// ホストが「スマホを持っていない人(兄弟で1台の親のスマホを使う小学生など)」の記録用アカウントを作る。
// LINEアカウント不要のproxy-IDを発行し、KnownUsersシートに保存して永続化する。
// 通知系の宛先は全てbroadcastTargets_でproxy-を除外しているため、このIDにDMが飛ぶことはない。
function actionRegisterMember_(body) {
  var userId = String(body.userId || '');
  if (userId !== HOST_USER_ID) throw new Error('メンバーの作成はホストのみ可能です');
  var name = String(body.name || '').trim();
  if (!name) throw new Error('名前が空です');
  // 同名の人が既にいれば新規作成せずその人を返す(同一人物の記録が別IDに分裂しないように)
  var existing = allMembers_();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].name === name) return { userId: existing[i].userId, name: existing[i].name };
  }
  var newId = 'proxy-' + Utilities.getUuid().slice(0, 8);
  getSheet_('KnownUsers').appendRow([newId, name, new Date().toISOString()]);
  return { userId: newId, name: name };
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
  // ホストは他人のマイスポットへも追加できる(代理記録中にその人専用スポットを作るため)
  var ownerUserId = String(body.ownerUserId || '') || userId;
  if (ownerUserId !== userId && userId !== HOST_USER_ID) throw new Error('他の人のマイスポットへの追加はホストのみ可能です');
  var ownerId = scope === 'personal' ? ownerUserId : '';

  var sh = getSheet_(SHEET_SPOTS);
  var id = Utilities.getUuid();
  var order = sh.getLastRow(); // ヘッダ含む行数 ≒ 追加順
  sh.appendRow([id, name, x, y, order, true, new Date().toISOString(), scope, ownerId, '']);
  invalidateSpotsCache_();
  return { spots: getSpots_(userId, userId === HOST_USER_ID) };
}

// マイスポット用カスタムシチュエーションの入力を掃除する(カンマ区切り文字列or配列を受ける)。
// 各名前は10文字まで・最大6個・重複除去。ライブの固定シチュエーションと同名でも構わない
// (集計はスポットのscopeで区別されるため混ざらない)
function sanitizeSituations_(raw) {
  var arr = Array.isArray(raw) ? raw : String(raw || '').split(',');
  var seen = {};
  var out = [];
  arr.forEach(function (s) {
    var v = String(s || '').trim().slice(0, 10);
    if (!v || seen[v]) return;
    seen[v] = true;
    if (out.length < 6) out.push(v);
  });
  return out;
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
      if (body.situations != null) {
        // カスタムシチュエーションはマイスポット専用。共通スポットに付けると、シチュエーション付き記録=
        // ライブ(3PT実戦形式)という集計上の前提が崩れてライブランキングに混入するため禁止する
        var scope = rows[i][7] ? String(rows[i][7]) : 'shared';
        if (scope !== 'personal') throw new Error('シチュエーションボタンはマイスポットにのみ設定できます');
        sh.getRange(i + 1, 10).setValue(sanitizeSituations_(body.situations).join(','));
      }
      invalidateSpotsCache_();
      return { spots: getSpots_(userId, userId === HOST_USER_ID) };
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
      return { spots: getSpots_(userId, userId === HOST_USER_ID) };
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

  // シチュエーション(任意)。'' = 指定なし(=スポットシューティング)。HO/チェック/ミート/ドリブルなど
  var situation = String(body.situation || '').trim().slice(0, 20);

  // 通信リトライで同じ保存が二重実行されても記録が重複しないよう、
  // クライアントが発行したID(clientId)を記録IDに使い、既に存在すれば追記せず成功として返す(冪等化)。
  // さらに保存ボタン連打などで同じclientIdの保存が「同時に」届いた場合も両方追記されないよう、
  // 重複チェック〜追記の間を排他ロックで直列化する。
  var clientId = String(body.clientId || '').trim();
  var id = clientId || Utilities.getUuid();
  var viewYm = String(body.viewYm || '') || null;

  // ライブシューティングを「初めて」解放した瞬間を検出するため、保存前の状態を控えておく
  var shotsBefore = getShots_();

  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (le) { throw new Error('サーバーが混み合っています。少し待ってからもう一度お試しください'); }
  var dupRow = null, shots = null;
  try {
    if (clientId) {
      var existing = getShots_();
      for (var ei = 0; ei < existing.length; ei++) {
        if (existing[ei].id === clientId) { dupRow = existing[ei]; break; }
      }
      if (dupRow) shots = existing;
    }
    if (!dupRow) {
      var sh = getSheet_(SHEET_SHOTS);
      sh.appendRow([
        id, new Date().toISOString(), ym, dateOf_(d),
        userId, displayName, spotId, makes, attempts, situation
      ]);
      invalidateShotsCache_();
    }
  } finally {
    lock.releaseLock();
  }

  var spots = getSpots_(actingUserId);
  if (!shots) shots = getShots_();
  // トロフィー・ライブ解放・フェス段階通知は記録の持ち主(代理記録なら対象メンバー)に対して判定する。重複保存の再送時は判定しない
  var newTrophies = dupRow ? [] : evaluateTrophies_(userId, displayName, shots);
  var newFestTier = dupRow ? null : checkFestTierCrossing_(shotsBefore, shots);
  if (!dupRow) notifyNewLiveUnlocks_(userId, displayName, shotsBefore, shots, spots);
  return {
    id: id, ym: dupRow ? dupRow.ym : ym, duplicate: dupRow ? true : undefined,
    myStats: computeMyStats_(spots, shots, actingUserId, 'month', viewYm),
    history: computeHistory_(spots, shots, actingUserId, 20),
    streak: computeStreak_(shots, actingUserId),
    newTrophies: newTrophies,
    trophyOwner: userId,
    // フェスカードは「画面を操作している人」の視点で表示する(「あなたの貢献」が代理対象者の本数に
    // 化けないように)。段階の判定・通知はチーム全体なので、この引数の違いには影響されない。
    fest: getFestStatus_(actingUserId, shots),
    newFestTier: newFestTier
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
    if (body.situation != null) sh.getRange(i + 1, 10).setValue(String(body.situation).trim().slice(0, 20));
    invalidateShotsCache_();

    var spots = getSpots_(actingUserId);
    var shots = getShots_();
    var viewYm = String(body.viewYm || '') || null;
    return {
      id: id,
      myStats: computeMyStats_(spots, shots, actingUserId, 'month', viewYm),
      history: computeHistory_(spots, shots, actingUserId, 20),
      streak: computeStreak_(shots, actingUserId),
      fest: getFestStatus_(actingUserId, shots) // 本数を編集したらチーム合計も変わるため一緒に返す
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
      streak: computeStreak_(shots, actingUserId),
      fest: getFestStatus_(actingUserId, shots) // 記録を消したらチーム合計も減るため一緒に返す
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
    streak: computeStreak_(shotsGone, actingUserId),
    fest: getFestStatus_(actingUserId, shotsGone)
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
  var isHost = requesterId === HOST_USER_ID;
  var rawTarget = String(body.targetUserId || '');
  var isTeam = rawTarget === '__team__';
  if (isTeam && !isHost) throw new Error('この統計を見る権限がありません');
  var targetUserId = isTeam ? '' : (rawTarget || requesterId);
  if (!isTeam && targetUserId !== requesterId && !isHost) {
    throw new Error('この統計を見る権限がありません');
  }
  // granularity: 'month'(既定) | 'week' | 'day'。period が空なら全期間。
  // 後方互換のため period 未指定時は ym を使う。
  var granularity = String(body.granularity || 'month');
  var period = body.period != null ? (String(body.period) || null) : (String(body.ym || '') || null);
  // チーム合算は共通スポットのみで集計する(個人ごとに違う名前のマイスポットは人をまたいで合算できないため)
  var spots = isTeam ? getSpots_(null) : getSpots_(targetUserId);
  return computeMyStats_(spots, getShots_(), targetUserId, granularity, period);
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

  // 連続シューティング日数(全員に公開)。続いている人だけを載せ、細かい順位はつけない
  var allShotsForStreak = getShots_();
  var streaks = uniqueMembers_(allShotsForStreak).map(function (m) {
    return { name: m.name, streak: computeStreak_(allShotsForStreak, m.userId) };
  }).filter(function (x) { return x.streak >= 1; })
    .sort(function (a, b) { return b.streak - a.streak; });

  var pctRanked = allUsers.filter(function (u) { return attemptsOf_(u, spotId) > 0; })
    .sort(function (a, b) { return pctOf_(b, spotId) - pctOf_(a, spotId); });
  // 左右コーナー・ウイング・スロット・トップの7スポット合計で見るスリーポイントランキング
  var threePointRanked = allUsers.filter(function (u) { return u.threePoint.attempts > 0; })
    .sort(function (a, b) { return b.threePoint.pct - a.threePoint.pct; });
  // 本数ランキングはマイスポット(個人スポット)分も含めた総試投数
  var countRanked = allUsers.filter(function (u) { return u.totalAttemptsAll > 0; })
    .sort(function (a, b) { return b.totalAttemptsAll - a.totalAttemptsAll; });

  // 「フリースロー」という名前のスポットがあれば、そのスポット専用のランキングを別枠で用意する
  var freeThrowSpot = null;
  for (var fi = 0; fi < allSpots.length; fi++) { if (allSpots[fi].name === 'フリースロー') { freeThrowSpot = allSpots[fi]; break; } }
  var ftId = freeThrowSpot ? freeThrowSpot.id : '';
  var ftRanked = freeThrowSpot
    ? allUsers.filter(function (u) { return attemptsOf_(u, ftId) > 0; }).sort(function (a, b) { return pctOf_(b, ftId) - pctOf_(a, ftId); })
    : [];

  // ライブシューティング確率。スポットの確率とは混ぜず専用ランキングにする。
  // situation指定なし= 全シチュエーション合計(従来通り)。指定ありならそのシチュエーションだけで見る
  // (スポットごとの内訳はbySpotにそのまま入っているので、選んだシチュエーションの中でどのスポットが
  // 得意/苦手かも同時にわかる)
  var liveSituation = String(body.situation || '');
  function liveExtraOf_(u) {
    if (!liveSituation) return { makes: u.live.makes, attempts: u.live.attempts, pct: u.live.pct, bySpot: null };
    var found = null;
    (u.live.bySituation || []).forEach(function (s) { if (s.situation === liveSituation) found = s; });
    return found ? { makes: found.makes, attempts: found.attempts, pct: found.pct, bySpot: found.bySpot }
                 : { makes: 0, attempts: 0, pct: 0, bySpot: null };
  }
  var liveRanked = allUsers.filter(function (u) { return liveExtraOf_(u).attempts > 0; })
    .sort(function (a, b) { return liveExtraOf_(b).pct - liveExtraOf_(a).pct; });
  // カード自体の表示可否は「チーム全体でこれまでに一度でもライブ記録があるか」で決める(situationの絞り込みとは独立)。
  // 選択中のシチュエーションだけで判定すると、まだ誰も試していないシチュエーションを選んだ瞬間に
  // セレクタごとカードが消えて選び直せなくなるため
  var liveHasAny = allUsers.some(function (u) { return u.live && u.live.attempts > 0; });

  if (isHost) {
    var spotsMetaAll = allSpots.map(function (s) { return { spotId: s.id, name: s.name, scope: s.scope, ownerId: s.ownerId }; });
    return {
      ym: ym, spots: spotsMetaAll, users: allUsers, streaks: streaks,
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
      }),
      liveSituation: liveSituation, liveSituations: LIVE_SITUATIONS, liveHasAny: liveHasAny,
      liveRanking: liveRanked.map(function (u) {
        var l = liveExtraOf_(u);
        return { userId: u.userId, name: u.name, makes: l.makes, attempts: l.attempts, pct: l.pct, bySpot: l.bySpot };
      })
    };
  }

  // ホスト以外には共通スポットの名前だけ返す(個人スポットの存在を他人に見せない)。
  // シュート本数ランキングだけは全員分を公開し、それ以外は「自分の順位」と「1位の人」だけ見せる
  // (確率が低い人でも始めやすいように、細かい順位までは他人に見せない措置)。
  var spotsMetaShared = allSpots.filter(function (s) { return s.scope !== 'personal'; })
    .map(function (s) { return { spotId: s.id, name: s.name }; });
  return {
    ym: ym, spots: spotsMetaShared, streaks: streaks,
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
    }) : { mine: null, top: null },
    // ライブは隠し要素なので、一度でも解放したことがある人にだけランキング欄ごと返す
    // (未解放の人には欄の存在も見せない。通信内容にも含めない)
    liveSituation: liveSituation, liveSituations: LIVE_SITUATIONS,
    liveRank: hasEverUnlockedLive_(allShotsForStreak, requestUserId, allSpots)
      ? rankSummary_(liveRanked, requestUserId, liveExtraOf_)
      : null
  };
}
// シチュエーションの固定語彙(推移タブの選択肢と揃える)。ここに無い値が記録されていても、
// 「全体」には反映されるが、選択式のシチュエーション別内訳には出ない
var LIVE_SITUATIONS = ['HO', 'チェック', 'ミート', 'ドリブル'];

// その人がライブシューティングをどこかのスポットで一度でも解放したことがあるか
function hasEverUnlockedLive_(shots, userId, spots) {
  var status = computeLiveStatus_(shots, userId, spots);
  return Object.keys(status).some(function (k) { return status[k].ever; });
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

  // situation 未指定: スポットシューティング(指定なし)のみ / '__live__': ライブ全体 / 個別名: そのシチュエーションのみ
  var sitFilter = String(body.situation || '') || null;

  var shots = getShots_();
  var byKey = {};
  shots.forEach(function (s) {
    if (sitFilter === null) { if (s.situation) return; }
    else if (sitFilter === '__live__') { if (!s.situation) return; }
    else if (s.situation !== sitFilter) return;
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

// ===== トロフィー(実績) ==========================================
// 隠し要素。獲得するまで存在を見せない。最初の1個は必ず「3日連続シューティング」になるよう、
// それを獲得するまで他のトロフィーは判定しない(簡単なもので先に開いて興ざめしないように)。
// チーム内で誰も獲得したことがないトロフィーを解放した瞬間は、全員に「誰かが新しいトロフィーを解放した」
// ことだけをLINE通知する(内容は秘密。会話のきっかけになるように)。
var SHEET_TROPHIES = 'Trophies';
var TROPHY_GATEWAY_ID = 'streak_3';
var TROPHY_DEFS = [
  { id: 'streak_3',    name: '3日連続シューティング',        tier: 'bronze' },
  { id: 'streak_7',    name: '7日連続シューティング',        tier: 'silver' },
  { id: 'streak_30',   name: '30日連続シューティング',       tier: 'gold'   },
  { id: 'month_1000',  name: '月間1000本',                   tier: 'bronze' },
  { id: 'month_10000', name: '月間10000本',                  tier: 'silver' },
  { id: 'month_20000', name: '月間20000本',                  tier: 'gold'   },
  { id: 'layup_10',    name: 'レイアップ10本',               tier: 'bronze' },
  { id: 'layup_100',   name: 'レイアップ100本',              tier: 'silver' },
  { id: 'layup_1000',  name: 'レイアップ1000本',             tier: 'gold'   },
  { id: 'perfect_10',  name: 'パーフェクト(1回の記録で10本以上100%)', tier: 'silver' }
];

// ユーザーの現在の実績値からトロフィー条件を満たすかを判定する
function trophyConditionMet_(def, userId, shots, spots) {
  if (def.id.indexOf('streak_') === 0) {
    var need = Number(def.id.split('_')[1]);
    return computeStreak_(shots, userId) >= need;
  }
  if (def.id.indexOf('month_') === 0) {
    var needM = Number(def.id.split('_')[1]);
    var ym = currentYm_();
    var total = 0;
    shots.forEach(function (s) { if (s.userId === userId && s.ym === ym) total += s.attempts; });
    return total >= needM;
  }
  if (def.id.indexOf('layup_') === 0) {
    var needL = Number(def.id.split('_')[1]);
    // 名前に「レイアップ」を含むスポット(共通・個人問わず)への総試投数
    var layupIds = {};
    spots.forEach(function (sp) { if (sp.name.indexOf('レイアップ') !== -1) layupIds[sp.id] = true; });
    var totalL = 0;
    shots.forEach(function (s) { if (s.userId === userId && layupIds[s.spotId]) totalL += s.attempts; });
    return totalL >= needL;
  }
  if (def.id === 'perfect_10') {
    return shots.some(function (s) { return s.userId === userId && s.attempts >= 10 && s.makes === s.attempts; });
  }
  return false;
}

function getTrophyRows_() {
  var sh = getSheet_(SHEET_TROPHIES);
  return sh.getDataRange().getValues();
}

function getMyTrophies_(userId) {
  var rows = getTrophyRows_();
  var byId = {}; TROPHY_DEFS.forEach(function (d) { byId[d.id] = d; });
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== userId) continue;
    var def = byId[String(rows[i][1])];
    if (def) out.push({ id: def.id, name: def.name, tier: def.tier, earnedAt: textCell_(rows[i][2]) });
  }
  return out;
}

// 記録保存後に呼ぶ。新規獲得したトロフィーの配列を返す(なければ空)。
// 「チーム内で誰も持っていなかったトロフィー」を獲得した場合は全員へ匿名内容の通知を送る。
function evaluateTrophies_(userId, displayName, shots) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return []; } // 混雑時は次回の保存時に再判定される
  var newOnes = [];
  var anyWorldFirst = false;
  try {
    var rows = getTrophyRows_();
    var mine = {}; var teamHas = {};
    for (var i = 1; i < rows.length; i++) {
      if (!rows[i][1]) continue;
      teamHas[String(rows[i][1])] = true;
      if (String(rows[i][0]) === userId) mine[String(rows[i][1])] = true;
    }
    var spots = getSpots_(null, true);
    // ゲート: 最初のトロフィーは必ず3日連続。未獲得の間は他を判定しない。
    // 獲得したその保存では3日連続だけを付与し、他は次の保存から判定する(初解放の瞬間を薄めない)
    var defsToCheck = mine[TROPHY_GATEWAY_ID]
      ? TROPHY_DEFS
      : TROPHY_DEFS.filter(function (d) { return d.id === TROPHY_GATEWAY_ID; });
    var sh = getSheet_(SHEET_TROPHIES);
    defsToCheck.forEach(function (def) {
      if (mine[def.id]) return;
      if (!trophyConditionMet_(def, userId, shots, spots)) return;
      sh.appendRow([userId, def.id, new Date().toISOString(), displayName]);
      newOnes.push({ id: def.id, name: def.name, tier: def.tier });
      // フェス期間中は通数節約のため、3日連続(ゲートウェイ)以外のチーム初獲得では通知しない
      if (!teamHas[def.id] && (!NOTIFY_TROPHY_GATEWAY_ONLY || def.id === TROPHY_GATEWAY_ID)) anyWorldFirst = true;
      teamHas[def.id] = true;
    });
  } finally {
    lock.releaseLock();
  }
  if (anyWorldFirst) {
    // 内容は伏せて「誰かが何かを解放した」ことだけ全員(本人以外)に伝える
    try {
      var memberMap = {};
      getKnownUsers_().forEach(function (m) { memberMap[m.userId] = m.name; });
      uniqueMembers_(shots).forEach(function (m) { memberMap[m.userId] = m.name; });
      pushLineMessageBatch_(broadcastTargets_(memberMap, userId), '🏆 ' + displayName + 'さんが誰も発見していないトロフィーを獲得しました！');
    } catch (e) { /* 通知失敗でも保存処理は成功扱い */ }
  }
  return newOnes;
}

// ===== 週目標(個人・本数) ==========================================
// 確率ではなく本数を目標にする(確率目標は虚偽申告を誘発しやすいため)。
// デフォルト非公開。公開に切り替えた人だけ、仲間のライセンス画面にも達成率が表示される。

function getMyGoal_(userId) {
  var rows = getSheet_(SHEET_GOALS).getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId) {
      return { weeklyGoal: Number(rows[i][1]) || 0, public: rows[i][2] === true || rows[i][2] === 'TRUE' };
    }
  }
  return { weeklyGoal: 0, public: false };
}

function actionSetGoal_(body) {
  var userId = String(body.userId || '');
  if (!userId) throw new Error('userId が空です');
  var weeklyGoal = Math.max(0, Math.min(9999, Math.floor(Number(body.weeklyGoal) || 0)));
  var isPublic = !!body.public;
  var sh = getSheet_(SHEET_GOALS);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId) {
      sh.getRange(i + 1, 2).setValue(weeklyGoal);
      sh.getRange(i + 1, 3).setValue(isPublic);
      sh.getRange(i + 1, 4).setValue(new Date().toISOString());
      return { goal: { weeklyGoal: weeklyGoal, public: isPublic } };
    }
  }
  sh.appendRow([userId, weeklyGoal, isPublic, new Date().toISOString()]);
  return { goal: { weeklyGoal: weeklyGoal, public: isPublic } };
}

// 今週(月曜〜今日)の本数。指定なし/ライブ問わず、打った本数はすべて対象(本数系は常に全記録を数える方針)
function weekAttemptsOf_(shots, userId) {
  var today = dateOf_(new Date());
  var monday = weekKeyOf_(today);
  var total = 0;
  shots.forEach(function (s) { if (s.userId === userId && s.date >= monday && s.date <= today) total += s.attempts; });
  return total;
}

// ===== 仲間のライセンス ============================================
// 誰でも誰の分でも閲覧できる(BeReal的に連続記録を見せ合う延長)。
// トロフィーは内容ではなく「数」だけ、称号・連続記録・累計本数によるレベルを表示する。

var LICENSE_LEVELS = [
  { tier: 'green',  min: 0 },
  { tier: 'blue',   min: 5000 },
  { tier: 'purple', min: 20000 },
  { tier: 'gold',   min: 50000 }
];
function computeLicenseLevel_(totalAttempts) {
  var cur = LICENSE_LEVELS[0], next = null;
  for (var i = 0; i < LICENSE_LEVELS.length; i++) {
    if (totalAttempts >= LICENSE_LEVELS[i].min) cur = LICENSE_LEVELS[i];
    else if (next === null) next = LICENSE_LEVELS[i];
  }
  return { tier: cur.tier, next: next ? next.min : null };
}

function totalCareerAttempts_(shots, userId) {
  var total = 0;
  shots.forEach(function (s) { if (s.userId === userId) total += s.attempts; });
  return total;
}
// 連続でなくても構わない、記録した日の延べ日数(通算プレー日数)
function totalPracticeDays_(shots, userId) {
  var days = {};
  shots.forEach(function (s) { if (s.userId === userId) days[s.date] = true; });
  return Object.keys(days).length;
}

// 連続記録の自己ベスト(現在進行形ではなく、過去の全期間で一番長かった連続日数)
function computeBestStreak_(shots, userId) {
  var daySet = {};
  shots.forEach(function (s) { if (s.userId === userId) daySet[s.date] = true; });
  var days = Object.keys(daySet).sort();
  var best = 0, cur = 0, prevDate = null;
  days.forEach(function (d) {
    if (prevDate) {
      var expected = new Date(prevDate + 'T00:00:00'); expected.setDate(expected.getDate() + 1);
      cur = (dateOf_(expected) === d) ? cur + 1 : 1;
    } else { cur = 1; }
    if (cur > best) best = cur;
    prevDate = d;
  });
  return best;
}

// 称号: 100本以上・スポットごとのしきい値以上を達成したスポットがあれば「(スポット名)のスペシャリスト」。
// フリースローは90%、スリーポイント(7スポット)は70%、それ以外は70%を基準にする。
// 確率系と同じくスポットシューティング(指定なし)のみで判定する。複数該当時は基準に対する余裕度が一番高いものを採用
function titleThresholdFor_(spotName) {
  if (spotName === 'フリースロー') return 90;
  return 70; // スリーポイント7スポット・その他共通
}
function computeTitle_(spots, shots, userId) {
  var bySpot = {};
  shots.forEach(function (s) {
    if (s.userId !== userId || s.situation) return;
    var b = bySpot[s.spotId] || (bySpot[s.spotId] = { makes: 0, attempts: 0 });
    b.makes += s.makes; b.attempts += s.attempts;
  });
  var spotName = {}; spots.forEach(function (sp) { spotName[sp.id] = sp.name; });
  var best = null;
  Object.keys(bySpot).forEach(function (spotId) {
    var b = bySpot[spotId];
    if (b.attempts < 100) return;
    var name = spotName[spotId] || '?';
    var need = titleThresholdFor_(name);
    var p = pct_(b.makes, b.attempts);
    if (p < need) return;
    var margin = p - need; // しきい値に対する余裕度が一番大きいものを採用
    if (!best || margin > best.margin) best = { name: name, pct: p, margin: margin };
  });
  return best ? (best.name + 'のスペシャリスト') : null;
}

// チーム全員分のライセンスを1回でまとめて返す(縦一列スクロールでの一覧表示用)。
// 現在の連続記録が長い順(自分も含めてフラットに並べる。同数なら累計本数が多い順)。
function actionGetAllLicenses_(body) {
  var requesterId = String(body.userId || '');
  if (!requesterId) throw new Error('userId が空です');

  var shots = getShots_();
  var spots = getSpots_(null, true); // 称号判定用に全員分のスポット名が要るため、共通+全員の個人スポット
  var memberMap = {};
  getKnownUsers_().forEach(function (m) { memberMap[m.userId] = m.name; });
  uniqueMembers_(shots).forEach(function (m) { memberMap[m.userId] = m.name; });
  if (!memberMap[requesterId]) memberMap[requesterId] = '自分';

  var ids = Object.keys(memberMap).filter(function (uid) { return uid.indexOf('proxy-') !== 0; });
  var list = ids.map(function (uid) {
    var trophies = getMyTrophies_(uid);
    var total = totalCareerAttempts_(shots, uid);
    var goal = getMyGoal_(uid);
    var item = {
      userId: uid, name: memberMap[uid],
      trophyCount: trophies.length, trophyTotal: TROPHY_DEFS.length,
      title: computeTitle_(spots, shots, uid),
      currentStreak: computeStreak_(shots, uid),
      bestStreak: computeBestStreak_(shots, uid),
      level: computeLicenseLevel_(total),
      totalAttempts: total,
      totalDays: totalPracticeDays_(shots, uid)
    };
    // 自分自身は常に見える。他人は公開設定のときだけ達成率を含める
    if (uid === requesterId || goal.public) {
      item.goal = { weeklyGoal: goal.weeklyGoal, weekAttempts: weekAttemptsOf_(shots, uid), public: goal.public };
    }
    return item;
  });
  list.sort(function (a, b) {
    if (b.currentStreak !== a.currentStreak) return b.currentStreak - a.currentStreak;
    return b.totalAttempts - a.totalAttempts; // 同数タイブレーク
  });
  return { licenses: list };
}

// ===== チーム共同ゴール(シュートフェス) ============================

// その月の「月末に収まる直近の月〜日」を自動計算する(手動で日付を書き換える必要をなくすため)。
// 月末日から直前の日曜まで遡り、そこから6日前を月曜とする。月をまたがないので、
// 月の途中でこの関数を呼んでも常にその月の最終週が返る。
function festDateRange_() {
  var todayStr = dateOf_(new Date());
  var y = Number(todayStr.slice(0, 4)), m = Number(todayStr.slice(5, 7));
  var lastDay = new Date(y, m, 0); // 翌月の0日目=今月の最終日(ローカル日付)
  var sunday = new Date(lastDay); sunday.setDate(sunday.getDate() - lastDay.getDay());
  var monday = new Date(sunday); monday.setDate(monday.getDate() - 6);
  return { monday: dateOf_(monday), sunday: dateOf_(sunday) };
}

// 対象週の合計本数。個人の週目標と同じ方針で、スポット・シチュエーションを問わず全記録を数える
// (上限は設けない。誰かの頑張りがそのまま無駄なく積み上がる設計にするため)。
// 日曜だけは「3段階目が未達のまま迎えた場合」倍率を掛けて底上げする。
function festTotals_(shots) {
  var range = festDateRange_();
  var total = 0;
  var byUser = {}; // 個人の貢献表示用
  var sundayRaw = 0;
  shots.forEach(function (s) {
    if (s.date < range.monday || s.date > range.sunday) return;
    total += s.attempts;
    byUser[s.userId] = (byUser[s.userId] || 0) + s.attempts;
    if (s.date === range.sunday) sundayRaw += s.attempts;
  });
  var tier3Value = FEST_TIERS[FEST_TIERS.length - 1];
  var reachedTier3BeforeMultiplier = total >= tier3Value;
  // 倍率は「日曜の時点で3段階目にまだ届いていない場合」のみ、日曜分の本数に適用する
  var displayTotal = total;
  var multiplierApplied = false;
  if (!reachedTier3BeforeMultiplier) {
    var todayStr = dateOf_(new Date());
    // 日曜以降(月曜になっても)、倍チャンス込みの結果を維持する。
    // 週が終わった後もアプリにフェスカードを残す運用があるため、月曜に生本数へ後退して
    // 「日曜に達成したはずなのに未達に見える」という矛盾が起きないようにする
    if (todayStr >= range.sunday) {
      displayTotal = (total - sundayRaw) + sundayRaw * FEST_SUNDAY_MULTIPLIER;
      multiplierApplied = sundayRaw > 0;
    }
  }
  return { range: range, rawTotal: total, displayTotal: displayTotal, multiplierApplied: multiplierApplied, byUser: byUser };
}

function festTierReached_(displayTotal) {
  var reached = 0;
  FEST_TIERS.forEach(function (t) { if (displayTotal >= t) reached++; });
  return reached; // 0〜3
}

function festExtraParticipants_() {
  var range = festDateRange_();
  var rows = getSheet_(SHEET_FEST_PARTICIPANTS).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === range.monday) out.push({ userId: String(rows[i][1]), name: String(rows[i][2]) });
  }
  return out;
}

// フェスの状態をまとめて返す(記録タブ・チームタブでの表示、日曜の分岐判定に使う)
function getFestStatus_(userId, shots) {
  if (!FEST_ENABLED) return { enabled: false };
  var range = festDateRange_();
  var todayStr = dateOf_(new Date());
  // 今月のフェス週(月末に収まる直近の月〜日)がまだ来ていない間はカード自体を出さない。
  // 週が終わった後は、月が変わってfestDateRange_の計算結果が来月分に切り替わるまで
  // (=todayStrがそちらのmondayより前になるまで)、この条件を満たし続けるので結果が表示され続ける
  if (todayStr < range.monday) return { enabled: false };
  var t = festTotals_(shots || getShots_());
  var tierReached = festTierReached_(t.displayTotal);
  var tier3Value = FEST_TIERS[FEST_TIERS.length - 1];
  var isSunday = todayStr === range.sunday;
  var isOver = todayStr > range.sunday;
  var mode = 'normal';
  var extra = null;
  if (isSunday && tierReached >= FEST_TIERS.length) {
    mode = 'extra';
    var participants = festExtraParticipants_();
    extra = {
      participants: participants.length,
      target: participants.length * FEST_EXTRA_PER_PERSON,
      joined: userId ? participants.some(function (p) { return p.userId === userId; }) : false
    };
  } else if (isSunday && t.multiplierApplied) {
    mode = 'double';
  }
  return {
    enabled: true, name: FEST_NAME, range: range, isSunday: isSunday, isOver: isOver,
    tiers: FEST_TIERS, tierReached: tierReached,
    rawTotal: t.rawTotal, displayTotal: t.displayTotal, multiplierApplied: t.multiplierApplied,
    myContribution: userId ? (t.byUser[userId] || 0) : 0,
    mode: mode, extra: extra
  };
}

function actionGetFestStatus_(body) {
  var userId = String(body.userId || '');
  return getFestStatus_(userId, getShots_());
}

function actionFestParticipate_(body) {
  var userId = String(body.userId || '');
  var displayName = String(body.displayName || '名無し').trim();
  if (!userId) throw new Error('userId が空です');
  var status = getFestStatus_(userId, getShots_());
  if (!status.enabled || status.mode !== 'extra') throw new Error('エクストラミッションは今は開催されていません');
  if (!status.extra.joined) {
    getSheet_(SHEET_FEST_PARTICIPANTS).appendRow([festDateRange_().monday, userId, displayName, new Date().toISOString()]);
  }
  return getFestStatus_(userId, getShots_());
}

// 記録保存直後に呼ぶ。今回の保存でチームの表示本数が段階を新たに超えたら、その段階番号(1〜3)を返す(超えていなければnull)。
// 3段階目を超えた瞬間だけLINE通知も送る(1・2段階目はアプリ内表示のみ、通数節約のため)。
function checkFestTierCrossing_(shotsBefore, shotsAfter) {
  if (!FEST_ENABLED) return null;
  var before = festTierReached_(festTotals_(shotsBefore).displayTotal);
  var after = festTierReached_(festTotals_(shotsAfter).displayTotal);
  if (after <= before) return null;
  if (after >= FEST_TIERS.length) {
    try {
      var status = getFestStatus_(null, shotsAfter);
      var memberMap = {};
      getKnownUsers_().forEach(function (m) { memberMap[m.userId] = m.name; });
      uniqueMembers_(shotsAfter).forEach(function (m) { memberMap[m.userId] = m.name; });
      var text = '🎉 ' + FEST_NAME + '、目標の' + FEST_TIERS[FEST_TIERS.length - 1] + '本を達成しました！\n'
        + '日曜日は特別なエクストラミッションが解禁されます。お楽しみに🔥';
      pushLineMessageBatch_(broadcastTargets_(memberMap, null), text);
    } catch (e) { /* 通知失敗でも保存処理は成功扱い */ }
  }
  return after; // 1, 2, 3
}

// ===== 集計ロジック(使い回し用) ==================================

// ---- ライブシューティング解放判定 ----
// そのスポットの「今月のスポットシューティング(シチュエーション指定なし)」で、
// 直近30本(記録単位で30本以上になる最小の末尾)の確率が50%以上になった瞬間に解放。
// 一度達成すればその月の間は解放が維持され、月が変わると再ロックされる。
// ever(過去に一度でも達成したことがあるか)は、初達成までUIに存在自体を見せない隠し要素判定に使う。
var LIVE_UNLOCK_ATTEMPTS = 30;
var LIVE_UNLOCK_RATE = 0.5;
// この日付より前の記録は解放判定に使わない。
// 機能公開前の過去データで達成済み扱いになると「初解放」の演出と隠し要素性が失われるため
// (2026-08-10以降の実データで誰も即解放されないことは確認済み)
var LIVE_FEATURE_START_DATE = '2026-08-10';

// 期間内の記録(時系列)を1件ずつ進めながら、その時点の直近30本が50%以上になった瞬間があったか
function liveCheckPeriod_(recs) {
  for (var i = 0; i < recs.length; i++) {
    var a = 0, m = 0;
    for (var j = i; j >= 0; j--) {
      a += recs[j].attempts; m += recs[j].makes;
      if (a >= LIVE_UNLOCK_ATTEMPTS) break;
    }
    if (a >= LIVE_UNLOCK_ATTEMPTS && m / a >= LIVE_UNLOCK_RATE) return true;
  }
  return false;
}

// spotId -> {unlocked, ever, periodAttempts, windowMakes, windowAttempts, windowPct}
// spots: ライブ解放の対象をスリーポイント7スポット(共通スコープのみ)に絞るために必要
function computeLiveStatus_(shots, userId, spots) {
  var liveEligibleIds = {};
  (spots || []).forEach(function (sp) {
    if (sp.scope !== 'personal' && THREE_POINT_NAMES.indexOf(sp.name) !== -1) liveEligibleIds[sp.id] = true;
  });
  var thisMonth = currentYm_();
  var bySpotMonth = {};
  shots.forEach(function (s) {
    if (s.userId !== userId) return;
    if (s.situation) return; // 解放判定はスポットシューティング(指定なし)のみで数える
    if (!liveEligibleIds[s.spotId]) return; // ライブシューティングはスリーポイント7スポットのみが対象
    if (s.date < LIVE_FEATURE_START_DATE) return; // 機能公開前の記録は判定対象外
    var spotMap = bySpotMonth[s.spotId] || (bySpotMonth[s.spotId] = {});
    (spotMap[s.ym] || (spotMap[s.ym] = [])).push(s);
  });
  var out = {};
  Object.keys(bySpotMonth).forEach(function (spotId) {
    var months = bySpotMonth[spotId];
    var ever = false, unlocked = false, periodAttempts = 0, windowMakes = 0, windowAttempts = 0;
    Object.keys(months).forEach(function (ym) {
      var recs = months[ym];
      recs.sort(function (a, b) { return a.ts < b.ts ? -1 : 1; }); // 記録した順
      var hit = liveCheckPeriod_(recs);
      if (hit) ever = true;
      if (ym === thisMonth) {
        unlocked = hit;
        recs.forEach(function (r) { periodAttempts += r.attempts; });
        var a = 0, m = 0;
        for (var j = recs.length - 1; j >= 0; j--) {
          a += recs[j].attempts; m += recs[j].makes;
          if (a >= LIVE_UNLOCK_ATTEMPTS) break;
        }
        windowAttempts = a; windowMakes = m;
      }
    });
    out[spotId] = {
      unlocked: unlocked, ever: ever, periodAttempts: periodAttempts,
      windowMakes: windowMakes, windowAttempts: windowAttempts,
      windowPct: pct_(windowMakes, windowAttempts)
    };
  });
  return out;
}

// そのスポットのライブシューティングを「そのユーザーが生まれて初めて」解放した瞬間に、
// ホスト以外の全員へ通知する(スポット名は伏せない。トロフィーと違い、これは早いもの勝ちの要素ではないため)。
// ホスト自身の解放は検証や代理記録の動作確認で頻発しがちなためノイズになるので通知しない。
function notifyNewLiveUnlocks_(userId, displayName, shotsBefore, shotsAfter, spots) {
  if (userId === HOST_USER_ID) return;
  if (NOTIFY_LIVE_UNLOCK_PAUSED) return; // フェス期間中は通数節約のためいったん停止
  try {
    var before = computeLiveStatus_(shotsBefore, userId, spots);
    var after = computeLiveStatus_(shotsAfter, userId, spots);
    var spotName = {}; spots.forEach(function (sp) { spotName[sp.id] = sp.name; });
    var newSpotNames = [];
    Object.keys(after).forEach(function (spotId) {
      var wasEver = !!(before[spotId] && before[spotId].ever);
      if (after[spotId].ever && !wasEver) newSpotNames.push(spotName[spotId] || '?');
    });
    if (!newSpotNames.length) return;
    var memberMap = {};
    getKnownUsers_().forEach(function (m) { memberMap[m.userId] = m.name; });
    uniqueMembers_(shotsAfter).forEach(function (m) { memberMap[m.userId] = m.name; });
    var text = '🔥 ' + displayName + 'さんが「' + newSpotNames.join('・') + '」のライブシューティングを解放しました！';
    pushLineMessageBatch_(broadcastTargets_(memberMap, userId), text);
  } catch (e) { /* 通知失敗でも保存処理は成功扱い */ }
}

function computeMyStats_(spots, shots, userId, granularity, period) {
  // granularity: 'month'(既定) | 'week' | 'day'。period が空/nullなら全期間。
  // week指定時は period(任意の日付)が属する週の月曜日キーに正規化して比較する。
  var targetKey = null;
  if (period) {
    targetKey = granularity === 'week' ? weekKeyOf_(period) : period;
  }
  var bySpot = {};
  var bySituation = {};
  var bySitSpot = {}; // シチュエーション -> スポットID -> {makes,attempts}(シチュエーション別カードのスポット内訳用)
  var perSpotSit = {}; // マイスポットのカスタムシチュエーション用: スポットID -> シチュエーション名 -> {makes,attempts}
  var scopeOfSpot = {}; spots.forEach(function (sp) { scopeOfSpot[sp.id] = sp.scope; });
  var hasLive = false; // 期間に関係なく、ライブ記録を一度でも持っているか(推移タブのライブ切替の表示判定用)
  shots.forEach(function (s) {
    if (userId && s.userId !== userId) return; // userId空文字はチーム合算(全員分を含める)
    // マイスポットのカスタムシチュエーション記録: ライブ(共通3PTの実戦形式)ではないので
    // シチュエーション別カードには混ぜず、スポット自体の合計とスポット内の内訳に数える。
    // spotsに無いスポットのシチュエーション記録(チーム合算時の他人のマイスポット等)もライブ扱いしない
    var spotScope = scopeOfSpot[s.spotId];
    var isPersonalSit = !!s.situation && (!spotScope || spotScope === 'personal');
    if (s.situation && !isPersonalSit) hasLive = true; // ライブ記録の有無は期間フィルタに関係なく判定する
    if (targetKey) {
      var key = granularity === 'day' ? s.date : granularity === 'week' ? weekKeyOf_(s.date) : s.ym;
      if (key !== targetKey) return;
    }
    if (isPersonalSit) {
      var pb = bySpot[s.spotId] || (bySpot[s.spotId] = { makes: 0, attempts: 0 });
      pb.makes += s.makes; pb.attempts += s.attempts;
      var psMap = perSpotSit[s.spotId] || (perSpotSit[s.spotId] = {});
      var psb = psMap[s.situation] || (psMap[s.situation] = { makes: 0, attempts: 0 });
      psb.makes += s.makes; psb.attempts += s.attempts;
      return;
    }
    var sitKey = s.situation || '';
    var sb = bySituation[sitKey] || (bySituation[sitKey] = { makes: 0, attempts: 0 });
    sb.makes += s.makes; sb.attempts += s.attempts;
    // スポット別・合計の確率はスポットシューティング(指定なし)のみで計算する。
    // ライブ分は上のシチュエーション別内訳と、シチュエーション×スポットの内訳にだけ入る(難易度が違う確率を混ぜない)
    if (s.situation) {
      var ssMap = bySitSpot[sitKey] || (bySitSpot[sitKey] = {});
      var ssb = ssMap[s.spotId] || (ssMap[s.spotId] = { makes: 0, attempts: 0 });
      ssb.makes += s.makes; ssb.attempts += s.attempts;
      return;
    }
    var b = bySpot[s.spotId] || (bySpot[s.spotId] = { makes: 0, attempts: 0 });
    b.makes += s.makes; b.attempts += s.attempts;
  });
  var liveMap = computeLiveStatus_(shots, userId, spots);
  var noLive = { unlocked: false, ever: false, periodAttempts: 0, windowMakes: 0, windowAttempts: 0, windowPct: 0 };
  var stats = spots.map(function (sp) {
    var b = bySpot[sp.id] || { makes: 0, attempts: 0 };
    // マイスポットはシチュエーションごとの内訳も付ける。ボタン設定の並び順を優先し、
    // ボタンから外した後も記録が残っているシチュエーションは末尾に足す(数字が見えなくならないように)
    var sitStats = null;
    if (sp.scope === 'personal') {
      var rec = perSpotSit[sp.id] || {};
      var names = (sp.situations || []).slice();
      Object.keys(rec).forEach(function (n) { if (names.indexOf(n) === -1) names.push(n); });
      if (names.length) {
        sitStats = names.map(function (n) {
          var v = rec[n] || { makes: 0, attempts: 0 };
          return { name: n, makes: v.makes, attempts: v.attempts, pct: pct_(v.makes, v.attempts) };
        });
      }
    }
    return { spotId: sp.id, name: sp.name, scope: sp.scope, makes: b.makes, attempts: b.attempts, pct: pct_(b.makes, b.attempts), live: liveMap[sp.id] || noLive, situations: sitStats };
  });
  var tot = stats.reduce(function (a, s) { a.makes += s.makes; a.attempts += s.attempts; return a; }, { makes: 0, attempts: 0 });
  // シチュエーション別の内訳(記録に使われたものだけ返す)。固定の並び順→その他(カスタム等)の順
  var sitOrder = ['', 'HO', 'チェック', 'ミート', 'ドリブル'];
  var threePointSpotsForLive = spots.filter(function (sp) { return sp.scope !== 'personal' && THREE_POINT_NAMES.indexOf(sp.name) !== -1; });
  var situations = Object.keys(bySituation)
    .sort(function (a, b2) {
      var ia = sitOrder.indexOf(a), ib = sitOrder.indexOf(b2);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map(function (k) {
      var v = bySituation[k];
      // 「指定なし」(通常のスポットシューティング)はスポット別一覧が別途あるので、ここでは重複させない
      var bySpotOut = k ? threePointSpotsForLive.map(function (sp) {
        var b = (bySitSpot[k] && bySitSpot[k][sp.id]) || { makes: 0, attempts: 0 };
        return { spotId: sp.id, name: sp.name, makes: b.makes, attempts: b.attempts, pct: pct_(b.makes, b.attempts) };
      }) : null;
      return { key: k, name: k || '指定なし', makes: v.makes, attempts: v.attempts, pct: pct_(v.makes, v.attempts), bySpot: bySpotOut };
    });
  return {
    granularity: granularity, period: period, spots: stats, situations: situations, hasLiveRecords: hasLive,
    weekAttempts: weekAttemptsOf_(shots, userId), // 週目標メーター用。期間フィルタに関係なく常に「今週」の実数
    total: { makes: tot.makes, attempts: tot.attempts, pct: pct_(tot.makes, tot.attempts) }
  };
}

function computeHistory_(spots, shots, userId, limit) {
  var spotName = {}; spots.forEach(function (s) { spotName[s.id] = s.name; });
  var mine = shots.filter(function (s) { return s.userId === userId; });
  mine.sort(function (a, b) { return a.ts < b.ts ? 1 : -1; }); // 新しい順
  return mine.slice(0, limit).map(function (s) {
    return { id: s.id, date: s.date, ym: s.ym, spotId: s.spotId, spot: spotName[s.spotId] || '(削除済)', makes: s.makes, attempts: s.attempts, pct: pct_(s.makes, s.attempts), situation: s.situation || '' };
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
    out.push({ id: String(r[0]), name: String(r[1]), x: Number(r[2]), y: Number(r[3]), order: Number(r[4]), scope: scope, ownerId: ownerId,
      situations: sanitizeSituations_(r[9]) }); // マイスポットのカスタムシチュエーションボタン(無ければ空配列)
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

// liveBySit(シチュエーション×スポットの内訳)から、表示用の完成形を組み立てる。
// 「全体」の確率(後方互換・ライブ全体カード用)と、シチュエーションごとのスポット別内訳の両方を返す。
function liveSummaryOf_(liveBySit, allSpots) {
  var threePointSpots = allSpots.filter(function (sp) { return sp.scope !== 'personal' && THREE_POINT_NAMES.indexOf(sp.name) !== -1; });
  var totalM = 0, totalA = 0;
  var bySituation = Object.keys(liveBySit || {}).map(function (sit) {
    var s = liveBySit[sit];
    totalM += s.makes; totalA += s.attempts;
    var bySpot = threePointSpots.map(function (sp) {
      var b = s.bySpot[sp.id] || { makes: 0, attempts: 0 };
      return { spotId: sp.id, name: sp.name, makes: b.makes, attempts: b.attempts, pct: pct_(b.makes, b.attempts) };
    });
    return { situation: sit, makes: s.makes, attempts: s.attempts, pct: pct_(s.makes, s.attempts), bySpot: bySpot };
  }).sort(function (a, b) { return b.attempts - a.attempts; });
  return { makes: totalM, attempts: totalA, pct: pct_(totalM, totalA), bySituation: bySituation };
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
    var u = byUser[s.userId] || (byUser[s.userId] = { userId: s.userId, name: s.displayName, spots: {}, tm: 0, ta: 0, taAll: 0, liveBySit: {} });
    u.name = s.displayName || u.name; // 最新表示名で上書き
    u.taAll += s.attempts; // 本数ランキング用: 個人スポット分もライブ分もすべて合算する(打った本数は打った本数)
    // スポットの確率集計はスポットシューティング(シチュエーション指定なし)のみ。
    // ライブは難易度が高く、混ぜると確率が下がって「確率を守るためにライブを打たない」動機になってしまうため、
    // スポットとは混ぜずライブ専用の確率として別枠で集計する。
    // シチュエーション×スポットで内訳を持たせ、ランキング(シチュエーション単位)と
    // 個人の内訳表示(スポット単位)の両方をこの1回の集計から作れるようにする。
    // ただしマイスポットのカスタムシチュエーション記録は「本人専用の練習バリエーション」であり
    // ライブ(共通3PTの実戦形式)ではないので、liveには入れずスポット自体の合計に数える
    if (s.situation && scopeOf[s.spotId] !== 'personal') {
      var sitMap = u.liveBySit[s.situation] || (u.liveBySit[s.situation] = { makes: 0, attempts: 0, bySpot: {} });
      sitMap.makes += s.makes; sitMap.attempts += s.attempts;
      var spotBucket = sitMap.bySpot[s.spotId] || (sitMap.bySpot[s.spotId] = { makes: 0, attempts: 0 });
      spotBucket.makes += s.makes; spotBucket.attempts += s.attempts;
      return;
    }
    var b = u.spots[s.spotId] || (u.spots[s.spotId] = { makes: 0, attempts: 0 });
    b.makes += s.makes; b.attempts += s.attempts;
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
      threePoint: { makes: tpm, attempts: tpa, pct: pct_(tpm, tpa) },
      live: liveSummaryOf_(u.liveBySit, allSpots)
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
      makes: Number(r[7]) || 0, attempts: Number(r[8]) || 0,
      // situation列(10列目)は後から追加されたため、古い行には存在しない('' = 指定なし)
      situation: r[9] != null ? String(r[9]) : ''
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
      sh.appendRow(['id', 'name', 'x', 'y', 'order', 'active', 'createdAt', 'scope', 'ownerId', 'situations']);
      DEFAULT_SPOTS.forEach(function (s, idx) {
        sh.appendRow([Utilities.getUuid(), s.name, s.x, s.y, idx, true, new Date().toISOString(), 'shared', '', '']);
      });
    } else if (name === SHEET_SHOTS) {
      sh.appendRow(['id', 'timestamp', 'ym', 'date', 'userId', 'displayName', 'spotId', 'makes', 'attempts', 'situation']);
    } else if (name === 'KnownUsers') {
      sh.appendRow(['userId', 'displayName', 'firstSeenAt']);
    } else if (name === SHEET_TROPHIES) {
      sh.appendRow(['userId', 'trophyId', 'earnedAt', 'displayName']);
    } else if (name === SHEET_GOALS) {
      sh.appendRow(['userId', 'weeklyGoal', 'public', 'updatedAt']);
    } else if (name === SHEET_FEST_PARTICIPANTS) {
      sh.appendRow(['weekKey', 'userId', 'displayName', 'joinedAt']);
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

// LINE Webhook: グループIDの記録に加えて、botに何かメッセージを送ったことがある人を
// 「KnownUsers」シートに記録する(アプリを一度も使っていなくても週間報告を送れるようにするため)。
function handleLineWebhook_(body) {
  try {
    (body.events || []).forEach(function (ev) {
      var src = ev.source || {};
      if (src.type === 'group' && src.groupId) {
        PropertiesService.getScriptProperties().setProperty('LINE_GROUP_ID', src.groupId);
      }
      if (src.userId) registerKnownUser_(src.userId);
    });
  } catch (err) { /* Webhookは常に200を返す */ }
  return json_({ ok: true });
}

// 送信対象として新しいuserIdを記録する(初回だけLINEのプロフィールAPIで表示名を取得する)
function registerKnownUser_(userId) {
  var sh = getSheet_('KnownUsers');
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === userId) return; // 登録済み
  }
  sh.appendRow([userId, fetchLineDisplayName_(userId) || '(名前未取得)', new Date().toISOString()]);
}

function fetchLineDisplayName_(userId) {
  var token = getLineToken_();
  if (!token) return null;
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + userId, {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText()).displayName || null;
  } catch (e) { return null; }
}

// botにメッセージを送ったことがある人の一覧(アプリを使ったことがない人を含む)
function getKnownUsers_() {
  var sh = getSheet_('KnownUsers');
  var rows = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    out.push({ userId: String(rows[i][0]), name: String(rows[i][1]) });
  }
  return out;
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

// その月が今月かどうかに関わらず、指定した日付がその月の最終日かどうかを判定する。
// festDateRange_の「今月の最終日を求める」計算と同じ考え方(翌月の0日目=今月の最終日)を使い回す
function isLastDayOfMonth_(dateStr) {
  var y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
  var lastDay = new Date(y, m, 0);
  return dateStr === dateOf_(lastDay);
}

function computeMonthlyRanking_(shots, ym) {
  var byUser = {};
  var teamTotal = 0;
  shots.forEach(function (s) {
    if (s.ym !== ym) return;
    var u = byUser[s.userId] || (byUser[s.userId] = { name: s.displayName, attempts: 0 });
    u.name = s.displayName || u.name;
    u.attempts += s.attempts;
    teamTotal += s.attempts;
  });
  var ranked = Object.keys(byUser).map(function (uid) { return { userId: uid, name: byUser[uid].name, attempts: byUser[uid].attempts }; })
    .sort(function (a, b) { return b.attempts - a.attempts; });
  return { ym: ym, ranked: ranked, teamTotal: teamTotal };
}

/** 毎日21:50頃のトリガーから呼ぶ想定。月末以外は何もしない(自己ガード)。
 * 週間DM(日曜21:45)と5分ずらしてあるので、月末が日曜と重なっても連続で2通届くだけで同時にはならない
 */
 * 月末の日に、その月の本数ランキング(5位まで)を個別メッセージで送る。
 * 「毎月◯日」トリガーは月によって最終日がずれるため使えず、毎日チェックする方式にしている。
 */
function sendMonthlyRankingPost() {
  var todayStr = dateOf_(new Date());
  if (!isLastDayOfMonth_(todayStr)) return;
  var ym = todayStr.slice(0, 7);
  var shots = getShots_();
  var r = computeMonthlyRanking_(shots, ym);

  var medals = ['🥇', '🥈', '🥉', '4位', '5位'];
  var lines = ['📅 ' + ym + ' の月間シュート本数ランキング'];
  if (r.ranked.length) {
    r.ranked.slice(0, 5).forEach(function (u, i) { lines.push(medals[i] + ' ' + u.name + ' ' + u.attempts + '本'); });
    lines.push('');
    lines.push('チーム合計: ' + r.teamTotal + '本');
  } else {
    lines.push('今月はまだ誰も記録していません');
  }
  var rankingText = lines.join('\n');

  var attemptsByUser = {};
  r.ranked.forEach(function (u) { attemptsByUser[u.userId] = u.attempts; });
  var memberMap = {};
  getKnownUsers_().forEach(function (m) { memberMap[m.userId] = m.name; });
  uniqueMembers_(shots).forEach(function (m) { memberMap[m.userId] = m.name; });
  var allMembers = broadcastTargets_(memberMap, null).map(function (uid) { return { userId: uid, name: memberMap[uid] }; });
  var failed = [];
  allMembers.forEach(function (m) {
    // 0本の人には個人本数に触れない(weeklyMvpPostと同じ方針。送る目的はトーク履歴を上げること)
    var myAttempts = attemptsByUser[m.userId] || 0;
    var personal = myAttempts > 0 ? 'あなたは今月 ' + myAttempts + '本 シュートを打ちました！\n' : '';
    var text = rankingText + '\n\n' + personal + '今月もお疲れさまでした！🏀';
    if (!pushLineMessageTo_(m.userId, text)) failed.push(m.name);
  });
  if (failed.length) Logger.log('送信できなかった人(未フォロー等): ' + failed.join(', '));
  Logger.log(ym + 'の月間ランキングを' + allMembers.length + '人に送信しました');
}

/** 手動実行用: 毎日21:50頃にチェックし、月末の日だけ月間ランキングを自動送信するトリガーを設定する(一度だけ実行) */
function setupMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendMonthlyRankingPost') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendMonthlyRankingPost').timeBased().everyDays(1).atHour(21).nearMinute(50).create();
  Logger.log('毎日21:50頃にチェックし、月末だけ月間ランキングを自動送信するトリガーを設定しました');
}

/** 手動実行用: フェス開始の告知を送る。準備ができたタイミングで1回だけ実行する */
function sendFestKickoff() {
  var shots = getShots_();
  var memberMap = {};
  getKnownUsers_().forEach(function (m) { memberMap[m.userId] = m.name; });
  uniqueMembers_(shots).forEach(function (m) { memberMap[m.userId] = m.name; });
  var range = festDateRange_();
  var text = '🎉 ' + FEST_NAME + ' 開催中！(' + range.monday + '〜' + range.sunday + ')\n\n'
    + 'チームみんなのシュート本数を合計して、目標達成を目指します🏀\n'
    + '🥉1段階目 ' + FEST_TIERS[0] + '本\n'
    + '🥈2段階目 ' + FEST_TIERS[1] + '本\n'
    + '🥇3段階目 ' + FEST_TIERS[2] + '本\n\n'
    + 'アプリを開けば今の進み具合が見られます。みんなでシュートしまくろう🔥';
  var targets = broadcastTargets_(memberMap, null);
  var failed = [];
  targets.forEach(function (uid) { if (!pushLineMessageTo_(uid, text)) failed.push(memberMap[uid]); });
  if (failed.length) Logger.log('送信できなかった人(未フォロー等): ' + failed.join(', '));
  Logger.log(FEST_NAME + '告知を' + targets.length + '人に送信しました');
}

/** 手動実行用: 週次トリガー未設定のため日曜に自動送信されなかった週(先週=直近のフェス週)の
 * フェス最終結果+本数ランキングをまとめて送る。1回だけ実行する。
 * weeklyMvpPost()は「今日が属する週」で集計するため月曜以降に実行すると空のランキングになってしまうので使わない。
 * festDateRange_()はまだ月が変わっていない間は直近のフェス週を指すので、そこから対象週を取る。
 */
function sendFestWeekReportManual() {
  var shots = getShots_();
  var range = festDateRange_();
  var byUser = {};
  var teamTotal = 0;
  shots.forEach(function (s) {
    if (s.date < range.monday || s.date > range.sunday) return;
    var u = byUser[s.userId] || (byUser[s.userId] = { name: s.displayName, attempts: 0 });
    u.name = s.displayName || u.name;
    u.attempts += s.attempts;
    teamTotal += s.attempts;
  });
  var ranked = Object.keys(byUser).map(function (uid) { return { userId: uid, name: byUser[uid].name, attempts: byUser[uid].attempts }; })
    .sort(function (a, b) { return b.attempts - a.attempts; });

  var medals = ['🥇', '🥈', '🥉'];
  var lines = ['📣 先週(' + range.monday + '〜' + range.sunday + ')のシュート本数ランキング'];
  if (ranked.length) {
    ranked.slice(0, 3).forEach(function (u, i) { lines.push(medals[i] + ' ' + u.name + ' ' + u.attempts + '本'); });
    lines.push('');
    lines.push('チーム合計: ' + teamTotal + '本');
  } else {
    lines.push('先週は記録がありませんでした');
  }

  // festFinalMessageBlock_は「今日が対象週の日曜」の時しか結果を返さない(月曜には使えない)ため、
  // 同じ文面をgetFestStatus_の値から組み立てる
  var status = getFestStatus_(null, shots);
  lines.push('');
  lines.push('🎉 ' + FEST_NAME + ' 最終結果');
  lines.push('合計: ' + status.displayTotal + '本(' + status.tierReached + '/' + FEST_TIERS.length + '段階達成)');
  if (status.tierReached >= FEST_TIERS.length) {
    lines.push('全段階達成、お疲れさまでした🏆');
  } else if (festIsRecordWeek_(shots, status.displayTotal)) {
    lines.push('目標には届きませんでしたが、このチーム合計はこれまでで一番の記録です！お疲れさまでした🎉');
  } else {
    lines.push('お疲れさまでした！');
  }
  var rankingText = lines.join('\n');

  var attemptsByUser = {};
  ranked.forEach(function (u) { attemptsByUser[u.userId] = u.attempts; });
  var memberMap = {};
  getKnownUsers_().forEach(function (m) { memberMap[m.userId] = m.name; });
  uniqueMembers_(shots).forEach(function (m) { memberMap[m.userId] = m.name; });
  var allMembers = broadcastTargets_(memberMap, null).map(function (uid) { return { userId: uid, name: memberMap[uid] }; });
  var failed = [];
  allMembers.forEach(function (m) {
    var myAttempts = attemptsByUser[m.userId] || 0;
    var personal = myAttempts > 0 ? 'あなたは先週 ' + myAttempts + '本 シュートを打ちました！\n' : '';
    var text = rankingText + '\n\n' + personal + '先週もお疲れさまでした！🏀';
    if (!pushLineMessageTo_(m.userId, text)) failed.push(m.name);
  });
  if (failed.length) Logger.log('送信できなかった人(未フォロー等): ' + failed.join(', '));
  Logger.log('先週のフェス結果+ランキングを' + allMembers.length + '人に送信しました');
}

// 今週(月曜〜今日)のシュート本数ランキングを、メンバー1人ずつに個別メッセージで送る。
// (グループ投稿ではなく個別チャットに送ることで、各自のトーク履歴の上位に来るようにする)
// 確率は含めない(本数だけなら誰でも上位を狙える)。今週の記録がなければ何もしない。
// 注意: LINEの仕様上、botを「友だち追加」していない人には個別メッセージは届かない。
// 今週(月曜〜今日)のユーザーごとの本数を集計する(投稿・閲覧の両方から使う共通ロジック)
function computeWeeklyRanking_(shots) {
  var today = dateOf_(new Date());
  var monday = weekKeyOf_(today);
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
  var r = computeWeeklyRanking_(getShots_());
  return { weekStart: r.weekStart, today: r.today, teamTotal: r.teamTotal, ranked: r.ranked };
}

// フェス最終日(日曜)の場合のみ、週間ランキングDMに結果を統合するための文面ブロックを作る。
// 通数節約のため専用の配信は行わず、既存の週間DMに載せる形にする。
// この週の合計(displayTotal)が、過去の全週(この週自身を除く)の実績を上回っているか。
// 目標未達でも「チーム合計は過去最高だった」と胸を張って言えるかどうかの判定に使う。
function festIsRecordWeek_(shots, thisWeekTotal) {
  var range = festDateRange_();
  var byWeek = {};
  shots.forEach(function (s) {
    var wk = weekKeyOf_(s.date);
    if (wk === range.monday) return; // 今週自身は比較対象から除く
    byWeek[wk] = (byWeek[wk] || 0) + s.attempts;
  });
  var maxPrior = 0;
  Object.keys(byWeek).forEach(function (wk) { if (byWeek[wk] > maxPrior) maxPrior = byWeek[wk]; });
  return thisWeekTotal > maxPrior;
}

function festFinalMessageBlock_(shots) {
  if (!FEST_ENABLED) return null;
  var range = festDateRange_();
  if (dateOf_(new Date()) !== range.sunday) return null;
  var status = getFestStatus_(null, shots);
  var lines = ['', '🎉 ' + FEST_NAME + ' 最終結果', '合計: ' + status.displayTotal + '本(' + status.tierReached + '/' + FEST_TIERS.length + '段階達成)'];
  if (status.tierReached >= FEST_TIERS.length) {
    // 2倍デーの後押しで届いた場合も、仕組みの説明はせず素直に祝う
    lines.push('全段階達成、お疲れさまでした🏆');
    var participants = festExtraParticipants_();
    if (participants.length) {
      var target = participants.length * FEST_EXTRA_PER_PERSON;
      lines.push('エクストラミッション: ' + participants.length + '人参加(目標' + target + '本)');
    }
  } else if (festIsRecordWeek_(shots, status.displayTotal)) {
    lines.push('目標には届きませんでしたが、このチーム合計はこれまでで一番の記録です！お疲れさまでした🎉');
  } else {
    lines.push('お疲れさまでした！');
  }
  return lines.join('\n');
}

function weeklyMvpPost() {
  var shots = getShots_();
  var r = computeWeeklyRanking_(shots);
  var ranked = r.ranked; // 今週シュートがあった人のみ
  var teamTotal = r.teamTotal;

  var medals = ['🥇', '🥈', '🥉'];
  var rankingLines = ['📣 今週のシュート本数ランキング'];
  if (ranked.length) {
    ranked.slice(0, 3).forEach(function (u, i) { rankingLines.push(medals[i] + ' ' + u.name + ' ' + u.attempts + '本'); });
    rankingLines.push('');
    rankingLines.push('チーム合計: ' + teamTotal + '本');
  } else {
    rankingLines.push('今週はまだ誰も記録していません');
  }
  var festBlock = festFinalMessageBlock_(shots);
  if (festBlock) rankingLines.push(festBlock);
  var rankingText = rankingLines.join('\n');
  var attemptsByUser = {};
  ranked.forEach(function (u) { attemptsByUser[u.userId] = u.attempts; });

  // 送信先 = 「記録したことがある人」+「botにメッセージを送ったことがある人」の合算(重複はuserIdで排除)。
  // アプリを一度も開いていなくても、botに一言でも送ったことがあれば対象に含められる。
  // (「友だち追加しただけで一度も何もしていない人」はLINEの仕様上どうしても特定できない)
  // 目的はトーク履歴を上げてアプリの存在を思い出してもらうことなので、0本の人こそ送る意味がある。
  // ただし0本の人への文面は責める内容にせず、軽く誘うだけに留める(順位も入れない)。
  var memberMap = {};
  getKnownUsers_().forEach(function (m) { memberMap[m.userId] = m.name; });
  uniqueMembers_(shots).forEach(function (m) { memberMap[m.userId] = m.name; }); // アプリの表示名の方が新しい可能性が高いので優先
  var allMembers = broadcastTargets_(memberMap, null).map(function (uid) { return { userId: uid, name: memberMap[uid] }; });
  var failed = [];
  allMembers.forEach(function (m) {
    // 0本の人には個人本数に触れない(送る目的はトーク履歴を上げることなので、それ以外は言及しない)
    var myAttempts = attemptsByUser[m.userId] || 0;
    var personal = myAttempts > 0 ? 'あなたは今週 ' + myAttempts + '本 シュートを打ちました！\n' : '';
    var text = rankingText + '\n\n' + personal + '今週もお疲れさまでした！🏀';
    if (!pushLineMessageTo_(m.userId, text)) failed.push(m.name);
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

// 複数人へ同じ文面を一括送信する。1人ずつ直列に送ると人数×0.3〜0.5秒かかり、
// 記録保存のレスポンス(=解放演出の表示)がその分遅れてしまうため、fetchAllで並列に送る
function pushLineMessageBatch_(userIds, text) {
  var token = getLineToken_();
  if (!token) { Logger.log('LINE_TOKEN未設定のため送信しません'); return; }
  if (!userIds.length) return;
  var reqs = userIds.map(function (uid) {
    return {
      url: 'https://api.line.me/v2/bot/message/push',
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: uid, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true
    };
  });
  var results = UrlFetchApp.fetchAll(reqs);
  results.forEach(function (res, i) {
    if (res.getResponseCode() !== 200) Logger.log('送信失敗(' + userIds[i] + '): ' + res.getContentText());
  });
}
