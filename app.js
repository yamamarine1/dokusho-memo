'use strict';

// ---------- 保存（この端末のキャッシュ） ----------
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量不足などは無視 */ }
  },
};

let settings = LS.get('dm.settings', { api: '', token: '' });
let memos = LS.get('dm.memos', []);   // サーバーの内容＋未送信分を反映したもの
let queue = LS.get('dm.queue', []);   // 未送信の操作 [{action, payload}]
let bookInfo = LS.get('dm.books', {}); // タイトル → {isbn, author, publisher, pages, cover, pending, status, startedAt, finishedAt}
let shelfMode = LS.get('dm.shelfMode', 'list'); // 本棚の表示：list / grid
let shelfFilter = LS.get('dm.shelfFilter', 'all'); // 本棚の絞り込み：all / reading / want / done
let pendingIsbn = '';                   // 検索で見つからなかった ISBN（次に保存する本に付ける）
let flushing = false;
let lastRefresh = 0;
let currentBook = '';
let bookSort = 'page';
let searchTag = '';

const $ = (sel) => document.querySelector(sel);
const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const STATUS = { reading: '読書中', want: '読む予定', done: '読了' };
const configured = () => Boolean(settings.api && settings.token);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS は Mac として名乗る
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------- ユーティリティ ----------
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function parseTags(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,、，#＃]+/);
  return [...new Set(list.map((t) => t.trim()).filter(Boolean))];
}

function normalize(m) {
  return {
    id: String(m.id),
    createdAt: m.createdAt || '',
    updatedAt: m.updatedAt || '',
    date: m.date || '',
    title: String(m.title || '').trim(),
    page: String(m.page || '').trim(),
    memo: String(m.memo || ''),
    tags: parseTags(m.tags),
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, q) {
  if (!q) return esc(text);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let out = '';
  let last = 0;
  text.replace(re, (match, idx) => {
    out += esc(text.slice(last, idx)) + '<mark>' + esc(match) + '</mark>';
    last = idx + match.length;
    return match;
  });
  return out + esc(text.slice(last));
}

function pageNum(m) {
  const n = parseInt(m.page, 10);
  return Number.isNaN(n) ? Infinity : n;
}

function activity(m) {
  return m.createdAt || m.date || '';
}

function spineColor(title) {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 45% 55%)`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------- 通信 ----------
async function api(action, extra = {}) {
  const res = await fetch(settings.api, {
    method: 'POST',
    // text/plain にすると CORS のプリフライトが発生せず Apps Script に届く
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: settings.token, action, ...extra }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function saveState() {
  LS.set('dm.memos', memos);
  LS.set('dm.queue', queue);
  LS.set('dm.books', bookInfo);
}

function applyLocal(op) {
  if (op.action === 'saveBook') {
    // サーバーと同じく、送らなかった項目（読書の状態など）は残す
    const { title } = op.payload.book;
    bookInfo[title] = { ...(bookInfo[title] || {}), ...op.payload.book };
    return;
  }
  if (op.action === 'delete') {
    memos = memos.filter((m) => m.id !== op.payload.id);
    return;
  }
  const memo = normalize(op.payload.memo);
  const i = memos.findIndex((m) => m.id === memo.id);
  if (i >= 0) memos[i] = { ...memos[i], ...memo };
  else memos.push(memo);
}

function enqueue(action, payload) {
  const op = { action, payload };
  queue.push(op);
  applyLocal(op);
  saveState();
  renderAll();
  flush();
}

async function flush() {
  if (flushing || !configured() || !navigator.onLine) { updateBadge(); return; }
  flushing = true;
  try {
    while (queue.length) {
      const op = queue[0];
      let res;
      try {
        res = await api(op.action, op.payload);
      } catch {
        break; // 通信できない → 次の機会に再送
      }
      if (!res.ok) {
        if (String(res.error).includes('合言葉')) { toast('合言葉が違います。設定を確認してください'); break; }
        toast('保存できなかったメモがあります: ' + res.error);
      }
      queue.shift();
      saveState();
      updateBadge();
    }
  } finally {
    flushing = false;
    updateBadge();
    renderAll();
  }
}

async function refresh(force = false) {
  if (!configured() || !navigator.onLine) return;
  if (!force && Date.now() - lastRefresh < 30000) return;
  lastRefresh = Date.now();
  await flush();
  try {
    const res = await api('list');
    if (!res.ok) { toast(res.error); return; }
    memos = res.memos.map(normalize);
    bookInfo = Object.fromEntries((res.books || []).map((b) => [b.title, b]));
    queue.forEach(applyLocal); // まだ届いていない分を上に重ねる
    saveState();
    renderAll();
  } catch {
    /* オフライン時はキャッシュのまま */
  }
}

function updateBadge() {
  const el = $('#syncBadge');
  if (queue.length) { el.textContent = `未送信 ${queue.length}`; el.hidden = false; }
  else if (!navigator.onLine) { el.textContent = 'オフライン'; el.hidden = false; }
  else el.hidden = true;
}

// ---------- 集計 ----------
// 読書の状態。未設定でもメモがあれば「読書中」とみなす
function statusOf(title, count) {
  const s = (bookInfo[title] || {}).status;
  if (STATUS[s]) return s;
  return count ? 'reading' : '';
}

function books() {
  const map = new Map();
  for (const m of memos) {
    if (!m.title) continue;
    const b = map.get(m.title) || { title: m.title, count: 0, last: '', firstDate: '', lastDate: '', maxPage: 0 };
    b.count += 1;
    if (activity(m) > b.last) b.last = activity(m);
    if (m.date > b.lastDate) b.lastDate = m.date;
    if (m.date && (!b.firstDate || m.date < b.firstDate)) b.firstDate = m.date;
    if (pageNum(m) !== Infinity && pageNum(m) > b.maxPage) b.maxPage = pageNum(m);
    map.set(m.title, b);
  }
  // メモがまだない本も、状態が付いていれば本棚に並べる（読む予定の本など）
  for (const [title, info] of Object.entries(bookInfo)) {
    if (!map.has(title) && STATUS[info.status]) {
      map.set(title, { title, count: 0, last: info.updatedAt || '', firstDate: '', lastDate: '', maxPage: 0 });
    }
  }
  const list = [...map.values()];
  list.forEach((b) => { b.status = statusOf(b.title, b.count); });
  return list.sort((a, b) => (a.last < b.last ? 1 : -1));
}

function saveBookPatch(title, patch) {
  enqueue('saveBook', { book: { ...(bookInfo[title] || {}), ...patch, title } });
}

// タップでステータスを選べる印（本棚・記録画面）
function statusPick(title, status) {
  return `<button type="button" class="status-pick" data-pick="${esc(title)}" aria-label="ステータスを変える">`
    + `<span class="status-badge s-${STATUS[status] ? status : 'none'}">${STATUS[status] || 'ステータスを選ぶ'}<span class="caret">▾</span></span></button>`;
}

// 総ページ数が分かっていれば、メモした最大ページから読書位置（%）を出す
function progress(b) {
  const total = parseInt((bookInfo[b.title] || {}).pages, 10);
  if (!total || !b.maxPage) return null;
  return Math.min(100, Math.round((b.maxPage / total) * 100));
}

function progressHTML(pct) {
  return pct === null ? '' : `<div class="progress"><span style="width:${pct}%"></span></div>`;
}

function coverImg(title, cls) {
  const info = bookInfo[title];
  return info && info.cover
    ? `<img class="${cls}" src="${esc(info.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '';
}

