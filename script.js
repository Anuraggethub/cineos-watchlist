/* ============================================================
   CINE//OS — script.js
   State machine + render engine + decision layer
   ============================================================ */

/* ---- STORAGE ---- */
const STORAGE_KEY = 'cineos_v1';

const Storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  },
  save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {}
  }
};

/* ---- STATE ---- */
const State = {
  data: [],         // master list
  filtered: [],     // current view
  selected: null,   // selected row id
  activeFilter: 'all',
  activeType: 'all',
  activePriority: null,
  sortCol: 'position',
  sortDir: 'asc',
  searchQuery: '',
  currentView: 'watchlist',

  init() {
    const saved = Storage.load();
    if (saved && saved.length > 0) {
      this.data = saved;
    } else {
      // Seed from CSV data
      this.data = SEED_DATA.map(d => ({ ...d }));
      Storage.save(this.data);
    }
    this.filtered = [...this.data];
  },

  save() {
    Storage.save(this.data);
  },

  getById(id) {
    return this.data.find(d => d.id === id);
  },

  update(id, changes) {
    const idx = this.data.findIndex(d => d.id === id);
    if (idx === -1) return;
    this.data[idx] = { ...this.data[idx], ...changes };
    this.save();
    this.applyFilter();
    renderTable();
    updateStats();
  },

  add(entry) {
    this.data.unshift(entry);
    this.save();
    this.applyFilter();
    renderTable();
    updateStats();
  },

  remove(id) {
    this.data = this.data.filter(d => d.id !== id);
    this.save();
    this.applyFilter();
    renderTable();
    updateStats();
    if (this.selected === id) {
      this.selected = null;
      closePanel();
    }
  },

  applyFilter() {
    let list = [...this.data];

    // search
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      list = list.filter(d =>
        d.title.toLowerCase().includes(q) ||
        (d.directors || '').toLowerCase().includes(q) ||
        d.genres.some(g => g.toLowerCase().includes(q))
      );
    }

    // status filter
    if (this.activeFilter !== 'all') {
      list = list.filter(d => d.status === this.activeFilter);
    }

    // type filter
    if (this.activeType !== 'all') {
      list = list.filter(d => d.type === this.activeType);
    }

    // priority filter
    if (this.activePriority) {
      list = list.filter(d => d.priority === this.activePriority);
    }

    // sort
    list = sortList(list, this.sortCol, this.sortDir);

    this.filtered = list;
  }
};

/* ---- SORT ENGINE ---- */
function sortList(list, col, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let av = a[col], bv = b[col];
    if (col === 'priority') {
      const rank = { '🔥': 0, '⚡': 1, '●': 2, null: 3, undefined: 3 };
      return (rank[av] ?? 3) - (rank[bv] ?? 3);
    }
    if (col.includes('-')) {
      const [field, d2] = col.split('-');
      av = a[field]; bv = b[field];
      const m2 = d2 === 'asc' ? 1 : -1;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av < bv ? -m2 : av > bv ? m2 : 0;
    }
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * mult;
    return (av - bv) * mult;
  });
}

/* ---- DECISION ENGINE ---- */
function getFlag(entry) {
  if (entry.status === 'watched') return '';
  const r = entry.imdbRating;
  if (!r) return '';
  if (r >= 9.0) return '🏆';    // All-time great
  if (r >= 8.5) return '🔥';    // Top tier
  if (r >= 8.0) return '⭐';    // Strong pick
  if (r < 5.5) return '⚠️';     // Low rated
  if (r < 4.5) return '🔻';     // Skip candidate
  return '';
}

