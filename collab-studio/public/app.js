// ─── 全局 CollabStudio API ──────────────────────────────
window.CollabStudio = {
  version: '2.0.0',
  socket: null,
  modules: {},
  get userId() { return myUserId; },
  get userName() { return myName; },
  get peers() { return peers; },
  get projects() { return projects; },
  get serverId() { return serverId; },
};

const socket = io();
CollabStudio.socket = socket;

// 持久身份 ID（localStorage，跨会话不变）
let myUserId = localStorage.getItem('collab-user-id');
if (!myUserId) {
  myUserId = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  localStorage.setItem('collab-user-id', myUserId);
}

let serverId = '';
let serverName = '';
let projects = [];
let peers = [];         // 所有在线对等设备 [{ serverId, name, ip, port, connected, note }]

// DOM
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const app             = $('#app');
const selfBadge       = $('#self-badge');
const peerBadge       = $('#peer-badge');
const lanCb           = $('#lan-toggle-cb');
const lanStatus       = $('#lan-status');
const refreshLanBtn   = $('#refresh-lan-btn');
const navBtns         = $$('.nav-btn[data-module]');
const panels          = $$('.module-panel');
const projectList     = $('#project-list');
const peerStatusArea  = $('#peer-status-area');
const transferSection = $('#transfer-section');
const transferList    = $('#transfer-list');
const transferBtn     = $('#transfer-btn');
const noteSection     = $('#note-section');
const peerNoteInput   = $('#peer-note-input');
const peerNoteSave    = $('#peer-note-save');
const receiveModal    = $('#receive-modal');
const receiveInfo     = $('#receive-info');
const receiveList     = $('#receive-list');
const receiveOk       = $('#receive-ok');
let onlineUsers = [];

// ─── 扫描状态 ────────────────────────────────────────────
let scanState = 'idle';

function showScanStatus() {
  if (scanState === 'scanning') {
    peerStatusArea.innerHTML += `<div class="scan-status scanning">🔍 正在扫描…还剩 ${getScanRemaining()}</div>`;
  } else if (scanState === 'nobody') {
    peerStatusArea.innerHTML += `<div class="scan-status nobody">⏰ 扫描结束，未发现设备</div>`;
    // 自动关闭局域网开关
    lanCb.checked = false;
    lanStatus.textContent = '🔴 局域网: 关闭';
  } else if (scanState === 'found') {
    // 已被 updatePeersUI 处理
  }
}

let scanStartTime = null;

// ─── 操作锁系统 ─────────────────────────────────────────
// lockKey → userName，如 "mindmap-node:n5" → "小明"
const locks = new Map();

function lockKey(type, id) { return `${type}:${id}`; }

function isLocked(type, id) { return locks.has(lockKey(type, id)); }

function getLockUser(type, id) { return locks.get(lockKey(type, id)) || null; }

// 获取锁（零延迟广播）
function acquireLock(type, id) {
  socket.emit('focus-lock', { type, id });
}

// 释放锁
function releaseLock(type, id) {
  socket.emit('focus-release', { type, id });
}

// Socket 事件监听
socket.on('focus-lock', ({ type, id, user }) => {
  if (user !== myName) {
    locks.set(lockKey(type, id), user);
    // 通知当前模块刷新锁状态
    window.dispatchEvent(new CustomEvent('locks-changed'));
  }
});

socket.on('focus-release', ({ type, id, user }) => {
  locks.delete(lockKey(type, id));
  window.dispatchEvent(new CustomEvent('locks-changed'));
});

socket.on('focus-release-all', ({ user }) => {
  // 释放某个用户的所有锁
  for (const [key, u] of locks) {
    if (u === user) locks.delete(key);
  }
  window.dispatchEvent(new CustomEvent('locks-changed'));
});

// ─── 操作审计日志 ───────────────────────────────────────
let operationLog = [];

socket.on('operation-log', (entry) => {
  operationLog.push(entry);
  window.dispatchEvent(new CustomEvent('log-entry', { detail: entry }));
});



function getScanRemaining() {
  if (!scanStartTime) return '<1 分钟';
  const elapsed = Date.now() - scanStartTime;
  const remaining = Math.ceil((5 * 60 * 1000 - elapsed) / 1000);
  if (remaining <= 0) return '即将结束';
  const min = Math.floor(remaining / 60);
  const sec = remaining % 60;
  return `${min}分${sec}秒`;
}