function bookMetaText(title) {
  const info = bookInfo[title] || {};
  const parts = [info.author, info.publisher, info.pages && `全${info.pages}ページ`];
  if (String(info.pending) === 'true') parts.push(`ISBN ${info.isbn}（本の情報は登録され次第、自動で取得します）`);
  return parts.filter(Boolean).join(' ／ ');
}

function tagCounts() {
  const map = new Map();
  memos.forEach((m) => m.tags.forEach((t) => map.set(t, (map.get(t) || 0) + 1)));
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------- 描画 ----------
function memoHTML(m, { showBook = true, q = '' } = {}) {
  const pending = queue.some((op) => (op.payload.memo ? op.payload.memo.id : op.payload.id) === m.id);
  return `<div class="memo" data-id="${esc(m.id)}">
    <div class="memo-meta">
      ${showBook ? `<span class="m-book">${highlight(m.title, q)}</span>` : ''}
      ${m.page ? `<span class="m-page">p.${esc(m.page)}</span>` : ''}
      <span>${esc(m.date)}</span>
      ${pending ? '<span class="pending">未送信</span>' : ''}
    </div>
    ${m.memo ? `<div class="memo-body">${highlight(m.memo, q)}</div>` : ''}
    ${m.tags.length ? `<div class="memo-tags">${m.tags.map((t) => `<span>#${highlight(t, q)}</span>`).join('')}</div>` : ''}
  </div>`;
}

function renderAddView() {
  const bs = books();
  $('#bookList').innerHTML = bs.map((b) => `<option value="${esc(b.title)}">`).join('');

  const current = $('#fTitle').value.trim();
  $('#recentBooks').innerHTML = bs.slice(0, 6)
    .map((b) => `<button type="button" class="chip ${b.title === current ? 'on' : ''}" data-title="${esc(b.title)}">${esc(b.title)}</button>`)
    .join('');

  const meta = bookMetaText(current)
    || (pendingIsbn ? `ISBN ${pendingIsbn}（保存後、本の情報が登録され次第自動で取得します）` : '');
  const infoEl = $('#bookInfo');
  infoEl.hidden = !meta;
  infoEl.innerHTML = meta ? `${coverImg(current, '')}<span>${esc(meta)}</span>` : '';

  // タイトルが入ったらステータスを選べる（本棚にまだない本は何も選ばれていない）
  const shelved = bs.find((b) => b.title === current);
  const status = shelved ? shelved.status : '';
  $('#fStatusField').hidden = !current;
  document.querySelectorAll('#fStatus button')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.status === status));

  const chosen = parseTags($('#fTags').value);
  $('#recentTags').innerHTML = tagCounts().slice(0, 12)
    .map(([t]) => `<button type="button" class="chip ${chosen.includes(t) ? 'on' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`)
    .join('');

  const recent = [...memos].sort((a, b) => (activity(a) < activity(b) ? 1 : -1)).slice(0, 10);
  $('#recentList').innerHTML = recent.length
    ? recent.map((m) => memoHTML(m)).join('')
    : '<p class="empty">まだメモはありません</p>';
}

const SHELF_EMPTY = {
  all: 'まだ本がありません。「本を追加」か、記録画面でメモを書くと並びます',
  reading: '読書中の本はありません',
  want: '読む予定の本はありません。「本を追加」で登録できます',
  done: '読み終えた本はまだありません',
};

// 本棚の並び：読書中 → 読む予定 → 読了。読了は読み終えた日の新しい順、ほかは最後に触った順
function shelfSort(a, b) {
  const rank = { reading: 0, want: 1, done: 2, '': 3 };
  const key = (x) => (x.status === 'done' ? (bookInfo[x.title] || {}).finishedAt || x.lastDate : x.last);
  return rank[a.status] - rank[b.status] || (key(a) < key(b) ? 1 : -1);
}

function renderShelf() {
  const all = books();
  const counts = { all: all.length, reading: 0, want: 0, done: 0 };
  all.forEach((b) => { if (counts[b.status] !== undefined) counts[b.status] += 1; });
  $('#statusFilter').innerHTML = [['all', 'すべて'], ...Object.entries(STATUS)]
    .map(([k, label]) => `<button type="button" data-filter="${k}" class="${k === shelfFilter ? 'active' : ''}">${label}<span class="n">${counts[k]}</span></button>`)
    .join('');

  const bs = all.filter((b) => shelfFilter === 'all' || b.status === shelfFilter).sort(shelfSort);
  $('#shelfCount').textContent = bs.length ? `${bs.length}冊` : '';
  const list = $('#shelfList');
  document.querySelectorAll('.shelf-toggle button')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.shelf === shelfMode));
  list.classList.toggle('grid', shelfMode === 'grid' && bs.length > 0);

  if (!bs.length) {
    list.innerHTML = `<p class="empty">${SHELF_EMPTY[shelfFilter] || SHELF_EMPTY.all}</p>`;
    return;
  }

  if (shelfMode === 'grid') {
    list.innerHTML = bs.map((b) => `<div class="gbook" data-title="${esc(b.title)}">
        <div class="gbook-cv">
          ${coverImg(b.title, 'gbook-cover')
            || `<div class="gbook-cover gbook-blank" style="background:${spineColor(b.title)}">${esc(b.title)}</div>`}
          ${statusPick(b.title, b.status)}
        </div>
        <div class="gbook-title">${esc(b.title)}</div>
        ${b.status === 'reading' ? progressHTML(progress(b)) : ''}
      </div>`).join('');
    return;
  }

  list.innerHTML = bs.map((b) => {
    const info = bookInfo[b.title] || {};
    const pct = progress(b);
    const sub = [
      info.author,
      b.status === 'done' && info.finishedAt ? `${info.finishedAt} 読了` : b.lastDate && `最終 ${b.lastDate}`,
      b.status === 'reading' && pct !== null && `${pct}%`,
    ].filter(Boolean).map(esc).join(' ・ ');
    return `<div class="book" data-title="${esc(b.title)}">
        ${coverImg(b.title, 'book-cover') || `<span class="book-spine" style="background:${spineColor(b.title)}"></span>`}
        <div class="book-info">
          <div class="book-title">${esc(b.title)}</div>
          <div class="book-sub">${statusPick(b.title, b.status)}<span>${sub}</span></div>
          ${b.status === 'reading' ? progressHTML(pct) : ''}
        </div>
        <span class="book-count">${b.count ? `${b.count}件` : ''}</span>
      </div>`;
  }).join('');
}