function getDecision(entry) {
  if (entry.status === 'watched') return { label: '✓ WATCHED', cls: 'decision-queue' };
  if (entry.status === 'watching') return { label: '▶ NOW WATCHING', cls: 'decision-watchnow' };
  if (entry.status === 'dropped') return { label: '✕ DROPPED', cls: 'decision-skip' };

  const r = entry.imdbRating || 0;
  const runtime = entry.runtime || 120;
  const pri = entry.priority;

  if (pri === '🔥') return { label: '🔥 MUST WATCH NEXT', cls: 'decision-watchnow' };
  if (r >= 8.5) return { label: '⭐ WATCH SOON', cls: 'decision-watchnow' };
  if (r >= 7.5 && runtime <= 120) return { label: '✓ GOOD PICK', cls: 'decision-queue' };
  if (r < 5.5) return { label: '⚠ SKIP CANDIDATE', cls: 'decision-skip' };
  return { label: '● QUEUE IT', cls: 'decision-anytime' };
}

function getTonightPick() {
  const candidates = State.data.filter(d => d.status === 'unwatched' || d.status === 'watching');
  if (!candidates.length) return null;

  // Score: IMDb × priority boost × short runtime bonus
  const priBump = { '🔥': 3, '⚡': 1.5, '●': 0.5, null: 0 };
  const scored = candidates.map(d => {
    let score = (d.imdbRating || 6) * 10;
    score += priBump[d.priority] || 0;
    if (d.status === 'watching') score += 15;                // continue watching bonus
    if (d.runtime && d.runtime <= 100) score += 5;          // short film bonus
    if (d.runtime && d.runtime > 160) score -= 3;           // long film slight penalty
    return { entry: d, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const pick = scored[0].entry;
  let reason = '';
  if (pick.status === 'watching') reason = 'You\'re already watching this — finish it tonight.';
  else if (pick.imdbRating >= 9.0) reason = `IMDb ${pick.imdbRating} — one of the highest rated titles in your list. A rare pick.`;
  else if (pick.imdbRating >= 8.5) reason = `IMDb ${pick.imdbRating} — top-tier pick. Strong critical consensus, worth your time.`;
  else if (pick.priority === '🔥') reason = 'You flagged this as must-watch. Trust your past self.';
  else reason = `IMDb ${pick.imdbRating || '?'} — solid queue pick based on your ratings.`;

  return { pick, reason };
}

/* ---- RATING COLORS ---- */
function ratingClass(r) {
  if (r == null) return 'rating-none';
  if (r >= 8.0) return 'rating-high';
  if (r >= 6.5) return 'rating-mid';
  return 'rating-low';
}

function formatRuntime(mins) {
  if (!mins) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/* ---- TABLE RENDER ---- */
function renderTable() {
  const tbody = document.getElementById('table-body');
  const list = State.filtered;

  document.getElementById('result-count').textContent = `${list.length} entr${list.length !== 1 ? 'ies' : 'y'}`;

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">◈</div><div class="empty-text">NO ENTRIES MATCH FILTERS</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(d => {
    const flag = getFlag(d);
    const ratingCls = ratingClass(d.imdbRating);
    const myRating = d.yourRating != null
      ? `<span class="my-rating-display" data-id="${d.id}" title="Click to edit">${d.yourRating}</span>`
      : `<span class="my-rating-display empty" data-id="${d.id}" title="Click to rate">—</span>`;

    const genreTags = (d.genres || []).slice(0, 2).map(g =>
      `<span class="genre-tag">${g}</span>`
    ).join('');

    const isSelected = State.selected === d.id;

    return `<tr data-id="${d.id}" class="${isSelected ? 'selected' : ''}">
      <td class="priority-cell">${d.priority || '·'}</td>
      <td class="td-title" title="${d.title}">
        ${d.url ? `<a href="${d.url}" target="_blank" onclick="event.stopPropagation()">${d.title}</a>` : d.title}
      </td>
      <td><span class="type-badge">${d.type === 'TV Mini Series' ? 'Mini' : d.type === 'TV Series' ? 'TV' : d.type}</span></td>
      <td style="color:var(--text-secondary);font-size:11px">${d.year || '—'}</td>
      <td><span class="rating-pill ${ratingCls}">${d.imdbRating != null ? d.imdbRating.toFixed(1) : '—'}</span></td>
      <td class="runtime-cell">${formatRuntime(d.runtime)}</td>
      <td><div class="genre-tags">${genreTags}</div></td>
      <td><span class="status-badge status-${d.status}">${d.status}</span></td>
      <td class="my-rating-cell">${myRating}</td>
      <td class="flag-cell">${flag}</td>
    </tr>`;
  }).join('');

  // Inline rating click handlers
  tbody.querySelectorAll('.my-rating-display').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineRatingEdit(el);
    });
  });

  // Row click → detail panel
  tbody.querySelectorAll('tr[data-id]').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      State.selected = id;
      openPanel(id);
      renderTable(); // re-highlight
    });
  });
}

