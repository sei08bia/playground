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
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  window.scrollTo(0, 0);
  if (page === 'new') return renderInfoForm(null);
  if (page === 'playlist' && id === 'new') return renderPlaylistForm(null);
  if (page === 'spotify') return renderSpotify();
  if (page === 'live' && getLive(id)) {
    if (sub === 'info') return isPlaylist(getLive(id)) ? renderPlaylistForm(getLive(id)) : renderInfoForm(getLive(id));
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
      <a href="#/playlist/new" class="button secondary grow-btn">♫ プレイリストを取り込む</a>
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
              ${isPlaylist(l) ? `
              <div class="date"><span class="badge">プレイリスト</span> ${esc(formatDate(l.date))}</div>
              <div class="title">${esc(l.title)}</div>` : `
              <div class="date">${esc(formatDate(l.date))}${l.venue ? ' ・ ' + esc(l.venue) : ''}</div>
              <div class="title">${esc(l.artist || '（アーティスト未入力）')}</div>
              ${l.title ? `<div>${esc(l.title)}</div>` : ''}`}
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
      <input id="f-artist" name="artist" value="${esc(l.artist)}" required autocomplete="off" placeholder="名前を入れると候補が出ます">
      <div class="artist-cands" id="artist-cands" role="radiogroup" aria-label="アーティストの候補"></div>
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
  const box = document.getElementById('artist-cands');
  // 候補から選んだアーティスト（写真・曲一覧の紐づけ先）
  let chosen = live?.catalogArtist?.id ? { ...live.catalogArtist } : null;
  let cands = chosen ? [chosen] : [];
  let searchSeq = 0;

  const renderCands = () => {
    box.innerHTML = cands.map((a) => `
      <button type="button" class="artist-cand" role="radio" aria-checked="${chosen?.id === a.id}" data-cand="${a.id}">
        ${avatarHtml(a.photo, a.name)}
        <span class="name">${esc(a.name)}</span>
        ${a.genre ? `<span class="hint">${esc(a.genre)}</span>` : ''}
      </button>`).join('');
  };

  const search = async (name) => {
    const seq = ++searchSeq;
    if (!name.trim()) { cands = []; chosen = null; renderCands(); return; }
    let found;
    try { found = await findArtists(name); } catch { return; }
    if (seq !== searchSeq) return;
    cands = found.slice(0, 6);
    chosen = cands.find((a) => normTitle(a.name) === normTitle(name)) || cands[0] || null;
    renderCands();
    // 写真は候補ごとに後から差し込む
    await Promise.all(cands.map(async (a) => {
      a.photo = await artistPhoto(a.name);
      if (seq === searchSeq) renderCands();
    }));
  };

  renderCands();
  if (chosen && chosen.photo === undefined) artistPhoto(chosen.name).then((p) => { chosen.photo = p; renderCands(); });

  let timer = null;
  form.artist.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(form.artist.value), 450);
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cand]');
    if (!b) return;
    chosen = cands.find((a) => String(a.id) === b.dataset.cand);
    renderCands();
  });

  if (!live) form.artist.focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    let target = live;
    if (!target) {
      target = { id: newId(), items: [], memo: '', createdAt: Date.now() };
      lives.push(target);
    }
    if (chosen) {
      target.catalogArtist = { id: chosen.id, name: chosen.name, photo: chosen.photo ?? undefined };
    } else if (target.artist !== values.artist.trim()) {
      // 候補を選ばずに名前を変えたら、曲一覧の紐づけは開いた時にやり直す
      delete target.catalogArtist;
    }
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

/* ===== プレイリストの取り込み ===== */

const isPlaylist = (l) => l?.kind === 'playlist';

// 貼り付けたテキストを曲のリストにする。
// ・Mac のミュージックAppからのコピー（タブ区切り: 名前 / 時間 / アーティスト …）
// ・「曲名 - アーティスト」「1. 曲名」などの1行1曲
function parseSongList(text) {
  const header = new Set(['名前', 'name', '曲名', 'タイトル', 'title']);
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let title;
    let artist = '';
    if (line.includes('\t')) {
      const cols = line.split('\t').map((c) => c.trim());
      title = cols[0];
      // 再生時間や記号の列は飛ばして、次の文字列をアーティストとみなす
      artist = cols.slice(1).find((c) => c && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(c) && !/^[\d\s♥❤️☆★]*$/.test(c)) || '';
    } else {
      line = line.replace(/^\d{1,3}\s*[.)．、:]\s*/, '');
      const m = line.match(/^(.+?)\s+[-–—/／]\s+(.+)$/);
      if (m) [, title, artist] = m;
      else title = line;
    }
    if (title && !header.has(title.toLowerCase())) out.push({ title: title.trim(), artist: artist.trim() });
  }
  return out;
}

