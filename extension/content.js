/* ============================================================
 * BOSS直聘 · 关键词标注器（只标注，不点击）
 *
 * 安全边界（重要）：
 *   · 不派发任何 pointer / mouse / keyboard 事件
 *   · 不点击页面上任何元素，不打开详情抽屉，不翻页，不自动滚动页面
 *   · 不修改页面 DOM —— 标注画在独立的固定定位悬浮层里（pointer-events:none）
 *   · 只做三件事：读页面文本、读页面文本节点的位置（Range，只读）、读 inject.js 捕获的接口数据
 *
 * 唯二会动到页面的地方，都由你主动触发：
 *   1. 点面板里的「定位」→ 仅调用 scrollIntoView 把该候选人滚到视野中央
 *   2. 点自己浮层上的「✓」→ 标记为已打招呼（只写本地存储）
 *
 * 标注规则：
 *   · 候选人卡片框 —— 按命中的「不同关键词个数」分三档配色
 *       1 个 → 蓝  2 个 → 橙  3 个及以上 → 红
 *   · QS 名校格外标记 —— 勾选后，QS 前 50 / 前 100 大学的简历会额外突出：
 *       卡片框外套一圈校色光环、角标前加「🎓 QS50」徽标、
 *       清单整行换校色并排到最前面
 *       前 50 → 紫 #7c3aed   前 100 → 青 #0e7490
 *       名单见 qs-rankings.js（QS 2026 前 100），纯文本匹配，不发任何请求
 *   · 详情浮层区域框 —— 同一套配色，命中数按该区域文本重算
 *   · 关键词文字高亮 —— 页面里每个关键词出现的位置都标出来（详情页同样持续标注）
 * ============================================================ */