function renderBook() {
  if (!currentBook) return;
  $('#bookTitle').textContent = currentBook;
  const info = bookInfo[currentBook] || {};
  const cover = $('#bookCover');
  cover.hidden = !info.cover;
  if (info.cover) cover.src = info.cover;
  const b = books().find((x) => x.title === currentBook);
  const pct = b ? progress(b) : null;
  $('#bookMeta').innerHTML = `<div>${esc(bookMetaText(currentBook))}</div>`
    + (pct === null ? '' : `<div>読んだ位置 p.${b.maxPage}（${pct}%）</div>${progressHTML(pct)}`);
  $('#bookScanBtn').innerHTML = icon('scan') + (info.isbn ? '本の情報を更新' : '本の情報を取得');

  const status = b ? b.status : statusOf(currentBook, 0);
  document.querySelectorAll('#bookStatus button')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.status === status));
  $('#bookStarted').value = info.startedAt || '';
  $('#bookFinished').value = info.finishedAt || '';
  $('#startedField').hidden = status !== 'reading' && status !== 'done';
  $('#finishedField').hidden = status !== 'done';
  $('.status-dates').hidden = $('#startedField').hidden;
  $('#removeBookBtn').hidden = !b || b.count > 0; // メモのある本は外さない（メモを消すと外せる）

  const list = memos.filter((m) => m.title === currentBook);
  list.sort(bookSort === 'page'
    ? (a, b) => pageNum(a) - pageNum(b) || (a.date < b.date ? -1 : 1)
    : (a, b) => (a.date === b.date ? (activity(a) < activity(b) ? 1 : -1) : (a.date < b.date ? 1 : -1)));
  $('#bookMemos').innerHTML = list.length
    ? list.map((m) => memoHTML(m, { showBook: false })).join('')
    : '<p class="empty">この本のメモはありません</p>';
  document.querySelectorAll('#view-book .sort-toggle button')
    .forEach((b) => b.classList.toggle('active', b.dataset.sort === bookSort));
}

function renderSearch() {
  $('#tagCloud').innerHTML = tagCounts()
    .map(([t, n]) => `<button type="button" class="chip ${t === searchTag ? 'on' : ''}" data-tag="${esc(t)}">#${esc(t)} ${n}</button>`)
    .join('');

  const q = $('#searchInput').value.trim();
  if (!q && !searchTag) {
    $('#searchResults').innerHTML = '<p class="empty">キーワードを入力するか、タグを選んでください</p>';
    return;
  }
  const lq = q.toLowerCase();
  const hits = memos
    .filter((m) => !searchTag || m.tags.includes(searchTag))
    .filter((m) => !q || [m.title, m.memo, m.page, m.tags.join(' '), (bookInfo[m.title] || {}).author || '']
      .join('\n').toLowerCase().includes(lq))
    .sort((a, b) => (activity(a) < activity(b) ? 1 : -1));
  $('#searchResults').innerHTML = hits.length
    ? `<p class="hint">${hits.length}件</p>` + hits.map((m) => memoHTML(m, { q })).join('')
    : '<p class="empty">見つかりませんでした</p>';
}

function renderAll() {
  renderAddView();
  renderShelf();
  renderBook();
  renderSearch();
  updateBadge();
}

// ---------- 画面切り替え ----------
const VIEW_TITLES = { add: '記録', shelf: '本棚', book: '本棚', search: '検索' };

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  const tab = name === 'book' ? 'shelf' : name;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === tab));
  $('#viewTitle').textContent = VIEW_TITLES[name];
  window.scrollTo(0, 0);
}

function openBook(title) {
  currentBook = title;
  renderBook();
  showView('book');
}

// ---------- 記録フォーム ----------
function resetForm() {
  $('#fDate').value = today();
  $('#fPage').value = '';
  $('#fMemo').value = '';
  $('#fTags').value = '';
  LS.set('dm.draft', null);
}

function saveDraft() {
  LS.set('dm.draft', {
    title: $('#fTitle').value, date: $('#fDate').value, page: $('#fPage').value,
    memo: $('#fMemo').value, tags: $('#fTags').value,
  });
}

$('#addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  stopMic();
  const title = $('#fTitle').value.trim();
  const memo = $('#fMemo').value.trim();
  const page = $('#fPage').value.trim();
  if (!title) { toast('タイトルを入力してください'); return; }
  if (!memo && !page) {
    toast(books().some((b) => b.title === title)
      ? `『${title}』は本棚に入っています。メモを残すときはメモかページを入力してください`
      : 'メモかページを入力してください（メモなしで本棚に入れるときは、ステータスを選んでください）');
    return;
  }

  const date = $('#fDate').value || today();
  enqueue('add', {
    memo: {
      id: uid(), createdAt: new Date().toISOString(),
      title, date, page, memo, tags: parseTags($('#fTags').value),
    },
  });
  const info = bookInfo[title] || {};
  const patch = {};
  // 見つからなかった ISBN は、この本に付けて保存しておく（サーバーが毎日再検索する）
  if (pendingIsbn && !info.isbn) Object.assign(patch, { isbn: pendingIsbn, pending: 'true' });
  // メモを書いたら「読書中」にする（読了の本に書き足したときはそのまま）
  if (!STATUS[info.status] || info.status === 'want') {
    const first = books().find((b) => b.title === title);
    Object.assign(patch, { status: 'reading', startedAt: info.startedAt || (first && first.firstDate) || date });
  }
  if (Object.keys(patch).length) saveBookPatch(title, patch);
  pendingIsbn = '';
  LS.set('dm.lastTitle', title);
  resetForm();
  renderAddView();
  toast(configured() && navigator.onLine ? '保存しました' : '保存しました（通信できたら送信します）');
});

['#fTitle', '#fDate', '#fPage', '#fMemo', '#fTags'].forEach((sel) => $(sel).addEventListener('input', saveDraft));
$('#fTitle').addEventListener('input', renderAddView);
$('#fTags').addEventListener('input', renderAddView);

// ステータスを選んだら、その場で本棚に入れる（メモはなくてよい）
$('#fStatus').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-status]');
  const title = $('#fTitle').value.trim();
  if (!btn || !title) return;
  const info = bookInfo[title] || {};
  const patch = statusPatch(title, btn.dataset.status);
  if (pendingIsbn && !info.isbn) Object.assign(patch, { isbn: pendingIsbn, pending: 'true' });
  saveBookPatch(title, patch);
  pendingIsbn = '';
  LS.set('dm.lastTitle', title);
  renderAddView();
  toast(`『${title}』を「${STATUS[btn.dataset.status]}」で本棚に入れました`);
});

$('#recentBooks').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-title]');
  if (!chip) return;
  $('#fTitle').value = chip.dataset.title;
  pendingIsbn = '';
  saveDraft();
  renderAddView();
});

$('#recentTags').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag]');
  if (!chip) return;
  const tags = parseTags($('#fTags').value);
  const t = chip.dataset.tag;
  const next = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t];
  $('#fTags').value = next.join(' ');
  saveDraft();
  renderAddView();
});

// ---------- 音声入力 ----------
// iPhone / iPad のホーム画面アプリではブラウザの音声認識が固まることがあるため、
// iOS ではキーボードの音声入力（マイクキー）に誘導する。パソコンではブラウザの音声認識を使う。
const SR = isIOS ? null : (window.SpeechRecognition || window.webkitSpeechRecognition);
let rec = null;

function stopMic() {
  if (rec) rec.stop();
}

