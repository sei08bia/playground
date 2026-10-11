'use strict';

/* ===== 保存（端末内の localStorage） ===== */

const STORAGE_KEY = 'setlist-note:lives:v1';
const APP_NAME = 'セトリノート';

function loadLives() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

let lives = loadLives();

function saveLives() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lives));
  } catch {
    toast('保存できませんでした（端末の容量不足の可能性があります）');
  }
}

let saveTimer = null;
function saveSoon(live) {
  live.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLives, 300);
}
// 入力途中で閉じても消えないように
window.addEventListener('pagehide', () => { clearTimeout(saveTimer); saveLives(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { clearTimeout(saveTimer); saveLives(); }
});

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const getLive = (id) => lives.find((l) => l.id === id);

function sortedLives() {
  return [...lives].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
}

/* ===== 表示まわりの小物 ===== */

const $app = document.getElementById('app');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}(${w})`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 2 + 'px';
}

// 曲番号: 本編は 01, 02…、アンコール区切りのあとは EN1, EN2…
function numberItems(items) {
  let song = 0;
  let en = 0;
  let inEncore = false;
  return items.map((it) => {
    if (it.type === 'encore') { inEncore = true; return ''; }
    if (it.type === 'mc') return 'MC';
    if (inEncore) return 'EN' + ++en;
    return String(++song).padStart(2, '0');
  });
}

const countSongs = (live) => live.items.filter((i) => i.type === 'song').length;

/* ===== ルーティング ===== */

let current = null; // 表示中のライブ（シェア用）

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, id, sub] = hash.split('/');
  current = null;
  window.scrollTo(0, 0);
  if (page === 'new') return renderInfoForm(null);
  if (page === 'live' && getLive(id)) {
    if (sub === 'info') return renderInfoForm(getLive(id));
    return renderEditor(getLive(id));
  }
  if (page === 'view' && id) return renderShared(id);
  renderList();
}
window.addEventListener('hashchange', route);

/* ===== ライブ一覧 ===== */

function renderList() {
  const list = sortedLives();
  $app.innerHTML = `
    <div class="toolbar">
      <a href="#/new" class="button grow-btn">＋ ライブを記録する</a>
    </div>
    ${list.length === 0 ? `
      <div class="empty">
        <p>まだ記録がありません。</p>
        <p class="hint">ライブに行ったら「ライブを記録する」から<br>セトリと感想をメモしましょう。</p>
      </div>` : `
      <ul class="live-list">
        ${list.map((l) => `
          <li class="card">
            <a href="#/live/${l.id}">
              <div class="date">${esc(formatDate(l.date))}${l.venue ? ' ・ ' + esc(l.venue) : ''}</div>
              <div class="title">${esc(l.artist || '（アーティスト未入力）')}</div>
              ${l.title ? `<div>${esc(l.title)}</div>` : ''}
              <div class="meta">${countSongs(l)}曲</div>
            </a>
          </li>`).join('')}
      </ul>`}
    <details class="backup">
      <summary>バックアップ</summary>
      <p class="hint">記録はこの端末のブラウザ内だけに保存されています。機種変更やブラウザのデータ削除に備えて、ときどき書き出しておくと安心です。</p>
      <div class="toolbar">
        <button class="secondary" data-action="export">ファイルに書き出す</button>
        <label class="button secondary file-btn">ファイルから読み込む<input type="file" accept="application/json,.json" data-action="import" hidden></label>
      </div>
    </details>`;
}

function exportBackup() {
  const blob = new Blob([JSON.stringify({ app: 'setlist-note', version: 1, lives }, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `setlist-note-${today()}.json`);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.lives;
    if (!Array.isArray(incoming)) throw new Error();
    let added = 0;
    for (const l of incoming) {
      if (!l || !l.id || !Array.isArray(l.items)) continue;
      const i = lives.findIndex((x) => x.id === l.id);
      if (i === -1) { lives.push(l); added++; }
      else if ((l.updatedAt || 0) > (lives[i].updatedAt || 0)) lives[i] = l;
    }
    saveLives();
    toast(`${added}件のライブを読み込みました`);
    renderList();
  } catch {
    toast('読み込めないファイルでした');
  }
}

/* ===== ライブ情報の入力 ===== */

function renderInfoForm(live) {
  const l = live || { artist: '', title: '', date: today(), venue: '' };
  $app.innerHTML = `
    <h1>${live ? 'ライブ情報を編集' : 'ライブを記録する'}</h1>
    <form class="card" id="info-form">
      <label for="f-artist">アーティスト</label>
      <input id="f-artist" name="artist" value="${esc(l.artist)}" required autocomplete="off">
      <label for="f-title">ライブ・ツアー名</label>
      <input id="f-title" name="title" value="${esc(l.title)}" autocomplete="off">
      <label for="f-date">日付</label>
      <input id="f-date" name="date" type="date" value="${esc(l.date)}">
      <label for="f-venue">会場</label>
      <input id="f-venue" name="venue" value="${esc(l.venue)}" autocomplete="off">
      <div class="toolbar">
        <button type="submit">${live ? '保存' : 'セトリを書きはじめる'}</button>
        <a class="button secondary" href="${live ? '#/live/' + live.id : '#/'}">キャンセル</a>
      </div>
    </form>
    ${live ? `<button class="danger" data-action="delete-live" data-id="${live.id}">このライブを削除</button>` : ''}`;

  const form = document.getElementById('info-form');
  if (!live) form.artist.focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    let target = live;
    if (!target) {
      target = { id: newId(), items: [], memo: '', createdAt: Date.now() };
      lives.push(target);
    }
    // アーティスト名を変えたら曲一覧の紐づけもやり直す
    if (target.artist !== values.artist.trim()) delete target.catalogArtist;
    Object.assign(target, {
      artist: values.artist.trim(),
      title: values.title.trim(),
      date: values.date,
      venue: values.venue.trim(),
      updatedAt: Date.now(),
    });
    saveLives();
    location.hash = '#/live/' + target.id;
  });
}

/* ===== セトリ編集 ===== */

let addType = 'song';

function headerHtml(l) {
  return `
    <div class="meta">${esc(formatDate(l.date))}${l.venue ? ' ・ ' + esc(l.venue) : ''}</div>
    <div class="artist">${esc(l.artist)}</div>
    ${l.title ? `<h1>${esc(l.title)}</h1>` : ''}`;
}

function renderEditor(live) {
  current = live;
  $app.innerHTML = `
    <section class="view-header card">
      ${headerHtml(live)}
      <div class="toolbar">
        <button data-action="share">シェア</button>
        <a class="button secondary" href="#/live/${live.id}/info">ライブ情報を編集</a>
      </div>
    </section>
    <h2>セットリスト <span class="hint" id="song-count"></span></h2>
    <ol class="setlist" id="setlist"></ol>
    <div class="card">
      <label for="overall">ライブ全体の感想</label>
      <textarea id="overall" data-field="memo" placeholder="全体を通して感じたこと、演出、客席の雰囲気など">${esc(live.memo)}</textarea>
    </div>
    <div class="add-bar">
      <div class="inner">
        <ul class="suggest" id="suggest" hidden></ul>
        <div class="types" role="group" aria-label="追加する種類">
          <button type="button" data-type="song">♪ 曲</button>
          <button type="button" data-type="mc">💬 MC</button>
          <button type="button" data-type="encore">★ アンコール</button>
        </div>
        <form class="row" id="add-form">
          <button type="button" class="secondary list-btn" data-action="open-picker">曲一覧</button>
          <input class="grow" id="add-input" autocomplete="off" enterkeyhint="done">
          <button type="submit">追加</button>
        </form>
      </div>
    </div>`;

  renderSetlist(live);
  setAddType(addType);
  autoGrow(document.getElementById('overall'));
  ensureCatalog(live);

  document.getElementById('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('add-input');
    const title = input.value.trim();
    if (addType === 'song' && !title) { input.focus(); return; }
    addItem(live, addType, addType === 'encore' ? '' : title);
    input.value = '';
    renderSuggest();
    if (addType !== 'song') setAddType('song');
    input.focus();
  });
}

function addItem(live, type, title) {
  live.items.push({ id: newId(), type, title, memo: '' });
  saveSoon(live);
  renderSetlist(live);
  document.getElementById('setlist').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function setAddType(type) {
  addType = type;
  document.querySelectorAll('.add-bar [data-type]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === type)));
  const input = document.getElementById('add-input');
  input.placeholder = { song: '曲名を入力 or 一覧から選ぶ', mc: 'MCの話題（あとで書いてもOK）', encore: '' }[type];
  input.hidden = type === 'encore';
  document.querySelector('[data-action="open-picker"]').hidden = type !== 'song';
  input.closest('form').querySelector('[type=submit]').textContent = type === 'encore' ? 'アンコールの区切りを追加' : '追加';
  renderSuggest();
}

/* ===== アーティストの曲一覧（Apple Music の公開検索APIから取得） ===== */

const CATALOG_PREFIX = 'setlist-note:catalog:';
const CATALOG_TTL = 7 * 24 * 60 * 60 * 1000;

// 曲一覧の状態（表示中のライブのもの）
const catalog = { liveId: null, status: 'idle', artist: null, songs: [] };

async function itunes(path, params) {
  const q = new URLSearchParams({ country: 'JP', lang: 'ja_jp', ...params });
  const res = await fetch(`https://itunes.apple.com/${path}?${q}`);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).results || [];
}

