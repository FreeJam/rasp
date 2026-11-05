/* ══════════════════════════════════════════════════════════════
   Расписание уроков — приложение
   Сетка: дни слева (строки), уроки сверху (столбцы).
   Данные: data/schedule.json (build.py из экспорта aSc Timetables)
   ══════════════════════════════════════════════════════════════ */
'use strict';

const KEY = 'rasp.state.v4';
const KEY_OLD = 'rasp.state.v3';  // миграция: тема по умолчанию тёмная
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
  // класс по умолчанию: 11 т-2 /1 (мат.инф); если его нет в данных — первый из 11 класса
  const pref = D.classes.find((c) => c.short === '11 т-2 /1' || c.name === '11 т-2 /1 (мат.инф)');
  const first = pref ? pref.id : ((D.parallels[String(top)] || [])[0] || D.classes[0].id);
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
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!saved) {
      // прежнее состояние: переносим фильтры и класс, тему сбрасываем на тёмную
      saved = JSON.parse(localStorage.getItem(KEY_OLD) || '{}') || {};
      saved.theme = 'dark';
    }
  } catch (e) { saved = {}; }
  S = Object.assign(defaultState(), saved);
  S.sel = Object.assign({ class: defaultState().sel.class, teacher: D.teachers[0].id, room: D.rooms[0].id }, saved.sel || {});
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

// короткие коды классов: «11 т-2/1», длинные списки сворачиваем
function clsShort(list) {
  const names = list.map((c) => c.short.replace(/\s*\/\s*/g, '/'));
  return names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(', ');
}

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

/* урок, который идёт (или следующий) у выбранной сущности */
function lessonAt(day, period) {
  if (day < 0 || !period) return null;
  const list = cellsFor(day)[String(period.n)];
  return (list && list[0]) || null;
}

function tickLive() {
  if (!D) return;
  const n = nowInfo();
  const box = $('#live');
  const txt = $('#liveText');
  const bar = $('#liveBar');
  const sub = (e) => {
    if (!e) return '';
    const room = e.r.map((r) => r.short).join(', ');
    return `<span class="live-sub"> · ${esc(e.s.short)}${room ? ' · ' + esc(room) : ''}</span>`;
  };

  if (n.day < 0) {
    box.classList.remove('is-break');
    txt.innerHTML = '<b>Выходной</b> · расписание на неделю';
    bar.style.width = '0%';
  } else if (n.cur) {
    box.classList.remove('is-break');
    const left = toMin(n.cur.end) - n.mins;
    txt.innerHTML = `<b>${n.cur.n}-й урок</b>${sub(lessonAt(n.day, n.cur))} · ${range(n.cur)}<span class="live-rest"> · ещё ${left} ${plural(left, 'минута', 'минуты', 'минут')}</span>`;
    const total = toMin(n.cur.end) - toMin(n.cur.start);
    bar.style.width = Math.max(2, Math.min(100, ((n.mins - toMin(n.cur.start)) / total) * 100)) + '%';
  } else if (n.next) {
    box.classList.add('is-break');
    const left = toMin(n.next.start) - n.mins;
    txt.innerHTML = `<b>Перемена</b>${sub(lessonAt(n.day, n.next))} · ${n.next.n}-й урок в ${fmtTime(n.next.start)}<span class="live-rest"> · через ${left} ${plural(left, 'минуту', 'минуты', 'минут')}</span>`;
    bar.style.width = '0%';
  } else {
    box.classList.add('is-break');
    txt.innerHTML = '<b>Уроки закончились</b><span class="live-rest"> · до завтра</span>';
    bar.style.width = '0%';
  }
  markNow(n);
}

