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
let bookInfo = LS.get('dm.books', {}); // タイトル → {isbn, author, publisher, pages, cover, pending}
let shelfMode = LS.get('dm.shelfMode', 'list'); // 本棚の表示：list / grid
let pendingIsbn = '';                   // 検索で見つからなかった ISBN（次に保存する本に付ける）
let flushing = false;
let lastRefresh = 0;
let currentBook = '';
let bookSort = 'page';
let searchTag = '';

const $ = (sel) => document.querySelector(sel);
const configured = () => Boolean(settings.api && settings.token);

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
    bookInfo[op.payload.book.title] = op.payload.book;
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
function books() {
  const map = new Map();
  for (const m of memos) {
    if (!m.title) continue;
    const b = map.get(m.title) || { title: m.title, count: 0, last: '', lastDate: '', maxPage: 0 };
    b.count += 1;
    if (activity(m) > b.last) b.last = activity(m);
    if (m.date > b.lastDate) b.lastDate = m.date;
    if (pageNum(m) !== Infinity && pageNum(m) > b.maxPage) b.maxPage = pageNum(m);
    map.set(m.title, b);
  }
  return [...map.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
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
      ${m.page ? `<span>p.${esc(m.page)}</span>` : ''}
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

  const chosen = parseTags($('#fTags').value);
  $('#recentTags').innerHTML = tagCounts().slice(0, 12)
    .map(([t]) => `<button type="button" class="chip ${chosen.includes(t) ? 'on' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`)
    .join('');

  const recent = [...memos].sort((a, b) => (activity(a) < activity(b) ? 1 : -1)).slice(0, 10);
  $('#recentList').innerHTML = recent.length
    ? recent.map((m) => memoHTML(m)).join('')
    : '<p class="empty">まだメモはありません</p>';
}

function renderShelf() {
  const bs = books();
  const list = $('#shelfList');
  document.querySelectorAll('.shelf-toggle button')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.shelf === shelfMode));
  list.classList.toggle('grid', shelfMode === 'grid' && bs.length > 0);

  if (shelfMode === 'grid') {
    list.innerHTML = bs.length
      ? bs.map((b) => `<div class="gbook" data-title="${esc(b.title)}">
          ${coverImg(b.title, 'gbook-cover')
            || `<div class="gbook-cover gbook-blank" style="background:${spineColor(b.title)}">${esc(b.title)}</div>`}
          <div class="gbook-title">${esc(b.title)}</div>
          ${progressHTML(progress(b))}
        </div>`).join('')
      : '<p class="empty">まだ本がありません</p>';
    return;
  }

  list.innerHTML = bs.length
    ? bs.map((b) => `<div class="book" data-title="${esc(b.title)}">
        ${coverImg(b.title, 'book-cover') || `<span class="book-spine" style="background:${spineColor(b.title)}"></span>`}
        <div class="book-info">
          <div class="book-title">${esc(b.title)}</div>
          <div class="book-sub">${esc([(bookInfo[b.title] || {}).author, `最終 ${b.lastDate}`].filter(Boolean).join(' ・ '))}${progress(b) === null ? '' : ` ・ ${progress(b)}%`}</div>
          ${progressHTML(progress(b))}
        </div>
        <span class="book-count">${b.count}件</span>
      </div>`).join('')
    : '<p class="empty">まだ本がありません</p>';
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
  $('#bookMeta').innerHTML = esc(bookMetaText(currentBook))
    + (pct === null ? '' : `<div>読んだ位置 p.${b.maxPage}（${pct}%）</div>${progressHTML(pct)}`);
  $('#bookScanBtn').textContent = info.isbn ? '📷 本の情報を更新' : '📷 本の情報を取得';

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
  if (!memo && !page) { toast('メモかページを入力してください'); return; }

  enqueue('add', {
    memo: {
      id: uid(), createdAt: new Date().toISOString(),
      title, date: $('#fDate').value || today(), page, memo, tags: parseTags($('#fTags').value),
    },
  });
  // 見つからなかった ISBN は、この本に付けて保存しておく（サーバーが毎日再検索する）
  if (pendingIsbn && !(bookInfo[title] && bookInfo[title].isbn)) {
    enqueue('saveBook', { book: { ...(bookInfo[title] || {}), title, isbn: pendingIsbn, pending: 'true' } });
  }
  pendingIsbn = '';
  LS.set('dm.lastTitle', title);
  resetForm();
  renderAddView();
  toast(configured() && navigator.onLine ? '保存しました' : '保存しました（通信できたら送信します）');
});

['#fTitle', '#fDate', '#fPage', '#fMemo', '#fTags'].forEach((sel) => $(sel).addEventListener('input', saveDraft));
$('#fTitle').addEventListener('input', renderAddView);
$('#fTags').addEventListener('input', renderAddView);

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