/* ---- INLINE RATING EDIT ---- */
function startInlineRatingEdit(el) {
  const id = el.dataset.id;
  const entry = State.getById(id);
  const current = entry?.yourRating ?? '';

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'my-rating-input';
  input.value = current;
  input.min = 1;
  input.max = 10;
  input.step = 0.5;

  el.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val >= 1 && val <= 10) {
      State.update(id, {
        yourRating: val,
        status: entry.status === 'unwatched' ? 'watched' : entry.status
      });
      toast('Rating saved ✓', 'success');
    } else {
      renderTable();
    }
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); renderTable(); }
  });
}

/* ---- DETAIL PANEL ---- */
function openPanel(id) {
  const entry = State.getById(id);
  if (!entry) return;

  document.getElementById('panel-title').textContent = entry.title;
  document.getElementById('app').classList.remove('panel-hidden');

  const dec = getDecision(entry);
  const flag = getFlag(entry);

  const genreHTML = (entry.genres || []).map(g => `<span class="genre-tag">${g}</span>`).join('');
  const priOptions = ['🔥', '⚡', '●', null];
  const priHTML = priOptions.map(p => {
    const lbl = p === null ? '— None' : ({ '🔥': '🔥 Must Watch', '⚡': '⚡ High', '●': '● Normal' })[p];
    return `<button class="pri-opt ${entry.priority === p ? 'selected' : ''}" data-pri="${p === null ? '' : p}">${lbl}</button>`;
  }).join('');

  document.getElementById('panel-body').innerHTML = `
    <div class="panel-section">
      <div class="decision-badge ${dec.cls}">${flag ? flag + ' ' : ''}${dec.label}</div>
    </div>

    <div class="panel-section">
      <div class="panel-section-title">DETAILS</div>
      <div class="panel-meta-grid">
        <div class="panel-meta-item">
          <span class="pmi-label">TYPE</span>
          <span class="pmi-value">${entry.type}</span>
        </div>
        <div class="panel-meta-item">
          <span class="pmi-label">YEAR</span>
          <span class="pmi-value">${entry.year || '—'}</span>
        </div>
        <div class="panel-meta-item">
          <span class="pmi-label">IMDb RATING</span>
          <span class="pmi-value accent">${entry.imdbRating != null ? entry.imdbRating.toFixed(1) + ' / 10' : '—'}</span>
        </div>
        <div class="panel-meta-item">
          <span class="pmi-label">RUNTIME</span>
          <span class="pmi-value">${formatRuntime(entry.runtime)}</span>
        </div>
        <div class="panel-meta-item">
          <span class="pmi-label">DIRECTOR</span>
          <span class="pmi-value" style="font-size:12px">${entry.directors || '—'}</span>
        </div>
        <div class="panel-meta-item">
          <span class="pmi-label">YOUR RATING</span>
          <span class="pmi-value accent">${entry.yourRating != null ? entry.yourRating + ' / 10' : '—'}</span>
        </div>
      </div>
      ${genreHTML ? `<div class="genre-tags" style="margin-top:10px;flex-wrap:wrap;gap:4px">${genreHTML}</div>` : ''}
      ${entry.url ? `<div style="margin-top:12px"><a class="imdb-link" href="${entry.url}" target="_blank">↗ Open on IMDb</a></div>` : ''}
    </div>

    <div class="panel-section">
      <div class="panel-section-title">PRIORITY</div>
      <div class="priority-selector">${priHTML}</div>
    </div>

    <div class="panel-section">
      <div class="panel-section-title">STATUS</div>
      <div class="panel-actions" id="status-actions">
        <button class="panel-btn ${entry.status === 'unwatched' ? 'active-state' : ''}" data-status="unwatched">Queue</button>
        <button class="panel-btn ${entry.status === 'watching' ? 'active-state' : ''}" data-status="watching">Watching</button>
        <button class="panel-btn success ${entry.status === 'watched' ? 'active-state' : ''}" data-status="watched">Watched</button>
        <button class="panel-btn danger ${entry.status === 'dropped' ? 'active-state' : ''}" data-status="dropped">Dropped</button>
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-section-title">NOTES / WHY WATCH</div>
      <textarea class="notes-area" id="panel-notes" placeholder="What made you add this? What are you expecting?">${entry.notes || ''}</textarea>
      <button class="notes-save-btn" id="notes-save">SAVE NOTE</button>
    </div>

    <div class="panel-section">
      <div class="panel-section-title">DANGER ZONE</div>
      <button class="panel-btn danger" id="delete-btn" style="width:100%">✕ REMOVE FROM LIST</button>
    </div>
  `;

  // Priority buttons
  document.querySelectorAll('.pri-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.pri || null;
      State.update(id, { priority: val });
      openPanel(id);
      toast('Priority updated', 'success');
    });
  });

  // Status buttons
  document.querySelectorAll('#status-actions .panel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      State.update(id, { status: btn.dataset.status });
      openPanel(id);
      toast(`Marked as ${btn.dataset.status}`, 'success');
    });
  });

  // Notes save
  document.getElementById('notes-save').addEventListener('click', () => {
    const notes = document.getElementById('panel-notes').value;
    State.update(id, { notes });
    toast('Note saved ✓', 'success');
  });

  // Delete
  document.getElementById('delete-btn').addEventListener('click', () => {
    if (confirm(`Remove "${entry.title}" from your list?`)) {
      State.remove(id);
      toast('Entry removed', 'error');
    }
  });
}