// ─── 联系管理员 ────────────────────────────────────────
function sendToAdmin() {
  const input = document.getElementById('contact-admin-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  socket.emit('user-message-to-admin', text);
  input.value = '';
  // 给用户反馈
  const orig = input.placeholder;
  input.placeholder = '✅ 已发送';
  setTimeout(() => { input.placeholder = orig; }, 1500);
}

// 管理员的收件箱
const adminMsgs = [];
socket.on('admin-incoming-msg', (msg) => {
  adminMsgs.push(msg);
  const container = document.getElementById('admin-msgs');
  if (!container) return;
  const time = new Date(msg.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const div = document.createElement('div');
  div.style.cssText = 'padding:3px 4px;border-bottom:1px solid var(--border);margin-bottom:2px';
  div.innerHTML = `<strong style="color:var(--accent)">${esc(msg.from)}</strong> ${esc(msg.text)} <span style="font-size:10px;color:var(--text-dim);float:right">${time}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
});

// 显示/隐藏联系管理员和管理面板
function updateUIBasedOnRole() {
  const contactSection = document.getElementById('contact-admin-section');
  const adminPanel = document.getElementById('admin-panel');
  if (contactSection) contactSection.style.display = isAdmin ? 'none' : 'block';
  if (adminPanel) adminPanel.style.display = isAdmin ? 'block' : 'none';
}

// ─── 浏览器指纹 ────────────────────────────────────────
function generateFingerprint() {
  let saved = localStorage.getItem('collab-fingerprint');
  if (saved) return saved;
  const canvas = document.createElement('canvas');
  canvas.width = 200; canvas.height = 50;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.font = '14px Arial';
  ctx.fillStyle = '#f60';
  ctx.fillRect(0, 0, 200, 50);
  ctx.fillStyle = '#fff';
  ctx.fillText('CollabStudio⚡', 10, 15);
  const raw = [
    navigator.userAgent,
    screen.width + 'x' + screen.height,
    navigator.language,
    navigator.hardwareConcurrency || '1',
    canvas.toDataURL().slice(100, 140),
    new Date().getTimezoneOffset()
  ].join('||');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash) + raw.charCodeAt(i); hash |= 0; }
  const fp = 'fp_' + Math.abs(hash).toString(36);
  localStorage.setItem('collab-fingerprint', fp);
  return fp;
}
const myFingerprint = generateFingerprint();

// ─── 入场 ────────────────────────────────────────────────

// 从 sessionStorage 读取登录凭证
let savedAuth = null;
try {
  const raw = sessionStorage.getItem('collab-auth');
  if (raw) savedAuth = JSON.parse(raw);
} catch(_) {}

if (!savedAuth || !savedAuth.name) {
  // 未登录，跳转到登录页
  window.location.href = '/';
}

let myName = savedAuth ? savedAuth.name : '';
let myPwd = savedAuth ? (savedAuth.pwd || '') : '';  // 从登录页传递的密码
let isAdmin = savedAuth ? savedAuth.isAdmin : false;

// 连接后自动用已保存的身份登录
socket.on('connect', () => {
  if (myName) {
    socket.emit('join', { name: myName, password: myPwd, fingerprint: myFingerprint });
  }
});

// 服务器验证结果
socket.on('login-success', ({ userName, isAdmin: admin }) => {
  isAdmin = admin;
  app.style.display = 'flex';
  selfBadge.textContent = isAdmin ? `👑 ${userName}` : `👤 ${userName}`;
  if (isAdmin) selfBadge.className = 'badge admin';
  else selfBadge.className = 'badge';
  updateUIBasedOnRole();
  initUI();
  if (isAdmin) renderAdminPanel();
  
  // 绑定联系管理员事件
  const contactBtn = document.getElementById('contact-admin-btn');
  const contactInput = document.getElementById('contact-admin-input');
  if (contactBtn) contactBtn.onclick = sendToAdmin;
  if (contactInput) contactInput.onkeydown = (e) => { if (e.key === 'Enter') sendToAdmin(); };
  
  // 请求管理员统计
  if (isAdmin) {
    socket.emit('admin-get-stats');
  }
  
  // 请求密码重置审批列表
  if (isAdmin) {
    socket.emit('admin-list-resets');
  }
});

socket.on('login-error', (msg) => {
  // 登录失败，清除凭证并跳转到登录页
  sessionStorage.removeItem('collab-auth');
  showAlert(msg, '登录失败', '❌');
  setTimeout(() => { window.location.href = '/'; }, 2000);
});

socket.on('kicked', (msg) => {
  showAlert(msg, '已被踢出', '🚫');
  sessionStorage.removeItem('collab-auth');
  setTimeout(() => { window.location.href = '/'; }, 2000);
  app.style.display = 'none';
});

// ─── Socket 事件 ─────────────────────────────────────────
socket.on('init', (data) => {
  serverId = data.serverId;
  serverName = data.serverName;
  projects = data.projects || [];
  peers = data.peers || [];
  onlineUsers = data.onlineUsers || [];
  scanState = data.scanState || 'idle';
  renderProjects();
  updatePeersUI();
  renderOnlineUsers();
});

socket.on('bridge-message', (msg) => {
  switch (msg.type) {
    case 'peers-update':
      peers = msg.peers || [];
      updatePeersUI();
      break;
    case 'projects-update':
      // 项目列表有变化，从服务器重新获取
      // 实际上服务器会发单独的 project-created/updated/deleted 事件
      break;
    case 'projects-received':
      showReceiveModal(msg);
      break;
    case 'realtime':
      // 来自对等设备的实时事件，只转发给各模块（各模块自己监听 socket 事件）
      // 服务器已经通过 io.emit 发送了原始事件
      break;
  }
});

socket.on('project-created', (p) => {
  projects.push(p);
  renderProjects();
});

socket.on('project-updated', (data) => {
  const p = projects.find(x => x.id === data.id);
  if (p) {
    if (data.name) p.name = data.name;
    if (data.data) p.data = data.data;
    p.updatedAt = data.updatedAt;
  }
  renderProjects();
});

socket.on('project-deleted', (id) => {
  projects = projects.filter(p => p.id !== id);
  renderProjects();
});

socket.on('transfer-sent', (data) => {
  showAlert(`${data.count} 个项目已发送给 ${data.to}`, '发送成功', '✅');
});

socket.on('transfer-failed', (data) => {
  showAlert(`发送失败: ${data.reason}`, '发送失败', '❌');
});

// ── 扫描状态 ──
socket.on('scan-state', (data) => {
  scanState = data.state;
  if (data.state === 'scanning') {
    scanStartTime = Date.now();
    // 定期更新倒计时
    if (window.scanTimer) clearInterval(window.scanTimer);
    window.scanTimer = setInterval(() => {
      if (scanState === 'scanning' && peers.length === 0) {
        updatePeersUI();
      } else {
        clearInterval(window.scanTimer);
      }
    }, 1000);
  }
  updatePeersUI();
});

// ── 在线用户 ──
socket.on('online-users', (list) => {
  onlineUsers = list;
  renderOnlineUsers();
});

// ─── 导航切换 ────────────────────────────────────────────
navBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const mod = btn.dataset.module;
    navBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    panels.forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`panel-${mod}`);
    if (panel) panel.classList.add('active');
    if (mod === 'mindmap') {
      setTimeout(() => {
        if (window.mmResize) window.mmResize();
        // 自动打开上次的导图（仅当导图面板未加载过项目时）
        const mmTitle = document.getElementById('mindmap-title');
        const hasLoaded = mmTitle && !mmTitle.textContent.includes('思维导图');
        if (!hasLoaded) {
          const lastId = localStorage.getItem('mm-last-id');
          let target = null;
          if (lastId) target = projects.find(p => p.id === lastId && p.type === 'mindmap');
          if (!target) target = (projects||[]).filter(p => p.type === 'mindmap').sort((a, b) => (b.updatedAt||0) - (a.updatedAt||0))[0];
          if (target) window.openMindMapEditor(target);
        }
      }, 100);
    }
    if (mod === 'devices') setTimeout(() => window.renderDevices && window.renderDevices(), 100);
  });
});

// 分镜导航按钮（不走 data-module 模式）
document.getElementById('nav-storyboard').addEventListener('click', () => {
  navBtns.forEach(b => b.classList.remove('active'));
  document.getElementById('nav-storyboard').classList.add('active');
  panels.forEach(p => p.classList.remove('active'));
  document.getElementById('panel-storyboard').classList.add('active');
});

function initUI() {
  if (projects.length === 0) {
    createDefaultProject('script', '未命名剧本');
    createDefaultProject('mindmap', '未命名导图');
    createDefaultProject('story', '未命名故事');
  }
  renderProjects();
  updatePeersUI();
}

// ─── 项目管理 ────────────────────────────────────────────
function getDefaultData(type) {
  switch (type) {
    case 'script': return { acts: [] };
    case 'mindmap': return { nodes: [], edges: [] };
    case 'story': return { chapters: [] };
    case 'folder': return { children: [] };
    default: return {};
  }
}

function createDefaultProject(type, name) {
  socket.emit('project-create', { type, name, data: getDefaultData(type) });
}

// ─── 新建项目通用弹窗 ──────────────────────────────────
const createModal    = document.getElementById('create-modal');
const createIcon     = document.getElementById('create-icon');
const createTitle    = document.getElementById('create-title');
const createHint     = document.getElementById('create-hint');
const createInput    = document.getElementById('create-input');
const createConfirm  = document.getElementById('create-confirm');
const createCancel   = document.getElementById('create-cancel');
const createClose    = document.getElementById('create-close');

let createCallback = null; // 确认时调用的函数

function showCreateModal(opts) {
  // opts: { icon, title, hint, placeholder, defaultName, confirmText, callback(name) }
  createIcon.textContent    = opts.icon || '📄';
  createTitle.textContent   = opts.title || '新建项目';
  createHint.textContent    = opts.hint || '输入项目名称后点击确认。';
  createInput.placeholder   = opts.placeholder || '输入项目名称...';
  createInput.value         = opts.defaultName || '';
  createConfirm.textContent = opts.confirmText || '创建';
  createCallback            = opts.callback || null;
  createModal.style.display = 'flex';
  setTimeout(() => createInput.focus(), 100);
}

function closeCreateModal() {
  createModal.style.display = 'none';
  createCallback = null;
}

function confirmCreate() {
  const name = createInput.value.trim();
  const defaultName = createInput.placeholder.replace('输入', '').replace('名称...', '').trim() || '未命名';
  const finalName = name || defaultName;
  closeCreateModal();
  if (createCallback) createCallback(finalName);
}

createConfirm.addEventListener('click', confirmCreate);
createCancel.addEventListener('click', closeCreateModal);
createClose.addEventListener('click', closeCreateModal);
createModal.addEventListener('click', (e) => {
  if (e.target === createModal) closeCreateModal();
});
createInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmCreate();
  if (e.key === 'Escape') closeCreateModal();
});

$('#new-script-btn').addEventListener('click', () => {
  showCreateModal({
    icon: '📜', title: '新建剧本', hint: '创建一个新的空白剧本项目。',
    placeholder: '输入剧本名称...', defaultName: '新剧本',
    callback: (name) => socket.emit('project-create', { type: 'script', name, data: getDefaultData('script') }),
  });
});
$('#new-mindmap-btn').addEventListener('click', () => {
  showCreateModal({
    icon: '🧠', title: '新建思维导图', hint: '创建一个新的空白思维导图项目。',
    placeholder: '输入思维导图名称...', defaultName: '新思维导图',
    callback: (name) => socket.emit('project-create', { type: 'mindmap', name, data: getDefaultData('mindmap') }),
  });
});
$('#new-story-btn').addEventListener('click', () => {
  showCreateModal({
    icon: '📖', title: '新建故事', hint: '创建一个新的空白故事项目。',
    placeholder: '输入故事名称...', defaultName: '新故事',
    callback: (name) => socket.emit('project-create', { type: 'story', name, data: getDefaultData('story') }),
  });
});
$('#new-folder-btn').addEventListener('click', () => {
  showCreateModal({
    icon: '📁', title: '新建文件夹', hint: '创建一个空文件夹容器，可自行添加内容。',
    placeholder: '输入文件夹名称...', defaultName: '新文件夹',
    callback: (name) => socket.emit('project-create', { type: 'folder', name, data: getDefaultData('folder') }),
  });
});
$('#new-shooting-plan-btn').addEventListener('click', () => {
  showCreateModal({
    icon: '📋', title: '新建拍摄计划', hint: '将自动创建剧本 + 思维导图 + 故事三个子项目。',
    placeholder: '输入拍摄计划名称...', defaultName: '新拍摄计划',
    confirmText: '创建',
    callback: (name) => {
      socket.emit('project-create-batch', {
        name,
        children: [
          { type: 'script', name: name + ' - 剧本' },
          { type: 'mindmap', name: name + ' - 思维导图' },
          { type: 'story', name: name + ' - 故事' },
        ]
      });
    },
  });
});
$('#new-storyboard-btn').addEventListener('click', () => {
  showCreateModal({
    icon: '🎬', title: '新建分镜', hint: '创建一个新的分镜项目，将跳转到分镜编辑工具。',
    placeholder: '输入分镜项目名称...', defaultName: '未命名分镜',
    confirmText: '创建并打开',
    callback: () => {
      // 跳转到分镜面板
      navBtns.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      document.getElementById('nav-storyboard').classList.add('active');
      document.getElementById('panel-storyboard').classList.add('active');
      const frame = document.querySelector('#storyboard-frame iframe');
      if (frame) {
        const src = frame.src;
        frame.src = '';
        setTimeout(() => { frame.src = src; }, 50);
      }
    },
  });
});


function renderProjects() {
  projectList.innerHTML = '';
  if (projects.length === 0) {
    projectList.innerHTML = '<div class="editor-placeholder">暂无项目，点击上方按钮创建</div>';
    return;
  }
  // 先画文件夹，再画其他项目，同文件夹的项目折叠在文件夹内
  const folders = projects.filter(p => p.type === 'folder');
  const others = projects.filter(p => p.type !== 'folder');
  // 找出有 parentId 的项目（归属文件夹的）
  const withParent = others.filter(p => p.parentId);
  const standalone = others.filter(p => !p.parentId);
  // 渲染文件夹
  folders.forEach(f => {
    const card = document.createElement('div');
    card.className = 'project-card folder';
    const childCount = (f.data && f.data.children) ? f.data.children.length : 0;
    card.innerHTML = `
      <span class="p-type">📁</span>
      <button class="p-del" data-id="${f.id}">×</button>
      <div class="p-name">${esc(cleanProjectName(f.name))}</div>
      <div class="p-meta">文件夹 · ${childCount} 个项目 · ${timeAgo(f.updatedAt)}</div>
      <div class="p-owner">${esc(f.owner || '我')}</div>
    `;
    card.querySelector('.p-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await showConfirm(`删除文件夹「${f.name}」及其所有子项目？`, '删除确认', '🗑️')) {
        // 同时删除子项目
        (f.data && f.data.children || []).forEach(cid => {
          const idx = projects.findIndex(pp => pp.id === cid);
          if (idx !== -1) {
            projects.splice(idx, 1);
            socket.emit('project-delete', cid);
          }
        });
        socket.emit('project-delete', f.id);
      }
    });
    card.addEventListener('click', () => openProject(f));
    projectList.appendChild(card);
  });
  // 渲染独立项目
  standalone.forEach(p => {
    const icons = { script: '📜', mindmap: '🧠', story: '📖', folder: '📁' };
    const names = { script: '剧本', mindmap: '思维导图', story: '故事', folder: '文件夹' };
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <span class="p-type">${icons[p.type] || '📄'}</span>
      <button class="p-del" data-id="${p.id}">×</button>
      <div class="p-name">${esc(cleanProjectName(p.name))}</div>
      <div class="p-meta">${names[p.type] || p.type} · ${timeAgo(p.updatedAt)}</div>
      <div class="p-owner">${esc(p.owner || '我')}</div>
    `;
    card.querySelector('.p-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await showConfirm(`删除「${p.name}」？`, '删除确认', '🗑️')) socket.emit('project-delete', p.id);
    });
    card.addEventListener('click', () => openProject(p));
    projectList.appendChild(card);
  });
  updateTransferList();
}