// ---------- 音声入力（Safari の音声認識。使えない環境ではボタンを出さない） ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;

function stopMic() {
  if (rec) rec.stop();
}

if (SR) {
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
      btn.textContent = '🎤 音声入力';
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

function makeReader() {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  return new ZXing.BrowserMultiFormatReader(hints, 300);
}

const scanDialog = $('#scanDialog');
let scanReader = null;
let scanResolve = null;

function stopCamera() {
  if (scanReader) { scanReader.reset(); scanReader = null; }
}

function finishScan(isbn) {
  const resolve = scanResolve;
  scanResolve = null;
  stopCamera();
  if (scanDialog.open) scanDialog.close();
  if (resolve) resolve(isbn);
}

function acceptCode(code) {
  if (isValidIsbn13(code)) { finishScan(code); return true; }
  $('#scanStatus').textContent = /^19[12]/.test(code)
    ? 'それは下段のバーコードです。上段（978 で始まる方）を読み取ってください'
    : 'ISBN として読み取れませんでした';
  return false;
}

// ISBN を読み取って返す（キャンセル時は null）
function scanIsbn() {
  return new Promise((resolve) => {
    scanResolve = resolve;
    $('#isbnInput').value = '';
    $('#scanStatus').textContent = 'カメラを起動しています…';
    scanDialog.showModal();
    loadZXing()
      .then(() => {
        if (!scanResolve) return null;
        const reader = makeReader();
        scanReader = reader;
        return reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } },
          $('#scanVideo'),
          (result) => { if (result) acceptCode(result.getText()); },
        ).then(() => {
          if (scanReader !== reader) reader.reset(); // 起動中にキャンセルされた
          else $('#scanStatus').textContent = 'バーコードを枠に合わせてください';
        });
      })
      .catch(() => {
        $('#scanStatus').textContent = 'カメラを使えません。写真から読み取るか、ISBN を手入力してください';
      });
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
  $('#scanStatus').textContent = '写真を解析しています…';
  const url = URL.createObjectURL(file);
  try {
    await loadZXing();
    const result = await makeReader().decodeFromImageUrl(url);
    acceptCode(result.getText());
  } catch {
    $('#scanStatus').textContent = '読み取れませんでした。バーコードを大きく、まっすぐ撮ってください';
  } finally {
    URL.revokeObjectURL(url);
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

// 戻り値：{ book } 見つかった ／ { notFound: true } 未登録 ／ null 通信エラーなど
async function lookupBook(isbn) {
  if (!configured() || !navigator.onLine) { toast('本の検索には通信が必要です'); return null; }
  toast('本の情報を検索しています…');
  try {
    const res = await api('lookup', { isbn });
    if (!res.ok) {
      if (res.notFound) return { notFound: true };
      toast(res.error);
      return null;
    }
    const book = { ...res.book, pending: '' };
    book.cover = await checkCover(book.cover);
    return { book };
  } catch {
    toast('検索できませんでした');
    return null;
  }
}

// 記録画面の 📷：読み取った本をタイトルに入れる
$('#scanBtn').addEventListener('click', async () => {
  const isbn = await scanIsbn();
  if (!isbn) return;
  // 同じ本を登録済みなら、そのタイトル（自分で直した名前かもしれない）を使う
  const known = Object.values(bookInfo).find((b) => b.isbn === isbn);
  // 検索中に保存されると前の本にメモが付いてしまうので、保存ボタンを止めておく
  const saveBtn = $('#addForm button[type="submit"]');
  saveBtn.disabled = true;
  saveBtn.textContent = '本を検索中…';
  let found;
  try {
    found = await lookupBook(isbn);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '保存';
  }
  if (!found) return;

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
  const isbn = await scanIsbn();
  if (!isbn) return;
  const found = await lookupBook(isbn);
  if (!found) return;
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

// ---------- 一覧のタップ → 編集 ----------
document.addEventListener('click', (e) => {
  const memoEl = e.target.closest('.memo[data-id]');
  if (memoEl) openEdit(memoEl.dataset.id);
});

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
  // タイトルを直したら、本の情報（著者・表紙など）も新しいタイトルに引き継ぐ
  if (title !== m.title && bookInfo[m.title] && !bookInfo[title]) {
    enqueue('saveBook', { book: { ...bookInfo[m.title], title } });
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

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS は Mac として名乗る
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
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
      parts.push('<b>アプリとして使うには</b><ol>'
        + '<li>Safari の共有ボタン →「ホーム画面に追加」</li>'
        + '<li>下の「設定コードをコピー」を押しておく</li>'
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