if (isIOS) {
  const btn = $('#micBtn');
  btn.hidden = false;
  btn.addEventListener('click', () => {
    const area = $('#fMemo');
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    $('#micHint').hidden = false; // トーストはキーボードに隠れるので、メモ欄の下に案内を出す
  });
  $('#fMemo').addEventListener('blur', () => { $('#micHint').hidden = true; });
} else if (SR) {
  const btn = $('#micBtn');
  btn.hidden = false;
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    const area = $('#fMemo');
    const base = area.value && !/\s$/.test(area.value) ? area.value + '\n' : area.value;
    rec = new SR();
    rec.lang = 'ja-JP';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let text = '';
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      area.value = base + text;
      saveDraft();
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed') toast('マイクの使用が許可されていません');
      else if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast('音声入力エラー: ' + ev.error);
    };
    rec.onend = () => {
      rec = null;
      btn.classList.remove('listening');
      btn.innerHTML = icon('mic') + '音声入力';
    };
    rec.start();
    btn.classList.add('listening');
    btn.textContent = '■ 停止';
  });
}

// ---------- バーコード（ISBN）読み取り ----------
let zxingLoading = null;

// 読み取りライブラリはカメラを開いたときだけ読み込む（起動を軽くするため）
function loadZXing() {
  if (window.ZXing) return Promise.resolve();
  if (!zxingLoading) {
    zxingLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/zxing-library-0.21.3.min.js';
      s.onload = resolve;
      s.onerror = () => { zxingLoading = null; reject(new Error('読み取り機能を読み込めませんでした')); };
      document.head.append(s);
    });
  }
  return zxingLoading;
}

// 読み取りは zxing-cpp（WebAssembly 版。ピンぼけに強い）と ZXing（JavaScript 版。細いバーコードに強いことがある）の両方で試す。
// WebAssembly 版を読み込めない端末では JavaScript 版だけを使う
let wasmReady = null;
function loadWasmReader() {
  if (!wasmReady) {
    wasmReady = loadScript('vendor/zxing-wasm-reader-3.1.4.js')
      .then(() => ZXingWASM.getZXingModule({
        locateFile: (path, prefix) => (path.endsWith('.wasm')
          ? new URL('vendor/zxing_reader-3.1.4.wasm', location.href).href
          : prefix + path),
      }))
      .then(() => true)
      .catch(() => false);
  }
  return wasmReady;
}

const WASM_OPTIONS = { formats: ['EAN13'], tryHarder: true, tryRotate: true, tryInvert: false, maxNumberOfSymbols: 2 };
let useWasm = false;

async function loadScanner() {
  const [wasm] = await Promise.all([loadWasmReader(), loadZXing()]);
  useWasm = wasm;
}

// キャンバスに描いた画像から ISBN を探す。上段（978/979）と下段（192）が両方写っていたら上段を返す
async function readCanvas(ctx, reader) {
  if (useWasm) {
    const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    const results = await ZXingWASM.readBarcodes(img, WASM_OPTIONS);
    const hit = results.find((r) => /^97[89]/.test(r.text)) || results[0];
    if (hit && /^97[89]/.test(hit.text)) return hit.text;
    const js = decodeCanvas(reader, ctx.canvas);
    return js || (hit ? hit.text : null);
  }
  return decodeCanvas(reader, ctx.canvas);
}

function isValidIsbn13(code) {
  if (!/^97[89]\d{10}$/.test(code)) return false;
  const sum = [...code.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

// 手入力の ISBN（ハイフン・全角・10桁も可）を 13 桁にそろえる
function toIsbn13(text) {
  const s = String(text).replace(/[０-９Ｘｘ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 13) return s;
  if (s.length !== 10) return s;
  const body = '978' + s.slice(0, 9);
  const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

function makeDecoder() {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  return reader;
}

// キャンバスの画像からバーコードを探す。明暗の判定方法を 2 通り試す（照明やピントの甘さに強くするため）
function decodeCanvas(reader, canvas) {
  const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
  for (const Binarizer of [ZXing.HybridBinarizer, ZXing.GlobalHistogramBinarizer]) {
    try {
      return reader.decodeWithState(new ZXing.BinaryBitmap(new Binarizer(source))).getText();
    } catch { /* 見つからない */ }
  }
  return null;
}

// 画像（または映像の 1 コマ）の一部を切り出し、長い辺を maxSide 以下にしてキャンバスに描く
function drawRegion(ctx, src, sw, sh, crop, maxSide) {
  const cw = sw * crop.w;
  const ch = sh * crop.h;
  const scale = Math.min(1, maxSide / Math.max(cw, ch));
  ctx.canvas.width = Math.max(1, Math.round(cw * scale));
  ctx.canvas.height = Math.max(1, Math.round(ch * scale));
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

const scanDialog = $('#scanDialog');
let scanStream = null;
let scanLoop = 0;     // カメラを止めたら番号を進めて、読み取りの繰り返しを終わらせる
let scanResolve = null;
let scanPick = null;  // 読み取って確認中の本 { isbn, found }
let scanSeq = 0;      // 読み直したあとに古い検索結果を表示しないための番号

function stopCamera() {
  scanLoop++;
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  $('#scanVideo').srcObject = null;
}

function finishScan(result) {
  const resolve = scanResolve;
  scanResolve = null;
  scanSeq++;
  stopCamera();
  if (scanDialog.open) scanDialog.close();
  if (resolve) resolve(result);
}

// 対応している端末では、ピントを合わせ続ける設定と 2 倍ズームにする（近づけすぎてぼやけるのを防ぐ）
function tuneTrack(track) {
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.focusMode = 'continuous';
    if (caps.zoom && caps.zoom.max >= 1.5) adv.zoom = Math.min(2, caps.zoom.max);
    if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] }).catch(() => {});
  } catch { /* 設定できない端末はそのまま */ }
}

async function startCamera() {
  const loop = ++scanLoop;
  $('#scanStatus').textContent = 'カメラを起動しています…';
  let stream;
  try {
    await loadScanner();
    if (loop !== scanLoop || !scanResolve || scanPick) return;
    // 細いバーコードの線がつぶれないよう、高い解像度で開く
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch {
    if (loop === scanLoop) $('#scanStatus').textContent = 'カメラを使えません。写真から読み取るか、ISBN を手入力してください';
    return;
  }
  if (loop !== scanLoop) { stream.getTracks().forEach((t) => t.stop()); return; } // 起動中にキャンセルされた
  scanStream = stream;
  tuneTrack(stream.getVideoTracks()[0]);
  const video = $('#scanVideo');
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay 属性で再生される */ }
  if (loop !== scanLoop) return;
  $('#scanStatus').textContent = 'バーコードを枠に合わせてください（近すぎるとぼやけます。15〜20cm 離して）';

  const reader = makeDecoder();
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  // 枠のあたり（中央の横長の帯）は縮小せずに、広めの範囲は縮小して、交互に読む
  const crops = [[{ w: 0.9, h: 0.3 }, 2000], [{ w: 1, h: 0.7 }, 1280]];
  let n = 0;
  const tick = async () => {
    if (loop !== scanLoop) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const [crop, maxSide] = crops[n++ % crops.length];
      drawRegion(ctx, video, video.videoWidth, video.videoHeight, crop, maxSide);
      let text = null;
      try { text = await readCanvas(ctx, reader); } catch { /* 次のコマで再挑戦 */ }
      if (loop !== scanLoop) return;
      if (text && acceptCode(text)) return;
    }
    setTimeout(tick, 60);
  };
  tick();
}

