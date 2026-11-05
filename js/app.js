/* ══════════════════════════════════════════════════════════════
   Расписание уроков — приложение
   Сетка: дни слева (строки), уроки сверху (столбцы).
   Данные: data/schedule.json (build.py из экспорта aSc Timetables)
   ══════════════════════════════════════════════════════════════ */
'use strict';

const KEY = 'rasp.state.v3';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let D = null;                 // данные
let S = null;                 // состояние
const RENDER = [];            // записи текущего рендера (для деталей)
const tSlots = new Map();     // teacherId -> [day][period] -> [entry]
const rSlots = new Map();     // roomId    -> [day][period] -> [entry]
const cSlots = new Map();     // classId   -> [day][period] -> [entry]
const subjSlots = new Map();  // subjectIdx -> [{classId, day, period, entry}]
const eCache = new WeakMap();

const GRP_SHORT = {
  'Весь класс': '', '1 группа': '1 гр', '2 группа': '2 гр',
  'Мальчики': 'мал', 'Девочки': 'дев',
};
const TYPE_LABEL = {
  lesson: 'Урок', vd: 'Внеурочное занятие', ek: 'Элективный курс',
  project: 'Индивидуальный проект', self: 'Самоподготовка',
};

/* ── утилиты ─────────────────────────────────────────────────── */
const toMin = (t) => {
  const [h, m] = String(t || '0:0').split(':').map(Number);
  return h * 60 + m;
};
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (t) => {
  const [h, m] = String(t || '').split(':');
  return h ? `${pad(h)}:${pad(m || 0)}` : '';
};
const range = (p) => (p ? `${fmtTime(p.start)}-${fmtTime(p.end)}` : '');
const plural = (n, a, b, c) => {
  const m = n % 100, k = n % 10;
  if (m > 10 && m < 20) return c;
  if (k === 1) return a;
  if (k > 1 && k < 5) return b;
  return c;
};
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ── разворачивание записей ──────────────────────────────────── */
function exp(rec) {
  let e = eCache.get(rec);
  if (e) return e;
  e = {
    rec,
    si: rec[0],
    s: D.subjects[rec[0]],
    t: rec[1].map((i) => D.teachers[i]),
    r: rec[2].map((i) => D.rooms[i]),
    g: rec[3].map((i) => D.groups[i]),
    c: rec[4].map((i) => D.classes[i]),
    // один и тот же урок в JSON продублирован для каждого класса — склеиваем по ключу
    key: rec[0] + '|' + rec[1].join(',') + '|' + rec[2].join(',') +
         '|' + rec[3].join(',') + '|' + rec[4].join(','),
  };
  eCache.set(rec, e);
  return e;
}

function buildIndexes() {
  const mk = () => [0, 1, 2, 3, 4].map(() => ({}));
  for (const cid in D.grid) {
    const days = mk();
    for (const d in D.grid[cid]) {
      for (const p in D.grid[cid][d]) {
        const list = D.grid[cid][d][p].map(exp);
        days[+d][p] = list;
        for (const e of list) {
          for (const t of e.t) {
            if (!tSlots.has(t.id)) tSlots.set(t.id, mk());
            const arr = (tSlots.get(t.id)[+d][p] = tSlots.get(t.id)[+d][p] || []);
            if (!arr.some((x) => x.key === e.key)) arr.push(e);
          }
          for (const r of e.r) {
            if (!rSlots.has(r.id)) rSlots.set(r.id, mk());
            const arr = (rSlots.get(r.id)[+d][p] = rSlots.get(r.id)[+d][p] || []);
            if (!arr.some((x) => x.key === e.key)) arr.push(e);
          }
          if (!subjSlots.has(e.si)) subjSlots.set(e.si, []);
          const arr = subjSlots.get(e.si);
          if (!arr.some((x) => x.classId === cid && x.day === +d && x.period === p)) {
            arr.push({ classId: cid, day: +d, period: p, entry: e });
          }
        }
      }
    }
    cSlots.set(cid, days);
  }
}

/* ── состояние ───────────────────────────────────────────────── */
function defaultState() {
  const top = Math.max(...Object.keys(D.parallels).map(Number));
  const first = (D.parallels[String(top)] || [])[0] || D.classes[0].id;
  return {
    mode: 'class',
    sel: { class: first, teacher: D.teachers[0].id, room: D.rooms[0].id },
    kinds: { lesson: true, vd: true, ek: true },
    group: 'all',
    density: 'normal',
    theme: 'dark',
  };
}