function renderPlaylistForm(live) {
  $app.innerHTML = `
    <h1>${live ? 'プレイリストを編集' : 'プレイリストを取り込む'}</h1>
    ${live ? '' : `
    <div class="card stack">
      <a href="#/spotify" class="button spotify-btn">Spotifyのプレイリストから選ぶ</a>
      <p class="hint">Apple Music などほかのサービスの場合は、下に曲名リストを貼り付けてください。</p>
    </div>`}
    <form class="card" id="pl-form">
      <label for="pl-title">プレイリスト名</label>
      <input id="pl-title" name="title" value="${esc(live?.title || '')}" required autocomplete="off">
      <label for="pl-songs">${live ? '追加する曲' : '曲のリスト'}（1行に1曲。「曲名 - アーティスト」の形ならアーティストも入ります）</label>
      <textarea id="pl-songs" name="songs" rows="8" placeholder="ここに貼り付け&#10;例）&#10;ライラック - Mrs. GREEN APPLE&#10;アイドル - YOASOBI"></textarea>
      <p class="hint" id="pl-preview" role="status"></p>
      <details class="howto">
        <summary>Apple Musicのプレイリストから曲名をコピーするには</summary>
        <p><b>Macの場合</b>：ミュージックAppでプレイリストを開き、曲を全部選択（⌘A）してコピー（⌘C）。そのまま上の欄に貼り付けられます。</p>
        <p><b>iPhoneの場合</b>：ショートカットAppで新しいショートカットを作り、「ミュージックを検索」（フィルタでプレイリストを指定）と「クリップボードにコピー」の2つを並べて実行します。コピーされた曲名を上の欄に貼り付けてください。</p>
        <p>手で打ち込んでも大丈夫です。</p>
      </details>
      <div class="toolbar">
        <button type="submit">${live ? '保存' : '取り込む'}</button>
        <a class="button secondary" href="${live ? '#/live/' + live.id : '#/'}">キャンセル</a>
      </div>
    </form>
    ${live ? `<button class="danger" data-action="delete-live" data-id="${live.id}">このプレイリストを削除</button>` : ''}`;

  const form = document.getElementById('pl-form');
  const preview = document.getElementById('pl-preview');
  form.songs.addEventListener('input', () => {
    const songs = parseSongList(form.songs.value);
    preview.textContent = songs.length
      ? `${songs.length}曲を読み取りました（1曲目：${songs[0].title}${songs[0].artist ? ' / ' + songs[0].artist : ''}）`
      : '';
  });
  if (!live) form.title.focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const songs = parseSongList(form.songs.value);
    let target = live;
    if (!target) {
      target = { id: newId(), kind: 'playlist', artist: '', venue: '', date: today(), items: [], memo: '', createdAt: Date.now() };
      lives.push(target);
    }
    target.title = form.title.value.trim();
    target.items.push(...songs.map((s) => ({ id: newId(), type: 'song', title: s.title, memo: '', ...(s.artist ? { artist: s.artist } : {}) })));
    target.updatedAt = Date.now();
    saveLives();
    if (songs.length) toast(`${songs.length}曲を取り込みました`);
    location.hash = '#/live/' + target.id;
  });
}

/* ===== Spotify のプレイリスト取り込み（PKCE方式。サーバー不要） ===== */

// Spotify の開発者ダッシュボードで作ったアプリの Client ID（公開して問題ない値）
const SPOTIFY_CLIENT_ID = '';
const SPOTIFY_TOKEN_KEY = 'setlist-note:spotify-token';
const SPOTIFY_PKCE_KEY = 'setlist-note:spotify-pkce';
const spotifyRedirect = () => location.origin + location.pathname;

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 保存できなくても続行 */ }
}

const randomCode = (n) => toBase64Url(crypto.getRandomValues(new Uint8Array(n)));

async function spotifyLogin() {
  const verifier = randomCode(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const state = randomCode(12);
  writeJson(SPOTIFY_PKCE_KEY, { verifier, state });
  const q = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: spotifyRedirect(),
    code_challenge_method: 'S256',
    code_challenge: toBase64Url(new Uint8Array(digest)),
    state,
    scope: 'playlist-read-private playlist-read-collaborative',
  });
  location.href = 'https://accounts.spotify.com/authorize?' + q;
}

function saveSpotifyToken(t, prev) {
  const token = {
    access: t.access_token,
    refresh: t.refresh_token || prev?.refresh,
    exp: Date.now() + ((t.expires_in || 3600) - 60) * 1000,
  };
  writeJson(SPOTIFY_TOKEN_KEY, token);
  return token;
}

async function spotifyTokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, ...params }),
  });
  if (!res.ok) throw new Error('token ' + res.status);
  return res.json();
}

// サインインから戻ってきた時（?code=... 付きで開かれる）にトークンを受け取る
async function handleSpotifyCallback() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  const saved = readJson(SPOTIFY_PKCE_KEY);
  writeJson(SPOTIFY_PKCE_KEY, null);
  history.replaceState(null, '', location.pathname + '#/spotify');
  if (params.has('error') || !saved || params.get('state') !== saved.state) {
    toast('Spotifyへのサインインを中止しました');
    return;
  }
  try {
    saveSpotifyToken(await spotifyTokenRequest({
      grant_type: 'authorization_code',
      code: params.get('code'),
      redirect_uri: spotifyRedirect(),
      code_verifier: saved.verifier,
    }));
  } catch {
    toast('Spotifyへのサインインに失敗しました');
  }
}

