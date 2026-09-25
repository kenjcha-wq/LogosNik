/* ============================================================
 * NikSync —— 双云同步版（Gitee + Supabase）
 * ------------------------------------------------------------
 * 保留完整的 Gitee 同步功能 + 新增 Supabase 云存储备份
 * 数据三保险：本地 localStorage + Gitee 仓库 + Supabase 数据库
 * ============================================================ */
/* ============================================================
 * 设备码设置模块 —— 放到 sync.js 最顶部
 * 首次使用弹窗设置，永久保存不可修改
 * ============================================================ */
(function() {
  let deviceId = localStorage.getItem('niksync_device_id');
  
  if (!deviceId) {
    const input = prompt(
      '🔑 首次使用设置\n\n' +
      '请输入你的设备码（用于识别你的数据）：\n' +
      '• 自己用：随便输一个，如 "mypc"\n' +
      '• 多设备共享：所有设备输入同一个码\n' +
      '• 注意：设置后不可修改！\n\n' +
      '⚠️ 不要告诉别人你的设备码！',
      'user-' + Math.random().toString(36).slice(2, 6)
    );
    
    if (input === null) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      deviceId = result;
      alert('⚠️ 已生成随机设备码：' + deviceId + '\n请记下这个码！');
    } else {
      deviceId = input.trim() || 'user-' + Math.random().toString(36).slice(2, 6);
    }
    
    localStorage.setItem('niksync_device_id', deviceId);
    alert('✅ 设备码已设置为：' + deviceId + '\n\n此码已保存，不可修改。');
  }
  
  // 在页面右下角显示设备码
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:8px;right:12px;font-size:9px;color:#8a8a8a;font-family:monospace;z-index:9999;background:rgba(0,0,0,0.6);color:#aaa;padding:3px 10px;border-radius:10px;opacity:0.5;pointer-events:none;';
  el.textContent = '🔑 ' + deviceId;
  document.body.appendChild(el);
  
  console.log('🔑 [NikSync] 设备码:', deviceId);
})();
(function (global) {
  'use strict';

  /* ========== 1. Supabase 配置（新增） ========== */
  const SUPABASE_URL = 'https://wxftncusytrdkrogqgjw.supabase.co'
  const SUPABASE_ANON_KEY = 'sb_publishable_Qy8NgPrDETVbTJJuRh-ZYg_rHRlqZTD'

  const supabase = {
    url: SUPABASE_URL,
    key: SUPABASE_ANON_KEY,

    async get(key) {
      try {
        const res = await fetch(`${this.url}/rest/v1/user_data?data_key=eq.${key}&select=data_value`, {
          headers: {
            'apikey': this.key,
            'Authorization': `Bearer ${this.key}`
          }
        })
        if (!res.ok) return null
        const data = await res.json()
        return data?.[0]?.data_value || null
      } catch (e) {
        console.warn('[Supabase] 读取失败:', e)
        return null
      }
    },

    async set(key, value) {
      try {
        // 先查后写：同一 data_key 已存在则 PATCH 更新，否则 POST 新建。
        // 原来一律用 POST + Prefer: resolution=merge-duplicates，
        // 但该表 data_key 的唯一约束不是主键，PostgREST 无法 upsert，
        // 实测首写 201、之后每次 409 且数据不更新 —— 备份实际只生效过一次。
        const k = encodeURIComponent(key);
        const exists = await this.get(key);
        const res = await fetch(
          exists !== null
            ? `${this.url}/rest/v1/user_data?data_key=eq.${k}`
            : `${this.url}/rest/v1/user_data`,
          {
            method: exists !== null ? 'PATCH' : 'POST',
            headers: {
              'apikey': this.key,
              'Authorization': `Bearer ${this.key}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(exists !== null
              ? { data_value: value, updated_at: new Date().toISOString() }
              : { data_key: key, data_value: value, updated_at: new Date().toISOString() })
          }
        );
        if (!res.ok && exists === null) {
          // 极小概率：并发下 get 没查到但已存在，退回 PATCH 再试一次
          const retry = await fetch(`${this.url}/rest/v1/user_data?data_key=eq.${k}`, {
            method: 'PATCH',
            headers: {
              'apikey': this.key,
              'Authorization': `Bearer ${this.key}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ data_value: value, updated_at: new Date().toISOString() })
          });
          return retry.ok;
        }
        return res.ok;
      } catch (e) {
        console.warn('[Supabase] 写入失败:', e);
        return false;
      }
    },

    // 批量写入多个 key
    async setBatch(dataMap) {
      let allOk = true
      for (const [key, value] of Object.entries(dataMap)) {
        const ok = await this.set(key, value)
        if (!ok) allOk = false
      }
      return allOk
    }
  }

  /* ========== 2. 原有 NikSync 核心（保留全部） ========== */
  var CFG_KEY = 'niksync_cfg';
  var META_KEY = 'niksync_meta';
  var BASE_KEY = 'niksync_base';
  var CFG = null, META = null, timer = null, ADAPTER = null;
  var lastErr = null;
  var DEFAULT_BRANCH = 'master';

  function mergeMode() { return getCfg().merge !== false; }

  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64d(s) {
    if (!s) return '';
    s = String(s).replace(/\s+/g, '');
    try { return decodeURIComponent(escape(atob(s))); }
    catch (e) { try { return atob(s); } catch (e2) { return ''; } }
  }
  function jget(key, fb) {
    try { var v = localStorage.getItem(key); return v === null ? fb : JSON.parse(v); }
    catch (e) { return fb; }
  }
  function jset(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  function nowTs() { return Date.now(); }
  function log() { try { console.log.apply(console, ['[NikSync]'].concat([].slice.call(arguments))); } catch (e) {} }
  function warn() { try { console.warn.apply(console, ['[NikSync]'].concat([].slice.call(arguments))); } catch (e) {} }

  function getCfg() {
    if (!CFG) CFG = jget(CFG_KEY, null);
    return CFG || { app: 'app', owner: '', repo: '', branch: DEFAULT_BRANCH, token: '', file: '', keys: [], device: '' };
  }
  function saveCfg(cfg) { CFG = cfg; jset(CFG_KEY, cfg); }
  function getMeta() {
    if (!META) META = jget(META_KEY, { ts: 0, device: '', pending: false });
    return META;
  }
  function setMeta(m) { META = m; jset(META_KEY, m); }
  function valid() {
    var c = getCfg();
    return !!(c.owner && c.repo && c.token && (c.file || c.app));
  }
  function filePath() {
    var c = getCfg();
    return c.file || ('data/' + c.app + '.json');
  }
  function deviceName() {
    var c = getCfg();
    return c.device || ('device-' + Math.random().toString(36).slice(2, 7));
  }

  function apiUrl(path, qs) {
    var c = getCfg();
    var url = 'https://gitee.com/api/v5/repos/' + encodeURIComponent(c.owner) + '/' +
      encodeURIComponent(c.repo) + '/contents/' + path;
    return qs ? (url + '?' + qs) : url;
  }
  function apiGet(path) {
    var c = getCfg();
    return fetch(apiUrl(path, 'access_token=' + encodeURIComponent(c.token)))
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) return r.json().then(function (j) { throw new Error('GET ' + r.status + ' ' + (j.message || '')); });
        return r.json();
      });
  }
  function apiWrite(path, content, sha) {
    var c = getCfg();
    var body = {
      access_token: c.token,
      content: b64e(content),
      message: 'sync ' + (c.app || 'app') + ' ' + new Date().toISOString()
    };
    if (sha) body.sha = sha;
    return fetch(apiUrl(path), {
      method: sha ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error('WRITE ' + r.status + ' ' + (j.message || '')); });
      return r.json();
    });
  }
  function apiGetRaw(path) {
    var c = getCfg();
    var seg = String(path).split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
    var url = 'https://gitee.com/api/v5/repos/' + encodeURIComponent(c.owner) + '/' +
      encodeURIComponent(c.repo) + '/raw/' + seg;
    var qs = 'access_token=' + encodeURIComponent(c.token) +
      '&ref=' + encodeURIComponent(c.branch || DEFAULT_BRANCH);
    return fetch(url + '?' + qs).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) return r.text().then(function (t) { throw new Error('RAW ' + r.status + ' ' + String(t).slice(0, 120)); });
      return r.text();
    });
  }

  async function collectLocal() {
    var c = getCfg(), data = {};
    (c.keys || []).forEach(function (k) {
      try { var v = localStorage.getItem(k); if (v !== null) data[k] = v; } catch (e) {}
    });
    if (ADAPTER && typeof ADAPTER.exportExtra === 'function') {
      try {
        var ex = await ADAPTER.exportExtra();
        if (ex) { Object.keys(ex).forEach(function (k) { data[k] = ex[k]; }); }
      } catch (e) { warn('exportExtra 失败：', e); }
    }
    return data;
  }
  async function applyRemote(data) {
    var changed = false;
    (getCfg().keys || []).forEach(function (k) {
      if (typeof data[k] !== 'string') return;
      try {
        if (localStorage.getItem(k) !== data[k]) { localStorage.setItem(k, data[k]); changed = true; }
      } catch (e) {}
    });
    if (ADAPTER && typeof ADAPTER.importExtra === 'function') {
      try { var r = await ADAPTER.importExtra(data); if (r) changed = true; } catch (e) { warn('importExtra 失败：', e); }
    }
    return changed;
  }
  function buildFile(payload) {
    return JSON.stringify({
      meta: { v: 1, ts: nowTs(), device: deviceName() },
      data: payload
    });
  }
  function parseText(txt) {
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }
  function parseContentB64(b64) {
    try { return JSON.parse(b64d(b64)); } catch (e) { return null; }
  }

  function getBaseData() { var b = jget(BASE_KEY, null); return (b && b.data) || null; }
  function setBaseData(data) { jset(BASE_KEY, { ts: nowTs(), data: data }); }
  function jparse(s) {
    if (typeof s !== 'string') return { ok: false, v: s };
    try { return { ok: true, v: JSON.parse(s) }; } catch (e) { return { ok: false, v: s }; }
  }
  function sameV(a, b) {
    if (a === undefined || b === undefined) return a === b;
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function itemId(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    var k = o.id != null ? 'id' : o._id != null ? '_id' : o.uid != null ? 'uid' : o.uuid != null ? 'uuid' : null;
    return k ? String(o[k]) : null;
  }
  function itemTsOf(o) {
    if (!o || typeof o !== 'object') return 0;
    var fs = ['updatedAt', 'updated_at', 'updateTime', 'modified', 'mtime', 'ts', 'time', 'createdAt', 'created_at'];
    var best = 0;
    for (var i = 0; i < fs.length; i++) {
      var v = o[fs[i]];
      if (typeof v === 'number' && v > best) best = v;
      else if (typeof v === 'string' && v && !isNaN(+v) && +v > best) best = +v;
    }
    return best;
  }
  function mergeArray(baseA, localA, remoteA, remoteNewer) {
    if (!localA.length && !remoteA.length) return localA;
    var idx = function (arr) {
      var m = {};
      for (var i = 0; i < arr.length; i++) {
        var k = itemId(arr[i]);
        if (k === null) return null;
        m[k] = arr[i];
      }
      return m;
    };
    var b = idx(baseA || []), l = idx(localA), r = idx(remoteA);
    if (!l || !r) return null;
    var inB = function (k) { return !!(b && b[k] !== undefined); };
    var out = [];
    for (var i = 0; i < localA.length; i++) {
      var it = localA[i], k = itemId(it);
      if (r[k] === undefined) { if (inB(k)) continue; out.push(it); }
      else if (sameV(it, r[k])) out.push(it);
      else {
        var tl = itemTsOf(it), tr = itemTsOf(r[k]);
        if (tl && tr) out.push(tl >= tr ? it : r[k]);
        else if (inB(k) && sameV(b[k], it)) out.push(r[k]);
        else if (inB(k) && sameV(b[k], r[k])) out.push(it);
        else out.push(remoteNewer ? r[k] : it);
      }
    }
    for (var j = 0; j < remoteA.length; j++) {
      var rk = itemId(remoteA[j]);
      if (l[rk] === undefined && !inB(rk)) out.push(remoteA[j]);
    }
    return out;
  }
  function mergeObject(baseO, localO, remoteO, remoteNewer, depth) {
    var out = {}, keys = {};
    Object.keys(localO).forEach(function (k) { keys[k] = 1; });
    Object.keys(remoteO).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      var lv = localO[k], rv = remoteO[k];
      var bv = (baseO && baseO[k] !== undefined) ? baseO[k] : undefined;
      if (rv === undefined) { if (bv === undefined && lv !== undefined) out[k] = lv; return; }
      if (lv === undefined) { if (bv === undefined) out[k] = rv; return; }
      out[k] = mergeValue(bv, lv, rv, remoteNewer, depth);
    });
    return out;
  }
  function mergeValue(b, l, r, remoteNewer, depth) {
    depth = depth || 0;
    var pl = jparse(l), pr = jparse(r);
    if (pl.ok && pr.ok) {
      if (Array.isArray(pl.v) && Array.isArray(pr.v)) {
        var pb = jparse(b);
        var marr = mergeArray((pb.ok && Array.isArray(pb.v)) ? pb.v : [], pl.v, pr.v, remoteNewer);
        if (marr !== null) return JSON.stringify(marr);
      }
      if (depth < 3 && pl.v && pr.v && typeof pl.v === 'object' && typeof pr.v === 'object'
        && !Array.isArray(pl.v) && !Array.isArray(pr.v)) {
        var pb2 = jparse(b);
        var pbo = (pb2.ok && pb2.v && typeof pb2.v === 'object' && !Array.isArray(pb2.v)) ? pb2.v : {};
        return JSON.stringify(mergeObject(pbo, pl.v, pr.v, remoteNewer, depth + 1));
      }
    }
    var lb = (b === undefined) ? false : sameV(b, l);
    var rb = (b === undefined) ? false : sameV(b, r);
    if (lb && rb) return l;
    if (lb) return r;
    if (rb) return l;
    return remoteNewer ? r : l;
  }
  function mergeData(baseD, localD, remoteD, remoteNewer) {
    var out = {}, keys = {};
    [baseD, localD, remoteD].forEach(function (d) { if (d) Object.keys(d).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      var l = localD[k], r = remoteD[k];
      var b = (baseD && baseD[k] !== undefined) ? baseD[k] : undefined;
      if (r === undefined) { if (b === undefined && l !== undefined) out[k] = l; return; }
      if (l === undefined) { if (b === undefined) out[k] = r; return; }
      out[k] = mergeValue(b, l, r, remoteNewer, 0);
    });
    return out;
  }

  /* ========== 3. 增强版 pushNow：Gitee + Supabase 双上传 ========== */
  function pushNow() {
    if (!valid()) { lastErr = '同步未配置：请在设置中填齐 用户名/仓库/令牌'; warn(lastErr); return Promise.resolve(false); }
    var path = filePath(), m = getMeta();
    
    return Promise.all([apiGetRaw(path), apiGet(path)]).then(async function (rs) {
      var txt = rs[0], remote = rs[1];
      var obj = txt ? parseText(txt) : null;
      var remoteTs = (obj && obj.meta && obj.meta.ts) || 0;
      var localData = await collectLocal();
      
      if (mergeMode() && obj && obj.data) {
        var merged = mergeData(getBaseData() || {}, localData, obj.data, remoteTs > m.ts);
        await applyRemote(merged);
        localData = await collectLocal(); // 重新收集合并后的数据
      } else if (!mergeMode() && remote && remoteTs > m.ts && m.pending) {
        var ok = global.confirm('云端数据比本机上次同步点更新，直接上传会覆盖云端新内容。\n建议先「下载」合并，仍要继续上传吗？');
        if (!ok) return false;
      }
      
      // ══════════════════════════════════════════════════════════
      //  安全阀：本机数据明显比云端少时，绝不自动上传覆盖
      //
      //  空设备 / 新设备最容易踩这个坑：本地什么都没有，
      //  一推就把云端的文章整片冲掉（2026-09-24 的丢失就是这么发生的）。
      //  宁可挡住，也不能默默覆盖 —— 要覆盖必须用户明确点确认。
      // ══════════════════════════════════════════════════════════
      var __payload = buildFile(localData);
      var __remoteLen = (txt || '').length;
      if (__remoteLen > 3000 && __payload.length < __remoteLen * 0.6) {
        var __ok = global.confirm(
          '⚠️ 本机数据比云端少很多，直接上传会用本机覆盖云端。\n\n' +
          '　本机：' + __payload.length + ' 字节\n' +
          '　云端：' + __remoteLen + ' 字节\n\n' +
          '多半是「本机没读到数据」。建议先点「下载」把云端合并下来。\n\n' +
          '确实要强制上传吗？'
        );
        if (!__ok) {
          lastErr = '已阻止上传：本机(' + __payload.length + '字节) 远少于云端(' + __remoteLen + '字节)';
          warn(lastErr);
          return false;
        }
        warn('用户强制上传：' + __payload.length + ' / 云端 ' + __remoteLen);
      }

      // === Gitee 上传 ===
      await apiWrite(path, __payload, remote ? remote.sha : undefined);
      
      // === Supabase 备份上传（新增） ===
      try {
        // 把 localData 中的每个 key 单独存入 Supabase
        const keys = getCfg().keys || [];
        const dataMap = {};
        keys.forEach(function(k) {
          if (localData[k] !== undefined) {
            dataMap[k] = JSON.parse(localData[k]);
          }
        });
        await supabase.setBatch(dataMap);
        log('✅ Supabase 备份上传成功');
      } catch (e) {
        warn('Supabase 备份上传失败:', e);
        // 不阻断 Gitee 同步
      }
      
      setBaseData(localData);
      setMeta({ ts: nowTs(), device: deviceName(), pending: false });
      lastErr = null;
      log('✅ Gitee + Supabase 双云同步完成');
      return true;
    }).catch(function (e) {
      lastErr = (e && e.message) || String(e);
      warn('上传失败：', lastErr);
      return false;
    });
  }

  /* ========== 4. 增强版 pullNow：Gitee + Supabase 双恢复 ========== */
  function pullNow(silent, preTxt) {
    if (!valid()) { lastErr = '同步未配置：请在设置中填齐 用户名/仓库/令牌'; warn(lastErr); return Promise.resolve(false); }
    var path = filePath(), m = getMeta();
    var getTxt = (preTxt !== undefined) ? Promise.resolve(preTxt) : apiGetRaw(path);
    
    return getTxt.then(async function (txt) {
      if (!txt) { 
        log('云端暂无数据，尝试从 Supabase 恢复...');
        // 尝试从 Supabase 恢复
        const keys = getCfg().keys || [];
        let hasData = false;
        for (const k of keys) {
          const data = await supabase.get(k);
          if (data) {
            localStorage.setItem(k, JSON.stringify(data));
            hasData = true;
          }
        }
        if (hasData) {
          log('✅ 从 Supabase 恢复数据成功');
          return true;
        }
        return false; 
      }
      
      var obj = parseText(txt);
      if (!obj || !obj.data) { lastErr = '云端数据格式异常'; warn(lastErr); return false; }
      
      var remoteTs = (obj.meta && obj.meta.ts) || 0;
      var target = obj.data;
      var localData = await collectLocal();
      
      if (mergeMode()) {
        target = mergeData(getBaseData() || {}, localData, obj.data, remoteTs > m.ts);
      } else {
        if (silent && !(remoteTs > m.ts)) { log('云端未更新，跳过自动拉取'); return false; }
        if (!silent && m.pending) {
          var ok = global.confirm('本机有未上传的改动，下载将用云端数据覆盖它们。\n确定继续？');
          if (!ok) return false;
        }
      }
      
      var changed = await applyRemote(target);
      if (mergeMode()) setBaseData(target);
      if (changed || remoteTs > m.ts) setMeta({ ts: remoteTs || nowTs(), device: deviceName(), pending: false });
      
      // 同时把数据同步到 Supabase 备份
      try {
        const keys = getCfg().keys || [];
        const dataMap = {};
        keys.forEach(function(k) {
          if (target[k] !== undefined) {
            dataMap[k] = JSON.parse(target[k]);
          }
        });
        await supabase.setBatch(dataMap);
        log('✅ 数据已同步到 Supabase 备份');
      } catch (e) {
        warn('Supabase 备份同步失败:', e);
      }
      
      lastErr = null;
      log(changed ? '已应用云端数据' : '与本机一致');
      return changed;
    }).catch(function (e) {
      lastErr = (e && e.message) || String(e);
      if (!silent) warn('下载失败：', lastErr);
      return false;
    });
  }

  /* ========== 5. 对外接口（完全兼容原有调用） ========== */
  function schedulePush(delay) {
    if (!valid()) return;
    var m = getMeta(); m.pending = true; setMeta(m);
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; pushNow(); }, delay || 3000);
  }
  
  function autoPull() {
    if (!valid()) return Promise.resolve(false);
    return apiGetRaw(filePath()).then(async function (txt) {
      if (!txt) {
        var localData = await collectLocal();
        if (!Object.keys(localData).length) return false;
        // 首次上传到 Gitee
        await apiWrite(filePath(), buildFile(localData), undefined);
        // 首次备份到 Supabase
        try {
          const keys = getCfg().keys || [];
          const dataMap = {};
          keys.forEach(function(k) {
            if (localData[k] !== undefined) {
              dataMap[k] = JSON.parse(localData[k]);
            }
          });
          await supabase.setBatch(dataMap);
        } catch (e) { warn('Supabase 首次备份失败:', e); }
        setBaseData(localData);
        setMeta({ ts: nowTs(), device: deviceName(), pending: false });
        log('首次使用：已自动上传到 Gitee + Supabase');
        return false;
      }
      return pullNow(true, txt);
    }).catch(function (e) { lastErr = (e && e.message) || String(e); return false; });
  }
  
  function cfg() { var c = getCfg(); return { app: c.app, owner: c.owner, repo: c.repo, branch: c.branch || DEFAULT_BRANCH, token: c.token || '', file: c.file, keys: (c.keys || []).slice(), device: c.device || '', merge: c.merge !== false }; }
  function save(c) { saveCfg(c); }
  function status() { var m = getMeta(); return { ts: m.ts, device: m.device, pending: m.pending, configured: valid() }; }
  function configured() { return valid(); }

  /* ========== 6. 云同步中心浮层（保留原有 UI） ========== */
  var fabEl = null, panelEl = null;
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTs(ts) {
    if (!ts) return '从未';
    var d = new Date(ts), p = function (n) { return n < 10 ? '0' + n : n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtBytes(n) {
    if (n === undefined || n === null) return '?';
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1048576).toFixed(1) + 'MB';
  }

  function inspectCloud() {
    if (!valid()) { lastErr = '同步未配置：请先填齐 用户名/仓库/令牌'; warn(lastErr); return Promise.resolve(null); }
    return apiGet(filePath()).then(function (remote) {
      if (!remote) return { exists: false };
      var big = remote.size != null && remote.size > 10000000;
      var obj = (!big && remote.content) ? parseContentB64(remote.content) : null;
      var sizes = {}, total = 0;
      if (obj && obj.data) {
        Object.keys(obj.data).forEach(function (k) { var b = String(obj.data[k] || '').length; sizes[k] = b; total += b; });
      }
      return {
        exists: true, bytes: remote.size || total, dataBytes: total, metaOk: !!obj,
        ts: (obj && obj.meta && obj.meta.ts) || 0,
        device: (obj && obj.meta && obj.meta.device) || '',
        keys: sizes, sha: remote.sha
      };
    }).catch(function (e) { lastErr = (e && e.message) || String(e); warn('查看云端失败：', lastErr); return null; });
  }

  function buildPanel() {
    var c = getCfg(), st = status();
    var p = document.createElement('div');
    p.id = 'niksync-panel';
    p.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483000;width:min(92vw,360px);background:#fbfaf6;color:#26221c;border:1px solid #d8d2c4;border-radius:14px;padding:18px;font-family:-apple-system,"PingFang SC","Noto Sans SC",sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.25);font-size:13px;line-height:1.5';
    var stTxt = st.configured
      ? '已配置 · 内容保存后自动上传' + (st.pending ? '（有待上传改动）' : '')
      : '未配置：填齐 用户名/仓库/令牌 即可用';
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<b style="font-size:14px">☁️ 双云同步 · Gitee + Supabase</b>' +
      '<span onclick="NikSync.hideSyncUI()" style="cursor:pointer;font-size:16px;line-height:1;color:#8a8578">×</span></div>' +
      '<div style="font-size:11px;color:#8a8578;margin-bottom:6px">' + esc(stTxt) + ' · 上次同步 ' + fmtTs(st.ts) + (st.device ? '（' + esc(st.device) + '）' : '') + '</div>' +
      '<div style="font-size:10px;color:#1d9e75;margin-bottom:10px">✅ Supabase 云数据库自动备份中</div>' +
      row('Gitee 用户名', 'niksync-owner', c.owner, '用户名') +
      row('仓库名', 'niksync-repo', c.repo, '如 data-sync') +
      row('本设备名', 'niksync-device', c.device, '可选，如 macbook') +
      row('分支', 'niksync-branch', c.branch || 'master', '一般 master') +
      '<div style="font-size:11px;color:#8a8578;margin:6px 0 3px">私人令牌（projects 权限）</div>' +
      '<input id="niksync-token" type="password" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d8d2c4;border-radius:8px;background:#fff;font-size:12px;outline:none" placeholder="gitee 私人令牌" value="' + esc(c.token || '') + '">' +
      '<label style="display:flex;align-items:flex-start;gap:6px;margin-top:10px;font-size:11px;color:#5a5548;cursor:pointer;line-height:1.5">' +
      '<input id="niksync-merge" type="checkbox"' + (c.merge !== false ? ' checked' : '') + ' style="margin-top:2px;accent-color:#26221c"> 合并模式：多设备各自新增的内容互不覆盖</label>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<button onclick="NikSync.saveFromPanel()" style="flex:1;padding:8px;border:none;border-radius:9px;background:#26221c;color:#f5f1e6;font-size:12px;cursor:pointer;font-weight:600">💾 保存并上传</button>' +
      '<button onclick="NikSync.downloadNow()" style="flex:1;padding:8px;border:1px solid #d8d2c4;border-radius:9px;background:#fff;color:#26221c;font-size:12px;cursor:pointer">📥 下载到本机</button></div>' +
      '<button onclick="NikSync.createAndSync()" style="width:100%;margin-top:8px;padding:8px;border:1px dashed #a8a18d;border-radius:9px;background:#f4f1e8;color:#26221c;font-size:12px;cursor:pointer">⚡ 首次使用：一键建私有仓库并上传</button>' +
      '<button onclick="NikSync.inspectUI()" style="width:100%;margin-top:6px;padding:8px;border:1px solid #d8d2c4;border-radius:9px;background:#fff;color:#26221c;font-size:12px;cursor:pointer">🔍 查看云端状态</button>' +
      '<div style="font-size:10px;color:#a29b8c;margin-top:10px;line-height:1.6">数据同时存于 Gitee 私有仓库 + Supabase 数据库，双重保险。</div>' +
      '<div id="niksync-msg" style="font-size:11px;color:#1d9e75;margin-top:6px;min-height:14px;white-space:pre-line"></div>';
    return p;
  }
  function row(label, id, val, ph) {
    return '<div style="font-size:11px;color:#8a8578;margin:6px 0 3px">' + label + '</div>' +
      '<input id="' + id + '" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d8d2c4;border-radius:8px;background:#fff;font-size:12px;outline:none" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '">';
  }
  function msg(txt, ok) {
    var m = document.getElementById('niksync-msg');
    if (m) { m.textContent = txt; m.style.color = ok ? '#1d9e75' : '#a32d2d'; }
  }
  function showSyncUI() {
    if (panelEl) { panelEl.remove(); panelEl = null; }
    panelEl = buildPanel();
    document.body.appendChild(panelEl);
  }
  function hideSyncUI() { if (panelEl) { panelEl.style.display = 'none'; } }
  function readPanel() {
    var c = getCfg();
    var val = function (id) {
      var el = document.getElementById(id);
      return (el && el.value != null) ? String(el.value).trim() : '';
    };
    var t;
    if ((t = val('niksync-owner'))) c.owner = t;
    if ((t = val('niksync-repo'))) c.repo = t;
    if ((t = val('niksync-device'))) c.device = t;
    if ((t = val('niksync-branch'))) c.branch = t;
    if ((t = val('niksync-token'))) c.token = t;
    var cb = document.getElementById('niksync-merge');
    if (cb) c.merge = cb.checked;
    return c;
  }
  function saveFromPanel() {
    saveCfg(readPanel());
    lastErr = null;
    msg('正在保存到 Gitee + Supabase…', true);
    pushNow().then(function (ok) { msg(ok ? '✅ 双云同步成功！（点「查看云端状态」核对）' : '❌ 同步失败：' + (lastErr || '检查配置/网络'), ok); });
  }
  function downloadNow() {
    saveCfg(readPanel());
    lastErr = null;
    msg('正在下载…', true);
    pullNow(false).then(function (ok) {
      if (ok) {
        msg('✅ 已下载并应用 ✓', true);
        setTimeout(function () {
          if (typeof window.AlterRefresh === 'function') { try { window.AlterRefresh(); } catch (e) {} }
          else location.reload();
        }, 600);
      } else if (lastErr) msg('❌ 下载失败：' + lastErr, false);
      else msg('云端与本机一致，没有新内容', true);
    });
  }
  function inspectUI() {
    saveCfg(readPanel());
    lastErr = null;
    msg('正在读取云端真实文件…', true);
    inspectCloud().then(function (r) {
      if (r === null) { msg('读取失败：' + (lastErr || '网络异常'), false); return; }
      if (!r.exists) {
        msg('⚠️ 云端还没有这个文件 —— 从未上传成功过。\n点「保存并上传」后再回来核对。', false);
        return;
      }
      var lines = ['✅ 云端文件真实存在：' + fmtBytes(r.bytes)];
      if (!r.metaOk) {
        lines.push('⚠️ 文件超过 10MB，接口不返回内容详情');
      } else {
        lines.push('上次上传：' + fmtTs(r.ts) + (r.device ? '（' + r.device + '）' : ''));
        var ks = Object.keys(r.keys);
        if (ks.length) lines.push('内容分块：' + ks.map(function (k) { return k + ' ' + fmtBytes(r.keys[k]); }).join('、'));
      }
      lines.push('✅ Supabase 备份: 已启用（自动同步）');
      msg(lines.join('\n'), true);
    });
  }
  function createAndSync() {
    saveCfg(readPanel());
    lastErr = null;
    msg('正在创建私有仓库…', true);
    createRepo().then(function (ok) {
      if (!ok) { msg('建仓失败：' + (lastErr || '请检查令牌/网络'), false); return; }
      msg('仓库就绪，正在上传到 Gitee + Supabase…', true);
      pushNow().then(function (up) {
        msg(up ? '✅ 建仓并双云同步成功！' : '❌ 上传失败：' + (lastErr || '检查配置'), up);
      });
    });
  }
  function createRepo() {
    if (!valid()) { lastErr = '同步未配置：请先填齐 用户名/仓库/令牌'; warn(lastErr); return Promise.resolve(false); }
    var c = getCfg();
    var api = 'https://gitee.com/api/v5/user/repos';
    var desc = (c.app || 'app') + ' NikSync 云同步数据仓库（双云备份）';
    return fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: c.token, name: c.repo, description: desc, private: true, has_issues: false, has_wiki: false, auto_init: false })
    }).then(function (r) {
      if (r.ok) { log('已建私有仓库', c.repo); return true; }
      return r.json().then(function (j) {
        var msg2 = (j && j.message) || '';
        if (r.status === 422 && /already|exists/i.test(msg2)) { log('仓库已存在，直接使用', c.repo); return true; }
        if (r.status === 401) { lastErr = '令牌无效或没有 projects 权限'; warn(lastErr); return false; }
        if (r.status === 403) { lastErr = '令牌缺少建仓权限（projects）'; warn(lastErr); return false; }
        if (r.status === 429) { lastErr = '触发 Gitee 限流，稍后再试'; warn(lastErr); return false; }
        lastErr = '建仓失败 ' + r.status + ' ' + msg2; warn(lastErr); return false;
      });
    }).catch(function (e) {
      lastErr = (e && e.message) || String(e); warn('建仓失败：', lastErr); return false;
    });
  }
  function ensureFAB() {
    if (fabEl || document.getElementById('niksync-fab')) return;
    fabEl = document.createElement('div');
    fabEl.id = 'niksync-fab';
    fabEl.textContent = '☁️';
    fabEl.title = '双云同步设置';
    var c = getCfg();
    var isM = typeof window.matchMedia === 'function' && window.matchMedia('(max-width:767px)').matches;
    var defPos = isM ? 'bottom:128px;left:12px' : 'bottom:96px;left:16px';
    var fabCfg = (c && c.fab) || {};
    var pos = fabCfg[isM ? 'm' : 'd'] || defPos;
    fabEl.style.cssText = 'position:fixed;' + pos + ';z-index:2147482000;width:34px;height:34px;border-radius:50%;background:#26221c;color:#f5f1e6;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;opacity:.55;box-shadow:0 2px 8px rgba(0,0,0,.2);font-family:sans-serif';
    fabEl.addEventListener('click', function (e) { e.stopPropagation(); showSyncUI(); });
    document.body.appendChild(fabEl);
  }
  function setFabVisible(v) {
    if (fabEl) fabEl.style.display = v ? '' : 'none';
  }

  /* ========== 7. 导出 ========== */
  global.NikSync = {
    init: saveCfg, schedulePush: schedulePush, pushNow: pushNow,
    pullNow: pullNow, autoPull: autoPull, cfg: cfg, save: save,
    status: status, configured: configured, setAdapter: function (a) { ADAPTER = a; },
    showSyncUI: showSyncUI, hideSyncUI: hideSyncUI, saveFromPanel: saveFromPanel,
    downloadNow: downloadNow, ensureFAB: ensureFAB, createRepo: createRepo,
    createAndSync: createAndSync, inspectCloud: inspectCloud, inspectUI: inspectUI,
    setFabVisible: setFabVisible, getLastErr: function () { return lastErr; }
  };

  // 自动加载 Supabase 配置到 NikSync
  log('✅ NikSync 双云同步版已加载（Gitee + Supabase）');
  log('📡 Supabase 项目:', SUPABASE_URL);

})(window);