// 表記ゆれを吸収した比較用の文字列（全角半角・大小文字・カタカナ/ひらがな・記号）
function normTitle(s) {
  return String(s).normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・'’"“”!?.,、。~〜\-_/:;()（）[\]「」『』]/g, '');
}

// "(Remastered 2020)" や "(Live)" などの付記は外して1曲にまとめる
function cleanTitle(t) {
  return t.replace(/\s*[(\[（［][^)\]）］]*\b(?:remaster(?:ed)?|live)\b[^)\]）］]*[)\]）］]/gi, '').trim();
}

const isExtraTrack = (t) => /instrumental|karaoke|off vocal|backing track|\(inst\.?\)|カラオケ/i.test(t);

async function findArtists(name) {
  const results = await itunes('search', { term: name, entity: 'musicArtist', limit: 10 });
  return results.map((a) => ({ id: a.artistId, name: a.artistName, genre: a.primaryGenreName || '' }));
}

async function fetchSongs(artist) {
  const cacheKey = CATALOG_PREFIX + artist.id;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey));
    if (cached && Date.now() - cached.at < CATALOG_TTL) return cached.songs;
  } catch { /* キャッシュなし */ }

  // 検索（人気順に近い）と、アーティストIDでの一覧を合わせて取りこぼしを減らす
  const [searched, looked] = await Promise.all([
    itunes('search', { term: artist.name, entity: 'song', attribute: 'artistTerm', limit: 200 }).catch(() => []),
    itunes('lookup', { id: artist.id, entity: 'song', limit: 200 }).catch(() => []),
  ]);
  const seen = new Set();
  const songs = [];
  for (const r of [...searched.filter((x) => x.artistId === artist.id), ...looked]) {
    if (r.wrapperType !== 'track' || !r.trackName || isExtraTrack(r.trackName)) continue;
    const title = cleanTitle(r.trackName);
    const key = normTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    songs.push({ title, year: (r.releaseDate || '').slice(0, 4) });
  }
  try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), songs })); } catch { /* 容量不足なら毎回取得 */ }
  return songs;
}