async function spotifyAccessToken() {
  const token = readJson(SPOTIFY_TOKEN_KEY);
  if (!token) return null;
  if (Date.now() < token.exp) return token.access;
  if (!token.refresh) { writeJson(SPOTIFY_TOKEN_KEY, null); return null; }
  try {
    return saveSpotifyToken(await spotifyTokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh }), token).access;
  } catch {
    writeJson(SPOTIFY_TOKEN_KEY, null);
    return null;
  }
}

async function spotifyGet(path) {
  const access = await spotifyAccessToken();
  if (!access) throw Object.assign(new Error('auth'), { status: 401 });
  const res = await fetch(path.startsWith('https:') ? path : 'https://api.spotify.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + access },
  });
  if (res.status === 401) writeJson(SPOTIFY_TOKEN_KEY, null);
  if (!res.ok) throw Object.assign(new Error('http'), { status: res.status });
  return res.json();
}

async function spotifyPlaylists() {
  const out = [];
  let next = '/me/playlists?limit=50';
  while (next && out.length < 300) {
    const page = await spotifyGet(next);
    out.push(...(page.items || []).filter(Boolean));
    next = page.next;
  }
  return out;
}

async function spotifyPlaylistSongs(id) {
  const songs = [];
  let next = `/playlists/${id}/tracks?limit=100`;
  let triedItems = false;
  while (next) {
    let page;
    try {
      page = await spotifyGet(next);
    } catch (e) {
      // 新しいAPIでは /items に変わっている場合があるので一度だけ切り替える
      if (!triedItems && !songs.length && (e.status === 403 || e.status === 404)) {
        triedItems = true;
        next = `/playlists/${id}/items?limit=100`;
        continue;
      }
      throw e;
    }
    for (const row of page.items || []) {
      const t = row?.track || row?.item;
      if (!t?.name) continue;
      songs.push({ title: t.name, artist: (t.artists || []).map((a) => a.name).join(', ') });
    }
    next = page.next;
  }
  return songs;
}

async function renderSpotify() {
  const back = '<a href="#/playlist/new" class="button secondary">戻る</a>';
  if (!SPOTIFY_CLIENT_ID) {
    $app.innerHTML = `
      <h1>Spotifyから取り込む</h1>
      <div class="card"><p>Spotify との接続設定がまだ終わっていません。設定が済むと、ここからサインインしてプレイリストを選べるようになります。</p>${back}</div>`;
    return;
  }
  if (!(await spotifyAccessToken())) {
    $app.innerHTML = `
      <h1>Spotifyから取り込む</h1>
      <div class="card stack">
        <p>Spotify にサインインすると、自分のプレイリストを一覧から選んで取り込めます。プレイリストの中身を読むだけで、変更はしません。</p>
        <button class="spotify-btn" data-sp="login">Spotifyでサインイン</button>
        ${back}
      </div>`;
    bindSpotify();
    return;
  }
  $app.innerHTML = `
    <div class="row"><h1 class="grow">Spotifyのプレイリスト</h1><button class="secondary small" data-sp="logout">サインアウト</button></div>
    <p class="hint" id="sp-status">読み込み中…</p>
    <ul class="picker-list works sp-list" id="sp-list"></ul>`;
  bindSpotify();
  try {
    const lists = await spotifyPlaylists();
    if (!location.hash.startsWith('#/spotify')) return;
    document.getElementById('sp-status').textContent = lists.length ? '取り込むプレイリストをタップしてください。' : 'プレイリストがありません。';
    document.getElementById('sp-list').innerHTML = lists.map((p) => `
      <li><button type="button" class="work" data-sp-playlist="${esc(p.id)}" data-name="${esc(p.name)}">
        ${p.images?.[0]?.url ? `<img class="album-art" src="${esc(p.images[0].url)}" alt="" loading="lazy">` : '<span class="album-art"></span>'}
        <span class="work-name">${esc(p.name)}</span>
        <span class="hint">${(p.tracks?.total ?? p.items?.total ?? '')}${(p.tracks?.total ?? p.items?.total) != null ? '曲' : ''}</span>
      </button></li>`).join('');
  } catch (e) {
    document.getElementById('sp-status').textContent = e.status === 403
      ? 'このSpotifyアカウントはまだこのアプリを使えません。アプリの持ち主がSpotifyの管理画面で利用者として追加する必要があります。'
      : e.status === 401 ? 'サインインの有効期限が切れました。もう一度サインインしてください。' : 'プレイリストを読み込めませんでした。電波の良い場所でもう一度試してください。';
  }
}