function markNow(n) {
  $$('.is-now').forEach((el) => el.classList.remove('is-now'));
  if (!n.cur) return;
  $$(`[data-slot="${n.day}-${n.cur.n}"]`).forEach((el) => {
    el.classList.add('is-now');
    $$('.les', el).forEach((t) => t.classList.add('is-now'));
  });
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

/* ── генеративный рисунок предмета ───────────────────────────────
   Каждый предмет получает свой узор: форма — по направлению (наука → орбиты,
   гуманитарные → волны, информатика → частицы, математика → лучи, прочее → сетка),
   а параметры (углы, частоты, точки) — детерминированно из id предмета. */
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seeded(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ART = {
  orbit(r) {
    const cx = 60 + (r() - 0.5) * 16, cy = 40 + (r() - 0.5) * 10;
    let out = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.2" fill="currentColor"/>`;
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const rx = 16 + i * 13 + r() * 5, ry = rx * (0.3 + r() * 0.35);
      const rot = (r() * 180).toFixed(1), a = r() * Math.PI * 2;
      const px = rx * Math.cos(a), py = ry * Math.sin(a);
      out += `<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rot})">` +
        `<ellipse rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" stroke-width=".8" opacity=".55"/>` +
        `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="1.8" fill="currentColor" stroke="none"/></g>`;
    }
    return out;
  },
  wave(r) {
    let out = '';
    for (let i = 0; i < 4; i++) {
      const amp = 5 + r() * 9, f = (1 + r() * 2) * Math.PI / 58, p = r() * 6.28, y0 = 18 + i * 14;
      let d = `M0 ${y0.toFixed(1)}`;
      for (let x = 4; x <= 120; x += 4) d += ` L${x} ${(y0 + amp * Math.sin(f * x + p)).toFixed(1)}`;
      out += `<path d="${d}" stroke-width="1" opacity="${(0.45 + i * 0.12).toFixed(2)}"/>`;
    }
    return out;
  },
  particles(r) {
    const pts = [];
    for (let i = 0; i < 22; i++) pts.push([r() * 120, r() * 80]);
    let out = '';
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (d < 26) out += `<line x1="${pts[i][0].toFixed(1)}" y1="${pts[i][1].toFixed(1)}" x2="${pts[j][0].toFixed(1)}" y2="${pts[j][1].toFixed(1)}" stroke-width=".6" opacity="${(1 - d / 26).toFixed(2)}"/>`;
    }
    for (const [x, y] of pts) out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.2" fill="currentColor" stroke="none"/>`;
    return out;
  },
  burst(r) {
    const rot = r() * 1.0, sides = 3 + Math.floor(r() * 4);
    let out = '';
    for (let k = 1; k <= 4; k++) {
      const R = 9 * k + r() * 3;
      let d = '';
      for (let s = 0; s <= sides; s++) {
        const a = rot + (s / sides) * Math.PI * 2;
        d += (s ? 'L' : 'M') + (60 + R * Math.cos(a)).toFixed(1) + ' ' + (40 + R * Math.sin(a)).toFixed(1);
      }
      out += `<path d="${d}" stroke-width=".8" opacity="${(0.25 + k * 0.15).toFixed(2)}"/>`;
    }
    for (let s = 0; s < sides + 2; s++) {
      const a = rot + (s / (sides + 2)) * Math.PI * 2;
      out += `<line x1="60" y1="40" x2="${(60 + 36 * Math.cos(a)).toFixed(1)}" y2="${(40 + 36 * Math.sin(a)).toFixed(1)}" stroke-width=".6" opacity=".5"/>`;
    }
    return out + '<circle cx="60" cy="40" r="2" fill="currentColor" stroke="none"/>';
  },
  mesh(r) {
    const tilt = (r() - 0.5) * 30;
    let out = '';
    for (let i = 0; i < 5; i++) {
      const cy = 18 + i * 11, rx = 46 * Math.sqrt(Math.max(0, 1 - ((cy - 40) / 30) ** 2));
      out += `<ellipse cx="60" cy="${cy}" rx="${rx.toFixed(1)}" ry="${(rx * 0.22).toFixed(1)}" stroke-width=".7" opacity=".5"/>`;
    }
    for (let j = 0; j < 4; j++) {
      out += `<ellipse cx="60" cy="40" rx="${(46 * Math.cos(j * Math.PI / 4)).toFixed(1)}" ry="32" stroke-width=".7" opacity=".4" transform="rotate(${(tilt + j * 45).toFixed(1)} 60 40)"/>`;
    }
    return out;
  },
};
const ART_BY_CAT = { sci: 'orbit', hum: 'wave', lang: 'wave', it: 'particles', math: 'burst', sport: 'mesh', extra: 'mesh', other: 'mesh' };
const artCache = new Map();
function artFor(subj) {
  if (artCache.has(subj.id)) return artCache.get(subj.id);
  const kind = ART_BY_CAT[subj.cat] || 'mesh';
  const svg = `<svg class="les-art" viewBox="0 0 120 80" fill="none" stroke="currentColor" aria-hidden="true">${ART[kind](seeded(hashStr(subj.id)))}</svg>`;
  artCache.set(subj.id, svg);
  return svg;
}

