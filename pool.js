/*!
 * pool.js —— 「一处搜全」
 *
 * 任何应用引入这一个文件，就获得一个「素材库」：
 * 一次搜索搜遍全部应用的内容，点一下直接插进你正在写的地方。
 *
 * 设计要点
 *   · 没有 to 字段 —— 谁都不"属于"谁，因此不存在应用互相绑定
 *   · 不需要切换应用 —— 你就在写字台里搜，不用跑去他我笔记
 *   · 不需要服务器 —— Gitee 与 Supabase 都允许浏览器跨域(已实测 allow-origin: *)
 *   · 不需要新密钥 —— 复用应用本机已有的 niksync_cfg（里面已有 Gitee token）
 *   · 只索引摘要 —— 索引仅几十 KB；全文按需取，6.4MB 的象库也不拖慢搜索
 *
 * 用法
 *   <script src="pool.js"></script>
 *   Pool.open();                                  // 打开素材库
 *   Pool.onInsert = function (item) { ... };      // 可选：自定义"插入"行为
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  /* ==================================================================
   * 0. 常量
   * ================================================================== */

  // Supabase 的 publishable key 设计上就是给浏览器用的（配合 RLS 保护数据）
  var SB_URL = 'https://wxftncusytrdkrogqgjw.supabase.co';
  var SB_KEY = 'sb_publishable_Qy8NgPrDETVbTJJuRh-ZYg_rHRlqZTD';

  var CACHE_KEY = 'nikpool_cache_v1';
  var CACHE_TTL = 10 * 60 * 1000;      // 索引缓存 10 分钟
  var SNIPPET_LEN = 140;

  /* ==================================================================
   * 1. 工具
   * ================================================================== */

  function str(v) { return v === undefined || v === null ? '' : String(v); }

  function stripHtml(s) {
    return str(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
  }

  function snippet(s, n) {
    var t = stripHtml(s).replace(/\s+/g, ' ').trim();
    return t.length > (n || SNIPPET_LEN) ? t.slice(0, n || SNIPPET_LEN) + '…' : t;
  }

  // 时间统一成 ISO 字符串；支持毫秒数 / "YYYY/M/D" / ISO
  function toISO(v) {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v === 'number' || /^\d{10,13}$/.test(str(v))) {
      var n = Number(v);
      if (n < 1e12) n *= 1000;
      var d = new Date(n);
      return isNaN(d.getTime()) ? '' : d.toISOString();
    }
    var s = str(v).trim();
    var m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) + 'T00:00:00.000Z';
    var d2 = new Date(s);
    return isNaN(d2.getTime()) ? '' : d2.toISOString();
  }

  function firstOf(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null && str(v) !== '') return v;
    }
    return '';
  }

  // Gitee 返回的 base64 需要按 UTF-8 还原（且带换行）
  function b64utf8(b64) {
    var bin = atob(str(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return decodeURIComponent(escape(bin));
  }

  // 有些字段是"套在字符串里的 JSON"，要二次解析
  function maybeJSON(v) {
    if (typeof v !== 'string') return v;
    var t = v.trim();
    if (!t || (t[0] !== '[' && t[0] !== '{')) return v;
    try { return JSON.parse(t); } catch (e) { return v; }
  }

  /* ==================================================================
   * 2. 数据源定义
   *   每个源负责把原始 JSON 变成统一的 item 数组：
   *   { id, title, content, date, tags, source }
   * ================================================================== */

  var SOURCES = [
    /* ---------- Gitee：象库 ---------- */
    {
      key: 'nikonto', label: '象库', kind: 'gitee', file: 'data/nikonto.json',
      parse: function (j) {
        var d = (j && j.data) || {}, out = [];
        var push = function (arr, src) {
          (arr || []).forEach(function (x) {
            if (!x || x.deleted) return;
            var c = firstOf(x, ['content', 'manuscript', 'text', 'note']);
            var t = firstOf(x, ['title', 'name']);
            // 只有标题、还没写正文的项目也要收 —— 标题本身就是可用的素材
            if (!str(c).trim() && !str(t).trim()) return;
            out.push({
              id: 'nikonto:' + str(x.id), title: str(t),
              content: str(c), date: toISO(firstOf(x, ['createdAt', 'updatedAt', 'time', 'ts'])),
              tags: [].concat(x.type || [], (src ? [src] : [])), source: '象库'
            });
          });
        };
        push(maybeJSON(d.qumei_v38_projects) instanceof Array
          ? maybeJSON(d.qumei_v38_projects).map(function (p) {
              return { id: p.id, title: p.name, content: p.manuscript };
            }) : [], '手稿');
        var projs = maybeJSON(d.qumei_v38_projects);
        if (projs instanceof Array) {
          projs.forEach(function (p) {
            (p.sources || []).forEach(function (s) {
              if (!s || s.deleted) return;
              out.push({
                id: 'nikonto:' + str(s.id), title: str(s.title), content: str(s.content),
                date: '', tags: [].concat(s.type || [], ['归档']), source: '象库'
              });
            });
          });
        }
        push(maybeJSON(d.qumei_v38_scratch), '随手记');
        return out;
      }
    },

    /* ---------- Gitee：象库轻工作台 ---------- */
    {
      key: 'niko', label: '轻工作台', kind: 'gitee', file: 'data/niko.json',
      parse: function (j) {
        var db = maybeJSON(((j && j.data) || {}).xiangku_workstation_db_v5) || {};
        var out = [];
        var take = function (arr, kind, contentKeys, titleKeys) {
          (arr || []).forEach(function (x) {
            if (!x) return;
            var c = firstOf(x, contentKeys || ['content', 'text', 'solution']);
            var t = firstOf(x, titleKeys || ['title', 'event']);
            if (!str(c).trim() && !str(t).trim()) return;
            out.push({
              id: 'niko:' + str(x.id), title: str(t),
              content: str(c), date: toISO(firstOf(x, ['date', 'timestamp', 'updatedAt', 't'])),
              tags: [kind].concat(x.category ? [x.category] : [], x.type ? [x.type] : []),
              source: '轻工作台'
            });
          });
        };
        take(db.notes, '笔记', ['content'], ['title']);
        take(db.knowledge, '知识', ['content'], ['title']);
        take(db.agentOutputs, '智能体', ['content'], ['title']);
        take(db.experiences, '经验', ['solution', 'summary'], ['title', 'scene']);
        take(db.methods, '方法', ['content'], ['title']);
        (db.growth || []).forEach(function (x) {
          var c = [str(x.experience), str(x.insight)].filter(Boolean).join('\n');
          if (!c.trim()) return;
          out.push({
            id: 'niko:' + str(x.id), title: str(x.event), content: c,
            date: toISO(x.date), tags: ['成长'], source: '轻工作台'
          });
        });
        take((db.bujo || {}).future, '子弹', ['content'], []);
        var logs = (db.bujo || {}).logs || {};
        Object.keys(logs).forEach(function (day) {
          (logs[day] || []).forEach(function (x) {
            if (!x || !str(x.content).trim()) return;
            out.push({
              id: 'niko:' + str(x.id), title: '', content: str(x.content),
              date: toISO(day), tags: ['子弹', day], source: '轻工作台'
            });
          });
        });
        return out;
      }
    },

    /* ---------- Gitee：他我笔记 ---------- */
    {
      key: 'alter-notes', label: '他我笔记', kind: 'gitee', file: 'data/alter-notes.json',
      parse: function (j) {
        var arr = (j && j.data) || [];      // 注意：这个已经是数组，不要二次解析
        if (!(arr instanceof Array)) arr = maybeJSON(arr) || [];
        return arr.map(function (x) {
          return {
            id: 'alter:' + str(x.id), title: '', content: str(x.content),
            date: toISO(x.updatedAt || x.time),
            tags: [].concat(x.persona ? [x.persona] : [], x.tag || [], x.tags || []),
            source: '他我笔记'
          };
        }).filter(function (x) { return x.content.trim(); });
      }
    },

    /* ---------- Gitee：写字台 ---------- */
    {
      key: 'logosnik', label: '写字台', kind: 'gitee', file: 'data/logosnik.json',
      parse: function (j) {
        var d = (j && j.data) || {}, out = [];
        var take = function (key, src, contentKeys, titleKeys, dateKeys, tagKeys) {
          var arr = maybeJSON(d[key]);
          if (!(arr instanceof Array)) return;
          arr.forEach(function (x) {
            if (!x) return;
            var c = firstOf(x, contentKeys);
            var t = firstOf(x, titleKeys || []);
            if (!str(c).trim() && !str(t).trim()) return;
            out.push({
              id: 'logos:' + str(x.id), title: str(t), content: stripHtml(str(c)) || str(t),
              date: toISO(firstOf(x, dateKeys || ['id', 'ts'])),
              tags: [src].concat(x.tag ? [x.tag] : []), source: '写字台'
            });
          });
        };
        take('ln_warehouse_v16', '仓库', ['note', 'textbook'], ['title', 'noteTitle'], ['id']);
        take('ln_inspirations_v1', '灵感', ['content'], [], ['ts', 'id']);
        take('ln_knowledge_v1', '知识', ['content'], ['title'], ['id']);
        take('ln_quicknotes_v1', '速记', ['content'], [], ['id']);
        // ln_chat_memories_v3 是"对象里套数组"，且与对话有关，默认不进池子（噪音）
        return out;
      }
    },

    /* ---------- Gitee：NikWeOS 工作日志 ---------- */
    {
      key: 'nikwe-worklog', label: '工作日志', kind: 'gitee', file: 'data/nikwe-worklog.json',
      optional: true,                    // 文件不存在时不报错
      parse: function (j) {
        var arr = (j && j.data) || j || [];
        if (!(arr instanceof Array)) return [];
        return arr.map(function (x) {
          return {
            id: 'log:' + str(x.id), title: str(x.title), content: str(x.content),
            date: toISO(x.date), tags: [].concat(x.tags || [], ['工作日志']), source: '工作日志'
          };
        });
      }
    },

    /* ---------- Supabase：筑案 ---------- */
    {
      key: 'zhuan', label: '筑案', kind: 'supabase', prefix: 'zhuan_row_',
      parse: function (rows) {
        var out = [];
        (rows || []).forEach(function (r) {
          var v = r.data_value;                      // 有的返回字符串，有的返回对象
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return; } }
          if (!v || v.deleted) return;
          var table = str(r.data_key).replace(/^zhuan_row_zhuan_/, '').replace(/_[^_]+$/, '');
          var c = firstOf(v, ['text', 'content', 'desc', 'name', 'title']);
          if (!str(c).trim()) return;
          out.push({
            id: 'zhuan:' + str(v.id), title: str(firstOf(v, ['name', 'title', 'text'])),
            content: str(c), date: toISO(firstOf(v, ['createdAt', 'updatedAt'])),
            tags: [table].concat(v.type ? [v.type] : [], v.kind ? [v.kind] : []), source: '筑案'
          });
        });
        return out;
      }
    }
  ];

  /* ==================================================================
   * 3. 取数据
   * ================================================================== */

  // 复用应用本机已存的同步配置（里面有 Gitee token）。不新增任何密钥。
  // 也接受 window.NIKPOOL_CFG 覆盖 —— 给本地预览页/测试用，省得依赖 localStorage。
  function giteeCfg() {
    var o = global.NIKPOOL_CFG;
    if (o && o.owner && o.repo && o.token) return o;
    try {
      var c = JSON.parse((global.localStorage || {}).getItem('niksync_cfg') || '{}');
      if (c && c.owner && c.repo && c.token) return c;
    } catch (e) {}
    return null;
  }

  function fetchGitee(src, cfg) {
    if (!cfg) return Promise.reject(new Error('本机没有 Gitee 同步配置（niksync_cfg），读不到云端文件'));
    var url = 'https://gitee.com/api/v5/repos/' + encodeURIComponent(cfg.owner) + '/' +
      encodeURIComponent(cfg.repo) + '/contents/' + src.file +
      '?access_token=' + encodeURIComponent(cfg.token) +
      '&ref=' + encodeURIComponent(cfg.branch || 'master');
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Gitee ' + r.status + ' ' + src.file);
      return r.json();
    }).then(function (j) {
      if (!j || !j.content) throw new Error('Gitee 返回无内容: ' + src.file);
      return JSON.parse(b64utf8(j.content));
    });
  }

  function fetchSupabase(src) {
    var url = SB_URL + '/rest/v1/user_data?select=data_key,data_value,updated_at' +
      '&data_key=like.' + encodeURIComponent(src.prefix) + '*&limit=1000';
    return fetch(url, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } })
      .then(function (r) {
        if (!r.ok) throw new Error('Supabase ' + r.status);
        return r.json();
      });
  }

  function fetchSource(src, cfg) {
    return src.kind === 'gitee' ? fetchGitee(src, cfg) : fetchSupabase(src);
  }

  /* ==================================================================
   * 4. 建索引（纯函数，可脱离网络单独测试）
   * ================================================================== */

  function buildIndex(rawByKey) {
    var items = [], errors = [];
    SOURCES.forEach(function (src) {
      var raw = rawByKey[src.key];
      if (raw === undefined) { errors.push(src.label + '：未取到'); return; }
      if (raw && raw.__error) { errors.push(src.label + '：' + raw.__error); return; }
      var list;
      try { list = src.parse(raw) || []; }
      catch (e) { errors.push(src.label + '：解析失败 ' + e.message); return; }
      list.forEach(function (it) {
        if (!it || !it.id) return;
        it.sourceKey = src.key;
        // 统一截到 400 字符：缓存命中与首次加载的搜索范围必须完全一致，
        // 否则同一句关键词在不同时候会搜出不同结果。
        it.search = (str(it.title) + ' ' + str(it.content)).slice(0, 400).toLowerCase();
        items.push(it);
      });
    });

    // 去重：同一个 id 只留一条
    var seen = {}, uniq = [];
    items.forEach(function (it) {
      if (seen[it.id]) return;
      seen[it.id] = 1; uniq.push(it);
    });

    uniq.sort(function (a, b) { return str(b.date).localeCompare(str(a.date)); });
    return { items: uniq, errors: errors, builtAt: Date.now() };
  }

  // 存到 localStorage 的轻量投影（不含全文，几十 KB）
  function toProjection(index) {
    return {
      builtAt: index.builtAt, errors: index.errors,
      items: index.items.map(function (i) {
        return {
          id: i.id, title: i.title, snippet: snippet(i.content), date: i.date,
          tags: i.tags, source: i.source, sourceKey: i.sourceKey,
          search: i.search.length > 400 ? i.search.slice(0, 400) : i.search
        };
      })
    };
  }

  /* ==================================================================
   * 5. 对外 API
   * ================================================================== */

  var state = { index: null, full: {}, loading: null };

  function readCache() {
    try {
      var c = JSON.parse((global.localStorage || {}).getItem(CACHE_KEY) || 'null');
      if (c && c.builtAt && Date.now() - c.builtAt < CACHE_TTL) return c;
    } catch (e) {}
    return null;
  }

  function writeCache(index) {
    try {
      (global.localStorage || {}).setItem(CACHE_KEY, JSON.stringify(toProjection(index)));
    } catch (e) { /* 配额满了就只留内存 */ }
  }

  /** 拉取全部数据源并建索引。force=true 时忽略缓存。 */
  function load(force) {
    if (state.loading) return state.loading;
    if (!force && state.index) return Promise.resolve(state.index);

    state.loading = new Promise(function (resolve) {
      var cfg = giteeCfg();
      var raw = {}, jobs = [];
      SOURCES.forEach(function (src) {
        jobs.push(
          fetchSource(src, cfg)
            .then(function (j) { raw[src.key] = j; })
            .catch(function (e) {
              if (src.optional) return;                 // 可选源缺文件不算错
              raw[src.key] = { __error: e.message || String(e) };
            })
        );
      });
      Promise.all(jobs).then(function () {
        var idx = buildIndex(raw);
        state.index = idx;
        state.full = {};
        idx.items.forEach(function (i) { state.full[i.id] = i.content; });
        writeCache(idx);
        state.loading = null;
        resolve(idx);
      });
    });
    return state.loading;
  }

  /** 用缓存（没有就联网）建索引。缓存命中时全文要按需取。 */
  function loadFast() {
    if (state.index) return Promise.resolve(state.index);
    var c = readCache();
    if (c && c.items) {
      c.items.forEach(function (i) { i.id = i.id; });
      state.index = c;
      return Promise.resolve(c);
    }
    return load(false);
  }

  function search(q, opts) {
    var idx = state.index || { items: [] };
    var kw = str(q).trim().toLowerCase();
    var list = idx.items;
    if (opts && opts.source) list = list.filter(function (i) { return i.source === opts.source; });
    if (!kw) return list.slice(0, 60);
    var words = kw.split(/\s+/).filter(Boolean);
    var scored = [];
    list.forEach(function (it) {
      var hay = it.search || ((str(it.title) + ' ' + str(it.content)).toLowerCase());
      var score = 0, ok = true;
      for (var i = 0; i < words.length; i++) {
        var p = hay.indexOf(words[i]);
        if (p === -1) { ok = false; break; }
        score += p === 0 ? 100 : (p < 40 ? 30 : 10);
        if (str(it.title).toLowerCase().indexOf(words[i]) !== -1) score += 50;
      }
      if (ok) scored.push({ it: it, s: score });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, 100).map(function (x) { return x.it; });
  }

  /** 取全文。索引命中的全文在内存里；缓存命中时按需回源。 */
  function get(item) {
    var id = typeof item === 'string' ? item : (item && item.id);
    if (state.full[id] !== undefined) return Promise.resolve(state.full[id]);
    var it = (state.index.items || []).filter(function (x) { return x.id === id; })[0];
    if (!it) return Promise.resolve('');
    return load(true).then(function () { return state.full[id] || ''; });
  }

  /** 素材库里只存摘要，全文按需 */
  function contentOf(item) { return state.full[item.id] !== undefined ? state.full[item.id] : (item.content || ''); }

  /* ==================================================================
   * 6. 默认插入行为
   * ================================================================== */

  function copyText(text) {
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); resolve();
    });
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#1c1c1e;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;' +
      'font-family:-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);opacity:0;transition:opacity .18s';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 220); }, 1600);
  }

  // 把文字插到"打开素材库之前"光标本来的位置。
  // 有这一层，绝大多数应用一行适配代码都不用写。
  function insertAtCursor(text) {
    var el = lastFocused;
    if (!el || !el.isConnected) return false;
    var tag = (el.tagName || '').toLowerCase();
    try {
      if (tag === 'textarea' || (tag === 'input' && /^(text|search|url|email)$/.test(el.type || 'text'))) {
        var s = el.selectionStart == null ? (el.value || '').length : el.selectionStart;
        var e = el.selectionEnd == null ? s : el.selectionEnd;
        var v = el.value || '';
        el.value = v.slice(0, s) + text + v.slice(e);
        el.selectionStart = el.selectionEnd = s + text.length;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
        return true;
      }
      if (el.isContentEditable) {
        el.focus();
        var sel = global.getSelection();
        if (sel && sel.rangeCount) {
          var r = sel.getRangeAt(0);
          r.deleteContents();
          var node = document.createTextNode(text);
          r.insertNode(node);
          r.setStartAfter(node); r.collapse(true);
          sel.removeAllRanges(); sel.addRange(r);
        } else {
          el.textContent += text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    } catch (err) { /* 落到剪贴板 */ }
    return false;
  }

  function insert(item) {
    var text = (item.title ? item.title + '\n\n' : '') + contentOf(item);
    if (typeof global.Pool.onInsert === 'function') {
      try { global.Pool.onInsert(item, text); return; } catch (e) { /* 落到默认行为 */ }
    }
    close();
    // 先试着插到光标处；插不进去再退回剪贴板
    setTimeout(function () {
      if (insertAtCursor(text)) { toast('已插入'); return; }
      copyText(text).then(function () { toast('已复制，去粘贴就行'); });
    }, 210);
  }

  /* ==================================================================
   * 7. 界面
   * ================================================================== */

  var ui = null;
  var lastFocused = null;      // 打开素材库之前，光标在哪儿

  function css() {
    return '' +
      '.nkp-mask{position:fixed;inset:0;background:rgba(0,0,0,.34);z-index:2147483640;opacity:0;transition:opacity .18s}' +
      '.nkp-mask.on{opacity:1}' +
      '.nkp{position:fixed;left:50%;top:11vh;transform:translateX(-50%) scale(.985);width:min(680px,92vw);' +
      'max-height:74vh;background:#fbfaf7;border:1px solid #e2ddd2;border-radius:14px;z-index:2147483641;' +
      'display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
      'box-shadow:0 24px 70px rgba(0,0,0,.30);opacity:0;transition:opacity .18s,transform .18s}' +
      '.nkp.on{opacity:1;transform:translateX(-50%) scale(1)}' +
      '.nkp-hd{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid #ece7dc}' +
      '.nkp-hd input{flex:1;border:0;outline:0;background:transparent;font-size:15px;color:#222;font-family:inherit}' +
      '.nkp-hd input::placeholder{color:#b3ada0}' +
      '.nkp-x{border:0;background:transparent;color:#a49d8f;font-size:19px;cursor:pointer;line-height:1;padding:2px 5px}' +
      '.nkp-st{padding:7px 14px;font-size:11.5px;color:#8b8578;border-bottom:1px solid #f0ebe1;display:flex;' +
      'justify-content:space-between;align-items:center;font-family:ui-monospace,Menlo,monospace}' +
      '.nkp-st b{font-weight:600;color:#5d5749}' +
      '.nkp-ls{overflow:auto;flex:1;padding:5px}' +
      '.nkp-it{padding:9px 11px;border-radius:9px;cursor:pointer;display:flex;gap:10px;align-items:flex-start}' +
      '.nkp-it:hover,.nkp-it.sel{background:#f1ece1}' +
      '.nkp-src{flex:none;font-size:10px;padding:2px 7px;border-radius:5px;background:#e8e2d5;color:#6b6455;' +
      'white-space:nowrap;margin-top:2px;font-family:ui-monospace,Menlo,monospace}' +
      '.nkp-bd{flex:1;min-width:0}' +
      '.nkp-t{font-size:13.5px;color:#1f1f1f;font-weight:600;margin-bottom:2px;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap}' +
      '.nkp-s{font-size:12px;color:#7d7768;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;' +
      '-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}' +
      '.nkp-d{font-size:10.5px;color:#b0a99b;margin-top:3px;font-family:ui-monospace,Menlo,monospace}' +
      '.nkp-fs{padding:26px 14px;text-align:center;color:#a49d8f;font-size:13px}' +
      '.nkp-ft{padding:8px 14px;border-top:1px solid #ece7dc;font-size:11px;color:#a49d8f;' +
      'display:flex;justify-content:space-between;font-family:ui-monospace,Menlo,monospace}' +
      '.nkp-ft a{color:#8b8578}' +
      '@media(max-width:640px){.nkp{top:0;left:0;transform:none;width:100vw;max-height:100vh;height:100vh;' +
      'border-radius:0;border:0}.nkp.on{transform:none}}';
  }

  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function buildUI() {
    if (ui) return ui;
    var style = document.createElement('style'); style.textContent = css();
    document.head.appendChild(style);

    var mask = el('div', '', ''); mask.className = 'nkp-mask';
    var box = el('div', '', ''); box.className = 'nkp';

    var hd = el('div'); hd.className = 'nkp-hd';
    var input = document.createElement('input');
    input.type = 'search'; input.placeholder = '搜遍全部应用…（象库 / 他我 / 写字台 / 轻工作台 / 筑案 / 工作日志）';
    var x = el('button', '', '✕'); x.className = 'nkp-x'; x.title = '关闭';
    hd.appendChild(input); hd.appendChild(x);

    var st = el('div'); st.className = 'nkp-st';
    var stL = el('span', '', '准备中…'); var stR = el('span', '', '');
    st.appendChild(stL); st.appendChild(stR);

    var ls = el('div'); ls.className = 'nkp-ls';
    var ft = el('div'); ft.className = 'nkp-ft';
    var ftL = el('span', '', '↑↓ 选择 · Enter 插入 · Esc 关闭');
    var ftR = el('span', '', 'pool.js v' + VERSION);
    ft.appendChild(ftL); ft.appendChild(ftR);

    box.appendChild(hd); box.appendChild(st); box.appendChild(ls); box.appendChild(ft);
    document.body.appendChild(mask); document.body.appendChild(box);

    ui = { mask: mask, box: box, input: input, list: ls, stL: stL, stR: stR, sel: 0, cur: [] };

    mask.addEventListener('click', close);
    x.addEventListener('click', close);
    input.addEventListener('input', function () { render(); });
    input.addEventListener('keydown', onKey);
    box.addEventListener('keydown', onKey);
    return ui;
  }

  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); ui.sel = Math.min(ui.sel + 1, ui.cur.length - 1); paintSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); ui.sel = Math.max(ui.sel - 1, 0); paintSel(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      var it = ui.cur[ui.sel];
      if (it) insert(it);
    }
  }

  function paintSel() {
    var nodes = ui.list.querySelectorAll('.nkp-it');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('sel', i === ui.sel);
    if (nodes[ui.sel] && nodes[ui.sel].scrollIntoView) nodes[ui.sel].scrollIntoView({ block: 'nearest' });
  }

  function render() {
    var u = buildUI();
    var q = u.input.value;
    var res = search(q);
    u.cur = res;
    u.sel = 0;
    u.list.innerHTML = '';

    if (!res.length) {
      u.list.appendChild(el('div', '', q ? '没找到「' + q + '」' : '还没有索引到内容'))
        .className = 'nkp-fs';
      return;
    }
    res.forEach(function (it, i) {
      var row = el('div'); row.className = 'nkp-it' + (i === 0 ? ' sel' : '');
      row.appendChild(el('span', '', it.source)).className = 'nkp-src';
      var bd = el('div'); bd.className = 'nkp-bd';
      if (it.title) bd.appendChild(el('div', '', it.title)).className = 'nkp-t';
      var sn = it.snippet || snippet(it.content) || '';
      if (sn) bd.appendChild(el('div', '', sn)).className = 'nkp-s';
      var meta = [it.date ? str(it.date).slice(0, 10) : '', (it.tags || []).join(' · ')].filter(Boolean).join('  ');
      if (!sn) meta = (meta ? meta + '  ' : '') + '（只有标题，还没写正文）';
      if (meta) bd.appendChild(el('div', '', meta)).className = 'nkp-d';
      row.appendChild(bd);
      row.addEventListener('click', function () { insert(it); });
      row.addEventListener('mouseenter', function () {
        ui.sel = i; paintSel();
      });
      u.list.appendChild(row);
    });
  }

  function open() {
    // 抢焦点之前先记住光标原来在哪 —— 插入时要送回去
    lastFocused = document.activeElement;
    buildUI();
    ui.mask.style.display = 'block';
    ui.box.style.display = 'flex';
    requestAnimationFrame(function () { ui.mask.classList.add('on'); ui.box.classList.add('on'); });
    ui.input.value = '';
    ui.input.focus();

    var cached = state.index;
    if (cached && cached.items && cached.items.length) {
      ui.stL.textContent = cached.items.length + ' 条';
      ui.stR.textContent = '缓存';
      render();
      refresh(true);
    } else {
      ui.stL.textContent = '正在读取各应用数据…';
      ui.stR.textContent = '';
      ui.list.innerHTML = '';
      refresh(false);
    }
  }

  function refresh(silent) {
    var t0 = Date.now();
    return load(true).then(function (idx) {
      if (!ui) return;
      ui.stL.textContent = idx.items.length + ' 条' + (idx.errors.length ? '（' + idx.errors.length + ' 个源失败）' : '');
      ui.stR.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      render();
      if (idx.errors.length) console.warn('[pool] 部分数据源失败：', idx.errors);
    }).catch(function (e) {
      if (!ui) return;
      ui.stL.textContent = '读取失败：' + (e.message || e);
    });
  }

  function close() {
    if (!ui) return;
    ui.mask.classList.remove('on'); ui.box.classList.remove('on');
    setTimeout(function () {
      if (!ui.box.classList.contains('on')) { ui.mask.style.display = 'none'; ui.box.style.display = 'none'; }
    }, 200);
  }

  function toggle() {
    if (ui && ui.box.classList.contains('on')) close(); else open();
  }

  /* ==================================================================
   * 8. 快捷键：⌘K / Ctrl+K
   * ================================================================== */

  function bindHotkey() {
    document.addEventListener('keydown', function (e) {
      var k = (e.key || '').toLowerCase();
      if (k === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggle(); }
    }, true);
  }

  /* ==================================================================
   * 导出
   * ================================================================== */

  var Pool = {
    version: VERSION,
    onInsert: null,
    open: open, close: close, toggle: toggle,
    load: load, search: search, get: get,
    insert: insert, toast: toast,
    contentOf: contentOf,
    // 测试/调试用
    _buildIndex: buildIndex, _sources: SOURCES, _toProjection: toProjection,
    _state: state, _snippet: snippet, _toISO: toISO, _stripHtml: stripHtml
  };

  global.Pool = Pool;
  if (typeof module !== 'undefined' && module.exports) module.exports = Pool;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindHotkey);
    } else bindHotkey();
  }
})(typeof window !== 'undefined' ? window : this);