function closePanel() {
  document.getElementById('app').classList.add('panel-hidden');
  State.selected = null;
  renderTable();
}

/* ---- STATS ---- */
function updateStats() {
  const total = State.data.length;
  const watched = State.data.filter(d => d.status === 'watched').length;
  const unwatched = State.data.filter(d => d.status === 'unwatched' || d.status === 'watching').length;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-unwatched').textContent = unwatched;
  document.getElementById('stat-watched').textContent = watched;
}

/* ---- ANALYTICS ---- */
function renderAnalytics() {
  renderRatingChart();
  renderGenreChart();
  renderTypeChart();
  renderTopRated();
  renderDecadeChart();
  renderRuntimeChart();
}

function renderRatingChart() {
  const buckets = { '9+': 0, '8–9': 0, '7–8': 0, '6–7': 0, '<6': 0 };
  State.data.forEach(d => {
    const r = d.imdbRating;
    if (r == null) return;
    if (r >= 9) buckets['9+']++;
    else if (r >= 8) buckets['8–9']++;
    else if (r >= 7) buckets['7–8']++;
    else if (r >= 6) buckets['6–7']++;
    else buckets['<6']++;
  });
  const max = Math.max(...Object.values(buckets), 1);
  const colors = { '9+': 'teal', '8–9': 'amber', '7–8': 'amber', '6–7': 'blue', '<6': 'red' };
  document.getElementById('chart-ratings').innerHTML = `<div class="bar-chart">${
    Object.entries(buckets).map(([k, v]) =>
      `<div class="bar-row">
        <span class="bar-label">${k}</span>
        <div class="bar-track"><div class="bar-fill ${colors[k]}" style="width:${Math.round(v/max*100)}%"></div></div>
        <span class="bar-val">${v}</span>
      </div>`
    ).join('')
  }</div>`;
}