function cardHTML(e, ent, half) {
  const idx = RENDER.push(e) - 1;
  const chips = groupChips(e);

  // служебная строка: кабинет первым (его ищут чаще всего), затем учитель/класс
  const room = e.r.map((r) => r.short).join(', ');
  let second = '';
  if (ent.type === 'class') second = e.t.map((t) => t.short).join(', ');
  else if (ent.type === 'teacher') second = clsShort(e.c);
  else second = e.t.map((t) => t.short).join(', ');

  const tip = `${e.s.name}${room ? ' · ' + room : ''}${second ? ' · ' + second : ''}`;
  return `<button class="les cat-${e.s.cat} ${kindOf(e) !== 'lesson' ? 'is-extra' : ''}"
      data-act="les" data-i="${idx}" type="button" title="${esc(tip)}">
      ${artFor(e.s)}
      <span class="les-top">
        ${half && chips.length ? `<span class="les-grp">${esc(chips.join(' · '))}</span>` : ''}
        <span class="les-sub">${esc(e.s.short)}</span>
      </span>
      <span class="les-meta">
        ${room ? `<span class="les-room">${esc(room)}</span>` : ''}
        ${room && second ? '<span class="les-sep">·</span>' : ''}
        ${second ? `<span class="les-teacher">${esc(second)}</span>` : ''}
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

// высота таблицы — по окну, чтобы заголовки могли липнуть при вертикальной прокрутке
function fitWrap() {
  const bar = $('.bar');
  const barH = bar ? bar.getBoundingClientRect().height : 0;
  const h = Math.max(300, Math.round(window.innerHeight - barH - 28));
  document.documentElement.style.setProperty('--wrap-h', h + 'px');
}
window.addEventListener('resize', () => { fitWrap(); });

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

  html += `<div class="wk-corner" style="grid-row:1;grid-column:1">день / урок</div>`;
  periods.forEach((p, j) => {
    const now = n.cur && n.cur.n === p.n;
    html += `<div class="wk-ph ${now ? 'is-now' : ''} ${extraCol(p.n) ? 'is-extra' : ''}"
      style="grid-row:1;grid-column:${j + 2}" data-timenum="${p.n}" data-col="${j + 2}">
      <b>${p.n}</b><span>${fmtTime(p.start)}-${fmtTime(p.end)}</span>${now ? '<i class="live-tag">live</i>' : ''}</div>`;
  });

  D.meta.days.forEach((d, i) => {
    const isToday = n.day === d.i;
    const row = i + 2;
    // полоса дня: широкий фон под плитками
    html += `<div class="lane ${isToday ? 'is-today' : ''}" style="grid-row:${row};grid-column:2/-1" aria-hidden="true"></div>`;
    html += `<div class="wk-day ${isToday ? 'is-today' : ''}" style="grid-row:${row};grid-column:1" data-day="${d.i}">
      <b>${d.short}</b>
      <span>${counts[d.i]}<em>${plural(counts[d.i], ' урок', ' урока', ' уроков')}</em></span>
      ${isToday ? '<i class="today-tag">сегодня</i>' : ''}</div>`;
    periods.forEach((p, j) => {
      const list = visibleEntries(cellsFor(d.i)[String(p.n)]);
      html += `<div class="wk-cell ${list.length ? '' : 'is-empty'} ${p.n % 2 === 0 ? 'is-alt' : ''}"
        style="grid-row:${row};grid-column:${j + 2}"
        data-slot="${d.i}-${p.n}" data-col="${j + 2}">${cardsHTML(list, ent)}</div>`;
    });
  });

  html += `</div></div>`;
  board.innerHTML = html;
  markNow(n);
  fitWrap();
  const gw = $('.grid-wrap');
  if (gw) {
    gw.classList.toggle('is-scrollable', gw.scrollWidth > gw.clientWidth + 4);
    // подводим к текущему уроку, если он за краем
    const cur = nowInfo();
    if (cur.cur && window.matchMedia('(max-width: 900px)').matches) {
      const cell = gw.querySelector(`.wk-cell[data-slot="${cur.day}-${cur.cur.n}"]`);
      if (cell && (cell.offsetLeft > gw.scrollLeft + gw.clientWidth - 80)) {
        gw.scrollLeft = Math.max(0, cell.offsetLeft - 140);
      }
    }
  }
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
/* подсветка столбца под курсором */
(function columnHover() {
  const board = $('#board');
  board.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-col]');
    if (!el) return;
    const col = el.dataset.col;
    if (board._col === col) return;
    board._col = col;
    $$('.wk-cell.is-hot', board).forEach((c) => c.classList.remove('is-hot'));
    $$(`.wk-cell[data-col="${col}"]`, board).forEach((c) => c.classList.add('is-hot'));
  });
  board.addEventListener('mouseleave', () => {
    board._col = null;
    $$('.wk-cell.is-hot', board).forEach((c) => c.classList.remove('is-hot'));
  });
})();

$('#sheetClose').addEventListener('click', closeSheet);
$('#sheetBack').addEventListener('click', closeSheet);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#sheetWrap').hidden) closeSheet();
});

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

/* ── фон: большие генеративные рисунки за таблицей и в шапке ───── */
function paintArt() {
  const drift = $('#bgDrift');
  if (drift && !drift.childElementCount) {
    const r0 = seeded(hashStr('rasp-drift'));
    let s = '';
    for (let i = 0; i < 26; i++) {
      s += `<i style="left:${(r0()*100).toFixed(1)}%;bottom:-20px;animation-duration:${(18+r0()*22).toFixed(1)}s;animation-delay:-${(r0()*30).toFixed(1)}s"></i>`;
    }
    drift.innerHTML = s;
  }
  const r = seeded(hashStr('rasp-art-v1'));
  const f = (x) => x.toFixed(1);
  let g = '';
  // 1. атомные орбиты (вращаются медленно, отключаются при reduce-motion)
  for (let k = 0; k < 5; k++) {
    const cx = 80 + r() * 1440, cy = 60 + r() * 880, rings = 3 + Math.floor(r() * 3);
    const dur = (50 + r() * 70).toFixed(0), dir = r() < 0.5 ? 'normal' : 'reverse';
    g += `<g class="orb" style="animation-duration:${dur}s;animation-direction:${dir};transform-origin:${f(cx)}px ${f(cy)}px">`;
    for (let i = 1; i <= rings; i++) {
      const rx = 60 + i * (45 + r() * 30), ry = rx * (0.28 + r() * 0.42), rot = r() * 180;
      const th = rot * Math.PI / 180, a = r() * Math.PI * 2;
      const px = rx * Math.cos(a), py = ry * Math.sin(a);
      const dx = px * Math.cos(th) - py * Math.sin(th), dy = px * Math.sin(th) + py * Math.cos(th);
      g += `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" transform="rotate(${f(rot)} ${f(cx)} ${f(cy)})" class="c${(i % 3) + 1}"/>`;
      g += `<circle cx="${f(cx + dx)}" cy="${f(cy + dy)}" r="3.5" class="dot"/>`;
    }
    g += `<circle cx="${f(cx)}" cy="${f(cy)}" r="7" class="dot"/></g>`;
  }
  // 2. волновые ленты внизу
  for (let b = 0; b < 3; b++) {
    const y0 = 720 + b * 85;
    for (let i = 0; i < 6; i++) {
      const amp = 20 + r() * 55, fr = (1 + r() * 2) * 2 * Math.PI / (700 + r() * 500), p = r() * 6.28;
      let d = `M-20 ${f(y0 + i * 9)}`;
      for (let x = 0; x <= 1620; x += 20) d += ` L${x} ${f(y0 + i * 9 + amp * Math.sin(fr * x + p))}`;
      g += `<path d="${d}" class="c${(i % 3) + 1}"/>`;
    }
  }
  // 3. созвездие частиц
  const pts = [];
  for (let i = 0; i < 80; i++) pts.push([r() * 1600, r() * 1000]);
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
    if (d < 150) g += `<line x1="${f(pts[i][0])}" y1="${f(pts[i][1])}" x2="${f(pts[j][0])}" y2="${f(pts[j][1])}" class="c1" style="opacity:${f(1 - d / 150)}"/>`;
  }
  for (const [x, y] of pts) g += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(1 + r() * 1.8)}" class="pt"/>`;
  // 4. перспективная сетка (пол) в нижней правой четверти
  const vx = 1150, vy = 640;
  for (let i = 0; i < 9; i++) g += `<line x1="${f(vx + (i - 4) * 260)}" y1="1000" x2="${f(vx)}" y2="${vy}" class="c2" style="opacity:.6"/>`;
  for (let j = 1; j <= 7; j++) { const y = vy + Math.pow(j / 7, 2) * 360; g += `<line x1="0" y1="${f(y)}" x2="1600" y2="${f(y)}" class="c2" style="opacity:${f(0.15 + j / 14)}"/>`; }
  const host = $('#bgArt');
  if (host) host.innerHTML = `<svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">${g}</svg>`;

  // шапка: длинные ленты и точки, растянуты по ширине
  let h = '';
  for (let i = 0; i < 4; i++) {
    const amp = 10 + r() * 14, fr = (1 + r() * 3) * 2 * Math.PI / 1600, p = r() * 6.28, y0 = 14 + i * 7;
    let d = `M0 ${f(y0)}`;
    for (let x = 0; x <= 1600; x += 16) d += ` L${x} ${f(y0 + amp * Math.sin(fr * x + p))}`;
    h += `<path d="${d}" class="c${(i % 3) + 1}"/>`;
  }
  for (let i = 0; i < 90; i++) h += `<circle cx="${f(r() * 1600)}" cy="${f(r() * 60)}" r="${f(0.8 + r() * 1.2)}" class="pt"/>`;
  const bar = $('#barArt');
  if (bar) bar.innerHTML = `<svg viewBox="0 0 1600 60" preserveAspectRatio="none">${h}</svg>`;
}