async function ensureCatalog(live, force = false) {
  if (!force && catalog.liveId === live.id && catalog.status !== 'error') return;
  Object.assign(catalog, { liveId: live.id, status: 'loading', artist: null, songs: [] });
  renderPicker();
  try {
    let artist = live.catalogArtist;
    if (artist === undefined) {
      // 名前が完全一致する候補を優先、なければ一番上の候補
      const found = live.artist ? await findArtists(live.artist) : [];
      artist = found.find((a) => normTitle(a.name) === normTitle(live.artist)) || found[0] || null;
      live.catalogArtist = artist && { id: artist.id, name: artist.name };
      saveSoon(live);
    }
    if (catalog.liveId !== live.id) return;
    if (!artist) { catalog.status = 'none'; renderPicker(); return; }
    const songs = await fetchSongs(artist);
    if (catalog.liveId !== live.id) return;
    Object.assign(catalog, { status: songs.length ? 'ready' : 'none', artist, songs });
  } catch {
    if (catalog.liveId === live.id) catalog.status = 'error';
  }
  renderPicker();
  renderSuggest();
}

function matchSongs(query, limit = Infinity) {
  const q = normTitle(query);
  if (!q) return catalog.songs.slice(0, limit);
  const starts = [];
  const contains = [];
  for (const s of catalog.songs) {
    const n = normTitle(s.title);
    if (n.startsWith(q)) starts.push(s);
    else if (n.includes(q)) contains.push(s);
  }
  return [...starts, ...contains].slice(0, limit);
}