function openProject(p) {
  navBtns.forEach(b => b.classList.remove('active'));
  panels.forEach(pl => pl.classList.remove('active'));
  // 文件夹：展开显示子项目
  if (p.type === 'folder') {
    const panel = document.getElementById('panel-projects');
    panel.classList.add('active');
    document.querySelector(`.nav-btn[data-module="projects"]`).classList.add('active');
    // 高亮该文件夹的子项目
    const children = p.data && p.data.children || [];
    renderProjects();
    // 滚动到子项目并标记
    if (children.length > 0) {
      setTimeout(() => {
        const cards = projectList.querySelectorAll('.project-card');
        cards.forEach(c => {
          const nameEl = c.querySelector('.p-name');
          if (nameEl) {
            const child = projects.find(pp => children.includes(pp.id));
            if (child && nameEl.textContent.includes(cleanProjectName(child.name).slice(0, 6))) {
              c.style.borderColor = 'var(--accent)';
              c.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        });
      }, 100);
    }
    return;
  }
  const panel = document.getElementById(`panel-${p.type}`);
  if (panel) {
    panel.classList.add('active');
    const btn = document.querySelector(`.nav-btn[data-module="${p.type}"]`);
    if (btn) btn.classList.add('active');
  }
  switch (p.type) {
    case 'script':  window.openScriptEditor(p); break;
    case 'mindmap': window.openMindMapEditor(p); break;
    case 'story':   window.openStoryEditor(p); break;
  }
}

// ─── 局域网开关 ──────────────────────────────────────────
lanCb.addEventListener('change', () => {
  lanStatus.textContent = lanCb.checked ? '🟢 局域网: 开启' : '🔴 局域网: 关闭';
  if (lanCb.checked) scanStartTime = Date.now();
  socket.emit('lan-toggle', lanCb.checked);
});
refreshLanBtn.addEventListener('click', () => socket.emit('refresh-lan'));
document.getElementById('lang-toggle-btn').addEventListener('click', () => {
  toggleLang();
  document.getElementById('lang-toggle-btn').textContent = currentLang === 'zh' ? '🇨🇳 中文' : '🇬🇧 English';
});

// ─── 管理员登录 ────────────────────────────────────────
document.getElementById('admin-login-btn').addEventListener('click', () => {
  if (isAdmin) { showAlert('你已是管理员', '提示', '👑'); return; }
  sessionStorage.removeItem('collab-auth');
  window.location.href = '/';
});

// ─── 多设备 UI ──────────────────────────────────────────
function updatePeersUI() {
  if (peers.length > 0) {
    let html = '';
    peers.forEach(p => {
      if (!p.connected && !p.reconnecting) return; // 已彻底离线的不显示
      const statusIcon = p.reconnecting ? '🔄' : (p.connected ? '🟢' : '🔴');
      const statusText = p.reconnecting ? '重连中...' : '';
      const noteHtml = p.note ? `<br><small>📝 ${esc(p.note)}</small>` : '';
      html += `<div style="margin-bottom:8px;padding:6px 0;border-bottom:1px solid var(--border)">
        <div class="peer-name">${statusIcon} ${esc(p.name)} ${statusText}</div>
        <div class="d-meta">IP: ${p.ip} · ID: ${p.serverId}</div>
        ${noteHtml}
      </div>`;
    });
    const onlineCount = peers.filter(p => p.connected).length;
    const reconnectingCount = peers.filter(p => p.reconnecting).length;
    const statusLine = onlineCount > 0
      ? `🟢 ${onlineCount} 台设备在线${reconnectingCount > 0 ? ` · 🔄 ${reconnectingCount} 重连中` : ''}`
      : `🔄 ${reconnectingCount} 台设备重连中...`;
    peerStatusArea.innerHTML = `<div class="status-connected">${statusLine}</div>${html}`;
    peerBadge.style.display = 'inline';
    peerBadge.className = onlineCount > 0 ? 'badge online' : 'badge';
    peerBadge.textContent = onlineCount > 0 ? `🤝 ${onlineCount} 在线` : '🔄 重连中';
    transferSection.style.display = 'block';
    noteSection.style.display = 'block';
    updateNoteSection();
    updateTransferList();
  } else {
    let html = `<div class="status-none">🔄 等待发现设备…<br><small>多台电脑都打开"开启局域网"</small></div>`;
    // 扫描状态提示
    if (scanState === 'scanning') {
      html += `<div class="scan-status scanning">🔍 正在扫描…还剩 ${getScanRemaining()}</div>`;
    } else if (scanState === 'nobody') {
      html += `<div class="scan-status nobody">⏰ 扫描 5 分钟结束，未发现设备</div>`;
      // 自动关闭开关
      lanCb.checked = false;
      lanStatus.textContent = '🔴 局域网: 关闭';
    }
    peerStatusArea.innerHTML = html;
    peerBadge.style.display = 'inline';
    peerBadge.className = 'badge offline';
    peerBadge.textContent = '💻 未连接';
    transferSection.style.display = 'none';
    noteSection.style.display = 'none';
  }
}

function updateNoteSection() {
  if (peers.length === 0) { noteSection.style.display = 'none'; return; }
  noteSection.style.display = 'block';

  let html = '<h3>📝 设备备注</h3>';
  peers.forEach(p => {
    html += `<div style="margin-bottom:6px">
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:2px">${esc(p.name)}</div>
      <input class="peer-note-input" data-id="${p.serverId}" value="${esc(p.note || '')}" placeholder="备注..." style="width:100%;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface2);color:var(--text);font-size:12px;outline:none">
    </div>`;
  });
  noteSection.innerHTML = html;

  // 自动保存备注
  noteSection.querySelectorAll('.peer-note-input').forEach(inp => {
    inp.addEventListener('change', () => {
      socket.emit('peer-note', { serverId: inp.dataset.id, note: inp.value.trim() });
    });
  });
}

// ─── 项目发送（多目标） ──────────────────────────────────
function updateTransferList() {
  transferList.innerHTML = '';
  if (peers.length === 0) { transferSection.style.display = 'none'; return; }

  // 目标选择
  let targetHtml = '<div style="margin-bottom:6px"><select id="transfer-target" style="width:100%;padding:4px;border:1px solid var(--border);border-radius:4px;background:var(--surface2);color:var(--text);font-size:12px">';
  peers.forEach(p => {
    targetHtml += `<option value="${p.serverId}">📤 发给 ${esc(p.name)}</option>`;
  });
  targetHtml += '</select></div>';
  transferList.innerHTML = targetHtml;

  // 项目选择
  projects.forEach(p => {
    const icons = { script: '📜', mindmap: '🧠', story: '📖', folder: '📁' };
    const item = document.createElement('div');
    item.className = 'transfer-item';
    item.innerHTML = `<input type="checkbox" class="transfer-cb" value="${p.id}"><span>${icons[p.type] || '📄'} ${esc(p.name)}</span>`;
    item.querySelector('.transfer-cb').addEventListener('change', updateTransferBtn);
    transferList.appendChild(item);
  });
  updateTransferBtn();
}

function updateTransferBtn() {
  const checked = document.querySelectorAll('.transfer-cb:checked');
  transferBtn.disabled = checked.length === 0;
}

transferBtn.addEventListener('click', async () => {
  const checked = document.querySelectorAll('.transfer-cb:checked');
  if (checked.length === 0) return;
  const ids = Array.from(checked).map(cb => cb.value);
  const target = document.getElementById('transfer-target');
  const targetServerId = target ? target.value : (peers[0] ? peers[0].serverId : null);
  if (!targetServerId) return showAlert('没有可发送的目标', '提示', '⚠️');
  const targetName = peers.find(p => p.serverId === targetServerId)?.name || '对方';
  if (await showConfirm(`发送 ${ids.length} 个项目给 ${targetName}？`, '发送确认', '📤')) {
    socket.emit('project-transfer', { ids, targetServerId });
  }
});

// ─── 接收弹窗 ────────────────────────────────────────────
function showReceiveModal(msg) {
  receiveInfo.textContent = `${esc(msg.from)} 给你发了 ${msg.projects.length} 个项目：`;
  receiveList.innerHTML = '';
  msg.projects.forEach(p => {
    const icons = { script: '📜', mindmap: '🧠', story: '📖', folder: '📁' };
    const div = document.createElement('div');
    div.className = 'rp-item';
    div.textContent = `${icons[p.type] || '📄'} ${p.name}`;
    receiveList.appendChild(div);
  });
  receiveModal.style.display = 'flex';
}
receiveOk.addEventListener('click', () => {
  receiveModal.style.display = 'none';
  renderProjects();
});

// ─── 工具 ────────────────────────────────────────────────
function cleanProjectName(name) {
  return (name || '').replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2702}-\u{27B0}\s]+/u, '');
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