function bindSpotify() {
  $app.querySelectorAll('[data-sp="login"]').forEach((b) => b.addEventListener('click', spotifyLogin));
  $app.querySelectorAll('[data-sp="logout"]').forEach((b) => b.addEventListener('click', () => {
    writeJson(SPOTIFY_TOKEN_KEY, null);
    renderSpotify();
  }));
  $app.querySelector('#sp-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-sp-playlist]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const status = document.getElementById('sp-status');
    status.textContent = `「${btn.dataset.name}」を取り込み中…`;
    try {
      const songs = await spotifyPlaylistSongs(btn.dataset.spPlaylist);
      const live = {
        id: newId(), kind: 'playlist', title: btn.dataset.name, artist: '', venue: '', date: today(), memo: '',
        source: 'spotify', createdAt: Date.now(), updatedAt: Date.now(),
        items: songs.map((s) => ({ id: newId(), type: 'song', title: s.title, memo: '', ...(s.artist ? { artist: s.artist } : {}) })),
      };
      lives.push(live);
      saveLives();
      toast(`${songs.length}曲を取り込みました`);
      location.hash = '#/live/' + live.id;
    } catch (err) {
      btn.disabled = false;
      status.textContent = err.status === 403
        ? 'このプレイリストは読み込めませんでした（Spotifyが提供を制限しているプレイリストの可能性があります）。'
        : '取り込めませんでした。もう一度試してください。';
    }
  });
}

/* ===== セトリ編集 ===== */

let addType = 'song';

function avatarHtml(photo, name) {
  return photo
    ? `<img class="avatar" src="${esc(photo)}" alt="" loading="lazy">`
    : `<span class="avatar placeholder" aria-hidden="true">${esc((name || '♪').trim().charAt(0))}</span>`;
}

const livePhoto = (l) => l.catalogArtist?.photo || l.sharedPhoto || null;

function headerHtml(l) {
  if (isPlaylist(l)) {
    return `
    <div class="header-row">
      <div class="grow">
        <div class="meta"><span class="badge">プレイリスト</span> ${esc(formatDate(l.date))}</div>
        <h1>${esc(l.title)}</h1>
      </div>
    </div>`;
  }
  return `
    <div class="header-row">
      ${livePhoto(l) ? avatarHtml(livePhoto(l), l.artist).replace('class="avatar"', 'class="avatar large"') : ''}
      <div class="grow">
        <div class="meta">${esc(formatDate(l.date))}${l.venue ? ' ・ ' + esc(l.venue) : ''}</div>
        <div class="artist">${esc(l.artist)}</div>
        ${l.title ? `<h1>${esc(l.title)}</h1>` : ''}
      </div>
    </div>`;
}

function renderEditor(live) {
  current = live;
  const pl = isPlaylist(live);
  $app.innerHTML = `
    <section class="view-header card">
      ${headerHtml(live)}
      <div class="toolbar">
        <button data-action="share">シェア</button>
        <a class="button secondary" href="#/live/${live.id}/info">${pl ? '名前の変更・曲の取り込み' : 'ライブ情報を編集'}</a>
      </div>
    </section>
    <h2>${pl ? '曲' : 'セットリスト'} <span class="hint" id="song-count"></span></h2>
    <ol class="setlist" id="setlist"></ol>
    <div class="card">
      <label for="overall">${pl ? 'プレイリスト全体の感想' : 'ライブ全体の感想'}</label>
      <textarea id="overall" data-field="memo" placeholder="${pl ? 'このプレイリストについて思うこと' : '全体を通して感じたこと、演出、客席の雰囲気など'}">${esc(live.memo)}</textarea>
    </div>
    <div class="add-bar">
      <div class="inner">
        <ul class="suggest" id="suggest" hidden></ul>
        <div class="types" role="group" aria-label="追加する種類" ${pl ? 'hidden' : ''}>
          <button type="button" data-type="song">♪ 曲</button>
          <button type="button" data-type="mc">💬 MC</button>
          <button type="button" data-type="encore">★ アンコール</button>
        </div>
        <form class="row" id="add-form">
          <button type="button" class="secondary list-btn" data-action="open-picker">曲を選ぶ</button>
          <input class="grow" id="add-input" autocomplete="off" enterkeyhint="done">
          <button type="submit">追加</button>
        </form>
      </div>
    </div>`;

  renderSetlist(live);
  setAddType(pl ? 'song' : addType);
  autoGrow(document.getElementById('overall'));
  if (pl) document.querySelector('[data-action="open-picker"]').hidden = true;
  else ensureCatalog(live);

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
  input.placeholder = { song: '曲名を入力', mc: 'MCの話題（あとで書いてもOK）', encore: '' }[type];
  input.hidden = type === 'encore';
  document.querySelector('[data-action="open-picker"]').hidden = type !== 'song' || (current && isPlaylist(current));
  input.closest('form').querySelector('[type=submit]').textContent = type === 'encore' ? 'アンコールの区切りを追加' : '追加';
  renderSuggest();
}

/* ===== アーティストの曲・作品（Apple Music の公開検索API）と写真（Deezer） ===== */

const CATALOG_PREFIX = 'setlist-note:catalog:';
const CATALOG_TTL = 7 * 24 * 60 * 60 * 1000;

// 表示中のライブのアーティスト情報
const catalog = { liveId: null, status: 'idle', artist: null, songs: [], albums: [] };

async function itunes(path, params) {
  const q = new URLSearchParams({ country: 'JP', lang: 'ja_jp', ...params });
  const res = await fetch(`https://itunes.apple.com/${path}?${q}`);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).results || [];
}