(() => {
  'use strict';
  if (window.__BAG_CONTENT__) return;
  window.__BAG_CONTENT__ = true;

  /* ================= 工具 ================= */
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
    return String(h >>> 0);
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  }
  const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* ================= 配置 ================= */
  const DEFAULT_CONFIG = {
    keywords: ['美股', '投资者关系', 'IR'],
    showBadge: true,         // 显示角标
    highlightText: true,     // 高亮页面文本里关键词所在的位置（详情页同样生效）
    highlightInCard: false,  // 命中的卡片内部也逐词高亮
    qsTop50: false,          // 格外标记 QS 前 50 大学的简历
    qsTop100: false,         // 格外标记 QS 前 100 大学的简历
    /* ---- 免费筛选（对齐 BOSS 的 VIP 筛选，只动边框和标签，不遮内容） ---- */
    ageMin: '',              // 年龄下限（数字字符串，'' = 不限）
    ageMax: '',              // 年龄上限
    eduTier: 'any',          // 院校: any | 985 | 211 | qs100
    activityMin: 'any',      // 活跃度: any | 5(刚刚) | 4(今日) | 3(3日内) | 2(本周) | 1(本月)
    majorKw: ''              // 专业关键词（逗号分隔，任一命中即符合）
  };
  let config = { ...DEFAULT_CONFIG };

  const GREET_TEXTS = ['打招呼', '立即沟通', '继续沟通'];
  const GREETED_TEXTS = ['继续沟通', '立即沟通'];

  /* ================= 命中等级配色 ================= */
  const LEVELS = {
    1: { color: '#2f6fed', box: 'rgba(47,111,237,.05)',  mark: 'rgba(47,111,237,.18)', glow: 'rgba(47,111,237,.35)' },
    2: { color: '#e8890c', box: 'rgba(232,137,12,.07)',  mark: 'rgba(232,137,12,.20)', glow: 'rgba(232,137,12,.35)' },
    3: { color: '#d93025', box: 'rgba(217,48,37,.055)',  mark: 'rgba(217,48,37,.18)',  glow: 'rgba(217,48,37,.35)' }
  };
  const levelOf = n => (n >= 3 ? 3 : (n === 2 ? 2 : 1));

  /* ================= QS 名校识别（只读文本匹配，不发请求） ================= */
  const QS_LEVELS = {
    50:  { color: '#7c3aed', box: 'rgba(124,58,237,.055)', mark: 'rgba(124,58,237,.20)', glow: 'rgba(124,58,237,.45)', tag: 'QS50' },
    100: { color: '#0e7490', box: 'rgba(14,116,144,.055)',  mark: 'rgba(14,116,144,.20)',  glow: 'rgba(14,116,144,.42)', tag: 'QS100' }
  };
  /** 关键词等级 + 名校档位 → 取一个可用配色（没有关键词命中时退化到校色） */
  const levelStyle = (lv, tier) => LEVELS[lv] || QS_LEVELS[tier] || LEVELS[1];
  const qsEnabled = () => !!(config.qsTop50 || config.qsTop100);
  /** 生效的最高档：只勾了前 50 → 50；勾了前 100（或都勾）→ 100 */
  const qsMaxRank = () => (config.qsTop100 ? 100 : (config.qsTop50 ? 50 : 0));
  const schoolTier = rank => (rank <= 50 ? 50 : 100);

  /* 名单来自 qs-rankings.js（QS 2026 前 100），这里只建索引 */
  const qsIndex = (() => {
    const raw = (window.__QS_RANKINGS__ && window.__QS_RANKINGS__.schools) || [];
    const schools = [];
    const owner = new Map();          // 别名 key -> 使用它的学校下标
    const asciiKeys = new Set();
    const cnKeys = new Set();
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      const aliases = [];
      const add = (value, strong) => {
        const text = String(value || '').trim();
        if (!text) return;
        const ascii = /^[\x00-\x7F]+$/.test(text);
        if (ascii && text.length < 3) return;      // 英文别名太短容易乱命中（UM / BU / KU）
        if (!ascii && text.length < 2) return;
        const key = ascii ? text.toLowerCase() : text;
        if (aliases.some(a => a.key === key)) return;
        aliases.push({ key, text, ascii, strong, re: null, school: i });
        (ascii ? asciiKeys : cnKeys).add(key);
        if (!owner.has(key)) owner.set(key, []);
        const arr = owner.get(key);
        if (arr.indexOf(i) < 0) arr.push(i);
      };
      add(s.zh, true);                       // 中文全名 = 强别名
      add(s.en, true);                       // 英文全名 = 强别名
      (s.a || []).forEach(v => add(v, false)); // 简称 = 弱别名
      if (aliases.length) schools.push({ rank: s.r, zh: s.zh, en: s.en, country: s.c || '', aliases });
    }

    // 1) 跨校后缀保护
    //    「City University of Hong Kong」里含「University of Hong Kong」，
    //    不保护的话城大的人会被同时标成港大。给被包含的一方加负向后顾。
    //    注意：同校内部的后缀关系（如 Osaka ⊂ University of Osaka）不处理，
    //    否则「University of Osaka」会因为排除 of 而两边都失配。
    const flat = [];
    for (const s of schools) for (const a of s.aliases) if (a.ascii) flat.push(a);
    for (const t of flat) {
      const guards = new Set();
      for (const o of flat) {
        if (o === t || o.school === t.school) continue;
        if (o.key.length > t.key.length && o.key.endsWith(' ' + t.key)) {
          const head = o.key.slice(0, o.key.length - t.key.length - 1).split(' ').pop();
          if (head && /^[a-z0-9]+$/.test(head)) guards.add(head);
        }
      }
      const g = Array.from(guards).map(x => '(?<!' + escapeRe(x) + ' )').join('');
      try {
        t.re = new RegExp(g + '(?<![a-z0-9])' + escapeRe(t.key) + '(?![a-z0-9])');
      } catch (e) { t.re = null; }     // 环境不支持 lookbehind 时退化为 indexOf
    }

    // 2) 粗筛正则：文本里连一个校名/简称都没出现 → 直接跳过整轮扫描
    let anyEn = null, anyCn = null;
    try {
      anyEn = new RegExp('(?<![a-z0-9])(?:' + Array.from(asciiKeys).map(escapeRe).join('|') + ')(?![a-z0-9])');
    } catch (e) { anyEn = null; }
    try {
      anyCn = new RegExp(Array.from(cnKeys).map(escapeRe).join('|'));
    } catch (e) { anyCn = null; }

    return { schools, owner, anyEn, anyCn };
  })();

  /** 该别名是否被多所学校共用（如 NTU = 南洋理工 / 台湾大学）→ 结果标记为「待确认」 */
  const qsAmbiguous = key => {
    const arr = qsIndex.owner.get(key);
    return !!(arr && arr.length > 1);
  };

  const QS_MAX_HIT = 4;        // 一份简历最多认定 4 所，防止异常长文本拖慢

  /* 深圳等分校区不算本部：简历写「香港中文大学（深圳）」时，
     不能因为命中「香港中文大学」就按 QS 前 50 的港中文本部标注 */
  const BRANCH_TRAP = /香港中文大学\s*[（(]\s*深圳/;

  /** 返回命中的 QS 名校（按排名升序），命中数决定「格外标记」的档位 */
  function matchSchools(text, capOverride) {
    const cap = Math.max(qsMaxRank(), Number(capOverride) || 0);
    if (!text || !cap) return [];
    const low = text.toLowerCase();
    // 粗筛：两所学校的名字都没沾到就直接返回，省掉 100 所 × 400 别名的扫描
    const coarse = (qsIndex.anyEn && qsIndex.anyEn.test(low)) ||
                   (qsIndex.anyCn && qsIndex.anyCn.test(text));
    if (!coarse) return [];
    const out = [];
    for (const s of qsIndex.schools) {
      if (s.rank > cap) continue;
      if (s.zh === '香港中文大学' && BRANCH_TRAP.test(text)) continue; // 分校区 ≠ 本部
      let via = '', weak = false;
      for (const al of s.aliases) {
        const ok = al.ascii
          ? (al.re ? al.re.test(low) : low.indexOf(al.key) >= 0)
          : cnHit(text, al.key);
        if (!ok) continue;
        if (al.strong) { via = al.text; weak = false; break; }   // 全名命中，最确定
        const amb = qsAmbiguous(al.key);
        if (!via || (weak && !amb)) { via = al.text; weak = amb; } // 有更确定的别名就换掉
        if (!weak) break;
      }
      if (!via) continue;
      out.push({
        rank: s.rank, zh: s.zh, en: s.en, country: s.country,
        via, weak, tier: schoolTier(s.rank)
      });
      if (out.length >= QS_MAX_HIT) break;
    }
    out.sort((a, b) => a.rank - b.rank);
    return out;
  }

  /** 名校名称显示：弱命中（缩写有歧义）加「?」并回退到缩写本身 */
  const schoolLabel = s => (s.weak ? s.via + '?' : s.zh);

  /* ================= 985 / 211 院校识别（免费筛选「院校」用） ================= */

  /* 中文简称歧义保护：简称前面出现这些字时不算命中（nb = not-before）。
     湖北大学 ≠ 北大 · 佛山/燕山大学 ≠ 山大 · 墨西哥大学 ≠ 哥大
     华东/西南政法大学 ≠ 法大 · 江苏大学 ≠ 苏大 · 山西电大 ≠ 西电
     杭州/西安/桂林电子科技大学 ≠ 电子科技大学(985) —— 紧邻字是 州/安/林
     上海对外经贸大学 ≠ 对外经贸（紧邻字是 海）
     na = not-after：西交利物浦大学 —— "西交"位于句首时前面没字可查，查后面 */
  const CN_ALIAS_GUARDS = {
    '北大': ['东', '河', '湖', '台', '桂', '鄂', '冀', '云'],
    '山大': ['中', '佛', '燕', '昆', '台', '唐', '乐', '岐', '文', '龙'],
    '哥大': ['墨'],
    '法大': ['政'],
    '苏大': ['江'],
    '北外': ['河', '湖', '豫', '冀'],
    '西电': ['山'],
    '电子科技大学': ['州', '安', '林'],
    '对外经贸': ['海'],
    '对外经济贸易大学': ['海'],
    '西交': { na: ['利'] }
  };

  /** 中文别名命中（带歧义保护：nb 查紧邻前字，na 查紧邻后字） */
  function cnHit(text, alias) {
    let nb = null, na = null;
    const g = CN_ALIAS_GUARDS[alias];
    if (Array.isArray(g)) nb = g;
    else if (g) { nb = g.nb || null; na = g.na || null; }
    let from = 0;
    for (let guard = 0; guard < 20; guard++) {
      const i = text.indexOf(alias, from);
      if (i < 0) return false;
      const before = i > 0 ? text[i - 1] : '';
      const after = i + alias.length < text.length ? text[i + alias.length] : '';
      if (nb && nb.includes(before)) { from = i + 1; continue; }
      if (na && na.includes(after)) { from = i + 1; continue; }
      return true;
    }
    return false;
  }

  const eduIndex = (() => {
    const R = window.__QS_RANKINGS__ || {};
    const mk = (list, tier) => (list || []).map(x => {
      const s = typeof x === 'string' ? { n: x, a: [] } : x;
      return { zh: s.n, tier, aliases: [s.n].concat(s.a || []) };
    });
    return { 985: mk(R.cn985, '985'), 211: mk(R.cn211, '211') };
  })();

  /** 返回命中的国内 985/211 校名（含简称），985 兼有 211 */
  function matchDomesticEdu(text) {
    if (!text) return { is985: false, is211: false, hits: [] };
    const out = { is985: false, is211: false, hits: [] };
    const LIMIT = 4;
    for (const tier of ['985', '211']) {
      for (const s of eduIndex[tier]) {
        if (s.matched) continue;
        for (const al of s.aliases) {
          if (cnHit(text, al)) {
            s.matched = true;
            out.hits.push({ zh: s.zh, tier });
            if (tier === '985') { out.is985 = true; out.is211 = true; }
            else out.is211 = true;
            break;
          }
        }
        if (out.hits.length >= LIMIT) break;
      }
      if (out.hits.length >= LIMIT) break;
    }
    for (const tier of ['985', '211']) eduIndex[tier].forEach(s => { delete s.matched; });
    out.hits.sort((a, b) => (a.tier === '985' ? -1 : 1));
    return out;
  }

  /* ================= 免费筛选：单卡条件解析（纯读文本） ================= */
  const ACTIVITY_LEVELS = { '刚刚活跃': 5, '今日活跃': 4, '3日内活跃': 3, '本周活跃': 2, '本月活跃': 1 };

  /** 年龄：卡片/接口文本里的「28岁」 */
  function parseAge(text) {
    const m = String(text || '').match(/(\d{1,2})\s*岁/);
    if (!m) return null;
    const n = Number(m[1]);
    return (n >= 16 && n <= 65) ? n : null;
  }

  /** 活跃度：返回 { text, level } 或 null */
  function parseActivity(text) {
    const m = String(text || '').match(/(刚刚活跃|今日活跃|3日内活跃|本周活跃|本月活跃)/);
    return m ? { text: m[1], level: ACTIVITY_LEVELS[m[1]] } : null;
  }

  /** 专业关键词命中（逗号分隔，任一命中即算） */
  function matchMajors(text) {
    const kws = String(config.majorKw || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    if (!kws.length || !text) return [];
    return kws.filter(kw => matchOne(text, kw));
  }

  /** 是否启用了任意筛选条件（性别筛选已删：BOSS 不在列表页/接口给可靠性别，推断不可靠） */
  function filterActive() {
    return !!(config.ageMin || config.ageMax ||
      (config.eduTier && config.eduTier !== 'any') ||
      (config.activityMin && config.activityMin !== 'any') ||
      (config.majorKw || '').trim());
  }

  /**
   * 对单张卡片做筛选判定。finfo = { age, activity, edu985, edu211, eduQs, majors }
   * 返回 { pass, fails:[] }（fails 用于面板提示哪条不满足）
   */
  function checkFilters(f) {
    const fails = [];
    if (config.ageMin && (f.age === null || f.age < Number(config.ageMin))) fails.push('年龄');
    if (config.ageMax && (f.age === null || f.age > Number(config.ageMax))) fails.push('年龄');
    if (config.eduTier === '985' && !f.edu985) fails.push('院校');
    if (config.eduTier === '211' && !f.edu211) fails.push('院校');
    if (config.eduTier === 'qs100' && !f.eduQs) fails.push('院校');
    if (config.activityMin && config.activityMin !== 'any') {
      if (!f.activity || f.activity.level < Number(config.activityMin)) fails.push('活跃度');
    }
    if (String(config.majorKw || '').trim() && !f.majors.length) fails.push('专业');
    return { pass: !fails.length, fails };
  }

  /** 符合筛选时角标上的短标签 */
  function filterTags(f) {
    const t = [];
    if (f.edu985) t.push('985');
    else if (f.edu211) t.push('211');
    else if (f.eduQs) t.push('QS100');
    if (f.age !== null) t.push(f.age + '岁');
    if (f.activity) t.push(f.activity.text);
    if (f.majors.length) t.push(f.majors[0]);
    return t;
  }

  /* ================= 状态 ================= */
  let entries = [];              // [{key, name, kws:[], schools:[], level, tier, finfo, fpass, card, done}]
  let hitCardSet = new Set();    // 命中卡片元素集合（元素身份比对，避免每帧重算文本）
  let failCardMap = new Map();   // 未通过免费筛选的卡片 -> 不满足的条件数组（不遮内容，只打灰框灰标）
  let filterStats = { active: false, pass: 0, total: 0 };
  let scannedCount = 0;
  const doneKeys = new Set();
  const flashMap = new Map();    // key -> 高亮截止时间
  let workerActive = false;
  let marksHidden = false;

  const todayKey = () => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /* ================= 卡片读取 ================= */
  const CARD_SEL = '.candidate-card-wrap, .card-item, [class*="candidate-card"]';

  function collectCards() {
    let nodes = Array.from(document.querySelectorAll('.candidate-card-wrap'));
    if (!nodes.length) nodes = Array.from(document.querySelectorAll('.card-item'));
    if (!nodes.length) nodes = Array.from(document.querySelectorAll('[class*="candidate-card"]'));
    return nodes.filter(el => el.isConnected && el.getBoundingClientRect().height > 40);
  }
  const cardCount = () => collectCards().length;

  const cardTextOf = el => norm(el.innerText || el.textContent || '');

  function nameOf(card) {
    const cands = card.querySelectorAll('[class*="name"]');
    for (const el of cands) {
      const t = norm(el.innerText);
      if (/^[\u4e00-\u9fa5]{2,4}(女士|先生)?$/.test(t)) return t.replace(/(女士|先生)$/, '');
    }
    const first = (card.innerText || '').split('\n').map(norm).find(Boolean) || '';
    const m = first.match(/^([\u4e00-\u9fa5]{2,4})(女士|先生)?/);
    return m ? m[1] : '未识别';
  }

  function idOf(card) {
    const el = card.matches('[data-geekid],[data-id],[data-userid]')
      ? card
      : card.querySelector('[data-geekid],[data-id],[data-userid]');
    if (!el) return '';
    return el.getAttribute('data-geekid') || el.getAttribute('data-id') || el.getAttribute('data-userid') || '';
  }

  function cardKey(card) {
    const id = idOf(card);
    if (id) return 'id:' + id;
    let t = cardTextOf(card);
    for (const g of GREET_TEXTS) t = t.split(g).join('');
    return 'nm:' + nameOf(card) + ':' + hashCode(t.slice(0, 160));
  }

  /* ---- 接口增强文本（inject.js 写入的 <html> 属性，纯被动读取） ---- */
  let mapCache = null, mapCacheAt = 0;
  function geekTextMap() {
    if (mapCache && Date.now() - mapCacheAt < 1500) return mapCache;
    let m = null;
    try {
      const raw = document.documentElement.getAttribute('data-bag-geek-text');
      if (raw) m = JSON.parse(raw);
    } catch (e) { m = null; }
    mapCache = m; mapCacheAt = Date.now();
    return m;
  }

  function enrichedText(card) {
    let t = cardTextOf(card);
    const map = geekTextMap();
    if (map) {
      const nm = nameOf(card);
      if (nm && map['n:' + nm]) t += '\n' + map['n:' + nm].text;
      const id = idOf(card);
      if (id && map[id]) t += '\n' + map[id].text;
    }
    return t;
  }

  /* ================= 关键词匹配 ================= */
  function matchOne(text, kw) {
    const k = String(kw || '').trim();
    if (!k) return false;
    if (k.length <= 4 && /^[A-Za-z0-9.+#/-]+$/.test(k)) {
      // 英文短词（IR 等）按整词边界匹配，避免命中 first / their / IRR / irq
      try {
        return new RegExp('(^|[^A-Za-z0-9])' + escapeRe(k) + '([^A-Za-z0-9]|$)', 'g').test(text);
      } catch (e) { return text.includes(k); }
    }
    return text.includes(k);
  }
  /** 返回命中的「不同关键词」列表（去重，按你填写的顺序） */
  function matchAll(text) {
    if (!text) return [];
    const out = [];
    for (const kw of config.keywords) if (matchOne(text, kw)) out.push(kw);
    return out;
  }
  /** 从 from 位置往后找下一个命中，返回 {start,end}；整词匹配时不越界 */
  function nextHit(text, kw, from) {
    const k = String(kw || '').trim();
    if (!k) return null;
    if (k.length <= 4 && /^[A-Za-z0-9.+#/-]+$/.test(k)) {
      let re;
      try { re = new RegExp('(^|[^A-Za-z0-9])(' + escapeRe(k) + ')([^A-Za-z0-9]|$)', 'g'); }
      catch (e) { re = null; }
      if (re) {
        re.lastIndex = from;
        const m = re.exec(text);
        if (!m) return null;
        const start = m.index + m[1].length;
        return { start, end: start + k.length };
      }
    }
    const i = text.indexOf(k, from);
    if (i < 0) return null;
    return { start: i, end: i + k.length };
  }

  /* ================= 打招呼按钮状态（只读，绝不点击） ================= */
  function findGreetBtn(root) {
    const list = (root || document).querySelectorAll(
      'button,a,[role="button"],[class*="btn-greet"],[class*="greet"],[class*="btn-start"]'
    );
    for (const el of list) {
      const t = norm(el.textContent);
      if (GREET_TEXTS.includes(t) && isVisible(el)) return { btn: el, text: t };
    }
    return null;
  }

  /* ================= 已打招呼记录（本地存储） ================= */
  let saveTimer = null;
  function saveDone() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await chrome.storage.local.set({ ['bag:done:' + todayKey()]: Array.from(doneKeys).slice(-3000) });
      } catch (e) {}
    }, 600);
  }
  async function loadDone() {
    try {
      const k = 'bag:done:' + todayKey();
      const o = await chrome.storage.local.get([k]);
      (o[k] || []).forEach(x => doneKeys.add(x));
    } catch (e) {}
  }

  /* ================= 页面文本里的关键词定位（只读，用 Range 取坐标） ================= */
  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1,
    SELECT: 1, OPTION: 1, SVG: 1, TITLE: 1
  };

  let textNodeCache = null;
  let hitRanges = [];            // [{node, start, end, kw, lv}]
  let rangesDirty = true;
  let detailInfo = null;         // { el, kws:[], level }
  let detailBoost = null;        // { name, kws:[] } —— 详情里多出来的命中，回填到该候选人
  let lastScrollAt = 0;

  function collectTextNodes(root) {
    const out = [];
    let walker;
    try { walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null); }
    catch (e) { return out; }
    let n, guard = 0;
    while ((n = walker.nextNode())) {
      if (++guard > 8000) break;
      const v = n.nodeValue;
      if (!v) continue;
      if (v.length < 2 || v.length > 5000) continue;   // 关键词最短 2 字符
      const p = n.parentElement;
      if (!p || SKIP_TAGS[p.tagName]) continue;
      out.push(n);
    }
    return out;
  }
  function textNodes() {
    if (!textNodeCache) textNodeCache = collectTextNodes(document.body || document.documentElement);
    return textNodeCache;
  }

  /**
   * 找当前打开的大浮层（详情抽屉 / 详情弹窗）。
   * 启发式，找不到就只做文字高亮、不画区域框，功能不降级。
   */
  function findDetailRoot() {
    if (!document.body) return null;
    const vw = window.innerWidth, vh = window.innerHeight;
    const vArea = vw * vh;
    const cands = [];
    const list = document.querySelectorAll('div,section,aside,main');
    for (const el of list) {
      if (el.id === 'bag-mark-host') continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < vArea * 0.3) continue;
      if (r.width < 260 || r.height < 200) continue;
      if (r.right < 60 || r.bottom < 60 || r.left > vw - 60 || r.top > vh - 60) continue;
      cands.push({ el, area });
    }
    if (!cands.length) return null;
    // getComputedStyle 很贵，只对面积最大的几个候选做判断
    cands.sort((a, b) => b.area - a.area);
    for (const c of cands.slice(0, 4)) {
      const el = c.el;
      if (el.closest(CARD_SEL)) continue;                       // 卡片内部不算
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (st.position !== 'fixed' && st.position !== 'absolute') continue;
      if (el.querySelectorAll(CARD_SEL).length >= 2) continue;  // 列表容器不算
      return el;
    }
    return null;
  }

  /* 详情容器探测节流：同一容器 2.5 秒内不重复全量扫描 */
  let detailRootCache = null, detailRootAt = 0;
  function detailRootThrottled() {
    const now = Date.now();
    if (detailRootCache && detailRootCache.isConnected && now - detailRootAt < 2500) {
      const r = detailRootCache.getBoundingClientRect();
      if (r.width > 120 && r.height > 120) return detailRootCache;
    }
    const el = findDetailRoot();
    detailRootCache = el || null;
    detailRootAt = now;
    return el;
  }

  function computeRanges() {
    rangesDirty = false;
    hitRanges = [];
    detailInfo = null;
    if (!config.highlightText || !document.body) return;

    const det = detailRootThrottled();
    if (det) {
      const dt = det.textContent || '';
      const kws = matchAll(dt);
      const schools = matchSchools(dt);
      if (kws.length || schools.length) {
        detailInfo = {
          el: det, kws, schools,
          level: kws.length ? levelOf(kws.length) : 0,
          tier: schools.length ? schools[0].tier : 0
        };
      }
    }
    const detLv = detailInfo ? levelStyle(detailInfo.level, detailInfo.tier) : null;

    const vh = window.innerHeight;
    const lo = -vh * 1.6, hi = vh * 2.6;
    const nodes = textNodes();
    const acc = [];
    const LIMIT = 400;
    const vW = window.innerWidth, vH = window.innerHeight;
    const rg = document.createRange();

    for (const node of nodes) {
      const p = node.parentElement;
      if (!p || !p.isConnected) continue;
      const pr = p.getBoundingClientRect();
      if (pr.bottom < lo || pr.top > hi) continue;
      const inDetail = !!(detailInfo && detailInfo.el.contains(p));
      if (!inDetail && !config.highlightInCard && p.closest(CARD_SEL)) continue;

      // 不可见文本（隐藏 / 透明 / 零字号）不标 —— 否则详情页会冒出悬空色块
      const st = getComputedStyle(p);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (Number(st.opacity) < 0.05 || parseFloat(st.fontSize) === 0) continue;
      if (/^rgba\(\d+,\d+,\d+,0\)$/.test(st.color.replace(/\s/g, ''))) continue;

      const lv = inDetail ? detLv : LEVELS[1];
      const text = node.nodeValue;
      for (const kw of config.keywords) {
        let from = 0, guard = 0;
        while (guard++ < 40) {
          const h = nextHit(text, kw, from);
          if (!h) break;
          from = h.end;
          // 命中处必须真实可见：拿一个矩形中心做命中测试，被无关元素盖住的不标
          let ok = false;
          try {
            rg.setStart(node, h.start);
            rg.setEnd(node, h.end);
            const rects = rg.getClientRects();
            for (let k = 0; k < rects.length; k++) {
              const rc = rects[k];
              if (rc.width < 3 || rc.height < 4) continue;
              if (rc.bottom < 0 || rc.top > vH || rc.right < 0 || rc.left > vW) continue;
              const cx = Math.min(Math.max(rc.left + rc.width / 2, 0), vW - 1);
              const cy = Math.min(Math.max(rc.top + rc.height / 2, 0), vH - 1);
              const hitEl = document.elementFromPoint(cx, cy);
              if (!hitEl || hitEl === p || p.contains(hitEl) || hitEl.contains(p)) { ok = true; break; }
              // 命中的是无关元素 → 这处文本被盖住了，跳过
            }
          } catch (err) { ok = true; }
          if (!ok) continue;
          acc.push({ node, start: h.start, end: h.end, kw, lv });
          if (acc.length >= LIMIT) break;
        }
        if (acc.length >= LIMIT) break;
      }
      if (acc.length >= LIMIT) break;
    }
    hitRanges = acc;
  }

  /** 详情里命中的关键词 / 名校回填给同名候选人 —— 打开详情后卡片框等级会升上去 */
  function syncDetailBoost() {
    detailBoost = null;
    if (!detailInfo || !entries.length) return;
    if (!detailInfo.kws.length && !detailInfo.schools.length) return;
    const t = (detailInfo.el.textContent || '').slice(0, 400);
    let best = '';
    for (const e of entries) {
      if (!e.name || e.name === '未识别' || e.name.length < 2) continue;
      if (!t.includes(e.name)) continue;
      if (e.name.length > best.length) best = e.name;
    }
    if (best) detailBoost = { name: best, kws: detailInfo.kws, schools: detailInfo.schools };
  }

  /* ================= 扫描（纯读取） ================= */
  function scan() {
    const cards = collectCards();
    scannedCount = cards.length;
    const out = [];
    const qsOn = qsEnabled();
    const fActive = filterActive();
    const needAge = fActive && !!(config.ageMin || config.ageMax);
    const needAct = fActive && config.activityMin && config.activityMin !== 'any';
    const needEdu = fActive && config.eduTier && config.eduTier !== 'any';
    const needMajor = fActive && !!String(config.majorKw || '').trim();
    const failed = new Map();
    let fPassCount = 0;

    for (const card of cards) {
      const key = cardKey(card);
      const name = nameOf(card);

      // 被动观察：按钮已是「继续沟通 / 立即沟通」→ 说明打过招呼了，自动打勾
      const g = findGreetBtn(card);
      if (g && GREETED_TEXTS.includes(g.text) && !doneKeys.has(key)) {
        doneKeys.add(key);
        saveDone();
      }

      const text = enrichedText(card);

      /* ---- 免费筛选判定：对每张卡都做（不符合的打灰框灰标，不遮内容） ---- */
      let finfo = null, fpass = true, ffails = [];
      if (fActive) {
        finfo = {
          age: needAge ? parseAge(text) : null,
          activity: needAct ? parseActivity(text) : null,
          edu985: false, edu211: false, eduQs: false,
          majors: needMajor ? matchMajors(text) : []
        };
        if (needEdu) {
          if (config.eduTier === '985') {
            const r = matchDomesticEdu(text);
            finfo.edu985 = r.is985; finfo.edu211 = r.is211;
          } else if (config.eduTier === '211') {
            finfo.edu211 = matchDomesticEdu(text).is211;
          } else if (config.eduTier === 'qs100') {
            finfo.eduQs = matchSchools(text, 100).length > 0;
          }
        }
        const chk = checkFilters(finfo);
        fpass = chk.pass; ffails = chk.fails;
        if (fpass) fPassCount++; else failed.set(card, ffails);
      }

      let kws = matchAll(text);
      let schools = qsOn ? matchSchools(text) : [];

      // 详情浮层里读到的额外命中，回填给同名候选人
      if (detailBoost && detailBoost.name === name) {
        if (detailBoost.kws.length) kws = Array.from(new Set(kws.concat(detailBoost.kws)));
        if (detailBoost.schools.length) {
          const seen = new Set(schools.map(s => s.rank + ':' + s.zh));
          for (const s of detailBoost.schools) {
            const k = s.rank + ':' + s.zh;
            if (!seen.has(k)) { seen.add(k); schools.push(s); }
          }
          schools.sort((a, b) => a.rank - b.rank);
        }
      }

      // 关键词、名校只要沾一个就收录（勾了名校后，没关键词但名校背景的简历也会被标出来）
      if (!kws.length && !schools.length) continue;

      out.push({
        key, name, kws, schools,
        level: kws.length ? levelOf(kws.length) : 0,
        tier: schools.length ? schools[0].tier : 0,
        finfo, fpass, ffails,
        card, done: doneKeys.has(key)
      });
    }
    entries = out;
    hitCardSet = new Set(out.map(e => e.card));
    failCardMap = failed;
    filterStats = { active: fActive, pass: fPassCount, total: scannedCount };
  }

  /* ================= 悬浮标注层 ================= */
  let host = null, shadow = null, layer = null, listBox = null;
  const badgeMap = new Map();     // key -> {rectEl, badgeEl}
  let collapsed = false;
  let lastStructural = '';

  function mountUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'bag-mark-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .layer { position:absolute; inset:0; pointer-events:none; }
        .hl {
          position:absolute; border:2px solid #2f6fed; border-radius:10px;
          background: rgba(47,111,237,.05); pointer-events:none;
          transition: box-shadow .2s ease, border-color .2s ease;
        }
        .hl.done { outline:2px solid #12a150; outline-offset:1px; }
        .kwm {
          position:absolute; border-radius:3px; pointer-events:none;
          background: rgba(47,111,237,.18); border-bottom:2px solid #2f6fed;
        }
        .hlf {
          position:absolute; border:2px dashed #b9bfca; border-radius:10px;
          background: transparent; pointer-events:none;
        }
        .fbadge {
          position:absolute; display:flex; align-items:center; gap:3px;
          font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
          font-size:10px; font-weight:600; line-height:1; padding:3px 6px;
          border-radius:6px; color:#5f6673; white-space:nowrap;
          background:#f1f2f5; border:1px solid #dfe2e8;
          pointer-events:none;
        }
        .badge {
          position:absolute; display:flex; align-items:center; gap:4px;
          font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
          font-size:11px; font-weight:600; line-height:1; padding:4px 6px 4px 8px;
          border-radius:7px; color:#fff; white-space:nowrap;
          max-width:calc(100vw - 32px);
          background:#2f6fed; box-shadow:0 2px 8px rgba(20,28,45,.22);
          pointer-events:none;
        }
        .badge .lbl { min-width:0; overflow:hidden; text-overflow:ellipsis; }
        .badge.done { background:#12a150; }
        .badge.dt { font-size:10.5px; padding:3px 7px; opacity:.96; }
        .badge .sch {
          font-size:9.5px; font-weight:700; padding:2px 4px; border-radius:4px;
          background:#fff; letter-spacing:.2px; flex:none;
        }
        .badge .sch.s50 { color:#7c3aed; }
        .badge .sch.s100 { color:#0e7490; }
        .badge .tick {
          pointer-events:auto; cursor:pointer; font-size:11px; padding:1px 4px;
          border-radius:4px; background:rgba(255,255,255,.22);
        }
        .badge .tick:hover { background:rgba(255,255,255,.42); }

        .panel {
          position:fixed; right:16px; bottom:16px; width:272px; pointer-events:auto;
          font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
          background:#fff; color:#1b1f27; border:1px solid #e3e6ec; border-radius:12px;
          box-shadow:0 10px 30px rgba(20,28,45,.16); overflow:hidden; font-size:12px;
        }
        .hd { display:flex; align-items:center; gap:7px; padding:9px 11px; background:#0f1724; color:#fff; }
        .dot { width:8px; height:8px; border-radius:50%; background:#8b93a7; flex:none; }
        .dot.on { background:#d93025; box-shadow:0 0 0 3px rgba(217,48,37,.2); }
        .ttl { font-weight:600; font-size:12px; }
        .hd .sp { flex:1; }
        .ico { width:21px; height:21px; line-height:19px; text-align:center; border-radius:6px;
               background:rgba(255,255,255,.1); color:#fff; cursor:pointer; user-select:none; font-size:13px; }
        .ico:hover { background:rgba(255,255,255,.2); }
        .bd { padding:9px 11px 11px; }
        .bd.hide { display:none; }
        .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; margin-bottom:7px; }
        .cell { background:#f6f7f9; border-radius:8px; padding:6px 2px; text-align:center; }
        .cell b { display:block; font-size:15px; line-height:1.25; }
        .cell span { font-size:9px; color:#79808f; }
        .cell.hi b { color:#d93025; }
        .cell.ok b { color:#12a150; }
        .cell.qs b { color:#7c3aed; }
        .lg { display:flex; gap:7px; font-size:9.5px; color:#79808f; margin-bottom:7px;
              background:#f6f7f9; border-radius:7px; padding:5px 7px; }
        .lg i { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:3px;
                vertical-align:-1px; }
        .lg b { color:#1b1f27; }
        .lg .on { color:#1b1f27; font-weight:600; }
        .dtline {
          font-size:10.5px; line-height:1.5; border-radius:7px; padding:5px 7px; margin-bottom:7px;
          background:#f0f4ff; color:#2b3446; border-left:3px solid #2f6fed; display:none;
        }
        .list { max-height:186px; overflow:auto; border-top:1px dashed #e6e8ee; padding-top:6px; }
        .row { display:flex; align-items:center; gap:6px; padding:4px 4px 4px 7px; border-radius:6px; }
        .row:hover { background:#f4f6fa; }
        .pin { width:8px; height:8px; border-radius:2px; flex:none; }
        .row .nm { font-weight:600; min-width:42px; }
        .row .kwt { flex:1; color:#8a91a1; font-size:10.5px; overflow:hidden;
                   text-overflow:ellipsis; white-space:nowrap; }
        .row.lv1 { background:rgba(47,111,237,.06);  box-shadow:inset 3px 0 0 #2f6fed; }
        .row.lv2 { background:rgba(232,137,12,.08);  box-shadow:inset 3px 0 0 #e8890c; }
        .row.lv3 { background:rgba(217,48,37,.075); box-shadow:inset 3px 0 0 #d93025; }
        .row.lv1 .nm { color:#1a56c4; }
        .row.lv2 .nm { color:#a05e00; }
        .row.lv3 .nm { color:#c02a20; }
        .row.lv1 .kwt { color:#3b6ef5; }
        .row.lv2 .kwt { color:#c77714; }
        .row.lv3 .kwt { color:#d13a30; }
        /* 名校命中：整行换校色，压过上面的关键词等级样式 */
        .row.s50  { background:rgba(124,58,237,.075); box-shadow:inset 3px 0 0 #7c3aed; }
        .row.s100 { background:rgba(14,116,144,.075); box-shadow:inset 3px 0 0 #0e7490; }
        .row.s50 .nm, .row.s50 .kwt  { color:#5b21b6; }
        .row.s100 .nm, .row.s100 .kwt { color:#0e7490; }
        .row button { cursor:pointer; border:none; border-radius:5px; font-size:10.5px;
                      padding:3px 7px; font-family:inherit; }
        .row .go { background:#eef1f6; color:#39415a; }
        .row .go:hover { background:#e2e7ef; }
        .row .tk { background:#fdecea; color:#c5221f; }
        .row .tk.on { background:#e7f6ee; color:#12a150; }
        .empty { color:#9aa1af; text-align:center; padding:14px 0; line-height:1.6; }
        .ft { display:flex; gap:6px; margin-top:9px; }
        .ft button { flex:1; border:none; border-radius:8px; padding:7px 0; font-size:12px;
                     font-weight:600; cursor:pointer; font-family:inherit;
                     background:#eef1f6; color:#39415a; }
        .ft button:hover { background:#e2e7ef; }
        .note { color:#9aa1af; font-size:10px; margin-top:7px; line-height:1.5; }
      </style>
      <div class="layer" id="layer"></div>
      <div class="panel">
        <div class="hd">
          <div class="dot" id="dot"></div>
          <div class="ttl">关键词标注</div>
          <div class="sp"></div>
          <div class="ico" id="min" title="折叠">–</div>
        </div>
        <div class="bd" id="bd">
          <div class="grid">
            <div class="cell"><b id="s1">0</b><span>本页候选人</span></div>
            <div class="cell hi"><b id="s2">0</b><span>命中</span></div>
            <div class="cell qs"><b id="s4">0</b><span>QS 名校</span></div>
            <div class="cell ok"><b id="s3">0</b><span>已打招呼</span></div>
          </div>
          <div class="lg">
            <span id="g1"><i style="background:#2f6fed"></i>1 个 <b>0</b></span>
            <span id="g2"><i style="background:#e8890c"></i>2 个 <b>0</b></span>
            <span id="g3"><i style="background:#d93025"></i>3 个+ <b>0</b></span>
          </div>
          <div class="lg" id="lgqs" style="display:none">
            <span id="gq5"><i style="background:#7c3aed"></i>QS 前 50 <b>0</b></span>
            <span id="gq1"><i style="background:#0e7490"></i>QS 前 100 <b>0</b></span>
          </div>
          <div class="lg" id="lgf" style="display:none">
            <span><i style="background:#12a150"></i>符合筛选 <b id="gf">0</b>/<b id="gt">0</b></span>
            <span style="color:#c02a20">不符的卡片已淡出</span>
          </div>
          <div class="dtline" id="dtline"></div>
          <div class="list" id="list"></div>
          <div class="ft">
            <button id="rescan">重新扫描</button>
            <button id="toggle">隐藏标注</button>
          </div>
          <div class="note">不点击任何按钮，打招呼请自己点。清单排序：符合筛选 → QS 名校 → 命中词数。</div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    layer = shadow.getElementById('layer');
    listBox = shadow.getElementById('list');

    shadow.getElementById('min').addEventListener('click', () => {
      collapsed = !collapsed;
      shadow.getElementById('bd').classList.toggle('hide', collapsed);
      shadow.getElementById('min').textContent = collapsed ? '+' : '–';
    });
    shadow.getElementById('toggle').addEventListener('click', () => {
      marksHidden = !marksHidden;
      shadow.getElementById('toggle').textContent = marksHidden ? '显示标注' : '隐藏标注';
      render(true);
    });
    shadow.getElementById('rescan').addEventListener('click', () => {
      textNodeCache = null; rangesDirty = true;
      tick();
      render(true);
    });
  }

  function toggleDone(key) {
    if (doneKeys.has(key)) doneKeys.delete(key); else doneKeys.add(key);
    saveDone();
    entries.forEach(e => { if (e.key === key) e.done = doneKeys.has(key); });
    render(true);
  }

  /* 页面被弹层遮住时收起卡片框，避免糊在弹窗上（详情框与文字高亮不受影响） */
  function isCovered() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const modals = document.querySelectorAll('[class*="mask"],[class*="overlay"],[class*="dialog"],[class*="drawer"]');
    for (const m of modals) {
      if (!isVisible(m)) continue;
      const r = m.getBoundingClientRect();
      if (r.width > vw * 0.6 && r.height > vh * 0.6) return true;
    }
    return false;
  }

  /* ================= 渲染 ================= */
  function render(force) {
    if (!host) return;
    if (marksHidden) {
      layer.innerHTML = '';
      badgeMap.clear();
      failRectPool.length = 0;
      failBadgePool.length = 0;
      kwPool.length = 0;
      detailBoxEl = null; detailBadgeEl = null;
      drawPanel();
      return;
    }

    const covered = isCovered();
    const structural = [
      entries.length,
      entries.map(e =>
        e.key + ':' + e.level + ':' + e.tier + ':' + e.schools.map(s => s.rank).join('+') + (e.done ? '1' : '0')
      ).join(','),
      scannedCount,
      config.showBadge ? 1 : 0,
      config.highlightText ? 1 : 0,
      config.highlightInCard ? 1 : 0,
      qsEnabled() ? qsMaxRank() : 0,
      filterStats.active ? (config.ageMin + '-' + config.ageMax + '/' + config.eduTier + '/' +
                            config.activityMin + '/' + (config.majorKw || '') +
                            ':' + filterStats.pass) : 0,
      detailInfo ? (detailInfo.level + ':' + detailInfo.tier + ':' + detailInfo.kws.join('/') +
                    ':' + detailInfo.schools.map(s => s.rank).join('+')) : '',
      hitRanges.length,
      covered ? 1 : 0
    ].join('|');

    if (force || structural !== lastStructural) {
      lastStructural = structural;
      drawPanel();
    }
    // 位置相关的一律每次重画（滚动时遮罩、高亮、文字标记都要跟着走）
    drawFailTags(covered);
    drawBadges(covered);
    drawKeywords();      // 与 covered 无关：详情打开时关键词位置继续标
    drawDetailBox();
  }

  let failRectPool = [];         // 筛选不符的灰虚线框元素池
  let failBadgePool = [];        // 筛选不符的灰色小标签元素池
  let kwPool = [];               // 关键词文字高亮元素池

  /* 免费筛选：不符合的卡片只画灰色虚线框 + 小灰标（✗不符·原因），不遮挡任何内容。
     关键词/名校已命中的卡片除外 —— 它们有自己的彩色框和角标（角标里已带 ✗原因）。 */
  function drawFailTags(covered) {
    let i = 0;
    if (!covered && filterStats.active) {
      for (const [card, fails] of failCardMap) {
        if (hitCardSet.has(card)) continue;          // 已命中的卡片走彩色框 + 角标
        if (!card.isConnected) continue;
        const r = card.getBoundingClientRect();
        if (r.bottom < -60 || r.top > window.innerHeight + 60) continue;
        // 详情抽屉等浮层打开时，被盖住的卡片不画 —— 否则框会透在详情上
        if (detailInfo) {
          const cx = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
          const cy = Math.min(Math.max(r.top + Math.min(24, r.height / 2), 0), window.innerHeight - 1);
          const hitEl = document.elementFromPoint(cx, cy);
          if (hitEl && hitEl !== card && !card.contains(hitEl) && !hitEl.contains(card)) continue;
        }
        let fr = failRectPool[i];
        if (!fr) {
          fr = document.createElement('div');
          fr.className = 'hlf';
          layer.appendChild(fr);
          failRectPool.push(fr);
        }
        fr.style.cssText =
          `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;display:block;`;

        let fb = failBadgePool[i];
        if (!fb) {
          fb = document.createElement('div');
          fb.className = 'fbadge';
          layer.appendChild(fb);
          failBadgePool.push(fb);
        }
        const why = Array.from(new Set(fails || [])).slice(0, 2).join('·');
        fb.textContent = '✗不符' + (why ? ' · ' + why : '');
        fb.style.left = Math.max(4, Math.min(r.left + 8, window.innerWidth - 160)) + 'px';
        fb.style.top = Math.max(4, r.top - 9) + 'px';
        fb.style.display = 'flex';
        i++;
      }
    }
    for (let j = i; j < failRectPool.length; j++) failRectPool[j].style.display = 'none';
    for (let j = i; j < failBadgePool.length; j++) failBadgePool[j].style.display = 'none';
  }

  function drawBadges(covered) {
    const seen = new Set();
    if (covered) {
      badgeMap.forEach(v => { v.rectEl.style.display = 'none'; v.badgeEl.style.display = 'none'; });
      return;
    }
    for (const e of entries) {
      if (!e.card || !e.card.isConnected) continue;
      const r = e.card.getBoundingClientRect();
      if (r.bottom < -60 || r.top > window.innerHeight + 60) continue;
      // 详情抽屉等浮层打开时，被盖住的卡片不再画框 —— 否则框会透在详情上
      if (detailInfo) {
        const cx = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
        const cy = Math.min(Math.max(r.top + Math.min(24, r.height / 2), 0), window.innerHeight - 1);
        const hitEl = document.elementFromPoint(cx, cy);
        if (hitEl && hitEl !== e.card && !e.card.contains(hitEl) && !hitEl.contains(e.card)) continue;
      }
      seen.add(e.key);
      const lv = levelStyle(e.level, e.tier);
      const qs = e.schools.length ? QS_LEVELS[e.tier] : null;

      let item = badgeMap.get(e.key);
      if (!item) {
        const rectEl = document.createElement('div');
        const badgeEl = document.createElement('div');
        badgeEl.innerHTML = '<span class="sch"></span><span class="lbl"></span><span class="tick" title="标记为已打招呼">✓</span>';
        badgeEl.querySelector('.tick').addEventListener('click', ev => {
          ev.stopPropagation();
          toggleDone(e.key);
        });
        layer.appendChild(rectEl);
        layer.appendChild(badgeEl);
        item = { rectEl, badgeEl };
        badgeMap.set(e.key, item);
      }

      const flashing = (flashMap.get(e.key) || 0) > Date.now();
      // 名校命中 → 卡片框外面再套一圈校色光环（与关键词等级框叠加，不互相覆盖）
      const ring = qs ? `0 0 0 3px ${qs.glow}` : '';
      const shadow = [
        ring,
        flashing ? `0 0 0 4px ${lv.glow},0 0 18px ${lv.glow}` : ''
      ].filter(Boolean).join(',');

      item.rectEl.className = 'hl' + (e.done ? ' done' : '');
      item.rectEl.style.cssText =
        `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;display:block;` +
        `border-color:${lv.color};background:${lv.box};` +
        (shadow ? `box-shadow:${shadow};` : '');

      item.badgeEl.className = 'badge' + (e.done ? ' done' : '');
      item.badgeEl.style.display = config.showBadge ? 'flex' : 'none';
      item.badgeEl.style.left = Math.max(4, Math.min(r.left + 8, window.innerWidth - 260)) + 'px';
      item.badgeEl.style.top = Math.max(4, r.top - 9) + 'px';
      item.badgeEl.style.background = e.done ? '#12a150' : lv.color;

      const schEl = item.badgeEl.querySelector('.sch');
      if (qs) {
        schEl.style.display = '';
        schEl.className = 'sch s' + e.tier;
        // 徽标带上学校名，方便核对是按哪所学校识别出来的
        const s0 = e.schools[0];
        const nm = (s0.zh || '').length > 8 ? s0.zh.slice(0, 8) + '…' : (s0.zh || '');
        schEl.textContent = '🎓 ' + (s0.weak ? 'QS?·' + nm : qs.tag + '·' + nm);
      } else {
        schEl.style.display = 'none';
        schEl.textContent = '';
      }
      item.badgeEl.querySelector('.lbl').textContent = badgeLabel(e);
    }
    badgeMap.forEach((v, k) => {
      if (!seen.has(k)) { v.rectEl.remove(); v.badgeEl.remove(); badgeMap.delete(k); }
    });
  }

  function badgeLabel(e) {
    const n = e.kws.length;
    let lbl;
    // 只命中名校、没有关键词 → 角标直接显示学校名（前面已有 🎓 QS50 徽标）
    if (!n) {
      const s = e.schools[0];
      if (!s) return '';
      const nm = s.weak ? s.via + '（待确认）' : s.zh;
      lbl = e.schools.length > 1 ? `${nm} 等 ${e.schools.length} 所` : nm;
    } else {
      const txt = e.kws.join('/');
      const short = txt.length > 20 ? txt.slice(0, 19) + '…' : txt;
      lbl = e.done ? '已打招呼 · ' + short
        : (n === 1 ? '命中 · ' + short : `命中 ${n} 词 · ` + short);
    }
    // 免费筛选：通过的带上条件标签（最多 3 个），没过的带上原因
    if (filterStats.active && e.finfo) {
      if (e.fpass) {
        const t = filterTags(e.finfo);
        if (t.length) lbl += ' · ' + t.slice(0, 3).join('·');
      } else if (e.ffails && e.ffails.length) {
        lbl += ' · ✗' + Array.from(new Set(e.ffails)).slice(0, 2).join('✗');
      }
    }
    return lbl;
  }

  /* 页面文本里关键词出现的位置 —— 详情页打开时同样持续标注 */
  function drawKeywords() {
    let i = 0;
    if (config.highlightText && hitRanges.length) {
      const rg = document.createRange();     // 复用同一个 Range，避免每帧新建大量对象
      const LIMIT = 700;
      for (const hr of hitRanges) {
        const node = hr.node;
        if (!node || !node.isConnected) continue;
        // 虚拟渲染会复用文本节点改写内容：内容对不上号就跳过，防止画到错误位置
        if (node.nodeValue.substr(hr.start, hr.end - hr.start) !== hr.kw) continue;
        let rects;
        try {
          rg.setStart(node, hr.start);
          rg.setEnd(node, hr.end);
          rects = rg.getClientRects();
        } catch (e) { continue; }
        if (!rects || !rects.length) continue;
        for (let k = 0; k < rects.length; k++) {
          const rc = rects[k];
          if (rc.width < 1 || rc.height < 1) continue;
          if (rc.bottom < -40 || rc.top > window.innerHeight + 40) continue;
          let el = kwPool[i];
          if (!el) {
            el = document.createElement('div');
            el.className = 'kwm';
            layer.appendChild(el);
            kwPool.push(el);
          }
          el.style.cssText =
            `left:${rc.left - 1}px;top:${rc.top - 1}px;` +
            `width:${rc.width + 2}px;height:${rc.height + 2}px;display:block;` +
            `background:${hr.lv.mark};border-bottom-color:${hr.lv.color};`;
          i++;
          if (i >= LIMIT) break;
        }
        if (i >= LIMIT) break;
      }
    }
    for (let j = i; j < kwPool.length; j++) kwPool[j].style.display = 'none';
  }

  /* 详情浮层区域框 —— 有关键词按关键词等级配色，纯名校则用校色 */
  let detailBoxEl = null, detailBadgeEl = null;
  function drawDetailBox() {
    const schs = (detailInfo && detailInfo.schools) || [];
    const on = !!(detailInfo && detailInfo.el && detailInfo.el.isConnected &&
                  (detailInfo.kws.length || schs.length));
    if (!on) {
      if (detailBoxEl) detailBoxEl.style.display = 'none';
      if (detailBadgeEl) detailBadgeEl.style.display = 'none';
      return;
    }
    const r = detailInfo.el.getBoundingClientRect();
    if (r.bottom < 40 || r.top > window.innerHeight - 40 || r.right < 40 || r.left > window.innerWidth - 40) {
      if (detailBoxEl) detailBoxEl.style.display = 'none';
      if (detailBadgeEl) detailBadgeEl.style.display = 'none';
      return;
    }
    const lv = levelStyle(detailInfo.level, detailInfo.tier);
    if (!detailBoxEl) {
      detailBoxEl = document.createElement('div');
      detailBoxEl.className = 'hl';
      detailBadgeEl = document.createElement('div');
      detailBadgeEl.className = 'badge dt';
      detailBadgeEl.innerHTML = '<span class="sch"></span><span class="lbl"></span>';
      layer.appendChild(detailBoxEl);
      layer.appendChild(detailBadgeEl);
    }
    detailBoxEl.className = 'hl';
    detailBoxEl.style.cssText =
      `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;display:block;` +
      `border-color:${lv.color};background:transparent;border-style:dashed;` +
      (schs.length ? `box-shadow:0 0 0 3px ${QS_LEVELS[detailInfo.tier].glow};` : '');

    const n = detailInfo.kws.length;
    const parts = [];
    if (schs.length) {
      parts.push('🎓 ' + schs.slice(0, 2).map(s => (s.weak ? s.via + '?' : s.zh)).join('/'));
      if (n) parts.push(n + ' 词');
    } else {
      parts.push('命中 ' + n + ' 词');
    }
    const schEl = detailBadgeEl.querySelector('.sch');
    schEl.style.display = 'none';
    detailBadgeEl.style.display = config.showBadge ? 'flex' : 'none';
    detailBadgeEl.style.background = lv.color;
    detailBadgeEl.style.left = Math.max(4, Math.min(r.left + 8, window.innerWidth - 260)) + 'px';
    detailBadgeEl.style.top = Math.max(4, r.top + 6) + 'px';
    detailBadgeEl.querySelector('.lbl').textContent = '详情 · ' + parts.join(' · ');
  }

  function drawPanel() {
    shadow.getElementById('s1').textContent = scannedCount;
    shadow.getElementById('s2').textContent = entries.length;
    shadow.getElementById('s3').textContent = entries.filter(e => e.done).length;
    shadow.getElementById('s4').textContent = entries.filter(e => e.schools.length).length;
    shadow.getElementById('dot').className = 'dot' + (entries.length ? ' on' : '');

    const c1 = entries.filter(e => e.level === 1).length;
    const c2 = entries.filter(e => e.level === 2).length;
    const c3 = entries.filter(e => e.level === 3).length;
    shadow.getElementById('g1').innerHTML = '<i style="background:#2f6fed"></i>1 个 <b>' + c1 + '</b>';
    shadow.getElementById('g2').innerHTML = '<i style="background:#e8890c"></i>2 个 <b>' + c2 + '</b>';
    shadow.getElementById('g3').innerHTML = '<i style="background:#d93025"></i>3 个+ <b>' + c3 + '</b>';

    const q50 = entries.filter(e => e.schools.length && e.tier === 50).length;
    const q100 = entries.filter(e => e.schools.length && e.tier === 100).length;
    shadow.getElementById('lgqs').style.display = qsEnabled() ? 'flex' : 'none';
    shadow.getElementById('gq5').innerHTML = '<i style="background:#7c3aed"></i>QS 前 50 <b>' + q50 + '</b>';
    shadow.getElementById('gq1').innerHTML = '<i style="background:#0e7490"></i>QS 前 100 <b>' + q100 + '</b>';

    const lgf = shadow.getElementById('lgf');
    lgf.style.display = filterStats.active ? 'flex' : 'none';
    if (filterStats.active) {
      shadow.getElementById('gf').textContent = filterStats.pass;
      shadow.getElementById('gt').textContent = filterStats.total;
    }

    const dl = shadow.getElementById('dtline');
    const dts = (detailInfo && detailInfo.schools) || [];
    if (detailInfo && (detailInfo.kws.length || dts.length)) {
      const lv = levelStyle(detailInfo.level, detailInfo.tier);
      const seg = [];
      if (dts.length) seg.push('名校 ' + dts.map(s => (s.weak ? s.via + '（待确认）' : s.zh)).join('、'));
      if (detailInfo.kws.length) seg.push('关键词 ' + detailInfo.kws.join('、'));
      dl.style.display = 'block';
      dl.style.borderLeftColor = lv.color;
      dl.textContent = '详情浮层命中：' + seg.join('；') +
        (detailBoost ? `（已并入 ${detailBoost.name}）` : '');
    } else {
      dl.style.display = 'none';
    }

    listBox.innerHTML = '';
    if (!entries.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      const tail = qsEnabled() ? `；也没发现 QS 前 ${qsMaxRank()} 名校背景` : '';
      d.textContent = scannedCount
        ? `本页 ${scannedCount} 位候选人，暂无命中「${config.keywords.join('、')}」的人${tail}`
        : '未检测到候选人列表，请进入「推荐牛人」页面';
      listBox.appendChild(d);
      return;
    }
    // 排序：符合筛选 → QS 前 50 → QS 前 100 → 关键词命中数多的，同级保持页面顺序
    const gRank = e => (e.schools.length ? (e.tier === 50 ? 0 : 1) : 2);
    const fRank = e => (filterStats.active ? (e.fpass ? 0 : 1) : 0);
    const ordered = entries.slice().sort((a, b) => (fRank(a) - fRank(b)) || (gRank(a) - gRank(b)) || (b.level - a.level));

    for (const e of ordered) {
      const hasSch = e.schools.length > 0;
      const lv = levelStyle(e.level, e.tier);
      const row = document.createElement('div');
      row.className = hasSch ? ('row s' + e.tier) : ('row lv' + e.level);

      const pin = document.createElement('div');
      pin.className = 'pin';
      pin.style.background = hasSch ? QS_LEVELS[e.tier].color : lv.color;

      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = e.name;

      const kw = document.createElement('div');
      kw.className = 'kwt';
      const s0 = hasSch ? e.schools[0] : null;
      const schTxt = s0
        ? `🎓 ${s0.weak ? s0.via + '?' : (s0.zh.length > 6 ? s0.zh.slice(0, 5) + '…' : s0.zh)}`
        : '';
      const kwTxt = e.kws.length
        ? (e.kws.length > 1 ? `${e.kws.length} 词 · ${e.kws.join(' / ')}` : e.kws[0])
        : '';
      kw.textContent = [schTxt, kwTxt].filter(Boolean).join(' · ');
      kw.title = hasSch
        ? e.schools.map(s => `QS ${s.rank} · ${s.zh}（${s.country}）`).join('\n') +
          (e.kws.length ? '\n关键词：' + e.kws.join('、') : '')
        : '';

      const go = document.createElement('button');
      go.className = 'go';
      go.textContent = '定位';
      go.addEventListener('click', () => {
        if (!e.card || !e.card.isConnected) return;
        e.card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flashMap.set(e.key, Date.now() + 1800);
        render(true);
      });

      const tk = document.createElement('button');
      tk.className = 'tk' + (e.done ? ' on' : '');
      tk.textContent = e.done ? '✓ 已打' : '标记';
      tk.addEventListener('click', () => toggleDone(e.key));

      row.append(pin, nm, kw, go, tk);
      listBox.appendChild(row);
    }
  }

  /* 滚动等高频场景只重绘位置，用 rAF 节流 */
  let rafPending = false;
  function paintSoon() {
    if (rafPending || !workerActive || !host) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      try { render(false); } catch (e) {}
    });
  }

  /* 闪烁高亮到点后要抹掉（用一个低频定时器兜底） */
  setInterval(() => {
    if (!workerActive || !flashMap.size) return;
    const now = Date.now();
    let changed = false;
    flashMap.forEach((t, k) => { if (t <= now) { flashMap.delete(k); changed = true; } });
    if (changed) render(true);
  }, 600);

  /* ================= 主循环（只读轮询） ================= */
  let scanning = false;
  function tick() {
    if (scanning) return;
    scanning = true;
    try {
      if (rangesDirty) computeRanges();
      syncDetailBoost();
      scan();
      render(false);
    } catch (e) {
      /* 静默 */
    } finally {
      scanning = false;
    }
  }

  /* ================= 工作 frame 判定 ================= */
  function becomeWorker() {
    if (workerActive) return;
    workerActive = true;
    mountUI();
    loadDone().then(() => tick());
  }

  /* ================= 消息 ================= */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (!workerActive) return false;      // 非工作 frame 静默，避免抢答

    if (msg.type === 'BAG_STATUS') {
      sendResponse({
        ok: true,
        scanned: scannedCount,
        matched: entries.length,
        done: entries.filter(e => e.done).length,
        lv1: entries.filter(e => e.level === 1).length,
        lv2: entries.filter(e => e.level === 2).length,
        lv3: entries.filter(e => e.level === 3).length,
        qsOn: qsEnabled(),
        qsMax: qsMaxRank(),
        qs50: entries.filter(e => e.schools.length && e.tier === 50).length,
        qs100: entries.filter(e => e.schools.length && e.tier === 100).length,
        filter: filterStats.active ? { pass: filterStats.pass, total: filterStats.total } : null,
        detail: detailInfo
          ? { n: detailInfo.kws.length, kws: detailInfo.kws, schools: detailInfo.schools.map(s => s.zh) }
          : null,
        names: entries.map(e =>
          `${e.name}（${[e.schools.length ? '🎓' + e.schools[0].zh : '', e.kws.join('/')]
            .filter(Boolean).join(' ')}）`
        ).slice(0, 30)
      });
      return false;
    }
    if (msg.type === 'BAG_RESCAN') {
      textNodeCache = null; rangesDirty = true;
      tick();
      render(true);
      sendResponse({ ok: true, scanned: scannedCount, matched: entries.length });
      return false;
    }
    if (msg.type === 'BAG_SHOW_PANEL') {
      marksHidden = false;
      const btn = shadow && shadow.getElementById('toggle');
      if (btn) btn.textContent = '隐藏标注';
      if (host) host.style.display = '';
      render(true);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  /* ================= 启动 ================= */
  (async () => {
    try {
      const o = await chrome.storage.local.get(['bag:config']);
      if (o['bag:config']) config = { ...DEFAULT_CONFIG, ...o['bag:config'] };
    } catch (e) {}

    if (cardCount() > 0) becomeWorker();

    // 列表异步渲染，轻量探测工作 frame
    setInterval(() => {
      if (!workerActive &&
          document.querySelector('.candidate-card-wrap, .card-item, [class*="candidate-card"]')) {
        becomeWorker();
      }
    }, 1500);

    // 只读轮询：滚动加载、筛选切换、页面翻页都能自动跟上
    setInterval(() => { if (workerActive && !document.hidden) tick(); }, 1200);

    // 页面结构变化（详情打开 / 加载更多 / 抽屉重建）→ 下一轮重算关键词位置
    try {
      const mo = new MutationObserver(() => { textNodeCache = null; rangesDirty = true; });
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) {}

    // 只重绘悬浮层位置，不触碰页面
    let scrollTimer = null;
    window.addEventListener('scroll', () => {
      paintSoon();
      lastScrollAt = Date.now();
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => { rangesDirty = true; }, 350);
    }, { passive: true, capture: true });
    window.addEventListener('resize', () => {
      textNodeCache = null; rangesDirty = true;
      if (workerActive) render(true);
    }, { passive: true });

    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch['bag:config']) {
        config = { ...DEFAULT_CONFIG, ...ch['bag:config'].newValue };
        textNodeCache = null; rangesDirty = true;
        lastStructural = '';
        tick();
      }
    });
  })();
})();