function renderGenreChart() {
  const counts = {};
  State.data.forEach(d => {
    (d.genres || []).forEach(g => { counts[g] = (counts[g] || 0) + 1; });
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = sorted[0]?.[1] || 1;
  const colorCycle = ['amber', 'teal', 'blue', 'amber', 'teal', 'blue', 'amber', 'teal'];
  document.getElementById('chart-genres').innerHTML = `<div class="bar-chart">${
    sorted.map(([k, v], i) =>
      `<div class="bar-row">
        <span class="bar-label">${k}</span>
        <div class="bar-track"><div class="bar-fill ${colorCycle[i % colorCycle.length]}" style="width:${Math.round(v/max*100)}%"></div></div>
        <span class="bar-val">${v}</span>
      </div>`
    ).join('')
  }</div>`;
}

function renderTypeChart() {
  const counts = {};
  State.data.forEach(d => { counts[d.type] = (counts[d.type] || 0) + 1; });
  const total = State.data.length;
  const colors = ['#F5A623', '#00C9B1', '#4D9EFF', '#FF4D5E'];
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  // Simple donut via SVG
  let offset = 0;
  const r = 50, cx = 55, cy = 55, circ = 2 * Math.PI * r;
  const slices = entries.map(([k, v], i) => {
    const pct = v / total;
    const dash = circ * pct;
    const s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="16"
      stroke-dasharray="${dash} ${circ - dash}" stroke-dashoffset="${-offset * circ / (2 * Math.PI)}"
      transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += pct * 2 * Math.PI * r;
    return s;
  });

  const legend = entries.map(([k, v], i) =>
    `<div class="legend-item"><span class="legend-dot" style="background:${colors[i % colors.length]}"></span>${k.replace('TV Mini Series', 'Mini').replace('TV Series', 'TV')} (${v})</div>`
  ).join('');

  document.getElementById('chart-types').innerHTML = `
    <div class="donut-wrap">
      <svg width="110" height="110" class="donut-svg">${slices.join('')}</svg>
      <div class="donut-legend">${legend}</div>
    </div>`;
}

function renderTopRated() {
  const unwatched = State.data
    .filter(d => d.status === 'unwatched' && d.imdbRating != null)
    .sort((a, b) => b.imdbRating - a.imdbRating)
    .slice(0, 8);

  document.getElementById('chart-toprated').innerHTML = `<div class="top-list">${
    unwatched.map((d, i) =>
      `<div class="top-item">
        <span class="top-rank">${i + 1}</span>
        <span class="top-name" title="${d.title}">${d.title}</span>
        <span class="top-rating">${d.imdbRating.toFixed(1)}</span>
      </div>`
    ).join('')
  }</div>`;
}

function renderDecadeChart() {
  const decades = {};
  State.data.forEach(d => {
    if (!d.year) return;
    const dec = Math.floor(d.year / 10) * 10;
    decades[dec] = (decades[dec] || 0) + 1;
  });
  const sorted = Object.entries(decades).sort((a, b) => a[0] - b[0]);
  const max = Math.max(...sorted.map(s => s[1]), 1);
  document.getElementById('chart-decades').innerHTML = `<div class="bar-chart">${
    sorted.map(([k, v]) =>
      `<div class="bar-row">
        <span class="bar-label">${k}s</span>
        <div class="bar-track"><div class="bar-fill blue" style="width:${Math.round(v/max*100)}%"></div></div>
        <span class="bar-val">${v}</span>
      </div>`
    ).join('')
  }</div>`;
}

function renderRuntimeChart() {
  const buckets = { '<90m': 0, '90–120m': 0, '2–3h': 0, '3h+': 0, 'Unknown': 0 };
  State.data.forEach(d => {
    const r = d.runtime;
    if (!r) { buckets['Unknown']++; return; }
    if (r < 90) buckets['<90m']++;
    else if (r <= 120) buckets['90–120m']++;
    else if (r <= 180) buckets['2–3h']++;
    else buckets['3h+']++;
  });
  const max = Math.max(...Object.values(buckets), 1);
  const colors = { '<90m': 'teal', '90–120m': 'amber', '2–3h': 'amber', '3h+': 'red', 'Unknown': 'blue' };
  document.getElementById('chart-runtime').innerHTML = `<div class="bar-chart">${
    Object.entries(buckets).map(([k, v]) =>
      `<div class="bar-row">
        <span class="bar-label">${k}</span>
        <div class="bar-track"><div class="bar-fill ${colors[k]}" style="width:${Math.round(v/max*100)}%"></div></div>
        <span class="bar-val">${v}</span>
      </div>`
    ).join('')
  }</div>`;
}

/* ---- TONIGHT MODAL ---- */
document.getElementById('tonight-btn').addEventListener('click', () => {
  const modal = document.getElementById('tonight-modal');
  modal.classList.remove('hidden');

  setTimeout(() => {
    const result = getTonightPick();
    if (!result) {
      document.getElementById('modal-body').innerHTML = '<div class="modal-loading">Queue is empty — add more titles.</div>';
      return;
    }
    const { pick, reason } = result;
    const genreHTML = pick.genres.slice(0, 3).map(g => `<span class="tp-badge">${g}</span>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <div class="tonight-pick">
        <div class="tp-title">${pick.title}</div>
        <div class="tp-meta">
          <span class="tp-badge tp-rating">★ ${pick.imdbRating != null ? pick.imdbRating.toFixed(1) : '?'}</span>
          <span class="tp-badge">${pick.year || '?'}</span>
          <span class="tp-badge">${pick.type === 'Movie' ? pick.type : pick.type.replace('TV ', '')}</span>
          <span class="tp-badge">${formatRuntime(pick.runtime)}</span>
          ${genreHTML}
        </div>
        <div class="tp-reason">${reason}</div>
        <div class="tp-actions">
          ${pick.url ? `<a href="${pick.url}" target="_blank" class="btn-accent" style="text-decoration:none;padding:8px 14px">↗ Open on IMDb</a>` : ''}
          <button class="panel-btn" id="modal-mark-watching" data-id="${pick.id}">▶ Mark as Watching</button>
          <button class="btn-ghost" id="modal-reshuffle">↻ Different Pick</button>
        </div>
      </div>`;

    document.getElementById('modal-mark-watching').addEventListener('click', () => {
      State.update(pick.id, { status: 'watching' });
      modal.classList.add('hidden');
      toast(`▶ Now watching: ${pick.title}`, 'success');
    });

    document.getElementById('modal-reshuffle').addEventListener('click', () => {
      // Temporarily deprioritize top pick to get second choice
      const candidates = State.data.filter(d =>
        (d.status === 'unwatched' || d.status === 'watching') && d.id !== pick.id
      );
      if (candidates.length) {
        const pri = { '🔥': 3, '⚡': 1.5, '●': 0.5, null: 0 };
        const next = candidates.sort((a, b) => {
          const sa = (a.imdbRating || 6) * 10 + (pri[a.priority] || 0);
          const sb = (b.imdbRating || 6) * 10 + (pri[b.priority] || 0);
          return sb - sa;
        })[0];
        document.getElementById('modal-body').querySelector('.tp-title').textContent = next.title;
      }
    });
  }, 350);
});

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('tonight-modal').classList.add('hidden');
});

document.getElementById('tonight-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('tonight-modal')) {
    document.getElementById('tonight-modal').classList.add('hidden');
  }
});