async function boot() {
  paintArt();
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
  render();
  tickLive();
  setInterval(tickLive, 15000);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (S.theme === 'auto') render();
  });
}

boot();

/* ── полноэкранный режим: кнопка в шапке и клавиша F ───────────── */
(function fullscreen() {
  const btn = document.getElementById('fsBtn');
  if (!btn) return;
  const root = document.documentElement;
  const supported = !!(root.requestFullscreen || root.webkitRequestFullscreen);
  const isOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement) || root.classList.contains('fs-on');
  const sync = () => {
    const on = isOn();
    btn.setAttribute('aria-label', on ? 'Выйти из полноэкранного режима' : 'Развернуть на весь экран');
    btn.title = on ? 'Выйти из полноэкранного режима (Esc)' : 'Во весь экран (F)';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  const enter = () => {
    const el = root;
    if (el.requestFullscreen) return el.requestFullscreen().catch(() => { root.classList.add('fs-on'); sync(); });
    if (el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); return; }
    root.classList.add('fs-on');   // запасной вариант: без API — растянуть на окно
    sync();
  };
  const exit = () => {
    if (document.fullscreenElement && document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitFullscreenElement && document.webkitExitFullscreen) return document.webkitExitFullscreen();
    root.classList.remove('fs-on');
    sync();
  };
  const toggle = () => (isOn() ? exit() : enter());
  btn.addEventListener('click', toggle);
  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) toggle();
  });
  document.addEventListener('fullscreenchange', () => { root.classList.toggle('fs-on', false); sync(); });
  document.addEventListener('webkitfullscreenchange', sync);
  if (!supported) btn.hidden = false;
  sync();
})();