function saveState() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* приватный режим */ }
}

function restoreState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  S = Object.assign(defaultState(), saved);
  S.sel = Object.assign({ class: D.classes[0].id, teacher: D.teachers[0].id, room: D.rooms[0].id }, saved.sel || {});
  S.kinds = Object.assign({ lesson: true, vd: true, ek: true }, saved.kinds || {});
  delete S.day;

  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.has('c') && D.classes[+h.get('c')]) { S.mode = 'class'; S.sel.class = D.classes[+h.get('c')].id; }
  if (h.has('t') && D.teachers[+h.get('t')]) { S.mode = 'teacher'; S.sel.teacher = D.teachers[+h.get('t')].id; }
  if (h.has('r') && D.rooms[+h.get('r')]) { S.mode = 'room'; S.sel.room = D.rooms[+h.get('r')].id; }

  if (!D.classes.some((c) => c.id === S.sel.class)) S.sel.class = D.classes[0].id;
  if (!D.teachers.some((t) => t.id === S.sel.teacher)) S.sel.teacher = D.teachers[0].id;
  if (!D.rooms.some((r) => r.id === S.sel.room)) S.sel.room = D.rooms[0].id;
}

function syncHash() {
  const p = new URLSearchParams();
  if (S.mode === 'class') p.set('c', D.classes.findIndex((c) => c.id === S.sel.class));
  if (S.mode === 'teacher') p.set('t', D.teachers.findIndex((t) => t.id === S.sel.teacher));
  if (S.mode === 'room') p.set('r', D.rooms.findIndex((r) => r.id === S.sel.room));
  history.replaceState(null, '', '#' + p.toString());
}

/* ── контекст ────────────────────────────────────────────────── */
function entity() {
  if (S.mode === 'class') {
    const c = D.classes.find((x) => x.id === S.sel.class);
    return { type: 'class', id: c.id, item: c, name: c.name, short: c.short };
  }
  if (S.mode === 'teacher') {
    const t = D.teachers.find((x) => x.id === S.sel.teacher);
    return { type: 'teacher', id: t.id, item: t, name: t.name, short: t.short };
  }
  const r = D.rooms.find((x) => x.id === S.sel.room);
  return { type: 'room', id: r.id, item: r, name: r.name, short: r.short };
}

function cellsFor(day) {
  const ent = entity();
  if (ent.type === 'class') {
    const grid = cSlots.get(ent.id);
    return grid ? (grid[day] || {}) : {};
  }
  const idx = ent.type === 'teacher' ? tSlots : rSlots;
  const grid = idx.get(ent.id);
  return grid ? (grid[day] || {}) : {};
}

function groupOptions() {
  if (S.mode !== 'class') return [];
  return D.groups
    .filter((g) => g.class === S.sel.class && (g.divtag === '1' || g.divtag === '2'))
    .map((g) => ({ id: g.id, label: g.name, short: GRP_SHORT[g.name] || g.name }));
}

const kindOf = (e) => (e.s.kind === 'vd' ? 'vd' : e.s.kind === 'ek' ? 'ek' : 'lesson');

function passes(e) {
  if (!S.kinds[kindOf(e)]) return false;
  if (S.mode === 'class' && S.group !== 'all') {
    return e.g.some((g) => g.class === S.sel.class && (g.entire || g.id === S.group));
  }
  return true;
}

const visibleEntries = (list) => (list || []).filter(passes);

function groupChips(e) {
  if (S.mode !== 'class') return [];
  const own = e.g.filter((g) => g.class === S.sel.class);
  if (!own.length || own.some((g) => g.entire)) return [];
  const names = [];
  for (const g of own) {
    const s = GRP_SHORT[g.name] || g.name;
    if (s && !names.includes(s)) names.push(s);
  }
  return names;
}

/* ── «сейчас» ────────────────────────────────────────────────── */
function nowInfo() {
  const now = new Date();
  const wd = now.getDay();
  const day = wd >= 1 && wd <= 5 ? wd - 1 : -1;
  const mins = now.getHours() * 60 + now.getMinutes();
  const ps = D.meta.periods;
  if (day < 0) return { day: -1, cur: null, next: null, mins };
  return {
    day,
    cur: ps.find((p) => mins >= toMin(p.start) && mins < toMin(p.end)) || null,
    next: ps.find((p) => toMin(p.start) > mins) || null,
    mins,
  };
}