/* ---- PANEL CLOSE ---- */
document.getElementById('panel-close').addEventListener('click', closePanel);

/* ---- VIEW SWITCHING ---- */
document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    State.currentView = view;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    if (view === 'analytics') renderAnalytics();
    if (view === 'add') {
      closePanel();
      document.getElementById('f-title').focus();
    }
  });
});

/* ---- STATUS FILTERS ---- */
document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    State.activeFilter = btn.dataset.filter;
    State.applyFilter();
    renderTable();
  });
});

document.querySelectorAll('.filter-btn[data-type]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn[data-type]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    State.activeType = btn.dataset.type;
    State.applyFilter();
    renderTable();
  });
});

document.querySelectorAll('.filter-btn[data-priority]').forEach(btn => {
  btn.addEventListener('click', () => {
    const isActive = btn.classList.contains('active');
    document.querySelectorAll('.filter-btn[data-priority]').forEach(b => b.classList.remove('active'));
    if (!isActive) { btn.classList.add('active'); State.activePriority = btn.dataset.priority; }
    else State.activePriority = null;
    State.applyFilter();
    renderTable();
  });
});

/* ---- SEARCH ---- */
let searchTimer;
document.getElementById('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    State.searchQuery = e.target.value.trim();
    State.applyFilter();
    renderTable();
  }, 180);
});