// 入力中の曲名に合う候補を入力欄の上に出す
function renderSuggest() {
  const ul = document.getElementById('suggest');
  if (!ul) return;
  const query = document.getElementById('add-input').value;
  const hits = addType === 'song' && query.trim() && catalog.status === 'ready' ? matchSongs(query, 5) : [];
  ul.hidden = hits.length === 0;
  ul.innerHTML = hits.map((s) => `<li><button type="button" data-pick="${esc(s.title)}">${esc(s.title)}</button></li>`).join('');
}

/* ===== 曲一覧ダイアログ ===== */

const picker = document.getElementById('picker-dialog');
const $pickerSearch = document.getElementById('picker-search');
let pickerMode = 'songs'; // 'songs' | 'artists'
let artistCandidates = [];

function openPicker() {
  if (!current) return;
  pickerMode = 'songs';
  $pickerSearch.value = '';
  picker.showModal();
  ensureCatalog(current);
  renderPicker();
}

function renderPicker() {
  if (!picker.open) return;
  const live = current;
  const head = document.getElementById('picker-artist');
  const status = document.getElementById('picker-status');
  const list = document.getElementById('picker-list');
  if (!live) return;

  if (pickerMode === 'artists') {
    head.textContent = 'アーティストを選ぶ';
    $pickerSearch.placeholder = 'アーティスト名で検索';
    status.textContent = artistCandidates.length ? '' : '見つかりませんでした。名前を変えて検索してみてください。';
    list.innerHTML = artistCandidates.map((a) => `
      <li><button type="button" class="pick-row" data-artist-id="${a.id}">
        <span class="grow">${esc(a.name)}</span><span class="hint">${esc(a.genre)}</span>
      </button></li>`).join('');
    return;
  }

  $pickerSearch.placeholder = '曲名で絞り込み';
  head.textContent = catalog.artist ? `${catalog.artist.name} の曲` : live.artist || '曲一覧';
  status.textContent = {
    loading: '曲一覧を読み込み中…',
    error: '曲一覧を読み込めませんでした。電波の良い場所でもう一度開いてください。',
    none: `「${live.artist}」の曲が見つかりませんでした。「アーティストを変更」から選び直せます。`,
    ready: '',
    idle: '',
  }[catalog.status];
  const used = new Set(live.items.filter((i) => i.type === 'song').map((i) => normTitle(i.title)));
  const hits = catalog.status === 'ready' ? matchSongs($pickerSearch.value) : [];
  const typed = $pickerSearch.value.trim();
  list.innerHTML = hits.map((s) => `
    <li><button type="button" class="pick-row ${used.has(normTitle(s.title)) ? 'used' : ''}" data-pick="${esc(s.title)}">
      <span class="grow">${esc(s.title)}</span>
      <span class="hint">${used.has(normTitle(s.title)) ? '追加済み' : esc(s.year)}</span>
    </button></li>`).join('')
    + (typed && !hits.some((s) => normTitle(s.title) === normTitle(typed))
      ? `<li><button type="button" class="pick-row free" data-pick="${esc(typed)}">「${esc(typed)}」をそのまま追加</button></li>`
      : '');
}

