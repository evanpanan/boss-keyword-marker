/* ============================================================
 * popup.js —— 关键词标注的配置面板（不涉及任何点击行为）
 * ============================================================ */
'use strict';

const $ = id => document.getElementById(id);

const DEFAULT_CONFIG = {
  keywords: ['美股', '投资者关系', 'IR'],
  showBadge: true,
  highlightText: true,
  highlightInCard: false,
  qsTop50: false,
  qsTop100: false,
  /* 免费筛选 */
  ageMin: '',
  ageMax: '',
  eduTier: 'any',
  activityMin: 'any',
  majorKw: ''
};

/** QS 名单（来自 qs-rankings.js，仅用于「诊断本页」的粗检） */
const QS_NAMES = (((window.__QS_RANKINGS__ || {}).schools) || []).map(s => s.zh).filter(Boolean);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/** 更新某一档配色的人数 + 高亮选中态 */
function setCell(id, n) {
  const v = Number(n || 0);
  const el = $(id);
  if (!el) return;
  el.querySelector('b').textContent = v;
  el.classList.toggle('on', v > 0);
}

function readConfig() {
  const kws = $('keywords').value.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
  const num = v => { const n = String(v || '').replace(/[^\d]/g, ''); return n ? String(Number(n)) : ''; };
  return {
    keywords: kws.length ? kws : DEFAULT_CONFIG.keywords.slice(),
    showBadge: $('showBadge').checked,
    highlightText: $('highlightText').checked,
    highlightInCard: $('highlightInCard').checked,
    qsTop50: $('qsTop50').checked,
    qsTop100: $('qsTop100').checked,
    ageMin: num($('ageMin').value),
    ageMax: num($('ageMax').value),
    eduTier: $('eduTier').value || 'any',
    activityMin: $('activityMin').value || 'any',
    majorKw: $('majorKw').value.trim()
  };
}

async function loadConfig() {
  const o = await chrome.storage.local.get(['bag:config']);
  const c = Object.assign({}, DEFAULT_CONFIG, o['bag:config'] || {});
  $('keywords').value = (c.keywords || []).join(',');
  $('showBadge').checked = c.showBadge !== false;
  $('highlightText').checked = c.highlightText !== false;
  $('highlightInCard').checked = !!c.highlightInCard;
  $('qsTop50').checked = !!c.qsTop50;
  $('qsTop100').checked = !!c.qsTop100;
  $('ageMin').value = c.ageMin || '';
  $('ageMax').value = c.ageMax || '';
  $('eduTier').value = c.eduTier || 'any';
  $('activityMin').value = c.activityMin || 'any';
  $('majorKw').value = c.majorKw || '';
}

async function saveConfig() {
  const cfg = readConfig();
  await chrome.storage.local.set({ 'bag:config': cfg });
  return cfg;
}

/** 取当前标签页；仅在 zhipin 域下返回 */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/zhipin\.com/.test(tab.url || '')) return null;
  return tab;
}

/* ---------- 状态刷新 ---------- */
async function refresh() {
  const tab = await activeTab();
  if (!tab) {
    setStatus('当前不是 BOSS 直聘页面。请打开招聘端「推荐牛人」页面后再看。');
    $('s1').textContent = $('s2').textContent = $('s3').textContent = '–';
    return;
  }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'BAG_STATUS' });
    if (!r || !r.ok) {
      setStatus('页面还没注入标注脚本，刷新一下 BOSS 页面即可。', 'warn');
      return;
    }
    $('s1').textContent = r.scanned;
    $('s2').textContent = r.matched;
    $('s3').textContent = r.done;
    $('s4').textContent = (r.qs50 || 0) + (r.qs100 || 0);

    setCell('g1', r.lv1);
    setCell('g2', r.lv2);
    setCell('g3', r.lv3);

    const dt = r.detail && (r.detail.n || (r.detail.schools || []).length)
      ? '\n详情浮层命中：' + [
          (r.detail.schools || []).length ? '名校 ' + r.detail.schools.join('、') : '',
          r.detail.n ? '关键词 ' + (r.detail.kws || []).join('、') : ''
        ].filter(Boolean).join('；')
      : '';
    const qsTxt = r.qsOn
      ? `\nQS 名校 ${(r.qs50 || 0) + (r.qs100 || 0)} 人（前 50 ${r.qs50 || 0} / 前 100 ${r.qs100 || 0}）`
      : '';
    const fTxt = r.filter
      ? `\n免费筛选：符合 ${r.filter.pass} / ${r.filter.total} 人（不符的卡片已淡出）`
      : '';

    if (!r.scanned) {
      setStatus('未检测到候选人列表。请进入「推荐牛人」页面（地址通常带 /web/frame/recommend/）。');
    } else if (!r.matched) {
      setStatus(`本页 ${r.scanned} 位候选人，暂无命中「${readConfig().keywords.join('、')}」的人。` +
        fTxt + qsTxt + dt, '');
    } else {
      setStatus(
        `命中 ${r.matched} 人（1 词 ${r.lv1 || 0} / 2 词 ${r.lv2 || 0} / 3 词+ ${r.lv3 || 0}）：\n` +
        (r.names || []).join('、') + fTxt + qsTxt + dt,
        'ok'
      );
    }
  } catch (e) {
    setStatus('页面还没注入标注脚本，刷新一下 BOSS 页面即可。', 'warn');
  }
}