function acceptCode(code) {
  if (isValidIsbn13(code)) { showScanned(code); return true; }
  $('#scanStatus').textContent = /^19[12]/.test(code)
    ? 'それは下段のバーコードです。上段（978 で始まる方）を読み取ってください'
    : 'ISBN として読み取れませんでした';
  return false;
}

// 読み取れたことをはっきり示し、本の情報を確かめてから「この本で記録」で決定する
async function showScanned(isbn) {
  const seq = ++scanSeq;
  stopCamera();
  scanPick = { isbn, found: null };
  $('.scan-view').classList.add('ok');
  $('#scanStatus').textContent = `✓ 読み取りました（ISBN ${isbn}）`;
  const card = $('#scanResult');
  card.hidden = false;
  $('#scanResultBody').innerHTML = '<span class="hit-cover"></span><span class="hit-main">'
    + `<span class="hit-title">本の情報を検索しています…</span><span class="hit-sub">ISBN ${isbn}</span></span>`;
  $('#scanConfirm').disabled = true;
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const known = Object.values(bookInfo).find((b) => b.isbn === isbn);
  const found = await lookupBook(isbn);
  if (seq !== scanSeq) return;
  scanPick.found = found;
  let html;
  if (found.book) {
    const b = found.book;
    const sub = [b.author, b.publisher, b.pages && `全${b.pages}ページ`].filter(Boolean).join(' ／ ');
    html = (b.cover ? `<img class="hit-cover" src="${esc(b.cover)}" alt="" referrerpolicy="no-referrer">` : '<span class="hit-cover"></span>')
      + `<span class="hit-main"><span class="hit-title">${esc(known ? known.title : b.title)}</span>`
      + `<span class="hit-sub">${esc(sub)}</span></span>`;
  } else if (found.notFound) {
    html = '<span class="hit-cover"></span><span class="hit-main">'
      + `<span class="hit-title">${known ? esc(known.title) : 'まだ登録されていない本です'}</span>`
      + `<span class="hit-sub">ISBN ${isbn}${known ? '' : '（決定するとタイトルを入力できます。本の情報は後日自動で取得します）'}</span></span>`;
  } else {
    html = '<span class="hit-cover"></span><span class="hit-main"><span class="hit-title">本の情報を検索できませんでした</span>'
      + `<span class="hit-sub">${esc(found.error)}。通信を確認して「読み直す」を押してください</span></span>`;
  }
  $('#scanResultBody').innerHTML = html;
  $('#scanConfirm').disabled = !!found.error;
}

function clearScanned() {
  scanSeq++;
  scanPick = null;
  $('#scanResult').hidden = true;
  $('.scan-view').classList.remove('ok');
}

$('#scanConfirm').addEventListener('click', () => { if (scanPick && scanPick.found) finishScan(scanPick); });
$('#scanRetry').addEventListener('click', () => { clearScanned(); startCamera(); });

// 本を探して返す：{ isbn, found }（found がなければ呼び出し側で検索）／ISBN なしの本 { book }／キャンセル時は null
function scanIsbn(confirmLabel = 'この本で記録') {
  return new Promise((resolve) => {
    scanResolve = resolve;
    clearScanned();
    $('#scanConfirm').textContent = confirmLabel;
    $('#isbnInput').value = '';
    $('#titleQuery').value = '';
    $('#findStatus').textContent = '';
    $('#ocrLines').innerHTML = '';
    $('#findResults').innerHTML = '';
    findHits = [];
    scanDialog.showModal();
    startCamera();
  });
}

scanDialog.addEventListener('close', () => finishScan(null));
$('#scanCancel').addEventListener('click', () => finishScan(null));

$('#isbnGo').addEventListener('click', () => {
  const code = toIsbn13($('#isbnInput').value);
  if (!acceptCode(code)) $('#scanStatus').textContent = 'ISBN（13桁または10桁）を確認してください';
});

$('#scanPhoto').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  stopCamera();
  clearScanned();
  $('#scanStatus').textContent = '写真を解析しています…';
  const url = URL.createObjectURL(file);
  try {
    await loadScanner();
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    // 写真全体・中央部分を、いくつかの大きさで試す
    const reader = makeDecoder();
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const tries = [[{ w: 1, h: 1 }, 1600], [{ w: 0.7, h: 0.5 }, 1600], [{ w: 1, h: 1 }, 2400], [{ w: 1, h: 1 }, 1000], [{ w: 0.5, h: 0.3 }, 1200]];
    let text = null;
    for (const [crop, size] of tries) {
      drawRegion(ctx, img, img.naturalWidth, img.naturalHeight, crop, size);
      text = await readCanvas(ctx, reader);
      if (text) break;
    }
    if (!text) throw new Error('not found');
    acceptCode(text);
  } catch {
    $('#scanStatus').textContent = '読み取れませんでした。バーコードが画面の中央に大きく写るよう、少し離してまっすぐ撮ってください';
  } finally {
    URL.revokeObjectURL(url);
  }
});

// ---------- 題名・スクリーンショットで探す（バーコードのない電子書籍など） ----------
let findHits = [];
let findSeq = 0; // 古い検索結果で上書きしないための番号

function canSearch() {
  if (configured() && navigator.onLine) return true;
  $('#findStatus').textContent = '検索には通信と設定（⚙︎）が必要です';
  return false;
}

function renderHits(hits) {
  findHits = hits;
  $('#findResults').innerHTML = hits.map((b, i) => {
    const sub = [b.author, b.publisher && b.publisher.slice(0, 20), b.year].filter(Boolean).join(' ／ ');
    const cover = b.isbn
      ? `<img class="hit-cover" src="https://www.hanmoto.com/bd/img/${b.isbn}.jpg" alt="" referrerpolicy="no-referrer" loading="lazy">`
      : '<span class="hit-cover"></span>';
    return `<button type="button" class="hit" data-i="${i}">${cover}<span class="hit-main">`
      + `<span class="hit-title">${esc(b.title)}${b.ebook ? '<span class="hit-tag">電子</span>' : ''}</span>`
      + `<span class="hit-sub">${esc(sub)}</span></span></button>`;
  }).join('');
  // 表紙が未登録の本は小さな代替画像が返るので消す
  $('#findResults').querySelectorAll('img.hit-cover').forEach((img) => {
    const hide = () => { img.style.visibility = 'hidden'; };
    img.addEventListener('error', hide);
    img.addEventListener('load', () => { if (img.naturalWidth < 100) hide(); });
  });
}

async function findByTitle(q) {
  q = q.trim();
  if (!q || !canSearch()) return;
  stopCamera();
  const seq = ++findSeq;
  $('#titleQuery').value = q;
  $('#findStatus').textContent = `「${q}」を検索しています…`;
  try {
    const res = await api('search', { q });
    if (seq !== findSeq) return;
    if (!res.ok) throw new Error(res.error);
    renderHits(res.results);
    $('#findStatus').textContent = res.results.length
      ? '該当する本をタップしてください'
      : '見つかりませんでした。題名を短くするか、著者名を足して試してください';
  } catch (err) {
    if (seq === findSeq) $('#findStatus').textContent = '検索できませんでした';
  }
}