async function searchArtistCandidates(name) {
  pickerMode = 'artists';
  artistCandidates = [];
  document.getElementById('picker-list').innerHTML = '';
  document.getElementById('picker-status').textContent = '検索中…';
  try {
    artistCandidates = name.trim() ? await findArtists(name) : [];
  } catch {
    document.getElementById('picker-status').textContent = '検索できませんでした。電波の良い場所でもう一度試してください。';
    return;
  }
  renderPicker();
}

let pickerSearchTimer = null;
$pickerSearch.addEventListener('input', () => {
  if (pickerMode === 'songs') return renderPicker();
  clearTimeout(pickerSearchTimer);
  pickerSearchTimer = setTimeout(() => searchArtistCandidates($pickerSearch.value), 400);
});

picker.addEventListener('click', (e) => {
  if (e.target === picker) return picker.close();
  const pick = e.target.closest('[data-pick]');
  if (pick && current) {
    addItem(current, 'song', pick.dataset.pick);
    toast(`「${pick.dataset.pick}」を追加しました`);
    renderPicker();
    return;
  }
  const artistBtn = e.target.closest('[data-artist-id]');
  if (artistBtn && current) {
    const a = artistCandidates.find((x) => String(x.id) === artistBtn.dataset.artistId);
    current.catalogArtist = { id: a.id, name: a.name };
    saveSoon(current);
    pickerMode = 'songs';
    $pickerSearch.value = '';
    ensureCatalog(current, true);
    return;
  }
  if (e.target.closest('[data-action="change-artist"]')) {
    $pickerSearch.value = current.artist;
    searchArtistCandidates(current.artist);
  }
});

function renderSetlist(live) {
  const nums = numberItems(live.items);
  const last = live.items.length - 1;
  document.getElementById('song-count').textContent = `${countSongs(live)}曲`;
  const ol = document.getElementById('setlist');
  ol.innerHTML = live.items.length === 0
    ? `<li class="empty">下の入力欄から1曲目を追加しましょう。<br><span class="hint">曲名を打つと候補が出ます。「曲一覧」からも選べます。</span></li>`
    : live.items.map((it, i) => {
      const controls = `
        <div class="controls">
          <button class="icon" data-action="up" ${i === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
          <button class="icon" data-action="down" ${i === last ? 'disabled' : ''} aria-label="下へ">↓</button>
          <button class="icon" data-action="remove" aria-label="削除">✕</button>
        </div>`;
      if (it.type === 'encore') {
        return `<li class="item encore" data-id="${it.id}"><div class="row"><span class="grow">ENCORE</span>${controls}</div></li>`;
      }
      const isMc = it.type === 'mc';
      return `
        <li class="item ${it.type}" data-id="${it.id}">
          <div class="row">
            <span class="num">${nums[i]}</span>
            <input class="grow title-input" data-item-field="title" value="${esc(it.title)}" placeholder="${isMc ? '話題（任意）' : '曲名'}" aria-label="${isMc ? 'MCの話題' : '曲名'}">
            ${controls}
          </div>
          <textarea data-item-field="memo" rows="1" placeholder="${isMc ? '何を話していたか' : 'この曲で感じたこと'}">${esc(it.memo)}</textarea>
        </li>`;
    }).join('');
  ol.querySelectorAll('textarea').forEach(autoGrow);
}

function moveItem(live, id, delta) {
  const i = live.items.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= live.items.length) return;
  [live.items[i], live.items[j]] = [live.items[j], live.items[i]];
  saveSoon(live);
  renderSetlist(live);
}

function removeItem(live, id) {
  const it = live.items.find((x) => x.id === id);
  if (!it) return;
  const name = it.type === 'encore' ? 'アンコールの区切り' : it.title || (it.type === 'mc' ? 'このMC' : 'この曲');
  if ((it.title || it.memo) && !confirm(`「${name}」を削除しますか？`)) return;
  live.items = live.items.filter((x) => x.id !== id);
  saveSoon(live);
  renderSetlist(live);
}

/* ===== 共有された閲覧ページ ===== */