/* ---------- 关键词 / 选项变化 → 立即生效 ---------- */
['keywords', 'showBadge', 'highlightText', 'highlightInCard', 'qsTop50', 'qsTop100',
 'ageMin', 'ageMax', 'eduTier', 'activityMin', 'majorKw'].forEach(id => {
  $(id).addEventListener('change', async () => {
    await saveConfig();
    const tab = await activeTab();
    if (tab) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'BAG_RESCAN' }); } catch (e) {}
    }
    setTimeout(refresh, 250);
  });
});

/* ---------- 按钮 ---------- */
$('rescan').addEventListener('click', async () => {
  await saveConfig();
  const tab = await activeTab();
  if (!tab) { setStatus('请先打开 BOSS 直聘招聘端页面。', 'warn'); return; }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'BAG_RESCAN' });
    if (r && r.ok) setStatus(`已重新扫描：${r.scanned} 位候选人，命中 ${r.matched} 人。`, 'ok');
    else setStatus('扫描失败，刷新页面后重试。', 'warn');
  } catch (e) {
    setStatus('页面还没注入标注脚本，刷新一下 BOSS 页面即可。', 'warn');
  }
  setTimeout(refresh, 200);
});

$('show').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) { setStatus('请先打开 BOSS 直聘招聘端页面。', 'warn'); return; }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'BAG_SHOW_PANEL' });
    setStatus('已让页面右下角的标注面板重新显示。', 'ok');
  } catch (e) {
    setStatus('页面还没注入标注脚本，刷新一下 BOSS 页面即可。', 'warn');
  }
});

/* ---------- 诊断 ---------- */
$('diag').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) { setStatus('请先打开 BOSS 直聘页面再诊断。', 'warn'); return; }
  setStatus('诊断中…');
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (qsNames) => {
        const q = s => { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
        const txt = document.body ? (document.body.innerText || '') : '';
        const btns = Array.from(document.querySelectorAll('button'))
          .map(b => (b.textContent || '').replace(/\s+/g, '').trim())
          .filter(Boolean).slice(0, 20);
        const raw = document.documentElement.getAttribute('data-bag-geek-text') || '';
        let geekCount = 0;
        try { geekCount = Object.keys(JSON.parse(raw) || {}).length; } catch (e) {}
        const cands = Array.from(document.querySelectorAll('.candidate-card-wrap, .card-item'))
          .slice(0, 6)
          .map(c => (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70));
        return {
          url: location.href,
          isTop: window.top === window,
          cards: q('.candidate-card-wrap'),
          cardItems: q('.card-item'),
          len: txt.length,
          有工作经历: txt.includes('工作经历'),
          命中关键词: ['美股', '投资者关系', 'IR'].filter(k => txt.includes(k)),
          QS命中校名: (qsNames || []).filter(n => txt.includes(n)).slice(0, 6),
          接口候选人数: geekCount,
          按钮文案: btns,
          卡片样本: cands
        };
      },
      args: [QS_NAMES]
    });
  } catch (e) {
    setStatus('诊断失败：' + e.message, 'warn');
    return;
  }
  const lines = frames.map(f => {
    const r = f.result || {};
    return `${r.isTop ? '[主文档]' : '[iframe]'} 卡片${r.cards || 0}/item${r.cardItems || 0} 文本${r.len || 0} ` +
           `工作经历${r.有工作经历 ? '有' : '无'} 接口候选人${r.接口候选人数 || 0} ` +
           `关键词[${(r.命中关键词 || []).join('/')}] QS校名[${(r.QS命中校名 || []).join('/')}] ` +
           `按钮(${(r.按钮文案 || []).slice(0, 6).join('|')})` +
           ((r.卡片样本 && r.卡片样本.length) ? `\n  样本：${r.卡片样本[0]}` : '');
  });
  setStatus('诊断结果（共 ' + lines.length + ' 个 frame）：\n' + lines.join('\n'));
});

/* ---------- 初始化 ---------- */
(async () => {
  await loadConfig();
  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 2000);
})();