$('#titleGo').addEventListener('click', () => findByTitle($('#titleQuery').value));
$('#titleQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); findByTitle(e.target.value); }
});

$('#findResults').addEventListener('click', (e) => {
  const el = e.target.closest('.hit');
  if (!el) return;
  const b = findHits[Number(el.dataset.i)];
  if (!b) return;
  // ISBN があれば通常の検索に回して表紙なども確認する。なければ候補の情報をそのまま使う
  if (b.isbn && isValidIsbn13(b.isbn)) finishScan({ isbn: b.isbn });
  else finishScan({ book: { title: b.title, author: b.author, publisher: b.publisher, pages: b.pages, isbn: '', cover: '', pending: '' } });
});

$('#ocrLines').addEventListener('click', (e) => {
  const el = e.target.closest('.chip');
  if (el) findByTitle(el.dataset.q);
});

// 画像を縮小して JPEG の base64 にする（送信量を減らし、OCR も速くなる）
function imageToJpegBase64(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を開けませんでした')); };
    img.src = url;
  });
}

$('#scanShot').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !canSearch()) return;
  stopCamera();
  const seq = ++findSeq;
  $('#ocrLines').innerHTML = '';
  $('#findResults').innerHTML = '';
  $('#findStatus').textContent = '画像の文字を読み取っています…（10秒ほど）';
  try {
    const image = await imageToJpegBase64(file);
    const res = await api('ocr', { image });
    if (seq !== findSeq) return;
    if (!res.ok) throw new Error(res.error);
    if (res.isbn) { showScanned(res.isbn); return; } // 奥付などに ISBN が写っていた
    $('#ocrLines').innerHTML = res.lines.map((l) => `<button type="button" class="chip" data-q="${esc(l)}">${esc(l)}</button>`).join('');
    if (res.query) $('#titleQuery').value = res.query;
    renderHits(res.results || []);
    $('#findStatus').textContent = res.results && res.results.length
      ? `「${res.query}」で見つかった本です。違うときは、題名の行をタップしてください`
      : (res.lines.length ? '題名の行をタップして検索してください' : '文字を読み取れませんでした。題名がはっきり写った画面で試してください');
  } catch (err) {
    if (seq === findSeq) $('#findStatus').textContent = '読み取れませんでした（' + (err.message || err) + '）';
  }
});

// 表紙画像があるか確認（未登録の本は小さな代替画像が返るので除外）
function checkCover(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(''); return; }
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    const timer = setTimeout(() => resolve(''), 8000);
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth >= 100 ? url : ''); };
    img.onerror = () => { clearTimeout(timer); resolve(''); };
    img.src = url;
  });
}

// 戻り値：{ book } 見つかった ／ { notFound: true } 未登録 ／ { error } 通信エラーなど
async function lookupBook(isbn) {
  if (!configured() || !navigator.onLine) return { error: '本の検索には通信と設定（⚙︎）が必要です' };
  try {
    const res = await api('lookup', { isbn });
    if (!res.ok) return res.notFound ? { notFound: true } : { error: res.error || '検索できませんでした' };
    const book = { ...res.book, pending: '' };
    book.cover = await checkCover(book.cover);
    return { book };
  } catch {
    return { error: '検索できませんでした' };
  }
}

// 題名検索の候補（ISBN あり）を選んだときは、ここで本の情報を確かめる
async function resolvePick(picked) {
  if (picked.found) return picked.found;
  toast('本の情報を検索しています…');
  return lookupBook(picked.isbn);
}

// 記録画面の 📷：読み取った本をタイトルに入れる
$('#scanBtn').addEventListener('click', async () => {
  const picked = await scanIsbn();
  if (!picked) return;
  if (picked.book) { // 題名検索で選んだ ISBN なしの本（電子書籍など）
    const known = bookInfo[picked.book.title];
    if (!known) enqueue('saveBook', { book: picked.book });
    $('#fTitle').value = picked.book.title;
    pendingIsbn = '';
    toast(`『${picked.book.title}』を選びました`);
    saveDraft();
    renderAddView();
    return;
  }
  const { isbn } = picked;
  // 同じ本を登録済みなら、そのタイトル（自分で直した名前かもしれない）を使う
  const known = Object.values(bookInfo).find((b) => b.isbn === isbn);
  // 検索中に保存されると前の本にメモが付いてしまうので、保存ボタンを止めておく
  const saveBtn = $('#addForm button[type="submit"]');
  saveBtn.disabled = true;
  saveBtn.textContent = '本を検索中…';
  let found;
  try {
    found = await resolvePick(picked);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '保存';
  }
  if (found.error) { toast(found.error); return; }

  if (found.notFound) {
    if (known) {
      $('#fTitle').value = known.title;
      toast(`『${known.title}』（登録済みの本）`);
    } else {
      pendingIsbn = isbn;
      $('#fTitle').value = '';
      $('#fTitle').focus();
      toast('まだ登録されていない本です。タイトルを入力してください（本の情報は後日自動で取得します）');
    }
  } else {
    const title = known ? known.title : found.book.title;
    enqueue('saveBook', { book: { ...found.book, title } });
    $('#fTitle').value = title;
    pendingIsbn = '';
    toast(`『${title}』を読み取りました`);
  }
  saveDraft();
  renderAddView();
});

// 本の詳細の 📷：既存の本に情報を付ける（タイトルはそのまま）
$('#bookScanBtn').addEventListener('click', async () => {
  const title = currentBook;
  const picked = await scanIsbn();
  if (!picked) return;
  if (picked.book) {
    const filled = Object.fromEntries(Object.entries(picked.book).filter(([, v]) => v)); // 空の項目で既存の情報を消さない
    enqueue('saveBook', { book: { ...(bookInfo[title] || {}), ...filled, title } });
    toast(`本の情報を取得しました（${picked.book.title}）`);
    return;
  }
  const { isbn } = picked;
  const found = await resolvePick(picked);
  if (found.error) { toast(found.error); return; }
  if (found.notFound) {
    enqueue('saveBook', { book: { ...(bookInfo[title] || {}), title, isbn, pending: 'true' } });
    toast('まだ登録されていない本です。ISBN を保存し、登録され次第自動で情報を取得します');
  } else {
    enqueue('saveBook', { book: { ...found.book, title } });
    toast(`本の情報を取得しました（${found.book.title}）`);
  }
});

document.querySelectorAll('.shelf-toggle button').forEach((btn) => btn.addEventListener('click', () => {
  shelfMode = btn.dataset.shelf;
  LS.set('dm.shelfMode', shelfMode);
  renderShelf();
}));

$('#statusFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  shelfFilter = btn.dataset.filter;
  LS.set('dm.shelfFilter', shelfFilter);
  renderShelf();
});

// ---------- 読書の状態（本の詳細） ----------
// 状態を変えたら、開始日・読了日が空なら自動で入れる（あとから日付欄で直せる）
function statusPatch(title, status) {
  const info = bookInfo[title] || {};
  const b = books().find((x) => x.title === title);
  const patch = { status };
  // 読了にしたときは、メモがあれば最初のメモの日を開始日にする（なければ空のまま）
  if (!info.startedAt && (status === 'reading' || (status === 'done' && b && b.firstDate))) {
    patch.startedAt = (b && b.firstDate) || today();
  }
  if (status === 'done' && !info.finishedAt) patch.finishedAt = today();
  return patch;
}