function tickLive() {
  if (!D) return;
  const n = nowInfo();
  const box = $('#live');
  const txt = $('#liveText');
  const bar = $('#liveBar');

  if (n.day < 0) {
    box.classList.remove('is-break');
    txt.innerHTML = '<b>Выходной</b> · расписание на неделю';
    bar.style.width = '0%';
  } else if (n.cur) {
    box.classList.remove('is-break');
    const left = toMin(n.cur.end) - n.mins;
    txt.innerHTML = `<b>${n.cur.n}-й урок</b> · ${range(n.cur)} · ещё ${left} ${plural(left, 'минута', 'минуты', 'минут')}`;
    const total = toMin(n.cur.end) - toMin(n.cur.start);
    bar.style.width = Math.max(2, Math.min(100, ((n.mins - toMin(n.cur.start)) / total) * 100)) + '%';
  } else if (n.next) {
    box.classList.add('is-break');
    const left = toMin(n.next.start) - n.mins;
    txt.innerHTML = `<b>Перемена</b> · ${n.next.n}-й урок через ${left} ${plural(left, 'минуту', 'минуты', 'минут')}`;
    bar.style.width = '0%';
  } else {
    box.classList.add('is-break');
    txt.innerHTML = '<b>Уроки закончились</b> · до завтра';
    bar.style.width = '0%';
  }
  markNow(n);
}

function markNow(n) {
  $$('.is-now').forEach((el) => el.classList.remove('is-now'));
  if (!n.cur) return;
  $$(`[data-slot="${n.day}-${n.cur.n}"]`).forEach((el) => el.classList.add('is-now'));
  $$(`[data-timenum="${n.cur.n}"]`).forEach((el) => el.classList.add('is-now'));
}

/* ── рендер ──────────────────────────────────────────────────── */
function render() {
  document.documentElement.dataset.density = S.density;
  applyTheme();
  renderPicker();
  renderBoard();
  renderFilterDot();
  syncHash();
}

function applyTheme() {
  const t = S.theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : S.theme;
  document.documentElement.dataset.theme = t;
}