// ─── 自定义 alert ────────────────────────────────────────
const alertModal    = document.getElementById('alert-modal');
const alertIcon     = document.getElementById('alert-icon');
const alertTitle    = document.getElementById('alert-title');
const alertText     = document.getElementById('alert-text');
const alertOk       = document.getElementById('alert-ok');

function showAlert(text, title, icon) {
  alertTitle.textContent  = title || '提示';
  alertIcon.textContent   = icon || 'ℹ️';
  alertText.textContent   = text;
  alertModal.style.display = 'flex';
  // 点击外部关闭
  alertModal.onclick = (e) => {
    if (e.target === alertModal) alertModal.style.display = 'none';
  };
}

alertOk.addEventListener('click', () => {
  alertModal.style.display = 'none';
});

// ─── 自定义 confirm ──────────────────────────────────────
const confirmModal   = document.getElementById('confirm-modal');
const confirmIcon    = document.getElementById('confirm-icon');
const confirmTitle   = document.getElementById('confirm-title');
const confirmText    = document.getElementById('confirm-text');
const confirmOk      = document.getElementById('confirm-ok');
const confirmCancel  = document.getElementById('confirm-cancel');

function showConfirm(text, title, icon) {
  return new Promise((resolve) => {
    confirmTitle.textContent = title || '确认操作';
    confirmIcon.textContent  = icon || '❓';
    confirmText.textContent  = text;
    confirmModal.style.display = 'flex';

    const cleanup = () => {
      confirmModal.style.display = 'none';
      confirmOk.onclick = null;
      confirmCancel.onclick = null;
      confirmModal.onclick = null;
    };

    confirmOk.onclick = () => { cleanup(); resolve(true); };
    confirmCancel.onclick = () => { cleanup(); resolve(false); };
    confirmModal.onclick = (e) => {
      if (e.target === confirmModal) { cleanup(); resolve(false); }
    };
  });
}