$('#bookStatus').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-status]');
  if (!btn || !currentBook) return;
  saveBookPatch(currentBook, statusPatch(currentBook, btn.dataset.status));
  toast(`「${STATUS[btn.dataset.status]}」にしました`);
});
$('#bookStarted').addEventListener('change', (e) => saveBookPatch(currentBook, { startedAt: e.target.value }));
$('#bookFinished').addEventListener('change', (e) => saveBookPatch(currentBook, { finishedAt: e.target.value }));
$('#removeBookBtn').addEventListener('click', () => {
  saveBookPatch(currentBook, { status: '' });
  toast(`『${currentBook}』を本棚から外しました`);
  showView('shelf');
});

// ---------- 本を追加（メモなしで本棚に入れる） ----------
const addBookDialog = $('#addBookDialog');
let abBook = null;     // 探して見つけた本の情報
let abStatus = 'want';

function renderAddBook() {
  document.querySelectorAll('#abStatus button')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.status === abStatus));
  const meta = abBook
    ? [abBook.author, abBook.publisher, abBook.pages && `全${abBook.pages}ページ`,
      String(abBook.pending) === 'true' && `ISBN ${abBook.isbn}（本の情報は登録され次第、自動で取得します）`].filter(Boolean).join(' ／ ')
    : '';
  $('#abInfo').hidden = !meta;
  $('#abInfo').innerHTML = meta
    ? (abBook.cover ? `<img src="${esc(abBook.cover)}" alt="" referrerpolicy="no-referrer">` : '') + `<span>${esc(meta)}</span>`
    : '';
}

$('#addBookBtn').addEventListener('click', () => {
  abBook = null;
  abStatus = shelfFilter === 'reading' || shelfFilter === 'done' ? shelfFilter : 'want';
  $('#abTitle').value = '';
  renderAddBook();
  addBookDialog.showModal();
});
$('#abCancel').addEventListener('click', () => addBookDialog.close());
$('#abStatus').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-status]');
  if (!btn) return;
  abStatus = btn.dataset.status;
  renderAddBook();
});

$('#abScan').addEventListener('click', async () => {
  const picked = await scanIsbn('この本を追加');
  if (!picked) return;
  if (picked.book) {
    abBook = picked.book;
    $('#abTitle').value = picked.book.title;
  } else {
    const known = Object.values(bookInfo).find((b) => b.isbn === picked.isbn);
    const found = await resolvePick(picked);
    if (found.error) { toast(found.error); return; }
    if (found.notFound) {
      abBook = { isbn: picked.isbn, pending: 'true' };
      $('#abTitle').value = known ? known.title : '';
      if (!known) { $('#abTitle').focus(); toast('まだ登録されていない本です。タイトルを入力してください'); }
    } else {
      abBook = found.book;
      $('#abTitle').value = known ? known.title : found.book.title;
    }
  }
  renderAddBook();
});

$('#addBookForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#abTitle').value.trim();
  if (!title) { toast('タイトルを入力してください'); return; }
  const filled = abBook ? Object.fromEntries(Object.entries(abBook).filter(([, v]) => v)) : {};
  delete filled.title;
  saveBookPatch(title, { ...filled, ...statusPatch(title, abStatus) });
  addBookDialog.close();
  toast(`『${title}』を「${STATUS[abStatus]}」に追加しました`);
});

// ---------- 一覧のタップ → 編集 ----------
document.addEventListener('click', (e) => {
  const memoEl = e.target.closest('.memo[data-id]');
  if (memoEl) openEdit(memoEl.dataset.id);
});

// ---------- ステータスを選ぶ（本棚・記録画面の印をタップ） ----------
const statusDialog = $('#statusDialog');
let pickTitle = '';

document.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (!pick) return;
  e.stopPropagation(); // 本の詳細は開かない
  pickTitle = pick.dataset.pick;
  const b = books().find((x) => x.title === pickTitle);
  const current = b ? b.status : statusOf(pickTitle, 0);
  $('#sdTitle').textContent = pickTitle;
  document.querySelectorAll('#sdOptions button')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.status === current));
  statusDialog.showModal();
}, true);
$('#sdOptions').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-status]');
  if (!btn || !pickTitle) return;
  saveBookPatch(pickTitle, statusPatch(pickTitle, btn.dataset.status));
  statusDialog.close();
  toast(`『${pickTitle}』を「${STATUS[btn.dataset.status]}」にしました`);
});
$('#sdCancel').addEventListener('click', () => statusDialog.close());

$('#shelfList').addEventListener('click', (e) => {
  const el = e.target.closest('[data-title]');
  if (el) openBook(el.dataset.title);
});
$('#backBtn').addEventListener('click', () => showView('shelf'));
$('#bookAddBtn').addEventListener('click', () => {
  $('#fTitle').value = currentBook;
  saveDraft();
  renderAddView();
  showView('add');
  $('#fPage').focus();
});
document.querySelectorAll('#view-book .sort-toggle button').forEach((b) => b.addEventListener('click', () => {
  bookSort = b.dataset.sort;
  renderBook();
}));

$('#searchInput').addEventListener('input', renderSearch);
$('#tagCloud').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag]');
  if (!chip) return;
  searchTag = searchTag === chip.dataset.tag ? '' : chip.dataset.tag;
  renderSearch();
});

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view === 'shelf' && document.querySelector('#view-book.active')) { showView('shelf'); return; }
  showView(b.dataset.view);
}));

// ---------- 編集ダイアログ ----------
let editingId = null;
const editDialog = $('#editDialog');
const editForm = $('#editForm');
const deleteBtn = $('#deleteBtn');

function openEdit(id) {
  const m = memos.find((x) => x.id === id);
  if (!m) return;
  editingId = id;
  editForm.title.value = m.title;
  editForm.date.value = m.date;
  editForm.page.value = m.page;
  editForm.memo.value = m.memo;
  editForm.tags.value = m.tags.join(' ');
  deleteBtn.textContent = '削除';
  deleteBtn.dataset.armed = '';
  editDialog.showModal();
}

editForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const m = memos.find((x) => x.id === editingId);
  if (!m) { editDialog.close(); return; }
  const title = editForm.title.value.trim();
  if (!title) { toast('タイトルを入力してください'); return; }
  enqueue('update', {
    memo: {
      ...m, title, date: editForm.date.value, page: editForm.page.value.trim(),
      memo: editForm.memo.value.trim(), tags: parseTags(editForm.tags.value),
    },
  });
  // タイトルを直したら、本の情報（著者・表紙・読書の状態など）も新しいタイトルに引き継ぐ
  if (title !== m.title && bookInfo[m.title] && !bookInfo[title]) {
    enqueue('saveBook', { book: { ...bookInfo[m.title], title } });
  }
  // 古いタイトルのメモがなくなったら、古い本が本棚に残らないよう状態を外す
  if (title !== m.title && STATUS[(bookInfo[m.title] || {}).status] && !memos.some((x) => x.title === m.title)) {
    saveBookPatch(m.title, { status: '' });
  }
  if (currentBook === m.title && title !== m.title) currentBook = title;
  editDialog.close();
  toast('更新しました');
});

