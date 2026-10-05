/* ============================================================
 * inject.js —— MAIN world 挂钩脚本
 *
 * 目的：把「推荐牛人」列表接口 wapi/zpjob/rec/geek/list 的响应
 *       解析成 { geekId|姓名 : 该候选人全部可读文本 } 的精简映射，
 *       写入 <html data-bag-geek-text="...">。
 *       DOM 属性可跨 world 读取（isolated world 的 content.js 能读到）。
 *
 * 为什么需要：列表卡片上的「优势摘要」常被截断，光靠卡片 DOM 文本
 *             会漏掉部分候选人。接口里的 geekDesc / advantage 更完整。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__BAG_INJECTED__) return;
  window.__BAG_INJECTED__ = true;

  var ATTR = 'data-bag-geek-text';
  var MAX_ATTR_BYTES = 900 * 1024; // 属性上限保护
  var recentSig = new Set();

  // 命中「后缀为这些词」的字段直接跳过（geekId / avatarUrl / encryptGeekId / createTime …）
  var JUNK_KEY_RE = /(id|ids|uuid|token|url|uri|time|timestamp|img|image|avatar|icon|pic|photo|phone|mobile|email|sign|hash|secret|key)$/i;

  function isJunkString(s) {
    if (typeof s !== 'string') return true;
    var t = s.trim();
    if (!t) return true;
    if (t.length < 2) return true;
    if (/^https?:\/\//i.test(t)) return true;
    if (/^data:/.test(t)) return true;
    if (/^[0-9a-fA-F]{16,}$/.test(t)) return true;
    if (/^[0-9a-f-]{30,}$/i.test(t)) return true;             // uuid
    if (/^[A-Za-z0-9+/=_.-]{28,}$/.test(t) && !/[\u4e00-\u9fa5]/.test(t)) return true; // 加密串
    if (/^\d{8,}$/.test(t)) return true;
    return false;
  }

  function isNameLike(s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    if (!t || t.length > 24) return false;
    if (!/^[\u4e00-\u9fa5]{2,8}(女士|先生|同学)?$/.test(t)) return false;
    return true;
  }

  /* 递归收集节点内的可读文本 */
  function collectText(node, depth, out) {
    if (depth > 6 || node == null) return;
    if (typeof node === 'string') {
      if (!isJunkString(node)) out.push(node.trim());
      return;
    }
    if (typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length && out.length < 240; i++) collectText(node[i], depth + 1, out);
      return;
    }
    if (typeof node === 'object') {
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        if (JUNK_KEY_RE.test(k)) continue;
        if (out.length >= 240) break;
        collectText(node[k], depth + 1, out);
      }
    }
  }

  /* 从候选人节点上取结构化性别（BOSS 接口自带，比文本推断可靠）。
     genderName 直接是「男/女」；gender 是数字：1=男 0=女（国内通用约定）。 */
  function pickGender(node, card) {
    var gn = String(card.genderName || node.genderName || card.genderDesc || node.genderDesc || '').trim();
    if (gn === '男' || /^male$/i.test(gn)) return '男';
    if (gn === '女' || /^female$/i.test(gn)) return '女';
    var n = Number(card.gender != null ? card.gender : node.gender);
    if (n === 1) return '男';
    if (n === 0) return '女';
    return '';
  }

  /* 从整个响应里挑出所有「候选人节点」 */
  function extractMap(json) {
    var map = {};
    var seen = 0;
    function visit(node) {
      if (!node || typeof node !== 'object' || seen > 4000) return;
      seen++;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) visit(node[i]);
        return;
      }
      var nm = node.geekName || node.geekNameDesc || node.name || node.userName;
      var isGeek = !!node.geekCard || !!node.geekId || !!node.encryptGeekId || !!node.encryptUserId || !!node.encryptGeekCard;
      if (isGeek) {
        var card = node.geekCard || node;
        var name = nm || card.geekName || card.geekNameDesc || card.name || '';
        var id = node.geekId || node.encryptGeekId || node.encryptUserId ||
                 card.geekId || card.encryptGeekId || card.encryptUserId || '';
        if (name && isNameLike(String(name))) {
          var out = [];
          collectText(card, 0, out);
          var text = out.join(' ');
          var gender = pickGender(node, card);
          var key = String(id || name);
          if (text && (!map[key] || map[key].text.length < text.length)) {
            map[key] = { name: String(name), text: text, gender: gender };
          } else if (map[key] && gender && !map[key].gender) {
            map[key].gender = gender;
          }
          // 姓名索引也存一份，便于 DOM 按姓名匹配
          var nk = 'n:' + String(name);
          if (!map[nk] || map[nk].text.length < text.length) {
            map[nk] = { name: String(name), text: text, gender: gender };
          } else if (map[nk] && gender && !map[nk].gender) {
            map[nk].gender = gender;
          }
        }
      }
      var keys = Object.keys(node);
      for (var j = 0; j < keys.length; j++) visit(node[keys[j]]);
    }
    visit(json);
    return map;
  }

  function mergeIntoAttr(partial) {
    try {
      var html = document.documentElement;
      var prev = {};
      var raw = html.getAttribute(ATTR);
      if (raw) { try { prev = JSON.parse(raw) || {}; } catch (e) { prev = {}; } }
      var changed = false;
      for (var k in partial) {
        if (!Object.prototype.hasOwnProperty.call(partial, k)) continue;
        var a = prev[k], b = partial[k];
        if (!a || (b && b.text && (!a.text || a.text.length <= b.text.length))) {
          if (!a || a.text !== b.text) {
            // 旧条目已有性别而新条目没有 → 合并时带上，避免被长文本覆盖丢掉
            if (a && !b.gender && a.gender) b.gender = a.gender;
            prev[k] = b; changed = true;
          }
        }
        // 保留旧条目，但把新读到的性别补进去
        if (a && prev[k] === a && b && b.gender && !a.gender) { a.gender = b.gender; changed = true; }
      }
      if (!changed) return;
      var s = JSON.stringify(prev);
      if (s.length > MAX_ATTR_BYTES) {
        // 太大就丢掉文本最短的一半，保证属性可用
        var arr = Object.keys(prev).map(function (k) { return [k, prev[k]]; });
        arr.sort(function (x, y) { return (y[1].text || '').length - (x[1].text || '').length; });
        prev = {};
        for (var i = 0; i < Math.min(arr.length, 200); i++) prev[arr[i][0]] = arr[i][1];
        s = JSON.stringify(prev);
      }
      html.setAttribute(ATTR, s);
    } catch (e) { /* ignore */ }
  }

  function looksLikeTarget(url) {
    if (!url) return false;
    return /wapi\/zpjob\/rec\/geek\/list/i.test(url) ||
           /rec\/geek\/list/i.test(url);
  }

  function handleText(text) {
    if (!text || text.length < 200) return;
    if (!/geekName|geekCard|geekDesc|expectPosition|workYear/i.test(text)) return;
    var sig = text.length + ':' + text.slice(0, 64);
    if (recentSig.has(sig)) return;
    recentSig.add(sig);
    if (recentSig.size > 24) recentSig.clear();
    var json;
    try { json = JSON.parse(text); } catch (e) { return; }
    // 剥 zpData 包裹
    if (json && json.zpData) json = json.zpData;
    var map = extractMap(json);
    if (map && Object.keys(map).length) mergeIntoAttr(map);
  }

  /* ---- fetch hook ---- */
  try {
    var origFetch = window.fetch;
    if (origFetch && !origFetch.__bagPatched) {
      var patched = function (input, init) {
        var url = '';
        try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
        var p = origFetch.apply(this, arguments);
        if (looksLikeTarget(url)) {
          try {
            p.then(function (res) {
              try { res.clone().text().then(handleText).catch(function () {}); } catch (e) {}
            }).catch(function () {});
          } catch (e) {}
        }
        return p;
      };
      patched.__bagPatched = true;
      window.fetch = patched;
    }
  } catch (e) {}

  /* ---- XHR hook ---- */
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__bagPatched) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try { this.__bagUrl = url; } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        var self = this;
        try {
          if (looksLikeTarget(self.__bagUrl)) {
            self.addEventListener('load', function () {
              try {
                if (self.responseType === '' || self.responseType === 'text') handleText(self.responseText);
                else if (self.responseType === 'json') {
                  try { handleText(JSON.stringify(self.response)); } catch (e) {}
                }
              } catch (e) {}
            });
          }
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
      XHR.prototype.__bagPatched = true;
    }
  } catch (e) {}
})();