// ─── 模块注册 ────────────────────────────────────────────
// 各编辑器模块在加载时将自己注册到 CollabStudio.modules
// 格式: { name, open, save, getData, setData }
window.registerCollabModule = function(name, api) {
  CollabStudio.modules[name] = api;
};

function renderAdminPanel() {
  const container = document.getElementById('admin-panel');
  if (!container) return;
  container.style.display = 'block';
  
  // 请求用户列表
  socket.emit('admin-list-users');
  
  // 刷新按钮
  const refreshBtn = container.querySelector('#admin-refresh-btn');
  if (refreshBtn) {
    refreshBtn.onclick = () => socket.emit('admin-list-users');
  }
}

socket.on('admin-users-list', (list) => {
  const tbody = document.getElementById('admin-users-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  list.forEach(u => {
    if (u.isAdmin) return; // 不显示管理员自己
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(u.name)}</td>
      <td>${u.isBanned ? '🚫 已拉黑' : '✅ 正常'}</td>
      <td><code style="font-size:11px;color:var(--text-dim)">${esc(u.fingerprint || '—')}</code></td>
      <td>
        <input type="password" class="admin-new-pwd" data-name="${esc(u.name)}" placeholder="新密码" style="width:90px;padding:2px 4px;border:1px solid var(--border);border-radius:3px;background:var(--surface2);color:var(--text);font-size:11px;outline:none">
        <button class="admin-pwd-btn" data-name="${esc(u.name)}" style="padding:2px 6px;font-size:11px">修改</button>
      </td>
      <td>
        ${u.isBanned
          ? `<button class="admin-unban-btn" data-name="${esc(u.name)}" style="padding:2px 6px;font-size:11px;background:var(--green);border:none;border-radius:3px;color:#000;cursor:pointer">解禁</button>`
          : `<button class="admin-ban-btn" data-name="${esc(u.name)}" data-fp="${esc(u.fingerprint || '')}" style="padding:2px 6px;font-size:11px;background:var(--danger);border:none;border-radius:3px;color:#fff;cursor:pointer">拉黑</button>`
        }
      </td>
    `;
    tbody.appendChild(tr);
  });
  
  // 修改密码
  tbody.querySelectorAll('.admin-pwd-btn').forEach(btn => {
    btn.onclick = async () => {
      const inp = btn.parentElement.querySelector('.admin-new-pwd');
      const pwd = inp.value.trim();
      if (!pwd) return;
      if (!await showConfirm(`将 ${btn.dataset.name} 的密码改为 "${pwd}"？`, '修改密码', '🔑')) return;
      socket.emit('admin-change-password', { targetName: btn.dataset.name, newPassword: pwd });
      inp.value = '';
    };
  });
  
  // 拉黑
  tbody.querySelectorAll('.admin-ban-btn').forEach(btn => {
    btn.onclick = async () => {
      const name = btn.dataset.name;
      const fp = btn.dataset.fp;
      if (!await showConfirm(`拉黑 ${name}？${fp ? '（同时拉黑该设备所有账号）' : ''}`, '拉黑确认', '🚫')) return;
      socket.emit('admin-ban-user', { targetName: name, fingerprint: fp || undefined });
    };
  });
  
  // 解禁
  tbody.querySelectorAll('.admin-unban-btn').forEach(btn => {
    btn.onclick = async () => {
      if (!await showConfirm(`解禁 ${btn.dataset.name}？`, '解禁确认', '✅')) return;
      socket.emit('admin-unban-user', { targetName: btn.dataset.name });
    };
  });
});

// ─── 活动日志 ────────────────────────────────────────────
function renderActivityLog() {
  const container = document.getElementById('activity-log');
  if (!container) return;
  container.innerHTML = '';
  const logs = [...operationLog].reverse();
  if (logs.length === 0) {
    container.innerHTML = '<div class="editor-placeholder">暂无操作记录</div>';
    return;
  }
  logs.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'log-entry';
    const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const icons = { joined: '🟢', left: '🔴', created: '📄', updated: '✏️', deleted: '🗑️', sent: '📤', received: '📥' };
    const icon = icons[entry.action] || '•';
    div.innerHTML = `<span class="log-time">${time}</span> <span class="log-user">${esc(entry.userName)}</span> ${icon} ${esc(formatLog(entry))}`;
    container.appendChild(div);
  });
}
function formatLog(entry) {
  const mi = { script: '📜', mindmap: '🧠', story: '📖', folder: '📁', system: '⚙️' };
  const m = mi[entry.module] || '';
  switch (entry.action) {
    case 'joined': return '加入了协作';
    case 'left':   return '离开了协作';
    case 'created': return `${m} 创建了 ${entry.target}`;
    case 'updated': return `${m} 修改了 ${entry.target}`;
    case 'deleted': return `${m} 删除了 ${entry.target}`;
    case 'sent':    return `📤 发送了项目给 ${entry.target}`;
    case 'received':return `📥 收到了来自 ${entry.target} 的项目`;
    default: return `${m} ${entry.action} ${entry.target}`;
  }
}
window.addEventListener('log-entry', () => {
  const p = document.getElementById('panel-activity');
  if (p && p.classList.contains('active')) renderActivityLog();
});
document.querySelector('.nav-btn[data-module="activity"]').addEventListener('click', () => {
  setTimeout(renderActivityLog, 100);
});
document.getElementById('log-clear-btn').addEventListener('click', () => {
  operationLog = []; renderActivityLog();
});

// ─── 返回项目列表 ────────────────────────────────────────
document.querySelectorAll('#script-back, #mindmap-back, #story-back, #sb-back').forEach(btn => {
  btn.addEventListener('click', () => {
    navBtns.forEach(b => b.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    document.querySelector('.nav-btn[data-module="projects"]').classList.add('active');
    document.getElementById('panel-projects').classList.add('active');
    renderProjects();
  });
});

socket.on('admin-stats', (stats) => {
  document.getElementById('ctl-users').textContent = stats.onlineUsers || 0;
  document.getElementById('ctl-peers').textContent = stats.peers || 0;
  document.getElementById('ctl-projects').textContent = stats.projects || 0;
  document.getElementById('ctl-logs').textContent = stats.logCount || 0;
});

// 管理员收到密码重置申请
socket.on('admin-reset-request', (req) => {
  const container = document.getElementById('admin-resets');
  const list = document.getElementById('admin-resets-list');
  if (!container || !list) return;
  container.style.display = 'block';
  const div = document.createElement('div');
  div.className = 'approve-item';
  div.innerHTML = `
    <span class="ai-name">${esc(req.name)}</span>
    <span class="ai-text">请求重置密码: ${esc(req.reason)}</span>
    <button class="ai-approve" data-id="${req.id}" data-name="${esc(req.name)}" data-pwd="${esc(req.newPassword)}">批准</button>
    <button class="ai-reject" data-id="${req.id}" data-name="${esc(req.name)}">拒绝</button>
  `;
  list.appendChild(div);
  div.querySelector('.ai-approve').addEventListener('click', () => {
    socket.emit('admin-approve-reset', { requestId: req.id, name: req.name, newPassword: req.newPassword, approve: true });
    div.remove();
    if (list.children.length === 0) container.style.display = 'none';
  });
  div.querySelector('.ai-reject').addEventListener('click', () => {
    socket.emit('admin-approve-reset', { requestId: req.id, name: req.name, approve: false });
    div.remove();
    if (list.children.length === 0) container.style.display = 'none';
  });
});

// 管理员批量接收重置申请列表
socket.on('admin-resets-list', (requests) => {
  const container = document.getElementById('admin-resets');
  const list = document.getElementById('admin-resets-list');
  if (!container || !list) return;
  list.innerHTML = '';
  if (!requests || requests.length === 0) { container.style.display = 'none'; return; }
  container.style.display = 'block';
  requests.forEach(req => {
    const div = document.createElement('div');
    div.className = 'approve-item';
    div.innerHTML = `
      <span class="ai-name">${esc(req.name)}</span>
      <span class="ai-text">请求重置密码: ${esc(req.reason)}</span>
      <button class="ai-approve" data-id="${req.id}" data-name="${esc(req.name)}" data-pwd="${esc(req.newPassword)}">批准</button>
      <button class="ai-reject" data-id="${req.id}" data-name="${esc(req.name)}">拒绝</button>
    `;
    list.appendChild(div);
    div.querySelector('.ai-approve').addEventListener('click', () => {
      socket.emit('admin-approve-reset', { requestId: req.id, name: req.name, newPassword: req.newPassword, approve: true });
      div.remove();
      if (list.children.length === 0) container.style.display = 'none';
    });
    div.querySelector('.ai-reject').addEventListener('click', () => {
      socket.emit('admin-approve-reset', { requestId: req.id, name: req.name, approve: false });
      div.remove();
      if (list.children.length === 0) container.style.display = 'none';
    });
  });
});

// ─── 私聊系统 ──────────────────────────────────────────
const chatModal = document.getElementById('chat-modal');
const chatModalTitle = document.getElementById('chat-modal-title');
const chatMsgs = document.getElementById('chat-msgs');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');
let chatTargetUser = null;
let chatPartnerName = '';
let hasMsgPermit = false; // 是否有发消息权限
let msgPermitRequested = false;

// 关闭私聊
document.getElementById('chat-modal-close').addEventListener('click', () => {
  chatModal.style.display = 'none';
});

// 点击在线用户 → 打开私聊
function renderOnlineUsers() {
  const container = document.getElementById('online-users-area');
  if (!container) return;
  
  const count = onlineUsers.length;
  const badge = document.getElementById('online-badge');
  if (badge) {
    if (count > 0) {
      badge.style.display = 'inline';
      badge.className = 'badge online';
      badge.textContent = `👥 ${count} 人在线`;
    } else {
      badge.style.display = 'none';
    }
  }
  
  if (count === 0) {
    container.innerHTML = '<div class="status-none">⏳ 等待其他人加入…</div>';
    return;
  }
  
  let html = '';
  onlineUsers.forEach(u => {
    const isMe = u.name === myName;
    const isAdminUser = u.isAdmin;
    let icon, label;
    if (isMe && isAdminUser) { icon = '👑'; label = `${esc(u.name)} (管理员/我)`; }
    else if (isMe)           { icon = '⭐'; label = `${esc(u.name)} (我)`; }
    else if (isAdminUser)    { icon = '👑'; label = `${esc(u.name)} (管理员)`; }
    else                     { icon = '🟢'; label = esc(u.name); }
    const chatBtn = isMe ? '' : `<button class="chat-start-btn" data-name="${esc(u.name)}" style="margin-left:auto;padding:1px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface2);color:var(--text-dim);cursor:pointer;font-size:11px">💬</button>`;
    html += `<div class="online-user-item">
      <span class="online-user-dot">${icon}</span>
      <span class="online-user-name">${label}</span>
      ${chatBtn}
    </div>`;
  });
  container.innerHTML = html;
  
  // 绑定私聊按钮
  container.querySelectorAll('.chat-start-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetName = btn.dataset.name;
      openChat(targetName);
    });
  });
}

function openChat(targetName) {
  chatTargetUser = onlineUsers.find(u => u.name === targetName);
  chatPartnerName = targetName;
  chatModalTitle.textContent = `💬 与 ${esc(targetName)} 聊天`;
  chatMsgs.innerHTML = '';
  
  // 检查是否是管理员（管理员不需要权限）
  if (isAdmin) {
    hasMsgPermit = true;
    chatSendBtn.disabled = false;
  } else {
    // 非管理员需要权限
    checkMsgPermission(targetName);
  }
  
  chatInput.value = '';
  chatModal.style.display = 'flex';
  setTimeout(() => chatInput.focus(), 200);
}

function checkMsgPermission(targetName) {
  // 检查是否有缓存权限
  const permitKey = `msg-permit-${targetName}`;
  const cached = sessionStorage.getItem(permitKey);
  if (cached === 'true') {
    hasMsgPermit = true;
    chatSendBtn.disabled = false;
    return;
  }
  
  // 请求服务器检查权限
  socket.emit('check-message-permission', { target: targetName });
}

socket.on('message-permission-status', ({ target, permitted }) => {
  if (target !== chatPartnerName) return;
  hasMsgPermit = permitted;
  chatSendBtn.disabled = !permitted;
  if (!permitted && !msgPermitRequested) {
    // 显示提示，并自动请求
    const hint = document.createElement('div');
    hint.className = 'chat-msg system';
    hint.textContent = '⏳ 需要管理员批准才能发送消息，正在请求权限…';
    chatMsgs.appendChild(hint);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
    msgPermitRequested = true;
    socket.emit('request-message-permission', { target });
  }
});

socket.on('message-permission-granted', ({ target }) => {
  if (target !== chatPartnerName && target !== myName) return;
  hasMsgPermit = true;
  chatSendBtn.disabled = false;
  const permitKey = `msg-permit-${chatPartnerName}`;
  sessionStorage.setItem(permitKey, 'true');
  const hint = document.createElement('div');
  hint.className = 'chat-msg system';
  hint.textContent = '✅ 管理员已批准消息权限，现在可以发送消息了';
  chatMsgs.appendChild(hint);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
});

socket.on('message-permission-denied', ({ target }) => {
  if (target !== chatPartnerName) return;
  hasMsgPermit = false;
  chatSendBtn.disabled = true;
  msgPermitRequested = false;
  const hint = document.createElement('div');
  hint.className = 'chat-msg system';
  hint.textContent = '❌ 管理员拒绝了消息权限申请';
  chatMsgs.appendChild(hint);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
});

// 发送私聊消息
function sendChatMsg() {
  const text = chatInput.value.trim();
  if (!text || !chatTargetUser) return;
  if (!hasMsgPermit && !isAdmin) {
    showAlert('需要管理员批准才能发送消息', '提示', '⚠️');
    return;
  }
  chatInput.value = '';
  
  // 本地显示
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="cm-from">我</span> <span class="cm-text">${esc(text)}</span> <span class="cm-time">${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>`;
  chatMsgs.appendChild(div);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  
  // 通过服务器转发
  socket.emit('user-message-to-user', { target: chatPartnerName, text });
}

chatSendBtn.addEventListener('click', sendChatMsg);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMsg(); });

