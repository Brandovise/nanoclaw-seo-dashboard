// ============================================================
// Shared utility functions — used by both index.html and blog.html
// ============================================================

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}

const DASH_AUTH_INTERVAL_MS = 60_000;

async function checkDashboardAuthOnce() {
  try {
    const r = await fetch('/api/dashboard/auth-status', { credentials: 'same-origin' });
    if (!r.ok) return;
    const s = await r.json();
    if (s.required && !s.loggedIn && !String(location.pathname).includes('login.html')) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.replace('/login.html?next=' + next);
    }
  } catch (e) {
    /* network / no auth on server */
  }
}

if (typeof window !== 'undefined') {
  checkDashboardAuthOnce();
  setInterval(() => { checkDashboardAuthOnce(); }, DASH_AUTH_INTERVAL_MS);
}

async function api(path, options = {}) {
  const r = await fetch(path, { ...options, credentials: 'same-origin' });
  if (r.status === 401) {
    if (!String(path).includes('auth-status') && !String(path).includes('login') && !String(location.pathname).includes('login.html')) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.replace('/login.html?next=' + next);
    }
    const t = await r.text();
    throw new Error(t || 'Unauthorized');
  }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(1) + 's';
  return Math.floor(ms/60000) + 'm ' + Math.floor((ms%60000)/1000) + 's';
}

function statusBadge(status) {
  const map = {
    active: 'badge-green', paused: 'badge-yellow', completed: 'badge-gray',
    success: 'badge-green', error: 'badge-red', running: 'badge-blue',
  };
  return `<span class="badge ${map[status] || 'badge-gray'}">${status}</span>`;
}

function channelIcon(ch) {
  const icons = { whatsapp: '📱', slack: '💬', discord: '🎮', telegram: '✈️', gmail: '📧' };
  return icons[ch] || '💬';
}

function truncate(s, n) {
  if (!s) return '';
  s = s.replace(/\n/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(c) {
  if (!c) return '$0.00';
  if (c < 0.01) return '<$0.01';
  return '$' + c.toFixed(2);
}

/** Empty shape matching `/api/tokens` usage trees. */
function emptyTokenUsage() {
  const z = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, requests: 0 };
  return { total: Object.assign({}, z), byModel: {}, byAgent: {}, byDay: {}, byAgentModel: {} };
}

function modelColor(model) {
  if (model.includes('opus')) return '#a78bfa';
  if (model.includes('sonnet')) return '#60a5fa';
  if (model.includes('haiku')) return '#34d399';
  if (model.includes('gpt-4o')) return '#fb923c';
  if (model.includes('gpt')) return '#facc15';
  return '#94a3b8';
}

function agentColor(label) {
  if (label === 'admin-billing') return '#f472b6';
  if (label.startsWith('andy:')) return '#6366f1';
  if (label.startsWith('claude-code:')) return '#10b981';
  if (label.startsWith('dashboard:')) return '#c084fc';
  if (label.startsWith('group:')) return '#38bdf8';
  return '#94a3b8';
}