// Deezer の API は CORS 非対応なので JSONP で呼ぶ
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = '__jsonp' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    // 遅れて届いた応答でエラーにならないよう、コールバックは空の関数にして残す
    const cleanup = () => { clearTimeout(timer); window[cb] = () => {}; script.remove(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 8000);
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('jsonp')); };
    script.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
    document.head.append(script);
  });
}

// 一定期間は端末に保存したものを使う（ライブ会場の電波が悪くても動くように）
async function cached(key, load) {
  try {
    const hit = JSON.parse(localStorage.getItem(CATALOG_PREFIX + key));
    if (hit && Date.now() - hit.at < CATALOG_TTL) return hit.value;
  } catch { /* キャッシュなし */ }
  const value = await load();
  try { localStorage.setItem(CATALOG_PREFIX + key, JSON.stringify({ at: Date.now(), value })); } catch { /* 容量不足なら毎回取得 */ }
  return value;
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

// アーティスト写真。名前が一致する時だけ使う（別人の写真を出さないため）
async function artistPhoto(name) {
  try {
    return await cached('photo:' + normTitle(name), async () => {
      const res = await jsonp(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`);
      const hit = (res.data || []).find((a) => normTitle(a.name) === normTitle(name));
      const url = hit?.picture_medium;
      // 写真未登録のアーティストは空のパスになる
      return url && !url.includes('/artist//') ? url : null;
    });
  } catch {
    return null;
  }
}

const KIND_LABEL = { album: 'アルバム', single: 'シングル', ep: 'EP' };

// 曲一覧と作品（アルバム・シングル）一覧をまとめて取得
function fetchArtistData(artist) {
  return cached('artist:' + artist.id, async () => {
    // 検索（人気順に近い）と、アーティストIDでの一覧を合わせて取りこぼしを減らす
    const [searched, looked, collections] = await Promise.all([
      itunes('search', { term: artist.name, entity: 'song', attribute: 'artistTerm', limit: 200 }).catch(() => []),
      itunes('lookup', { id: artist.id, entity: 'song', limit: 200 }).catch(() => []),
      itunes('lookup', { id: artist.id, entity: 'album', limit: 200 }).catch(() => []),
    ]);
    const tracks = [...searched.filter((x) => x.artistId === artist.id), ...looked].filter((r) => r.wrapperType === 'track');

    const seen = new Set();
    const songs = [];
    for (const r of tracks) {
      if (!r.trackName || isExtraTrack(r.trackName)) continue;
      const title = cleanTitle(r.trackName);
      const key = normTitle(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      songs.push({ title, year: (r.releaseDate || '').slice(0, 4) });
    }

    // 作品名は英語表記で返ることがあるので、曲側に付いている日本語の作品名を優先する
    const jaName = new Map(tracks.map((r) => [r.collectionId, r.collectionName]));
    const seenAlbums = new Set();
    const albums = collections
      .filter((r) => r.wrapperType === 'collection' && r.collectionName && !isExtraTrack(r.collectionName))
      .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
      .map((r) => {
        const full = jaName.get(r.collectionId) || r.collectionName;
        const m = full.match(/^(.*?)\s+-\s+(Single|EP)$/i);
        return {
          id: r.collectionId,
          name: m ? m[1] : full,
          kind: m ? m[2].toLowerCase() : 'album',
          year: (r.releaseDate || '').slice(0, 4),
          art: (r.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
        };
      })
      .filter((a) => {
        const key = a.kind + normTitle(a.name);
        if (seenAlbums.has(key)) return false; // 通常盤/クリーン盤などの重複
        seenAlbums.add(key);
        return true;
      });
    return { songs, albums };
  });
}

function fetchAlbumTracks(albumId) {
  return cached('tracks:' + albumId, async () => {
    const results = await itunes('lookup', { id: albumId, entity: 'song' });
    return results
      .filter((r) => r.wrapperType === 'track')
      .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber))
      .map((r) => ({ title: cleanTitle(r.trackName), n: r.trackNumber, extra: isExtraTrack(r.trackName) }))
      .filter((t) => !t.extra);
  });
}

async function ensureCatalog(live, force = false) {
  if (!force && catalog.liveId === live.id && catalog.status !== 'error') return;
  Object.assign(catalog, { liveId: live.id, status: 'loading', artist: null, songs: [], albums: [] });
  renderPicker();
  try {
    let artist = live.catalogArtist;
    if (artist === undefined || (artist && !artist.id)) {
      // 名前が完全一致する候補を優先、なければ一番上の候補
      const found = live.artist ? await findArtists(live.artist) : [];
      const hit = found.find((a) => normTitle(a.name) === normTitle(live.artist)) || found[0];
      artist = hit ? { id: hit.id, name: hit.name } : null;
      live.catalogArtist = artist;
      saveSoon(live);
    }
    if (catalog.liveId !== live.id) return;
    if (!artist) { catalog.status = 'none'; renderPicker(); return; }
    const { songs, albums } = await fetchArtistData(artist);
    if (catalog.liveId !== live.id) return;
    Object.assign(catalog, { status: songs.length || albums.length ? 'ready' : 'none', artist, songs, albums });
    if (artist.photo === undefined) {
      artist.photo = await artistPhoto(artist.name);
      saveSoon(live);
      if (current === live && location.hash.startsWith('#/live/' + live.id) && !location.hash.endsWith('/info')) {
        const header = document.querySelector('.view-header .header-row');
        if (header) header.outerHTML = headerHtml(live);
      }
    }
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

/* ===== 曲を選ぶシート（ジャケット一覧 → 収録曲） ===== */

const picker = document.getElementById('picker-dialog');
const $pickerSearch = document.getElementById('picker-search');
let pickerMode = 'works'; // 'works' | 'album' | 'artists'
let workFilter = 'all';   // 'all' | 'album' | 'single'
let openedAlbum = null;   // { album, tracks, status }
let artistCandidates = [];

function openPicker() {
  if (!current) return;
  pickerMode = 'works';
  openedAlbum = null;
  $pickerSearch.value = '';
  picker.showModal();
  miniCount = 0; // 開いた時は最後の曲まで送る（光らせはしない）
  renderMini();
  document.querySelectorAll('.mini-item.flash').forEach((el) => el.classList.remove('flash'));
  ensureCatalog(current);
  renderPicker();
}

function usedTitles() {
  return new Set(current.items.filter((i) => i.type === 'song').map((i) => normTitle(i.title)));
}

function songRows(list, used) {
  return list.map((s) => {
    const done = used.has(normTitle(s.title));
    return `
      <li><button type="button" class="pick-row ${done ? 'used' : ''}" data-pick="${esc(s.title)}">
        ${s.n ? `<span class="track-no">${s.n}</span>` : ''}
        <span class="grow">${esc(s.title)}</span>
        <span class="hint">${done ? '✓ 追加済み' : esc(s.year || '')}</span>
      </button></li>`;
  }).join('');
}

function renderPicker() {
  if (!picker.open || !current) return;
  const live = current;
  const $head = document.getElementById('picker-head');
  const $status = document.getElementById('picker-status');
  const $list = document.getElementById('picker-list');
  const $filters = document.getElementById('picker-filters');
  const query = $pickerSearch.value.trim();
  $filters.hidden = true;
  $pickerSearch.hidden = false;

  if (pickerMode === 'artists') {
    $head.innerHTML = `<button type="button" class="icon" data-action="picker-back" aria-label="戻る">←</button><h2 class="grow">アーティストを選ぶ</h2>`;
    $pickerSearch.placeholder = 'アーティスト名で検索';
    $status.textContent = artistCandidates.length ? '' : '見つかりませんでした。名前を変えて検索してみてください。';
    $list.className = 'picker-list';
    $list.innerHTML = artistCandidates.map((a) => `
      <li><button type="button" class="pick-row" data-artist-id="${a.id}">
        ${avatarHtml(a.photo, a.name)}<span class="grow">${esc(a.name)}</span><span class="hint">${esc(a.genre)}</span>
      </button></li>`).join('');
    return;
  }

  if (pickerMode === 'album' && openedAlbum) {
    const { album, tracks, status } = openedAlbum;
    $pickerSearch.hidden = true;
    $head.innerHTML = `
      <button type="button" class="icon" data-action="picker-back" aria-label="作品一覧に戻る">←</button>
      <img class="album-art small" src="${esc(album.art)}" alt="">
      <div class="grow album-head"><h2>${esc(album.name)}</h2><span class="hint">${KIND_LABEL[album.kind]} ・ ${esc(album.year)}</span></div>`;
    $status.textContent = status === 'loading' ? '収録曲を読み込み中…' : status === 'error' ? '収録曲を読み込めませんでした。' : '';
    $list.className = 'picker-list';
    $list.innerHTML = songRows(tracks || [], usedTitles());
    return;
  }

  // 作品一覧（検索中は曲名で絞り込み）
  const artist = catalog.artist;
  $head.innerHTML = `
    ${artist ? avatarHtml(artist.photo, artist.name) : ''}
    <h2 class="grow">${esc(artist ? artist.name : live.artist || '曲一覧')}</h2>
    <button type="button" class="secondary small" data-action="change-artist">変更</button>`;
  $pickerSearch.placeholder = '曲名で探す';
  $status.textContent = {
    loading: '作品を読み込み中…',
    error: '読み込めませんでした。電波の良い場所でもう一度開いてください。',
    none: `「${live.artist}」の作品が見つかりませんでした。「変更」からアーティストを選び直せます。`,
    ready: '',
    idle: '',
  }[catalog.status];
  if (catalog.status !== 'ready') { $list.innerHTML = ''; return; }

  if (query) {
    const hits = matchSongs(query);
    $list.className = 'picker-list';
    $list.innerHTML = songRows(hits, usedTitles())
      + (!hits.some((s) => normTitle(s.title) === normTitle(query))
        ? `<li><button type="button" class="pick-row free" data-pick="${esc(query)}">「${esc(query)}」をそのまま追加</button></li>`
        : '');
    return;
  }

  $filters.hidden = false;
  $filters.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === workFilter)));
  const albums = catalog.albums.filter((a) => workFilter === 'all' || (workFilter === 'single' ? a.kind !== 'album' : a.kind === 'album'));
  $list.className = 'picker-list works';
  $list.innerHTML = albums.length
    ? albums.map((a) => `
      <li><button type="button" class="work" data-album="${a.id}">
        <img class="album-art" src="${esc(a.art)}" alt="" loading="lazy">
        <span class="work-name">${esc(a.name)}</span>
        <span class="hint">${KIND_LABEL[a.kind]} ・ ${esc(a.year)}</span>
      </button></li>`).join('')
    : '<li class="hint">該当する作品がありません。上の欄に曲名を入れて探せます。</li>';
}

// 曲を選ぶシートの上部に出す、いまのセトリ（追加するとその場で反映）
let miniCount = 0;
function renderMini() {
  if (!picker.open || !current) return;
  const items = current.items;
  const nums = numberItems(items);
  const added = items.length > miniCount;
  miniCount = items.length;
  document.getElementById('mini-count').textContent = `${countSongs(current)}曲`;
  const ol = document.getElementById('mini-list');
  ol.innerHTML = items.length === 0
    ? '<li class="hint mini-empty">まだ空です。下から曲をタップすると、ここに追加されます。</li>'
    : items.map((it, i) => {
      const flash = added && i === items.length - 1 ? ' flash' : '';
      if (it.type === 'encore') return `<li class="mini-item encore${flash}" data-id="${it.id}"><span class="grow">― ENCORE ―</span><button type="button" class="mini-remove" data-action="mini-remove" aria-label="削除">✕</button></li>`;
      const label = it.type === 'mc' ? (it.title || '') : it.title;
      return `<li class="mini-item ${it.type}${flash}" data-id="${it.id}">
        <span class="num">${nums[i]}</span><span class="grow">${esc(label)}</span>
        <button type="button" class="mini-remove" data-action="mini-remove" aria-label="削除">✕</button>
      </li>`;
    }).join('');
  if (added) ol.scrollTop = ol.scrollHeight;
}

async function openAlbum(albumId) {
  const album = catalog.albums.find((a) => String(a.id) === String(albumId));
  if (!album) return;
  openedAlbum = { album, tracks: [], status: 'loading' };
  pickerMode = 'album';
  renderPicker();
  document.getElementById('picker-list').scrollTop = 0;
  try {
    const tracks = await fetchAlbumTracks(album.id);
    if (openedAlbum?.album === album) Object.assign(openedAlbum, { tracks, status: 'ready' });
  } catch {
    if (openedAlbum?.album === album) openedAlbum.status = 'error';
  }
  renderPicker();
}

async function searchArtistCandidates(name) {
  pickerMode = 'artists';
  artistCandidates = [];
  renderPicker();
  document.getElementById('picker-status').textContent = '検索中…';
  try {
    artistCandidates = name.trim() ? (await findArtists(name)).slice(0, 8) : [];
  } catch {
    document.getElementById('picker-status').textContent = '検索できませんでした。電波の良い場所でもう一度試してください。';
    return;
  }
  renderPicker();
  const list = artistCandidates;
  await Promise.all(list.map(async (a) => { a.photo = await artistPhoto(a.name); }));
  if (list === artistCandidates) renderPicker();
}

let pickerSearchTimer = null;
$pickerSearch.addEventListener('input', () => {
  if (pickerMode !== 'artists') return renderPicker();
  clearTimeout(pickerSearchTimer);
  pickerSearchTimer = setTimeout(() => searchArtistCandidates($pickerSearch.value), 400);
});

picker.addEventListener('click', (e) => {
  if (e.target === picker) return picker.close();
  if (!current) return;
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    addItem(current, 'song', pick.dataset.pick);
    toast(`「${pick.dataset.pick}」を追加しました`);
    renderPicker();
    return;
  }
  const miniRemove = e.target.closest('[data-action="mini-remove"]');
  if (miniRemove) {
    removeItem(current, miniRemove.closest('.mini-item').dataset.id);
    miniCount = current.items.length;
    renderMini();
    renderPicker();
    return;
  }
  if (e.target.closest('[data-action="mini-mc"]')) return addItem(current, 'mc', '');
  if (e.target.closest('[data-action="mini-encore"]')) return addItem(current, 'encore', '');
  const work = e.target.closest('[data-album]');
  if (work) return openAlbum(work.dataset.album);
  const filter = e.target.closest('[data-filter]');
  if (filter) { workFilter = filter.dataset.filter; return renderPicker(); }
  const artistBtn = e.target.closest('[data-artist-id]');
  if (artistBtn) {
    const a = artistCandidates.find((x) => String(x.id) === artistBtn.dataset.artistId);
    current.catalogArtist = { id: a.id, name: a.name, photo: a.photo ?? undefined };
    saveSoon(current);
    pickerMode = 'works';
    $pickerSearch.value = '';
    renderEditor(current);
    ensureCatalog(current, true);
    return;
  }
  if (e.target.closest('[data-action="picker-back"]')) {
    pickerMode = 'works';
    openedAlbum = null;
    $pickerSearch.value = '';
    return renderPicker();
  }
  if (e.target.closest('[data-action="change-artist"]')) {
    $pickerSearch.value = current.artist;
    searchArtistCandidates(current.artist);
  }
});

/* ===== セトリの表示と並べ替え ===== */

function renderSetlist(live) {
  const nums = numberItems(live.items);
  const last = live.items.length - 1;
  document.getElementById('song-count').textContent = `${countSongs(live)}曲`;
  const ol = document.getElementById('setlist');
  ol.innerHTML = live.items.length === 0
    ? isPlaylist(live)
      ? `<li class="empty">曲がまだありません。<br><span class="hint">「名前の変更・曲の取り込み」から貼り付けるか、下の入力欄から追加できます。</span></li>`
      : `<li class="empty">下の入力欄から1曲目を追加しましょう。<br><span class="hint">曲名を打つと候補が出ます。「曲を選ぶ」からジャケットで選ぶこともできます。</span></li>`
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
          ${it.artist ? `<div class="item-artist">${esc(it.artist)}</div>` : ''}
          <textarea data-item-field="memo" rows="1" placeholder="${isMc ? '何を話していたか' : 'この曲で感じたこと'}">${esc(it.memo)}</textarea>
        </li>`;
    }).join('');
  ol.querySelectorAll('textarea').forEach(autoGrow);
  renderMini();
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
  // メモを書いた項目だけ確認する（曲名だけならすぐ入れ直せる）
  if (it.memo && !confirm(`「${name}」を削除しますか？`)) return;
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
      <div class="banner">共有された${isPlaylist(live) ? 'プレイリスト' : 'セトリ'}です。<a href="#/">自分でも記録する</a></div>
      <section class="view-header card">${headerHtml(live)}</section>
      <ol class="setlist">
        ${live.items.map((it, i) => it.type === 'encore'
          ? '<li class="item encore">ENCORE</li>'
          : `<li class="item ${it.type}">
              <div class="row"><span class="num">${nums[i]}</span><span class="grow song-title">${esc(it.title)}</span></div>
              ${it.artist ? `<div class="item-artist">${esc(it.artist)}</div>` : ''}
              <div class="memo">${esc(it.memo)}</div>
            </li>`).join('')}
      </ol>
      ${live.memo ? `<div class="card"><h2>${isPlaylist(live) ? 'プレイリスト全体の感想' : 'ライブ全体の感想'}</h2><div class="overall-memo">${esc(live.memo)}</div></div>` : ''}
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
    a: live.artist, t: live.title, d: live.date, v: live.venue, p: livePhoto(live) || undefined,
    k: isPlaylist(live) ? 'p' : undefined,
    m: includeMemo ? live.memo : '',
    i: live.items.map((it) => {
      const row = [TYPE_CODES[it.type], it.title || ''];
      if (includeMemo && it.memo) row.push(it.memo);
      if (it.artist) row[2] = row[2] || '', row.push(it.artist);
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
    kind: c.k === 'p' ? 'playlist' : undefined,
    sharedPhoto: /^https:\/\/[\w.-]+\.dzcdn\.net\//.test(c.p || '') ? c.p : undefined,
    items: (c.i || []).map(([t, title, memo, artist]) => ({
      id: newId(), type: CODE_TYPES[t] || 'song', title: title || '', memo: memo || '', ...(artist ? { artist } : {}),
    })),
  };
}

async function shareUrl(live, includeMemo) {
  return location.href.split('#')[0] + '#/view/' + (await encodeLive(live, includeMemo));
}

/* ===== テキスト出力 ===== */

function liveHeadline(l) {
  if (isPlaylist(l)) return `プレイリスト「${l.title}」`;
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
      lines.push(`${nums[i]}. ${it.title}${it.artist ? ' / ' + it.artist : ''}`);
    }
    if (includeMemo && it.memo) lines.push(...it.memo.split('\n').map((m) => '　└ ' + m));
  });
  if (includeMemo && live.memo) lines.push('', '【感想】', live.memo);
  if (isPlaylist(live)) lines.splice(1, 1); // プレイリストは日付・会場の行を出さない
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function postText(live) {
  // X は日本語1文字=2カウント。曲名は入るところまで
  let text = `${liveHeadline(live)} ${isPlaylist(live) ? 'の感想' : 'のセトリ'}\n`;
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

  if (isPlaylist(live)) {
    add('PLAYLIST', { size: 30, weight: 700, color: '#a89fbd' });
    add(live.title, { size: 52, weight: 800, color: '#ff5c8a', gap: 0.2 });
  } else {
    add([formatDate(live.date), live.venue].filter(Boolean).join('  '), { size: 30, color: '#a89fbd' });
    add(live.artist, { size: 52, weight: 800, color: '#ff5c8a', gap: 0.2 });
    if (live.title) add(live.title, { size: 40, weight: 700 });
  }
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
    if (it.artist) add(it.artist, { size: 26, color: '#a89fbd', x: P + numW, maxW: W - P * 2 - numW, gap: 0.3 });
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
    $status.textContent = (await copyText(url)) ? 'リンクをコピーしました。開くと誰でもこの内容を見られます。' : 'コピーできませんでした';
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

handleSpotifyCallback().finally(route);