// 收到私聊消息
socket.on('user-incoming-msg', (msg) => {
  const from = msg.from;
  
  // 如果聊天窗口已打开且是对应人，直接显示
  if (chatModal.style.display === 'flex' && chatPartnerName === from) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<span class="cm-from">${esc(from)}</span> <span class="cm-text">${esc(msg.text)}</span> <span class="cm-time">${new Date(msg.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>`;
    chatMsgs.appendChild(div);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  } else {
    // 否则显示通知
    showAlert(`来自 ${esc(from)} 的消息: ${esc(msg.text)}`, '新消息', '💬');
  }
});

// ─── 管理员审批消息权限 ──────────────────────────────
socket.on('admin-permission-request', ({ from, target }) => {
  if (!isAdmin) return;
  showConfirm(
    `用户 ${esc(from)} 请求向 ${esc(target)} 发送消息，是否批准？`,
    '消息权限申请',
    '💬'
  ).then(approved => {
    socket.emit('admin-approve-permission', { from, target, approve: approved });
  });
});

// ─── 校易班纳新群二维码 ──────────────────────────────
const qqGroupBtn = document.getElementById('qq-group-btn');
if (qqGroupBtn) {
  qqGroupBtn.addEventListener('click', () => {
    if (window.openImagePreview) {
      window.openImagePreview('/qq-group-qr.jpg');
    }
  });
}