function renderPicker() {
  const ent = entity();
  $('#pickVal').textContent = ent.type === 'teacher' ? ent.item.short : ent.name;
  $$('.seg-btn').forEach((b) => {
    const on = b.dataset.mode === S.mode;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.title = `${ent.name} — Расписание уроков`;
}

function cardHTML(e, ent, half) {
  const idx = RENDER.push(e) - 1;
  const chips = groupChips(e);
  // короткие коды классов: «11 т-2/1» вместо «11 т-2 /1», длинные списки сворачиваем
  const clsShort = (list) => {
    const names = list.map((c) => c.short.replace(/\s*\/\s*/g, '/'));
    return names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(', ');
  };
  let meta = '';
  let badge = '';
  if (ent.type === 'class') {
    meta = e.t.map((t) => t.short).join(', ');
    badge = e.r.map((r) => r.short).join(', ');
  } else if (ent.type === 'teacher') {
    meta = clsShort(e.c);
    badge = e.r.map((r) => r.short).join(', ');
  } else {
    meta = e.t.map((t) => t.short).join(', ');
    badge = clsShort(e.c);
  }
  if (chips.length) meta += '';
  const tip = `${e.s.name} · ${meta}${badge ? ' · ' + badge : ''}`;
  return `<button class="les cat-${e.s.cat} ${kindOf(e) !== 'lesson' ? 'is-extra' : ''} ${half ? 'half' : ''}"
      data-act="les" data-i="${idx}" type="button" title="${esc(tip)}">
      <span class="les-top">
        ${half && chips.length ? `<span class="les-grp">${esc(chips.join(' · '))}</span>` : ''}
        <span class="les-sub">${esc(e.s.short)}</span>
        ${badge ? `<span class="les-room">${esc(badge)}</span>` : ''}
      </span>
      <span class="les-meta">
        <span class="les-teacher">${esc(meta)}</span>
        ${!half && chips.length ? `<span class="les-grp">${esc(chips.join(' · '))}</span>` : ''}
      </span>
    </button>`;
}

function cardsHTML(list, ent) {
  if (!list.length) return '';
  if (list.length === 1) return cardHTML(list[0], ent, false);
  return `<div class="les-combo">${list.map((e) => cardHTML(e, ent, true)).join('')}</div>`;
}

function usedPeriods() {
  let max = 0;
  for (let d = 0; d < 5; d++) {
    const cells = cellsFor(d);
    for (const p in cells) {
      if (visibleEntries(cells[p]).length) max = Math.max(max, +p);
    }
  }
  return max ? D.meta.periods.filter((p) => p.n <= max) : [];
}

function renderBoard() {
  const ent = entity();
  const board = $('#board');
  RENDER.length = 0;

  const periods = usedPeriods();
  if (!periods.length) {
    board.innerHTML = emptyHTML(ent);
    return;
  }

  const n = nowInfo();
  const counts = D.meta.days.map((d) => {
    const cells = cellsFor(d.i);
    let c = 0;
    for (const p in cells) if (visibleEntries(cells[p]).length) c++;
    return c;
  });

  // колонки, где бывают только ВД/ЭК, делаем уже: там короткие названия
  const extraCol = (n2) => {
    let any = false;
    for (let d = 0; d < 5; d++) {
      for (const e of visibleEntries(cellsFor(d)[String(n2)])) {
        any = true;
        if (kindOf(e) === 'lesson') return false;
      }
    }
    return any;
  };
  const cols = periods
    .map((p) => (extraCol(p.n) ? 'minmax(92px, .8fr)' : 'minmax(120px, 1fr)'))
    .join(' ');

  let html = `<div class="print-head"><strong>${esc(ent.name)}</strong> — неделя</div>`;
  html += `<div class="grid-wrap"><div class="week" style="--pcount:${periods.length};grid-template-columns:var(--day-w) ${cols}">`;

  html += `<div class="wk-corner">день / урок</div>`;
  for (const p of periods) {
    const now = n.cur && n.cur.n === p.n;
    html += `<div class="wk-ph ${now ? 'is-now' : ''} ${extraCol(p.n) ? 'is-extra' : ''}" data-timenum="${p.n}">
      <b>${p.n}</b><span>${fmtTime(p.start)}-${fmtTime(p.end)}</span></div>`;
  }

  for (const d of D.meta.days) {
    const isToday = n.day === d.i;
    html += `<div class="wk-day ${isToday ? 'is-today' : ''}" data-day="${d.i}">
      <b><span class="d-long">${d.full}</span><span class="d-short">${d.short}</span></b>
      <span>${counts[d.i]}<em>${plural(counts[d.i], ' урок', ' урока', ' уроков')}</em></span>
      ${isToday ? '<i class="today-tag">сегодня</i>' : ''}</div>`;
    for (const p of periods) {
      const list = visibleEntries(cellsFor(d.i)[String(p.n)]);
      html += `<div class="wk-cell ${list.length ? '' : 'is-empty'} ${isToday ? 'is-today' : ''} ${p.n % 2 === 0 ? 'is-alt' : ''}"
        data-slot="${d.i}-${p.n}">${cardsHTML(list, ent)}</div>`;
    }
  }

  html += `</div></div>`;
  board.innerHTML = html;
  markNow(n);
  const gw = $('.grid-wrap');
  if (gw) gw.classList.toggle('is-scrollable', gw.scrollWidth > gw.clientWidth + 4);
}

function emptyHTML(ent) {
  return `<div class="empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2.5v3M16 2.5v3"/>
    </svg>
    <h3>Занятий нет</h3>
    <p>${esc(ent.name)}: по выбранным фильтрам уроков не найдено. Включите внеурочные занятия или выберите другую подгруппу.</p>
    <button class="btn" data-act="reset" type="button">Сбросить фильтры</button>
  </div>`;
}

function filtersActive() {
  return S.group !== 'all' || !S.kinds.lesson || !S.kinds.vd || !S.kinds.ek;
}

function renderFilterDot() {
  const on = filtersActive();
  $('#filterDot').hidden = !on;
  const rb = $('#resetBtn');
  if (rb) {
    rb.hidden = !on;
    rb.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
}

function resetFilters(silent) {
  S.kinds = { lesson: true, vd: true, ek: true };
  S.group = 'all';
  saveState();
  render();
  if (!silent) toast('Фильтры сброшены');
}

/* ── шиты ────────────────────────────────────────────────────── */
let lastFocus = null;

function openSheet(title, html) {
  lastFocus = document.activeElement;
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').scrollTop = 0;
  $('#sheetWrap').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#sheetClose').focus({ preventScroll: true }), 30);
}

function closeSheet() {
  $('#sheetWrap').hidden = true;
  document.body.style.overflow = '';
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
}

function optHTML(id, name, type, on, sub) {
  return `<button class="opt ${on ? 'is-on' : ''}" data-act="pick-set" data-type="${type}" data-id="${esc(id)}" type="button">
    <span class="opt-name">${esc(name)}</span>
    ${sub ? `<span class="opt-sub">${esc(sub)}</span>` : ''}
    ${on ? `<svg class="opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>` : ''}
  </button>`;
}

function countSlots(map, id) {
  const g = map.get(id);
  if (!g) return 0;
  let c = 0;
  for (const d of g) for (const p in d) c++;
  return c;
}

function openPicker() {
  const type = S.mode;
  const cur = S.sel[type];
  const title = type === 'class' ? 'Классы' : type === 'teacher' ? 'Учителя' : 'Кабинеты';
  openSheet(title, `<div class="search-box">
      <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input class="search-input" id="pickSearch" type="search" placeholder="Поиск" autocomplete="off" enterkeyhint="search">
    </div><div id="pickList"></div>`);

  const section = (label, rows) => rows.length
    ? `<div class="group-label">${label}</div><div class="list">${rows}</div>` : '';

  const draw = (q) => {
    const s = norm(q);
    const list = $('#pickList');
    if (!list) return;
    let html = '';
    if (type === 'class') {
      for (const par of Object.keys(D.parallels).sort((a, b) => b - a)) {
        const items = D.parallels[par]
          .map((id) => D.classes.find((c) => c.id === id))
          .filter((c) => !s || norm(`${c.name} ${c.profile || ''}`).includes(s));
        html += section(`${par} параллель`, items.map((c) => optHTML(c.id, c.name, type, cur === c.id, '')).join(''));
      }
    } else if (type === 'teacher') {
      const items = D.teachers
        .filter((t) => !s || norm(t.name).includes(s))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      html = section(`${items.length} ${plural(items.length, 'учитель', 'учителя', 'учителей')}`,
        items.map((t) => optHTML(t.id, t.name, type, cur === t.id, `${countSlots(tSlots, t.id)} ч`)).join(''));
    } else {
      const items = D.rooms
        .filter((r) => !s || norm(r.name).includes(s))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
      html = section(`${items.length} ${plural(items.length, 'кабинет', 'кабинета', 'кабинетов')}`,
        items.map((r) => optHTML(r.id, r.name, type, cur === r.id, `${countSlots(rSlots, r.id)} ч`)).join(''));
    }
    list.innerHTML = html || `<p class="hint">Ничего не найдено</p>`;
  };

  draw('');
  $('#pickSearch').addEventListener('input', (e) => draw(e.target.value));
}

function openSearch() {
  openSheet('Поиск', `<div class="search-box">
      <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input class="search-input" id="globSearch" type="search" placeholder="Класс, учитель, кабинет, предмет" autocomplete="off">
    </div><div id="globRes"></div>`);

  const section = (label, rows) => rows.length
    ? `<div class="group-label">${label}</div><div class="list">${rows}</div>` : '';

  const draw = (q) => {
    const box = $('#globRes');
    if (!box) return;
    const s = norm(q);
    if (!s) {
      box.innerHTML = section('Например', ['10 т2', 'Миннегалеев', '203', 'Python']
        .map((x) => `<button class="opt" data-act="search-example" data-q="${esc(x)}" type="button">
          <span class="opt-name">${esc(x)}</span></button>`).join(''));
      return;
    }
    const cls = D.classes.filter((c) => norm(`${c.name} ${c.profile || ''} ${c.short}`).includes(s)).slice(0, 8);
    const tch = D.teachers.filter((t) => norm(t.name).includes(s)).slice(0, 8);
    const rms = D.rooms.filter((r) => norm(r.name).includes(s)).slice(0, 8);
    const sbj = D.subjects.filter((x) => norm(x.name).includes(s)).slice(0, 8);

    let html = '';
    html += section('Классы', cls.map((c) => optHTML(c.id, c.name, 'class', false, '')).join(''));
    html += section('Учителя', tch.map((t) => optHTML(t.id, t.name, 'teacher', false, '')).join(''));
    html += section('Кабинеты', rms.map((r) => optHTML(r.id, r.name, 'room', false, '')).join(''));
    html += section('Предметы', sbj.map((x) => {
      const n = (subjSlots.get(D.subjects.indexOf(x)) || []).length;
      return `<button class="opt" data-act="subj" data-i="${D.subjects.indexOf(x)}" type="button">
        <span class="opt-name">${esc(x.name)}</span><span class="opt-sub">${n} кл.</span></button>`;
    }).join(''));
    box.innerHTML = html || `<p class="hint">Ничего не найдено</p>`;
  };
  draw('');
  const inp = $('#globSearch');
  inp.addEventListener('input', (e) => draw(e.target.value));
  setTimeout(() => inp.focus({ preventScroll: true }), 50);
}

function openSubject(si) {
  const subj = D.subjects[si];
  const occ = subjSlots.get(si) || [];
  const byClass = new Map();
  for (const o of occ) {
    if (!byClass.has(o.classId)) byClass.set(o.classId, []);
    byClass.get(o.classId).push(o);
  }
  const rows = Array.from(byClass.entries()).map(([cid, list]) => {
    const c = D.classes.find((x) => x.id === cid);
    const slots = list
      .sort((a, b) => a.day - b.day || a.period - b.period)
      .map((o) => `${D.meta.days[o.day].short} ${o.period}`)
      .join(', ');
    const t = Array.from(new Set(list.flatMap((o) => o.entry.t.map((x) => x.short)))).join(', ');
    return `<button class="opt" data-act="goto-class-day" data-id="${esc(cid)}" data-day="${list[0].day}" type="button">
      <span class="opt-name">${esc(c.name)}<br><span style="font-weight:500;font-size:11.5px;color:var(--muted)">${esc(t)}</span></span>
      <span class="opt-sub">${esc(slots)}</span></button>`;
  }).join('');
  openSheet(subj.name, rows
    ? `<div class="group-label">Классы и часы</div><div class="list">${rows}</div>`
    : '<p class="hint">Нет занятий</p>');
}

function openFilters() {
  const gs = groupOptions();
  const kindChips = [['lesson', 'Уроки'], ['vd', 'Внеурочные'], ['ek', 'Элективные']]
    .map(([k, label]) => `<button class="chip ${S.kinds[k] ? 'is-on' : ''}" data-act="kind" data-kind="${k}" type="button">${label}</button>`).join('');

  const grpChips = gs.length ? `<div class="group-label">Подгруппа</div>
    <div class="chips">
      <button class="chip ${S.group === 'all' ? 'is-on' : ''}" data-act="group" data-group="all" type="button">Все</button>
      ${gs.map((g) => `<button class="chip ${S.group === g.id ? 'is-on' : ''}" data-act="group" data-group="${esc(g.id)}" type="button">${esc(g.label)}</button>`).join('')}
    </div>
    <p class="hint">Показывать занятия только для выбранной подгруппы.</p>` : '';

  const dens = [['compact', 'Компактно'], ['normal', 'Обычно'], ['large', 'Крупно']]
    .map(([k, l]) => `<button class="chip ${S.density === k ? 'is-on' : ''}" data-act="density" data-density="${k}" type="button">${l}</button>`).join('');

  const theme = [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']]
    .map(([k, l]) => `<button class="chip ${S.theme === k ? 'is-on' : ''}" data-act="theme-set" data-theme="${k}" type="button">${l}</button>`).join('');

  openSheet('Фильтры', `
    <div class="group-label">Тип занятий</div>
    <div class="chips">${kindChips}</div>
    ${grpChips}
    <div class="group-label">Размер карточек</div>
    <div class="chips">${dens}</div>
    <div class="group-label">Оформление</div>
    <div class="chips">${theme}</div>
    <div class="group-label">Обозначения</div>
    <div class="legend">
      <span><i style="--c:var(--blue)"></i>математика и информатика</span>
      <span><i style="--c:var(--purple)"></i>естественные науки</span>
      <span><i style="--c:var(--pink)"></i>гуманитарные и языки</span>
      <span><i style="--c:var(--muted)"></i>физкультура, ВД и ЭК</span>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-primary" data-act="today" type="button">Сегодня</button>
      <button class="btn" data-act="print" type="button">Печать недели</button>
    </div>
    <button class="link-btn reset" data-act="reset" type="button">Сбросить фильтры</button>`);
}

function openDetails(i) {
  const e = RENDER[i];
  if (!e) return;
  const slots = [];
  for (const d of D.meta.days) {
    const cells = cellsFor(d.i);
    for (const p in cells) {
      if (cells[p].some((x) => x.key === e.key)) slots.push({ day: d, n: +p });
    }
  }
  const gs = e.g.filter((g) => S.mode !== 'class' || g.class === S.sel.class);
  const grpText = gs.length ? Array.from(new Set(gs.map((g) => g.name))).join(', ') : '';
  const clsText = e.c.map((c) => c.name).join(', ');
  const tchText = e.t.map((t) => t.name).join(', ');
  const roomText = e.r.length ? e.r.map((r) => r.name).join(', ') : '';

  // один блок «когда» — день, урок и время в отдельных строках
  const whenLines = slots.map((s) => {
    const pd = D.meta.periods.find((x) => x.n === s.n);
    return { day: s.day.short, full: s.day.full, n: s.n, time: pd ? range(pd) : '' };
  });

  const rows = [];
  if (e.s.name !== e.s.short) rows.push(['Предмет', esc(e.s.name)]);
  rows.push(['Тип', esc(TYPE_LABEL[e.s.kind] || 'Урок')]);
  rows.push(['Когда', whenLines.length
    ? `<span class="when">${whenLines.map((l) => `<span title="${esc(l.full)}"><b>${esc(l.day)}</b><em>${l.n} урок</em><i>${esc(l.time)}</i></span>`).join('')}</span>`
    : '—']);
  if (grpText && grpText !== 'Весь класс') rows.push(['Подгруппа', esc(grpText)]);
  rows.push([e.c.length > 1 ? 'Классы' : 'Класс',
    `<button data-act="goto-class" data-id="${esc(e.c[0].id)}" type="button">${esc(clsText)}</button>`]);
  rows.push([e.t.length > 1 ? 'Учителя' : 'Учитель',
    `<button data-act="goto-teacher" data-id="${esc(e.t[0].id)}" type="button">${esc(tchText)}</button>`]);
  rows.push(['Кабинет', roomText
    ? `<button data-act="goto-room" data-id="${esc(e.r[0].id)}" type="button">${esc(roomText)}</button>`
    : 'не указан']);

  openSheet(e.s.short, `
    <div class="dl">${rows.map(([k, v]) => `<div class="dl-row"><span class="dl-k">${k}</span><span class="dl-v">${v}</span></div>`).join('')}</div>
    <div class="sheet-actions">
      <button class="btn" data-act="goto-class" data-id="${esc(e.c[0].id)}" type="button">К классу</button>
      <button class="btn" data-act="goto-teacher" data-id="${esc(e.t[0].id)}" type="button">К учителю</button>
      <button class="btn" data-act="goto-room" data-id="${esc(e.r[0].id)}" type="button">К кабинету</button>
    </div>`);
}

function openBells() {
  const n = nowInfo();
  const rows = D.meta.periods.map((p) => `
    <div class="bell ${n.cur && n.cur.n === p.n ? 'is-now' : ''}">
      <b>${p.n}</b><span>${fmtTime(p.start)}-${fmtTime(p.end)}</span>
      <em>${toMin(p.end) - toMin(p.start)} мин</em>
    </div>`).join('');
  openSheet('Расписание звонков', `<div class="bells">${rows}</div>`);
}

/* ── действия ────────────────────────────────────────────────── */
function setMode(mode) {
  S.mode = mode;
  if (mode !== 'class') S.group = 'all';
  render();
}

function scrollToDay(day) {
  const el = document.querySelector(`.wk-day[data-day="${day}"]`);
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function goEntity(type, id, day) {
  S.mode = type;
  S.sel[type] = id;
  if (type !== 'class') S.group = 'all';
  render();
  closeSheet();
  if (day != null) setTimeout(() => scrollToDay(day), 60);
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  switch (el.dataset.act) {
    case 'mode': setMode(el.dataset.mode); saveState(); break;
    case 'pick': openPicker(); break;
    case 'pick-set':
      goEntity(el.dataset.type, el.dataset.id); saveState();
      toast(D.classes.find((c) => c.id === el.dataset.id)?.name
        || D.teachers.find((t) => t.id === el.dataset.id)?.name
        || D.rooms.find((r) => r.id === el.dataset.id)?.name || '');
      break;
    case 'search': openSearch(); break;
    case 'search-example': {
      const inp = $('#globSearch');
      if (inp) { inp.value = el.dataset.q; inp.dispatchEvent(new Event('input')); inp.focus(); }
      break;
    }
    case 'subj': openSubject(+el.dataset.i); break;
    case 'filter': openFilters(); break;
    case 'kind':
      S.kinds[el.dataset.kind] = !S.kinds[el.dataset.kind];
      if (!S.kinds.lesson && !S.kinds.vd && !S.kinds.ek) S.kinds[el.dataset.kind] = true;
      saveState(); render(); openFilters(); break;
    case 'group':
      S.group = el.dataset.group; saveState(); render(); openFilters(); break;
    case 'density':
      S.density = el.dataset.density; saveState(); render(); openFilters(); break;
    case 'theme-set':
      S.theme = el.dataset.theme; saveState(); render(); openFilters(); break;
    case 'bells': openBells(); break;
    case 'print':
      closeSheet();
      setTimeout(() => window.print(), 200);
      break;
    case 'today': {
      const n = nowInfo();
      closeSheet();
      setTimeout(() => scrollToDay(n.day >= 0 ? n.day : 0), 60);
      break;
    }
    case 'reset':
      closeSheet(); resetFilters(); break;
    case 'les': openDetails(+el.dataset.i); break;
    case 'goto-class': goEntity('class', el.dataset.id); break;
    case 'goto-teacher': goEntity('teacher', el.dataset.id); break;
    case 'goto-room': goEntity('room', el.dataset.id); break;
    case 'goto-class-day': goEntity('class', el.dataset.id, +el.dataset.day); break;
  }
});

$$('.seg-btn').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); saveState(); }));
$('#pickBtn').addEventListener('click', openPicker);
$('#searchBtn').addEventListener('click', openSearch);
$('#filterBtn').addEventListener('click', openFilters);
$('#themeBtn').addEventListener('click', () => {
  S.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  saveState(); render();
});
$('#resetBtn').addEventListener('click', () => resetFilters());
$('#bellsBtn').addEventListener('click', openBells);
$('#printBtn').addEventListener('click', () => setTimeout(() => window.print(), 200));
$('#live').addEventListener('click', () => {
  const n = nowInfo();
  scrollToDay(n.day >= 0 ? n.day : 0);
});
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheetBack').addEventListener('click', closeSheet);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#sheetWrap').hidden) closeSheet();
});

/* компактная панель при прокрутке */
(function navScroll() {
  const nav = $('#nav');
  const upd = () => nav.classList.toggle('is-compact', window.scrollY > 44);
  window.addEventListener('scroll', upd, { passive: true });
  upd();
})();

/* свой скроллбар */
(function scrollbar() {
  const bar = $('.scrollbar');
  const thumb = $('#scrollThumb');
  const upd = () => {
    const h = document.documentElement.scrollHeight;
    const vh = window.innerHeight;
    if (h <= vh + 20) { bar.classList.remove('visible'); return; }
    const kh = Math.max(32, (vh / h) * vh);
    thumb.style.height = kh + 'px';
    thumb.style.top = (window.scrollY / (h - vh)) * (vh - kh) + 'px';
    bar.classList.add('visible');
  };
  window.addEventListener('scroll', upd, { passive: true });
  window.addEventListener('resize', upd);
  if (window.ResizeObserver) new ResizeObserver(upd).observe(document.body);
  upd();
})();

/* ── запуск ──────────────────────────────────────────────────── */
async function boot() {
  try {
    const res = await fetch('data/schedule.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    D = await res.json();
  } catch (err) {
    $('#board').innerHTML = `<div class="empty">
      <h3>Не удалось загрузить расписание</h3>
      <p>Файл data/schedule.json недоступен (${esc(err.message)}). Проверьте соединение и обновите страницу.</p>
      <button class="btn" onclick="location.reload()" type="button">Обновить</button></div>`;
    return;
  }

  buildIndexes();
  restoreState();
  $('#brandSub').textContent = D.meta.subtitle || '10–11 классы';
  render();
  tickLive();
  setInterval(tickLive, 15000);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (S.theme === 'auto') render();
  });
}

boot();