function renderShared(encoded) {
  $app.innerHTML = '<p class="hint">読み込み中…</p>';
  decodeLive(encoded).then((live) => {
    current = live;
    const nums = numberItems(live.items);
    $app.innerHTML = `
      <div class="banner">共有されたセトリです。<a href="#/">自分でも記録する</a></div>
      <section class="view-header card">${headerHtml(live)}</section>
      <ol class="setlist">
        ${live.items.map((it, i) => it.type === 'encore'
          ? '<li class="item encore">ENCORE</li>'
          : `<li class="item ${it.type}">
              <div class="row"><span class="num">${nums[i]}</span><span class="grow song-title">${esc(it.title)}</span></div>
              <div class="memo">${esc(it.memo)}</div>
            </li>`).join('')}
      </ol>
      ${live.memo ? `<div class="card"><h2>ライブ全体の感想</h2><div class="overall-memo">${esc(live.memo)}</div></div>` : ''}
      <div class="toolbar">
        <button data-action="share">シェア</button>
        <button class="secondary" data-action="save-shared">自分のノートに保存</button>
      </div>`;
  }).catch(() => {
    $app.innerHTML = `<div class="empty"><p>リンクが壊れているようです。</p><a href="#/">トップへ</a></div>`;
  });
}

function saveShared() {
  const copy = { ...structuredClone(current), id: newId(), createdAt: Date.now(), updatedAt: Date.now() };
  copy.items.forEach((it) => { it.id = newId(); });
  lives.push(copy);
  saveLives();
  location.hash = '#/live/' + copy.id;
  toast('自分のノートに保存しました');
}

/* ===== 共有リンク（データをURLに詰める。サーバー不要） ===== */