/* ---- SORT ---- */
document.getElementById('sort-select').addEventListener('change', (e) => {
  const val = e.target.value;
  State.sortCol = val;
  State.sortDir = 'asc';
  State.applyFilter();
  renderTable();
});

document.querySelectorAll('#watchlist-table th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (State.sortCol === col) {
      State.sortDir = State.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      State.sortCol = col;
      State.sortDir = 'asc';
    }
    document.querySelectorAll('th').forEach(t => t.classList.remove('sort-active'));
    th.classList.add('sort-active');
    State.applyFilter();
    renderTable();
  });
});

/* ---- ADD FORM ---- */
document.getElementById('add-submit-btn').addEventListener('click', () => {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }

  const genres = document.getElementById('f-genres').value
    .split(',').map(g => g.trim()).filter(Boolean);

  const entry = {
    id: 'custom_' + Date.now(),
    title,
    type: document.getElementById('f-type').value,
    year: parseInt(document.getElementById('f-year').value) || null,
    imdbRating: parseFloat(document.getElementById('f-imdb').value) || null,
    runtime: parseInt(document.getElementById('f-runtime').value) || null,
    genres,
    directors: document.getElementById('f-director').value.trim(),
    url: document.getElementById('f-url').value.trim(),
    yourRating: null,
    dateRated: '',
    addedDate: new Date().toISOString().slice(0, 10),
    status: document.getElementById('f-status').value,
    priority: document.getElementById('f-priority').value || null,
    notes: document.getElementById('f-notes').value.trim(),
    position: State.data.length + 1
  };

  State.add(entry);
  toast(`"${title}" added ✓`, 'success');

  // Reset form
  ['f-title','f-year','f-imdb','f-runtime','f-genres','f-director','f-url','f-notes'].forEach(id => {
    document.getElementById(id).value = '';
  });

  // Switch to watchlist
  document.querySelector('.nav-btn[data-view="watchlist"]').click();
});

document.getElementById('add-cancel-btn').addEventListener('click', () => {
  document.querySelector('.nav-btn[data-view="watchlist"]').click();
});

/* ---- KEYBOARD SHORTCUTS ---- */
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName.toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

  if (e.key === 'Escape') {
    closePanel();
    document.getElementById('tonight-modal').classList.add('hidden');
    return;
  }

  if (typing) return;

  if (e.key === 'a' || e.key === 'A') {
    document.querySelector('.nav-btn[data-view="add"]').click();
    return;
  }

  if (e.key === '/') {
    e.preventDefault();
    document.querySelector('.nav-btn[data-view="watchlist"]').click();
    document.getElementById('search').focus();
    return;
  }

  // Arrow navigation
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = State.filtered;
    if (!rows.length) return;
    const currentIdx = rows.findIndex(d => d.id === State.selected);
    let next = e.key === 'ArrowDown' ? currentIdx + 1 : currentIdx - 1;
    next = Math.max(0, Math.min(next, rows.length - 1));
    State.selected = rows[next].id;
    openPanel(rows[next].id);
    renderTable();
    // scroll into view
    const row = document.querySelector(`tr[data-id="${rows[next].id}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    return;
  }

  if (e.key === 'Enter' && State.selected) {
    const entry = State.getById(State.selected);
    if (entry?.url) window.open(entry.url, '_blank');
    return;
  }
});

/* ---- TOAST ---- */
let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2200);
}

/* ---- INIT ---- */
function init() {
  State.init();
  State.applyFilter();
  renderTable();
  updateStats();

  // Start with panel hidden
  document.getElementById('app').classList.add('panel-hidden');
}

init();

/* ---- TOAST ELEMENT ---- */
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);