deleteBtn.addEventListener('click', () => {
  // 誤タップ防止のため 2 回タップで削除
  if (!deleteBtn.dataset.armed) {
    deleteBtn.dataset.armed = '1';
    deleteBtn.textContent = 'もう一度タップで削除';
    return;
  }
  enqueue('delete', { id: editingId });
  editDialog.close();
  toast('削除しました');
});
$('#cancelEdit').addEventListener('click', () => editDialog.close());

// ---------- 設定ダイアログ ----------
const settingsDialog = $('#settingsDialog');
const settingsForm = $('#settingsForm');

let installPrompt = null;

// 設定コード：URL と合言葉を 1 つの文字列にまとめたもの（DM1-<base64url>）。設定リンクにも埋め込む
function encodeSetup(s) {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify({ a: s.api, t: s.token }))));
  return 'DM1-' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeSetup(text) {
  const m = String(text || '').match(/DM1-([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const o = JSON.parse(decodeURIComponent(escape(atob(b64))));
    return o.a && o.t ? { api: o.a, token: o.t } : null;
  } catch {
    return null;
  }
}

function setupLink() {
  // # 以降はサーバーに送られない
  return location.origin + location.pathname + '#setup=' + encodeSetup(settings);
}

// 設定コード欄 → 直接入力欄 の順に読む
function formSettings() {
  const fromCode = decodeSetup($('#setupCode').value);
  if (fromCode) return fromCode;
  const api = settingsForm.api.value.trim();
  const token = settingsForm.token.value.trim();
  return api && token ? { api, token } : null;
}

const scriptCache = {};
function loadScript(src) {
  if (!scriptCache[src]) {
    scriptCache[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete scriptCache[src]; reject(new Error('読み込めませんでした: ' + src)); };
      document.head.append(s);
    });
  }
  return scriptCache[src];
}

let settingsNotice = ''; // 設定画面の上に出すお知らせ（インストール案内を描き直しても消えないよう保持）

function renderInstallBox() {
  const parts = settingsNotice ? [settingsNotice] : [];
  if (!isStandalone) {
    if (isIOS) {
      // 下の共有欄は画面外になりやすいので、コピーボタンは案内の中に置く
      parts.push('<b>アプリとして使うには</b><ol>'
        + (configured()
          ? '<li><button type="button" id="copyCodeTop">設定コードをコピー</button></li>'
          : '<li>先に下の欄で設定を済ませる</li>')
        + '<li>Safari の共有ボタン →「ホーム画面に追加」</li>'
        + '<li>ホーム画面のアプリを開き、設定画面で「📋 貼り付け」→「保存」</li></ol>'
        + '<small>ホーム画面のアプリは Safari と設定が別になるため、もう一度貼り付けが必要です。</small>');
    } else if (installPrompt) {
      parts.push('<button type="button" id="installBtn">このパソコンにアプリとしてインストール</button>');
    } else {
      parts.push('パソコンの Chrome / Edge では、アドレスバー右端の「アプリをインストール」アイコンからアプリとして追加できます。');
    }
  }
  const box = $('#installBox');
  box.hidden = !parts.length;
  box.innerHTML = parts.join('<hr>');
}

async function renderShareBox() {
  const box = $('#shareBox');
  box.hidden = !configured();
  if (!configured()) return;
  try {
    await loadScript('vendor/qrcode-generator-1.4.4.js');
    const qr = window.qrcode(0, 'M');
    qr.addData(setupLink());
    qr.make();
    $('#qrBox').innerHTML = qr.createSvgTag(4, 2);
  } catch {
    $('#qrBox').textContent = '';
  }
}

function openSettings(notice = '') {
  settingsForm.api.value = settings.api;
  settingsForm.token.value = settings.token;
  $('#setupCode').value = '';
  $('#testResult').textContent = '';
  settingsNotice = notice;
  renderInstallBox();
  renderShareBox();
  if (!settingsDialog.open) settingsDialog.showModal();
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // クリップボード API が使えないときの代替
    const ta = document.createElement('textarea');
    ta.value = text;
    settingsForm.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`${label}をコピーしました`);
}

$('#settingsBtn').addEventListener('click', () => openSettings());
$('#cancelSettings').addEventListener('click', () => settingsDialog.close());
$('#copyCode').addEventListener('click', () => copyText(encodeSetup(settings), '設定コード'));
$('#copyLink').addEventListener('click', () => copyText(setupLink(), '設定リンク'));

$('#pasteCode').addEventListener('click', async () => {
  try {
    $('#setupCode').value = (await navigator.clipboard.readText()).trim();
    $('#testResult').textContent = decodeSetup($('#setupCode').value)
      ? '設定コードを読み取りました。「保存」を押してください'
      : 'クリップボードに設定コードがありません';
  } catch {
    toast('欄を長押しして「ペースト」してください');
  }
});

$('#installBox').addEventListener('click', async (e) => {
  if (e.target.id === 'copyCodeTop') {
    await copyText(encodeSetup(settings), '設定コード');
    e.target.textContent = '✓ コピーしました';
    return;
  }
  if (e.target.id !== 'installBtn' || !installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  renderInstallBox();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (settingsDialog.open) renderInstallBox();
});

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const next = formSettings();
  if (!next) { $('#testResult').textContent = '設定コードか、URL と合言葉を入力してください'; return; }
  settings = next;
  LS.set('dm.settings', settings);
  settingsDialog.close();
  toast('設定を保存しました');
  refresh(true);
});

$('#testBtn').addEventListener('click', async () => {
  const out = $('#testResult');
  const saved = settings;
  settings = formSettings() || settings;
  out.textContent = '接続中…';
  try {
    const res = await api('list');
    out.textContent = res.ok ? `接続できました（メモ ${res.memos.length} 件）` : `エラー: ${res.error}`;
  } catch (err) {
    out.textContent = `接続できません: ${err.message}`;
  } finally {
    settings = saved;
  }
});

// ---------- 起動 ----------
(function init() {
  const draft = LS.get('dm.draft', null);
  $('#fTitle').value = (draft && draft.title) || LS.get('dm.lastTitle', '');
  // 書きかけのメモがあるときだけ下書きの日付を使う（前日の日付が残らないように）
  $('#fDate').value = (draft && draft.memo && draft.date) || today();
  if (draft) {
    $('#fPage').value = draft.page || '';
    $('#fMemo').value = draft.memo || '';
    $('#fTags').value = draft.tags || '';
  }
  memos = memos.map(normalize);
  renderAll();

  // 設定リンク（…#setup=DM1-…）から開かれたら、その設定を取り込んでリンクの痕跡を消す
  const fromLink = location.hash.startsWith('#setup=') ? decodeSetup(location.hash) : null;
  if (location.hash.startsWith('#setup=')) history.replaceState(null, '', location.pathname + location.search);
  if (fromLink) {
    settings = fromLink;
    LS.set('dm.settings', settings);
    openSettings('<b>この端末の設定が完了しました。</b>');
    refresh(true);
  } else if (!configured()) {
    openSettings();
  } else {
    refresh(true);
  }

  window.addEventListener('online', () => refresh(true));
  window.addEventListener('offline', updateBadge);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