const TYPE_CODES = { song: 's', mc: 'm', encore: 'e' };
const CODE_TYPES = { s: 'song', m: 'mc', e: 'encore' };

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipeBytes(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

async function encodeLive(live, includeMemo) {
  const compact = {
    a: live.artist, t: live.title, d: live.date, v: live.venue,
    m: includeMemo ? live.memo : '',
    i: live.items.map((it) => {
      const row = [TYPE_CODES[it.type], it.title || ''];
      if (includeMemo && it.memo) row.push(it.memo);
      return row;
    }),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(compact));
  if ('CompressionStream' in window) {
    try { return 'z' + toBase64Url(await pipeBytes(bytes, new CompressionStream('deflate-raw'))); } catch { /* 下へ */ }
  }
  return 'u' + toBase64Url(bytes);
}

async function decodeLive(encoded) {
  let bytes = fromBase64Url(encoded.slice(1));
  if (encoded[0] === 'z') bytes = await pipeBytes(bytes, new DecompressionStream('deflate-raw'));
  else if (encoded[0] !== 'u') throw new Error('unknown format');
  const c = JSON.parse(new TextDecoder().decode(bytes));
  return {
    artist: c.a || '', title: c.t || '', date: c.d || '', venue: c.v || '', memo: c.m || '',
    items: (c.i || []).map(([t, title, memo]) => ({ id: newId(), type: CODE_TYPES[t] || 'song', title: title || '', memo: memo || '' })),
  };
}

async function shareUrl(live, includeMemo) {
  return location.href.split('#')[0] + '#/view/' + (await encodeLive(live, includeMemo));
}

/* ===== テキスト出力 ===== */

function liveHeadline(l) {
  return [l.artist, l.title && `「${l.title}」`].filter(Boolean).join(' ');
}

function formatText(live, includeMemo) {
  const nums = numberItems(live.items);
  const lines = [liveHeadline(live), [formatDate(live.date), live.venue && '@' + live.venue].filter(Boolean).join(' '), ''];
  live.items.forEach((it, i) => {
    if (it.type === 'encore') { lines.push('― ENCORE ―'); return; }
    if (it.type === 'mc') {
      if (!includeMemo && !it.title) return;
      lines.push(`MC${it.title ? '：' + it.title : ''}`);
    } else {
      lines.push(`${nums[i]}. ${it.title}`);
    }
    if (includeMemo && it.memo) lines.push(...it.memo.split('\n').map((m) => '　└ ' + m));
  });
  if (includeMemo && live.memo) lines.push('', '【感想】', live.memo);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function postText(live) {
  // X は日本語1文字=2カウント。曲名は入るところまで
  let text = `${liveHeadline(live)} のセトリ\n`;
  const songs = live.items.filter((i) => i.type === 'song').map((i) => i.title);
  let list = '';
  for (const s of songs) {
    if ((list + s).length > 70) { list += '…'; break; }
    list += (list ? ' / ' : '') + s;
  }
  return text + list + '\n#セトリノート';
}

/* ===== 画像出力（Canvas） ===== */

const FONT = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      if (ctx.measureText(line + ch).width > maxWidth && line) { out.push(line); line = ch; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}

function renderImage(live, includeMemo) {
  const W = 1080;
  const P = 72;
  const ops = [];
  const measure = document.createElement('canvas').getContext('2d');
  let y = P;

  const add = (text, { size, weight = 400, color = '#f1edf8', x = P, maxW = W - P * 2, gap = 0.5 }) => {
    measure.font = `${weight} ${size}px ${FONT}`;
    for (const line of wrapLines(measure, text, maxW)) {
      y += size * 1.35;
      ops.push({ text: line, font: measure.font, color, x, y });
    }
    y += size * gap;
  };

  add([formatDate(live.date), live.venue].filter(Boolean).join('  '), { size: 30, color: '#a89fbd' });
  add(live.artist, { size: 52, weight: 800, color: '#ff5c8a', gap: 0.2 });
  if (live.title) add(live.title, { size: 40, weight: 700 });
  y += 24;
  ops.push({ rule: true, y });
  y += 20;

  const nums = numberItems(live.items);
  const numW = 120;
  live.items.forEach((it, i) => {
    if (it.type === 'encore') {
      y += 16;
      add('― ENCORE ―', { size: 32, weight: 700, color: '#ffc35c', gap: 0.4 });
      return;
    }
    if (it.type === 'mc' && !includeMemo && !it.title) return;
    const color = it.type === 'mc' ? '#3ec6b4' : '#ff5c8a';
    ops.push({ text: nums[i], font: `800 34px ${FONT}`, color, x: P, y: y + 34 * 1.35 });
    add(it.title || '', { size: 34, weight: it.type === 'mc' ? 400 : 700, x: P + numW, maxW: W - P * 2 - numW, gap: 0.25 });
    if (includeMemo && it.memo) add(it.memo, { size: 27, color: '#c9c1d9', x: P + numW, maxW: W - P * 2 - numW, gap: 0.6 });
  });

  if (includeMemo && live.memo) {
    y += 24;
    ops.push({ rule: true, y });
    y += 12;
    add(live.memo, { size: 28, color: '#c9c1d9' });
  }
  y += 40;
  add(APP_NAME, { size: 26, weight: 700, color: '#7c6cff', gap: 0 });
  const H = Math.round(y + P * 0.8);

  const canvas = document.createElement('canvas');
  // 端末のCanvas上限を超えないよう、長すぎる時は縮小する
  const scale = Math.min(1, 14000 / H);
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#16131f');
  grad.addColorStop(1, '#241a35');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ff5c8a';
  ctx.fillRect(0, 0, W, 10);
  for (const op of ops) {
    if (op.rule) { ctx.fillStyle = '#2d2640'; ctx.fillRect(P, op.y, W - P * 2, 2); continue; }
    ctx.font = op.font;
    ctx.fillStyle = op.color;
    ctx.fillText(op.text, op.x, op.y);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/* ===== シェアダイアログ ===== */

const dialog = document.getElementById('share-dialog');
const $preview = document.getElementById('share-preview');
const $status = document.getElementById('share-status');
let imageBlob = null;

function openShare() {
  if (!current) return;
  imageBlob = null;
  $preview.hidden = true;
  document.getElementById('share-image-actions').hidden = true;
  $status.textContent = '';
  dialog.showModal();
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function fileBase(live) {
  return `setlist-${live.date || today()}`;
}

async function handleShare(kind) {
  const live = current;
  const includeMemo = document.getElementById('share-include-memo').checked;
  if (kind === 'text') {
    $status.textContent = (await copyText(formatText(live, includeMemo))) ? 'テキストをコピーしました' : 'コピーできませんでした';
  } else if (kind === 'link') {
    const url = await shareUrl(live, includeMemo);
    $status.textContent = (await copyText(url)) ? 'リンクをコピーしました。開くと誰でもこのセトリを見られます。' : 'コピーできませんでした';
  } else if (kind === 'x') {
    const url = await shareUrl(live, includeMemo);
    const params = new URLSearchParams({ text: postText(live) });
    // あまりに長いリンクはXで弾かれるので、その時はテキストだけにする
    if (url.length < 3000) params.set('url', url);
    else $status.textContent = '感想が長いためリンクは付けずに開きます。画像を添付するのがおすすめです。';
    window.open('https://x.com/intent/post?' + params, '_blank', 'noopener');
  } else if (kind === 'image') {
    $status.textContent = '画像を作成中…';
    imageBlob = await renderImage(live, includeMemo);
    if ($preview.src) URL.revokeObjectURL($preview.src);
    $preview.src = URL.createObjectURL(imageBlob);
    $preview.hidden = false;
    document.getElementById('share-image-actions').hidden = false;
    const canShareFile = navigator.canShare?.({ files: [new File([imageBlob], 'a.png', { type: 'image/png' })] });
    document.querySelector('[data-share="image-native"]').hidden = !canShareFile;
    $status.textContent = '画像を長押しでも保存できます';
  } else if (kind === 'image-download' && imageBlob) {
    downloadBlob(imageBlob, fileBase(live) + '.png');
  } else if (kind === 'image-native' && imageBlob) {
    try {
      await navigator.share({
        files: [new File([imageBlob], fileBase(live) + '.png', { type: 'image/png' })],
        text: postText(live),
      });
    } catch { /* キャンセル */ }
  }
}

dialog.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-share]');
  if (btn) handleShare(btn.dataset.share);
  else if (e.target === dialog) dialog.close(); // 背景タップで閉じる
});

/* ===== 画面内の操作（イベント委譲） ===== */

$app.addEventListener('click', (e) => {
  const typeBtn = e.target.closest('.add-bar [data-type]');
  if (typeBtn) {
    setAddType(typeBtn.dataset.type);
    if (addType !== 'encore') document.getElementById('add-input').focus();
    return;
  }
  const pick = e.target.closest('#suggest [data-pick]');
  if (pick && current) {
    addItem(current, 'song', pick.dataset.pick);
    const input = document.getElementById('add-input');
    input.value = '';
    renderSuggest();
    input.focus();
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.tagName === 'INPUT') return;
  const action = btn.dataset.action;
  if (action === 'share') return openShare();
  if (action === 'open-picker') return openPicker();
  if (action === 'export') return exportBackup();
  if (action === 'save-shared') return saveShared();
  if (action === 'delete-live') {
    const live = getLive(btn.dataset.id);
    if (live && confirm(`「${live.artist} ${live.title}」の記録を削除しますか？\nこの操作は取り消せません。`)) {
      lives = lives.filter((l) => l !== live);
      saveLives();
      location.hash = '#/';
    }
    return;
  }
  const li = btn.closest('.item');
  if (!li || !current) return;
  if (action === 'up') moveItem(current, li.dataset.id, -1);
  if (action === 'down') moveItem(current, li.dataset.id, 1);
  if (action === 'remove') removeItem(current, li.dataset.id);
});

$app.addEventListener('input', (e) => {
  const el = e.target;
  if (el.tagName === 'TEXTAREA') autoGrow(el);
  if (el.id === 'add-input') return renderSuggest();
  if (!current || !getLive(current.id)) return;
  if (el.dataset.field) {
    current[el.dataset.field] = el.value;
    saveSoon(current);
  } else if (el.dataset.itemField) {
    const it = current.items.find((x) => x.id === el.closest('.item').dataset.id);
    if (it) {
      it[el.dataset.itemField] = el.value;
      saveSoon(current);
    }
  }
});

$app.addEventListener('change', (e) => {
  if (e.target.dataset.action === 'import' && e.target.files[0]) importBackup(e.target.files[0]);
});

route();
