'use strict';
/* Mis Pelis — registro privado de películas y series.
   Los datos viven en el navegador (IndexedDB). La copia en la nube es opcional
   y va cifrada con tu contraseña antes de salir del dispositivo. */

const VERSION = '1.1.0';
const IMG = 'https://image.tmdb.org/t/p/';
const BACKUP_FILE = 'mis-pelis.enc.json';

/* ---------- Utilidades ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function localToday() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${+d}/${+m}/${y}`;
}
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- Ajustes (solo en este dispositivo) ---------- */
const Settings = {
  get(k, def = '') { try { return localStorage.getItem('mp.' + k) ?? def; } catch { return def; } },
  set(k, v) {
    try {
      if (v === '' || v == null) localStorage.removeItem('mp.' + k);
      else localStorage.setItem('mp.' + k, v);
    } catch { /* almacenamiento no disponible */ }
  }
};

/* ---------- Base de datos local ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mis-pelis', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  all() {
    return new Promise((res, rej) => {
      const q = this.db.transaction('items').objectStore('items').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  },
  putMany(list) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction('items', 'readwrite');
      const st = tx.objectStore('items');
      list.forEach(i => st.put(i));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
};

/* Un elemento:
   { id:'movie:603'|'tv:1399', tmdbId, type:'movie'|'tv', title, originalTitle, year, poster,
     overview, genres[], runtime, seasons, imdbId,
     ratings:{ imdb, imdbVotes, rt, mc, tmdb, at },
     status:'pending'|'seen'|'watching'|'dropped', myRating:1-10|null, seenDate:'YYYY-MM-DD',
     comment, addedAt, updatedAt, deleted } */
const items = new Map();
const alive = () => [...items.values()].filter(i => !i.deleted);

async function saveItem(it) {
  it.updatedAt = Date.now();
  items.set(it.id, it);
  await DB.putMany([it]);
  Sync.schedule();
}

/* ---------- APIs de películas ---------- */
const Api = {
  async tmdb(path, params = {}) {
    const key = Settings.get('tmdbKey').trim();
    if (!key) throw new Error('Falta la clave de TMDb (ve a Ajustes)');
    const url = new URL('https://api.themoviedb.org/3' + path);
    Object.entries({ language: 'es-ES', ...params }).forEach(([k, v]) => url.searchParams.set(k, v));
    const headers = {};
    if (key.length > 40) headers.Authorization = 'Bearer ' + key; // token de lectura (v4)
    else url.searchParams.set('api_key', key);                  // clave clásica (v3)
    let r;
    try { r = await fetch(url, { headers }); } catch { throw new Error('Sin conexión con TMDb'); }
    if (r.status === 401) throw new Error('La clave de TMDb no es válida');
    if (!r.ok) throw new Error('TMDb respondió ' + r.status);
    return r.json();
  },
  async search(q) {
    const d = await this.tmdb('/search/multi', { query: q, include_adult: 'false' });
    return (d.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
  },
  async details(type, id) {
    const d = await this.tmdb(`/${type}/${id}`, { append_to_response: 'external_ids' });
    return {
      id: `${type}:${id}`, tmdbId: id, type,
      title: d.title || d.name || '',
      originalTitle: d.original_title || d.original_name || '',
      year: (d.release_date || d.first_air_date || '').slice(0, 4),
      poster: d.poster_path || null,
      overview: d.overview || '',
      genres: (d.genres || []).map(g => g.name),
      runtime: d.runtime || (d.episode_run_time && d.episode_run_time[0]) || null,
      seasons: d.number_of_seasons || null,
      imdbId: d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || null,
      tmdbVote: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null
    };
  },
  async omdb(imdbId) {
    const key = Settings.get('omdbKey').trim();
    if (!key || !imdbId) return null;
    let d;
    try {
      const r = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(key)}`);
      d = await r.json();
    } catch { throw new Error('Sin conexión con OMDb'); }
    if (d.Response === 'False') {
      if (/api key/i.test(d.Error || '')) throw new Error('La clave de OMDb no es válida o no está activada');
      if (/limit/i.test(d.Error || '')) throw new Error('OMDb: límite diario alcanzado');
      return null;
    }
    const out = {};
    if (d.imdbRating && d.imdbRating !== 'N/A') out.imdb = d.imdbRating;
    if (d.imdbVotes && d.imdbVotes !== 'N/A') out.imdbVotes = d.imdbVotes;
    for (const x of d.Ratings || []) {
      if (x.Source === 'Rotten Tomatoes') out.rt = x.Value;
      if (x.Source === 'Metacritic') out.mc = String(x.Value).replace('/100', '');
    }
    if (!out.mc && d.Metascore && d.Metascore !== 'N/A') out.mc = d.Metascore;
    return out;
  }
};

async function fetchInfo(type, tmdbId) {
  const d = await Api.details(type, tmdbId);
  const ratings = { tmdb: d.tmdbVote, at: Date.now() };
  delete d.tmdbVote;
  try {
    const o = await Api.omdb(d.imdbId);
    if (o) Object.assign(ratings, o);
  } catch (e) { toast(e.message); }
  d.ratings = ratings;
  return d;
}

/* ---------- Cifrado (AES-GCM con clave derivada de tu contraseña) ---------- */
function toB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
const Crypto = {
  async key(pass, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  },
  async encrypt(obj, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(pass, salt),
      new TextEncoder().encode(JSON.stringify(obj)));
    return JSON.stringify({ app: 'mis-pelis', v: 1, enc: 'AES-GCM-256/PBKDF2-SHA256', salt: toB64(salt), iv: toB64(iv), data: toB64(ct) });
  },
  isEncrypted(text) {
    try { return !!JSON.parse(text).data; } catch { return false; }
  },
  async decrypt(text, pass) {
    const o = JSON.parse(text);
    if (!o.data) return o; // copia sin cifrar
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(o.iv) },
        await this.key(pass, fromB64(o.salt)), fromB64(o.data));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch { throw new Error('Contraseña de cifrado incorrecta'); }
  }
};

const payload = () => ({ app: 'mis-pelis', v: 1, exportedAt: new Date().toISOString(), items: [...items.values()] });

/* Fusiona elementos de otra copia: gana la versión modificada más tarde. */
async function mergeItems(list) {
  const changed = [];
  const remoteIds = new Map();
  for (const r of list) {
    if (!r || !r.id) continue;
    remoteIds.set(r.id, r.updatedAt || 0);
    const l = items.get(r.id);
    if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { items.set(r.id, r); changed.push(r); }
  }
  if (changed.length) await DB.putMany(changed);
  // ¿Hay algo en local más nuevo que en la copia remota?
  const localNewer = [...items.values()].some(l => (l.updatedAt || 0) > (remoteIds.get(l.id) ?? -1));
  return { pulled: changed.length, localNewer };
}

/* ---------- Copia en GitHub (Gist secreto, contenido cifrado) ---------- */
const Gist = {
  async req(method, path, body) {
    const token = Settings.get('ghToken').trim();
    let r;
    try {
      r = await fetch('https://api.github.com' + path, {
        method, cache: 'no-store',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch { throw new Error('Sin conexión con GitHub'); }
    if (r.status === 401) throw new Error('El token de GitHub no es válido o ha caducado');
    if (r.status === 404) { const e = new Error('No se encontró la copia en GitHub'); e.notFound = true; throw e; }
    if (r.status === 403) throw new Error('GitHub: el token no tiene permiso "gist"');
    if (!r.ok) throw new Error('GitHub respondió ' + r.status);
    return r.json();
  },
  async find() {
    for (let page = 1; page <= 5; page++) {
      const list = await this.req('GET', `/gists?per_page=100&page=${page}`);
      const g = list.find(g => g.files && g.files[BACKUP_FILE]);
      if (g) return g.id;
      if (list.length < 100) break;
    }
    return null;
  },
  async read(id) {
    const g = await this.req('GET', '/gists/' + id);
    const f = g.files && g.files[BACKUP_FILE];
    if (!f) return null;
    if (f.truncated) return (await fetch(f.raw_url, { cache: 'no-store' })).text();
    return f.content;
  },
  async create(content) {
    const g = await this.req('POST', '/gists', {
      description: 'Copia cifrada de Mis Pelis', public: false, files: { [BACKUP_FILE]: { content } }
    });
    return g.id;
  },
  update(id, content) {
    return this.req('PATCH', '/gists/' + id, { files: { [BACKUP_FILE]: { content } } });
  }
};

const Sync = {
  busy: false, again: false, timer: null,
  configured() { return !!(Settings.get('ghToken') && Settings.get('passphrase')); },
  schedule() {
    if (!this.configured()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 4000);
  },
  async run(manual = false) {
    if (!this.configured()) {
      if (manual) toast('Activa la copia en la nube en Ajustes');
      return;
    }
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    setSyncState('busy');
    try {
      const pass = Settings.get('passphrase');
      let id = Settings.get('gistId');
      if (!id) { id = await Gist.find(); if (id) Settings.set('gistId', id); }
      let needPush = true;
      if (id) {
        let text = null;
        try { text = await Gist.read(id); }
        catch (e) { if (e.notFound) { Settings.set('gistId', ''); id = null; } else throw e; }
        if (text) {
          const data = await Crypto.decrypt(text, pass);
          const res = await mergeItems(data.items || []);
          needPush = res.localNewer;
          if (res.pulled) { render(); if (manual) toast(`${res.pulled} cambios recibidos`); }
        }
      }
      if (needPush) {
        const content = await Crypto.encrypt(payload(), pass);
        if (id) await Gist.update(id, content);
        else { id = await Gist.create(content); Settings.set('gistId', id); }
      }
      Settings.set('lastSync', String(Date.now()));
      setSyncState('ok');
      if (manual) toast('Copia sincronizada ✓');
      if (tab === 'settings') render();
    } catch (e) {
      setSyncState('error');
      toast(e.message, 4000);
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.schedule(); }
    }
  }
};
function setSyncState(s) {
  const d = $('#sync-dot');
  d.className = 'dot ' + (s || '');
  d.title = { ok: 'Copia al día', busy: 'Sincronizando…', error: 'Error al sincronizar' }[s] || 'Sin copia en la nube';
}

/* ---------- Copia manual en archivo ---------- */
async function exportBackup() {
  const pass = Settings.get('passphrase');
  const text = pass ? await Crypto.encrypt(payload(), pass) : JSON.stringify(payload());
  const name = `mis-pelis-${localToday()}${pass ? '-cifrada' : ''}.json`;
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Copia de Mis Pelis' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importBackup(file) {
  const text = await file.text();
  let pass = Settings.get('passphrase');
  if (Crypto.isEncrypted(text) && !pass) {
    pass = prompt('Esta copia está cifrada. Escribe su contraseña:') || '';
    if (!pass) return;
  }
  try {
    const data = await Crypto.decrypt(text, pass);
    if (!Array.isArray(data.items)) throw new Error('El archivo no es una copia de Mis Pelis');
    const res = await mergeItems(data.items);
    toast(`Importado: ${res.pulled} elementos nuevos o actualizados`);
    render();
    if (res.pulled) Sync.schedule();
  } catch (e) { toast(e.message, 4000); }
}

/* ---------- Interfaz ---------- */
let tab = 'seen';
const ui = { seenType: 'all', seenSort: 'date', seenQ: '', pendType: 'all', pendSort: 'added', searchQ: '', results: null, searching: false };
let cur = null; // ficha abierta: { item, isNew, loading }

const STATUS = {
  movie: [['pending', 'Pendiente'], ['seen', 'Vista']],
  tv: [['pending', 'Pendiente'], ['watching', 'Viendo'], ['seen', 'Terminada'], ['dropped', 'Abandonada']]
};
const statusLabel = it => (STATUS[it.type].find(s => s[0] === it.status) || [, ''])[1];
const clampRating = v => Math.min(10, Math.max(1, Math.round(v * 10) / 10));
const fmtRating = v => (Math.round(v * 10) / 10).toFixed(1);
const ratingValHtml = v => v != null ? `${fmtRating(v)}<small>/10</small>` : '–<small>sin nota</small>';
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? -1 : n; };

function posterHtml(path, cls = 'poster', size = 'w185') {
  return path
    ? `<img class="${cls}" src="${IMG}${size}${esc(path)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="${cls}">🎞️</div>`;
}
function scoresHtml(r = {}) {
  const p = [];
  if (r.imdb) p.push(`<span class="imdb">IMDb <b>${esc(r.imdb)}</b></span>`);
  if (r.rt) p.push(`<span class="rt">🍅 <b>${esc(r.rt)}</b></span>`);
  if (r.mc) p.push(`<span class="mc">MC <b>${esc(r.mc)}</b></span>`);
  if (!p.length && r.tmdb) p.push(`<span class="tmdb">TMDb <b>${esc(r.tmdb)}</b></span>`);
  return `<div class="scores">${p.join('')}</div>`;
}
function cardHtml(it, mode) {
  const badges = [];
  if (it.type === 'tv') badges.push('<span class="badge tv">Serie</span>');
  if (it.status === 'watching') badges.push('<span class="badge watching">Viendo</span>');
  if (it.status === 'dropped') badges.push('<span class="badge dropped">Abandonada</span>');
  const meta = mode === 'seen'
    ? (it.seenDate ? fmtDate(it.seenDate) : '')
    : (it.comment ? esc(it.comment.slice(0, 60)) : '');
  const right = mode === 'seen'
    ? `<div class="mine">${it.myRating != null ? fmtRating(it.myRating) : '–'}<small>tu nota</small></div>` : '';
  return `<button class="card" data-act="open" data-id="${esc(it.id)}">
    ${posterHtml(it.poster)}
    <div class="info">
      <div class="t">${esc(it.title)} <span class="small">${esc(it.year)}</span></div>
      <div class="meta">${badges.join('')}${meta}</div>
      ${scoresHtml(it.ratings)}
    </div>${right}</button>`;
}
function chipsHtml(key, val) {
  return `<div class="chips">${[['all', 'Todo'], ['movie', 'Pelis'], ['tv', 'Series']]
    .map(([v, l]) => `<button class="chip ${val === v ? 'on' : ''}" data-act="filter" data-key="${key}" data-val="${v}">${l}</button>`).join('')}</div>`;
}
function emptyHtml(icon, text) { return `<div class="empty"><div class="big">${icon}</div>${text}</div>`; }

function seenList() {
  const q = ui.seenQ.trim().toLowerCase();
  let list = alive().filter(i => i.status !== 'pending');
  if (ui.seenType !== 'all') list = list.filter(i => i.type === ui.seenType);
  if (q) list = list.filter(i => (i.title + ' ' + i.originalTitle + ' ' + (i.comment || '')).toLowerCase().includes(q));
  const by = {
    date: (a, b) => (b.seenDate || '').localeCompare(a.seenDate || '') || b.updatedAt - a.updatedAt,
    mine: (a, b) => (b.myRating ?? -1) - (a.myRating ?? -1),
    imdb: (a, b) => num(b.ratings?.imdb) - num(a.ratings?.imdb),
    title: (a, b) => a.title.localeCompare(b.title, 'es')
  }[ui.seenSort];
  return list.sort(by);
}
function pendingList() {
  let list = alive().filter(i => i.status === 'pending');
  if (ui.pendType !== 'all') list = list.filter(i => i.type === ui.pendType);
  const by = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    imdb: (a, b) => num(b.ratings?.imdb) - num(a.ratings?.imdb),
    rt: (a, b) => num(b.ratings?.rt) - num(a.ratings?.rt),
    title: (a, b) => a.title.localeCompare(b.title, 'es')
  }[ui.pendSort];
  return list.sort(by);
}

function renderSeenList() {
  const list = seenList();
  return list.length
    ? `<div class="list">${list.map(i => cardHtml(i, 'seen')).join('')}</div>`
    : emptyHtml('🎬', alive().some(i => i.status !== 'pending')
      ? 'Nada coincide con el filtro.'
      : 'Aún no has apuntado nada.<br>Ve a <b>Buscar</b> y añade la última película que viste.');
}
function renderSeen() {
  const seen = alive().filter(i => i.status !== 'pending');
  const year = String(new Date().getFullYear());
  const rated = seen.filter(i => i.myRating);
  const avg = rated.length ? (rated.reduce((s, i) => s + i.myRating, 0) / rated.length).toFixed(1) : '–';
  const nMovies = seen.filter(i => i.type === 'movie').length;
  const nTv = seen.filter(i => i.type === 'tv').length;
  return `
    <div class="stats"><b>${nMovies}</b> ${nMovies === 1 ? 'peli' : 'pelis'} ·
      <b>${nTv}</b> ${nTv === 1 ? 'serie' : 'series'} ·
      <b>${seen.filter(i => (i.seenDate || '').startsWith(year)).length}</b> en ${year} ·
      tu media <b>${avg}</b></div>
    <div class="controls">
      ${chipsHtml('seenType', ui.seenType)}
      <select data-act="sort" data-key="seenSort">
        ${[['date', 'Más recientes'], ['mine', 'Mi nota'], ['imdb', 'Nota IMDb'], ['title', 'Título']]
          .map(([v, l]) => `<option value="${v}" ${ui.seenSort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input type="search" id="seen-q" placeholder="Filtrar por título o comentario" value="${esc(ui.seenQ)}">
    </div>
    <div id="list">${renderSeenList()}</div>`;
}
function renderPending() {
  const list = pendingList();
  return `
    <div class="controls">
      ${chipsHtml('pendType', ui.pendType)}
      <select data-act="sort" data-key="pendSort">
        ${[['added', 'Añadidas recientemente'], ['imdb', 'Nota IMDb'], ['rt', 'Rotten Tomatoes'], ['title', 'Título']]
          .map(([v, l]) => `<option value="${v}" ${ui.pendSort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${list.length
      ? `<div class="list">${list.map(i => cardHtml(i, 'pending')).join('')}</div>`
      : emptyHtml('🕒', 'No tienes nada pendiente.<br>Busca una peli y pulsa <b>Pendiente</b>.')}`;
}
function renderSearch() {
  let body = '';
  if (ui.searching) body = '<div class="spinner">Buscando…</div>';
  else if (ui.results && !ui.results.length) body = emptyHtml('🤷', 'Sin resultados.');
  else if (ui.results) {
    body = `<div class="list">${ui.results.map(r => {
      const id = `${r.media_type}:${r.id}`;
      const mine = items.get(id);
      const tag = mine && !mine.deleted
        ? `<span class="badge ${mine.status === 'pending' ? '' : 'watching'}">${mine.status === 'pending' ? 'Pendiente' : '✓ ' + statusLabel(mine)}</span>` : '';
      const year = (r.release_date || r.first_air_date || '').slice(0, 4);
      return `<button class="card" data-act="open-result" data-type="${r.media_type}" data-tmdb="${r.id}">
        ${posterHtml(r.poster_path)}
        <div class="info">
          <div class="t">${esc(r.title || r.name)} <span class="small">${esc(year)}</span></div>
          <div class="meta">${r.media_type === 'tv' ? '<span class="badge tv">Serie</span>' : ''}${tag}</div>
          ${r.vote_average ? `<div class="scores"><span class="tmdb">TMDb <b>${(Math.round(r.vote_average * 10) / 10)}</b></span></div>` : ''}
        </div></button>`;
    }).join('')}</div>`;
  } else body = emptyHtml('🔍', 'Busca una película o serie por su título.');
  const noKey = !Settings.get('tmdbKey') ? `<div class="set"><p>⚠️ Primero pon tu clave de TMDb en <b>Ajustes</b>.</p></div>` : '';
  return `${noKey}
    <form id="search-form" class="row" style="margin-bottom:12px">
      <input type="search" id="search-q" class="grow" placeholder="Ej: El club de la lucha" value="${esc(ui.searchQ)}" enterkeyhint="search" autocomplete="off">
      <button class="btn primary">Buscar</button>
    </form>${body}`;
}
function renderSettings() {
  const last = +Settings.get('lastSync') || 0;
  const syncOn = Sync.configured();
  const total = alive().length;
  return `
    <div class="set">
      <h3>🔑 Claves de las bases de datos</h3>
      <p>Se guardan solo en este dispositivo. Son gratuitas: <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">TMDb</a> (búsqueda, pósters) y <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">OMDb</a> (notas de IMDb, Rotten Tomatoes y Metacritic).</p>
      <label>Clave de TMDb (API Key o token de lectura)</label>
      <input type="password" id="k-tmdb" value="${esc(Settings.get('tmdbKey'))}" autocomplete="off">
      <label>Clave de OMDb</label>
      <input type="password" id="k-omdb" value="${esc(Settings.get('omdbKey'))}" autocomplete="off">
      <button class="btn primary block" data-act="save-keys">Guardar claves</button>
    </div>

    <div class="set">
      <h3>☁️ Copia cifrada y sincronización</h3>
      <p>Tu lista se cifra en el dispositivo con tu contraseña y se guarda en un Gist secreto de tu cuenta de GitHub. GitHub solo ve datos ilegibles. Así no la pierdes y la tienes igual en el iPhone y en el ordenador.</p>
      <label>Token de GitHub (solo permiso "gist")</label>
      <input type="password" id="k-gh" value="${esc(Settings.get('ghToken'))}" autocomplete="off">
      <label>Contraseña de cifrado (la misma en todos tus dispositivos)</label>
      <input type="password" id="k-pass" value="${esc(Settings.get('passphrase'))}" autocomplete="new-password">
      <p class="small">⚠️ Si olvidas esta contraseña, la copia no se puede recuperar. Apúntala en un sitio seguro.</p>
      <button class="btn primary block" data-act="save-sync">${syncOn ? 'Guardar y sincronizar' : 'Activar copia en la nube'}</button>
      ${syncOn ? `<p class="small" style="margin-top:10px">Última sincronización: ${last ? new Date(last).toLocaleString('es-ES') : 'nunca'}</p>
        <button class="btn block" data-act="sync">Sincronizar ahora</button>
        <button class="btn danger block" data-act="sync-off">Desactivar en este dispositivo</button>` : ''}
    </div>

    <div class="set">
      <h3>💾 Copia en archivo</h3>
      <p>Descarga un archivo con todo (cifrado si tienes contraseña) para guardarlo donde quieras, o recupera uno.</p>
      <div class="row"><button class="btn grow" data-act="export">Exportar</button><button class="btn grow" data-act="import">Importar</button></div>
    </div>

    <p class="small" style="text-align:center">Mis Pelis ${VERSION} · ${total} elementos guardados en este dispositivo<br>
    Datos de películas: TMDb y OMDb. Este producto usa la API de TMDb pero no está avalado ni certificado por TMDb.</p>`;
}

function render() {
  $('#title').textContent = { seen: 'Vistas', pending: 'Pendientes', search: 'Buscar', settings: 'Ajustes' }[tab];
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#view').innerHTML = { seen: renderSeen, pending: renderPending, search: renderSearch, settings: renderSettings }[tab]();
  if (cur) renderSheet();
}

/* ---------- Ficha ---------- */
function renderSheet() {
  const sh = $('#sheet');
  if (!cur) { sh.hidden = true; sh.innerHTML = ''; document.body.style.overflow = ''; return; }
  sh.hidden = false;
  document.body.style.overflow = 'hidden';
  if (cur.loading) {
    sh.innerHTML = `<div class="sheet-in"><div class="sheet-close"><button data-act="close">✕</button></div><div class="spinner">Cargando…</div></div>`;
    return;
  }
  const it = cur.item;
  const r = it.ratings || {};
  const meta = [it.year, it.type === 'tv' ? (it.seasons ? `${it.seasons} temporada${it.seasons > 1 ? 's' : ''}` : 'Serie') : (it.runtime ? `${it.runtime} min` : ''), (it.genres || []).slice(0, 3).join(', ')]
    .filter(Boolean).join(' · ');
  const big = [
    ['imdb', 'IMDb', r.imdb], ['rt', 'Rotten T.', r.rt], ['mc', 'Metacritic', r.mc], ['tmdb', 'TMDb', r.tmdb]
  ].map(([c, l, v]) => `<div class="${c}"><b>${v ? esc(v) : '–'}</b><span>${l}</span></div>`).join('');
  const showSeen = it.status && it.status !== 'pending';
  sh.innerHTML = `<div class="sheet-in">
    <div class="sheet-close"><button data-act="close" aria-label="Cerrar">✕</button></div>
    <div class="hero">
      ${posterHtml(it.poster, 'poster', 'w342')}
      <div>
        <h2>${esc(it.title)}</h2>
        ${it.originalTitle && it.originalTitle !== it.title ? `<div class="orig">${esc(it.originalTitle)}</div>` : ''}
        <div class="meta">${esc(meta)}</div>
        ${r.imdbVotes ? `<div class="small" style="margin-top:6px">${esc(r.imdbVotes)} votos en IMDb</div>` : ''}
      </div>
    </div>
    <div class="bigscores">${big}</div>
    ${it.overview ? `<p class="overview">${esc(it.overview)}</p>` : ''}
    <div class="row" style="justify-content:space-between">
      <span class="small">${r.at ? 'Notas del ' + new Date(r.at).toLocaleDateString('es-ES') : ''}</span>
      <span>
        ${it.imdbId ? `<a class="link" href="https://www.imdb.com/title/${esc(it.imdbId)}/" target="_blank" rel="noopener noreferrer">Ver en IMDb</a> · ` : ''}
        <button class="link" data-act="refresh">Actualizar notas</button>
      </span>
    </div>

    <div class="section">
      <h3>Tu registro</h3>
      <div class="seg">${STATUS[it.type].map(([v, l]) =>
        `<button data-act="status" data-val="${v}" class="${it.status === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${showSeen ? `
        <div class="label">Tu nota</div>
        <div class="rating">
          <button class="step" data-act="rate-step" data-val="-0.1" aria-label="Bajar 0.1">−</button>
          <div class="rating-val" id="rating-val">${ratingValHtml(it.myRating)}</div>
          <button class="step" data-act="rate-step" data-val="0.1" aria-label="Subir 0.1">+</button>
        </div>
        <input type="range" class="slider" id="rating-slider" min="1" max="10" step="0.1" value="${it.myRating ?? 5.5}">
        <div class="row" style="justify-content:space-between">
          <span class="small">Arrastra y afina con − / + (de 0,1 en 0,1)</span>
          ${it.myRating != null ? '<button class="link" data-act="rate-clear">Quitar nota</button>' : ''}
        </div>
        <div class="label">${it.type === 'tv' && it.status === 'watching' ? 'Empezada el' : 'Vista el'}</div>
        <input type="date" data-field="seenDate" value="${esc(it.seenDate || '')}" max="${localToday()}">` : ''}
      <div class="label">Comentario${it.status === 'pending' ? ' (ej.: quién te la recomendó)' : ''}</div>
      <textarea data-field="comment" placeholder="Lo que quieras recordar…">${esc(it.comment || '')}</textarea>
      <div class="actions">
        ${!cur.isNew ? '<button class="btn danger" data-act="delete">Eliminar</button>' : ''}
        <button class="btn primary" data-act="save" ${it.status ? '' : 'disabled'}>${cur.isNew ? 'Añadir' : 'Guardar'}</button>
      </div>
      ${cur.isNew && !it.status ? '<p class="small" style="margin-top:8px">Elige primero si ya la has visto o si la dejas pendiente.</p>' : ''}
    </div>
  </div>`;
}

async function openItem(id) {
  const stored = items.get(id);
  cur = { item: structuredClone(stored), isNew: false };
  renderSheet();
  $('#sheet').scrollTop = 0;
  // Si las notas tienen más de 30 días, se actualizan solas
  if (!stored.ratings?.at || Date.now() - stored.ratings.at > 30 * 864e5) refreshRatings(true);
}
async function openResult(type, tmdbId) {
  const id = `${type}:${tmdbId}`;
  const stored = items.get(id);
  if (stored && !stored.deleted) return openItem(id);
  cur = { loading: true };
  renderSheet();
  try {
    const info = await fetchInfo(type, tmdbId);
    if (!cur) return; // cerrada mientras cargaba
    cur = { item: { ...info, status: null, myRating: null, seenDate: '', comment: '', addedAt: null }, isNew: true };
    renderSheet();
    $('#sheet').scrollTop = 0;
  } catch (e) {
    cur = null; renderSheet(); toast(e.message, 4000);
  }
}
async function refreshRatings(silent = false) {
  if (!cur || !cur.item) return;
  const it = cur.item;
  try {
    const info = await fetchInfo(it.type, it.tmdbId);
    if (!cur || cur.item.id !== it.id) return;
    // Actualiza datos de la película sin tocar lo que has escrito tú
    const keep = { status: it.status, myRating: it.myRating, seenDate: it.seenDate, comment: it.comment, addedAt: it.addedAt };
    Object.assign(cur.item, info, keep);
    if (!cur.isNew) {
      const stored = items.get(it.id);
      Object.assign(stored, info);
      await saveItem(stored);
      if (!$('#sheet').hidden) render();
    }
    renderSheet();
    if (!silent) toast('Notas actualizadas');
  } catch (e) { if (!silent) toast(e.message, 4000); }
}
async function saveSheet() {
  const it = cur.item;
  if (!it.status) return toast('Elige un estado');
  if (it.status !== 'pending' && !it.seenDate) it.seenDate = localToday();
  if (it.status === 'pending') { it.myRating = null; it.seenDate = ''; }
  if (!it.addedAt) it.addedAt = Date.now();
  it.deleted = false;
  const wasNew = cur.isNew;
  await saveItem(it);
  cur = null;
  renderSheet();
  render();
  toast(wasNew ? (it.status === 'pending' ? 'Añadida a pendientes' : 'Añadida a tus vistas') : 'Guardado');
}
async function deleteSheet() {
  const it = cur.item;
  if (!confirm(`¿Eliminar "${it.title}" de tu lista?`)) return;
  const tomb = { id: it.id, tmdbId: it.tmdbId, type: it.type, title: it.title, deleted: true };
  await saveItem(tomb);
  cur = null;
  renderSheet();
  render();
  toast('Eliminada');
}

/* ---------- Eventos ---------- */
document.addEventListener('click', async e => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    render();
    window.scrollTo(0, 0);
    if (tab === 'search' && !ui.results) setTimeout(() => $('#search-q')?.focus(), 50);
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case 'open': return openItem(el.dataset.id);
    case 'open-result': return openResult(el.dataset.type, +el.dataset.tmdb);
    case 'close': cur = null; return renderSheet();
    case 'filter': ui[el.dataset.key] = el.dataset.val; return render();
    case 'status':
      cur.item.status = el.dataset.val;
      if (cur.item.status !== 'pending' && !cur.item.seenDate) cur.item.seenDate = localToday();
      return renderSheet();
    case 'rate-step': {
      const base = cur.item.myRating ?? 5.5;
      cur.item.myRating = clampRating(base + +el.dataset.val);
      return renderSheet();
    }
    case 'rate-clear':
      cur.item.myRating = null;
      return renderSheet();
    case 'refresh': return refreshRatings(false);
    case 'save': return saveSheet();
    case 'delete': return deleteSheet();
    case 'sync': return Sync.run(true);
    case 'save-keys':
      Settings.set('tmdbKey', $('#k-tmdb').value.trim());
      Settings.set('omdbKey', $('#k-omdb').value.trim());
      toast('Claves guardadas en este dispositivo');
      return render();
    case 'save-sync': {
      const t = $('#k-gh').value.trim();
      const p = $('#k-pass').value;
      if (!t || !p) return toast('Pon el token y la contraseña');
      if (p.length < 8) return toast('Usa una contraseña de al menos 8 caracteres');
      if (p !== Settings.get('passphrase')) Settings.set('gistId', '');
      Settings.set('ghToken', t);
      Settings.set('passphrase', p);
      render();
      return Sync.run(true);
    }
    case 'sync-off':
      if (!confirm('¿Desactivar la copia en este dispositivo? Tus datos locales no se borran.')) return;
      ['ghToken', 'passphrase', 'gistId', 'lastSync'].forEach(k => Settings.set(k, ''));
      setSyncState('');
      return render();
    case 'export': return exportBackup();
    case 'import': return $('#import-file').click();
  }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.act === 'sort') { ui[el.dataset.key] = el.value; render(); }
  if (el.id === 'rating-slider' && cur) renderSheet();
  if (el.id === 'import-file' && el.files[0]) { importBackup(el.files[0]); el.value = ''; }
});

document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'seen-q') { ui.seenQ = el.value; $('#list').innerHTML = renderSeenList(); }
  if (el.id === 'search-q') ui.searchQ = el.value;
  if (el.id === 'rating-slider' && cur && cur.item) {
    // Mientras arrastras solo se actualiza el número (para no cortar el gesto)
    cur.item.myRating = clampRating(+el.value);
    $('#rating-val').innerHTML = ratingValHtml(cur.item.myRating);
  }
  if (el.dataset.field && cur && cur.item) cur.item[el.dataset.field] = el.value;
});

document.addEventListener('submit', async e => {
  if (e.target.id !== 'search-form') return;
  e.preventDefault();
  const q = ui.searchQ.trim();
  if (!q) return;
  $('#search-q').blur();
  ui.searching = true; render();
  try { ui.results = await Api.search(q); }
  catch (err) { ui.results = null; toast(err.message, 4000); }
  ui.searching = false;
  if (tab === 'search') render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - (+Settings.get('lastSync') || 0) > 60000) Sync.run();
});

/* ---------- Arranque ---------- */
(async function start() {
  try {
    await DB.open();
    (await DB.all()).forEach(i => items.set(i.id, i));
  } catch (e) {
    toast('No se pudo abrir la base de datos local: ' + e.message, 6000);
  }
  if (!Settings.get('tmdbKey')) tab = 'settings';
  render();
  setSyncState(Sync.configured() ? '' : '');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (Sync.configured()) Sync.run();
})();
