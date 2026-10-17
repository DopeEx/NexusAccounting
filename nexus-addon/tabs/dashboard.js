// Dashboard tab (default): empire bird's-eye view — active missions and fleet
// slots, running research, and per-colony construction, ship queues and hangar
// fleet. Data comes from the background's GET_DASHBOARD_OVERVIEW; countdowns
// tick locally every second, the data itself is re-fetched on a slower interval
// and whenever a countdown reaches zero.

import { fmt } from '../common.js';
import { AUTOMATIONS } from '../human-verification.js';

const REFRESH_MS = 60000;
const CLASS_COLORS = { combat: '#ff7b72', utility: '#58a6ff', civilian: '#e3b341', recon: '#56d364', special: '#bc8cff', other: '#6e7681' };
const RES_KEYS = [
  ['ore', 'Ore', 'ore'], ['silicates', 'Silicates', 'silicates'],
  ['hydrogen', 'Hydrogen', 'hydrogen'], ['alloys', 'Alloys', 'alloys'],
];

let started = false;
let data = null;
let loading = false;
let tickers = [];
let refreshAt = 0;

const root = () => document.getElementById('dashboard-content');
const visible = () => root() && root().style.display !== 'none';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'done';
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  if (d) return `${d}d ${h}h ${p(m)}m`;
  if (h) return `${h}h ${p(m)}m ${p(sec)}s`;
  if (m) return `${m}m ${p(sec)}s`;
  return `${sec}s`;
}

function countdown(endsAt) {
  const span = el('span', 'ov-countdown');
  const target = new Date(endsAt).getTime();
  const update = () => { span.textContent = `⏱ ${fmtCountdown(target - Date.now())}`; };
  update();
  tickers.push({ update, target });
  return span;
}

function section(title) {
  const box = el('section', 'dashboard-panel');
  box.appendChild(el('div', 'section-label dashboard-section-label', title));
  return box;
}

function kv(label, value, cls) {
  const row = el('div', 'ov-kv');
  row.append(el('span', 'ov-kv-label', label), el('span', `ov-kv-value ${cls || ''}`, value));
  return row;
}

function bar(fraction, color) {
  const track = el('div', 'ov-bar');
  const fill = el('div', 'ov-bar-fill');
  fill.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  fill.style.background = color;
  track.appendChild(fill);
  return track;
}

function idle(title, text) {
  const box = el('div', 'ov-idle');
  box.append(el('b', null, title));
  if (text) box.append(el('span', null, text));
  return box;
}

const RARE_KEYS = [
  ['cryoIce', 'Cryo-Ice'], ['quantumDust', 'Quantum Dust'], ['plasmaCore', 'Plasma Core'],
  ['bioExtract', 'Bio-Extract'], ['darkMatter', 'Dark Matter'], ['antimatter', 'Antimatter'],
];

function statCard(label, cls, value, rate) {
  const card = el('div', `stat-card ${cls}`);
  card.append(el('div', 'label', label), el('div', 'value', fmt(value)));
  if (rate) card.appendChild(el('div', 'ov-dim ov-res-rate',   `${rate > 0 ? '+' : ''}${fmt(rate)}/h`));
  return card;
}

// Sum of stock and hourly production across every colony.
function totalsPanel(d) {
  const all = [...d.planets, ...(d.moons || [])];
  const sum = key => all.reduce((s, p) => s + (p.resources[key] || 0), 0);
  const panel = el('section', 'dashboard-panel global-overview-panel ov-totals');
  const head = el('div', 'ov-totals-head');
  head.append(el('div', 'section-label dashboard-section-label', 'Total resources'),
    el('span', 'ov-dim', `across ${d.planets.length} planets${d.moons?.length ? ` + ${d.moons.length} moons` : ''}`));
  panel.appendChild(head);

  const row = el('div', 'stats ov-stats');
  for (const [key, label, cls] of RES_KEYS) {
    row.appendChild(statCard(label, cls, sum(key), sum(`${key}Rate`)));
  }
  for (const [key, label] of RARE_KEYS) {
    row.appendChild(statCard(label, key, sum(key), sum(`${key}Rate`)));
  }
  row.style.setProperty('--n', row.children.length);
  panel.appendChild(row);
  return panel;
}

function missionEta(m) {
  const t = [m.arrivesAt, m.returnArrivesAt]
    .map(x => (x ? new Date(x).getTime() : null))
    .filter(x => x && x > Date.now());
  return t.length ? Math.min(...t) : null;
}

function missionStage(m) {
  const now = Date.now();
  const arr = m.arrivesAt ? new Date(m.arrivesAt).getTime() : null;
  const ret = m.returnDepartsAt ? new Date(m.returnDepartsAt).getTime() : null;
  if (arr && now < arr) return 'Outbound';
  if (ret && now < ret) return 'On site';
  return 'Returning';
}

function missionsCard(d) {
  const card = section('Active Missions');
  const missions = d.missions;
  const etas = missions.map(missionEta).filter(Boolean).sort((a, b) => a - b);
  card.appendChild(kv('Total active', String(missions.length)));
  const next = el('div', 'ov-kv');
  next.appendChild(el('span', 'ov-kv-label', 'Next arrival'));
  if (etas.length) {
    const v = el('span', 'ov-kv-value ov-warn');
    v.appendChild(countdown(new Date(etas[0]).toISOString()));
    next.appendChild(v);
  } else {
    next.appendChild(el('span', 'ov-kv-value ov-dim', '-'));
  }
  card.appendChild(next);
  const max = d.maxFleetSlots;
  card.appendChild(bar(max ? missions.length / max : 0, '#38bdf8'));
  card.appendChild(el('div', 'ov-hint', `${missions.length} / ${max ?? '?'} fleet slots used`));

  if (missions.length) {
    const groups = new Map();
    for (const m of missions) {
      const g = groups.get(m.type) || { type: m.type, fleets: 0, ships: 0, stages: {}, eta: null };
      g.fleets++;
      g.ships += m.ships || 0;
      const st = missionStage(m);
      g.stages[st] = (g.stages[st] || 0) + 1;
      const eta = missionEta(m);
      if (eta && (!g.eta || eta < g.eta)) g.eta = eta;
      groups.set(m.type, g);
    }
    const list = el('div', 'ov-list');
    for (const g of [...groups.values()].sort((a, b) => (a.eta || Infinity) - (b.eta || Infinity))) {
      const row = el('div', 'ov-row');
      const label = el('span', 'ov-row-name', `${g.type.replace(/_/g, ' ')} · ${g.fleets} ${g.fleets === 1 ? 'fleet' : 'fleets'} · ${g.ships.toLocaleString()} ships`);
      const right = el('span', 'ov-row-right');
      right.appendChild(el('span', 'ov-dim', Object.entries(g.stages).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ')));
      if (g.eta) right.appendChild(countdown(new Date(g.eta).toISOString()));
      row.append(label, right);
      list.appendChild(row);
    }
    card.appendChild(list);
  }
  return card;
}

function researchCard(d) {
  const card = section('Research');
  card.appendChild(kv('Running', `${d.research.length} / ${d.researchSlots}`));
  if (!d.research.length) {
    card.appendChild(idle('Research idle', 'No research is currently running.'));
    return card;
  }
  const list = el('div', 'ov-list');
  for (const r of d.research) {
    const row = el('div', 'ov-row');
    const name = el('span', 'ov-row-name', r.name);
    if (r.level != null) name.appendChild(el('span', 'ov-dim', ` Lv.${r.level}`));
    if (r.planetName) name.appendChild(el('span', 'ov-dim', ` · ${r.planetName}`));
    row.append(name, countdown(r.endsAt));
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function empireCard(d) {
  const card = section('Empire Status');
  const hangar = [...d.planets, ...(d.moons || [])].reduce((s, p) => s + p.fleet.total, 0);
  const flying = d.missions.reduce((s, m) => s + m.ships, 0);
  const all = [...d.planets, ...(d.moons || [])];
  const sum = (list, f) => list.reduce((s, p) => s + (f(p) || 0), 0);
  const withSlots = all.filter(p => p.buildSlots?.max != null);
  const queued = d.planets.filter(p => p.queueMax != null);
  const fullList = [];
  for (const p of all) {
    const near = [];
    for (const [key, label] of RES_KEYS) {
      const cap = p.resources[`${key}Storage`];
      if (cap && p.resources[key] >= cap * 0.9) near.push([label, p.resources[key], cap]);
    }
    const rareCap = p.resources.rareStorage;
    if (rareCap) {
      for (const [key, label] of RARE_KEYS) {
        if (p.resources[key] >= rareCap * 0.9) near.push([label, p.resources[key], rareCap]);
      }
    }
    for (const [label, have, cap] of near) {
      fullList.push(`${p.name}${p.isMoon ? ' (moon)' : ''} · ${label}: ${Math.floor(have / cap * 100)}% (${fmt(have)} / ${fmt(cap)})`);
    }
  }
  const full = new Set(fullList.map(s => s.split(' · ')[0])).size;
  const popMax = sum(d.planets, p => p.maxPopulation);

  const list = el('div', 'ov-kv-row ov-empire');
  list.append(
    kv('Colonies', fmt(d.planets.length)),
    kv('Moons', fmt(d.moons?.length || 0)),
    kv('Ships', `${fmt(hangar + flying)} (${fmt(hangar)} docked · ${fmt(flying)} flying)`),
  );
  if (popMax) list.appendChild(kv('Population', `${fmt(sum(d.planets, p => p.population))} / ${fmt(popMax)}`));
  if (withSlots.length) list.appendChild(kv('Building slots', `${sum(withSlots, p => p.buildSlots.used)}/${sum(withSlots, p => p.buildSlots.max)}`));
  if (queued.length) {
    const busy = queued.filter(p => p.construction.length).length;
    list.appendChild(kv('Planets building', `${busy}/${queued.length}`, busy < queued.length ? 'ov-warn' : ''));
  }
  const fullRow = kv('Storage almost full', fmt(full), full ? 'ov-warn' : '');
  if (fullList.length) fullRow.title = fullList.join('\n');
  list.appendChild(fullRow);
  card.appendChild(list);
  return card;
}

function planetCard(p, research) {
  const card = el('section', 'dashboard-panel ov-planet');
  const head = el('div', 'ov-planet-head');
  const title = el('div');
  title.append(el('div', 'ov-planet-name', p.name),
    el('div', 'ov-dim ov-planet-sub', [p.systemName, p.planetType].filter(Boolean).join(' · ') || 'Unknown system'));
  head.appendChild(title);
  if (p.isHomeworld || p.isMoon) head.appendChild(el('span', 'ov-badge', p.isMoon ? 'Moon' : 'Homeworld'));
  card.appendChild(head);

  const stats = el('div', 'ov-kv-row');
  if (p.buildSlots.max != null) stats.appendChild(kv('Building slots', `${p.buildSlots.used}/${p.buildSlots.max}`));
  if (p.maxPopulation) {
    const row = kv('Population', `${fmt(p.population)} / ${fmt(p.maxPopulation)}`);
    const rate = p.populationRate;
    if (p.population >= p.maxPopulation) row.title = 'Population is full';
    else if (rate > 0) row.title = `+${fmt(rate)}/h · full in ${fmtCountdown((p.maxPopulation - p.population) / rate * 3600000)}`;
    stats.appendChild(row);
  }
  if (stats.childElementCount) card.appendChild(stats);

  const res = el('div', 'ov-res');
  for (const [key, label, cls] of RES_KEYS) {
    const r = el('div', 'ov-res-item');
    const rate = p.resources[`${key}Rate`];
    const cap = p.resources[`${key}Storage`];
    if (cap) {
      const have = p.resources[key];
      if (have >= cap) r.title = `Storage ${fmt(cap)} · full`;
      else if (rate > 0) r.title = `Storage ${fmt(cap)} · full in ${fmtCountdown((cap - have) / rate * 3600000)}`;
      else r.title = `Storage ${fmt(cap)}`;
    }
    r.append(el('span', 'ov-kv-label', label), el('b', cls, fmt(p.resources[key])),
      el('span', 'ov-dim ov-res-rate', rate ? `${rate > 0 ? '+' : ''}${fmt(rate)}/h` : ''));
    res.appendChild(r);
  }
  card.appendChild(res);

  const rares = RARE_KEYS.filter(([key]) => p.resources[key] > 0 || p.resources[`${key}Rate`] > 0);
  if (rares.length) {
    const rareRow = el('div', 'ov-rares');
    const cap = p.resources.rareStorage;
    for (const [key, label] of rares) {
      const rate = p.resources[`${key}Rate`];
      const have = p.resources[key];
      const item = el('span', 'ov-rare-item');
      item.append(el('span', 'ov-dim', label), el('b', key, fmt(have)));
      if (rate) item.appendChild(el('span', 'ov-dim', `${rate > 0 ? '+' : ''}${fmt(rate)}/h`));
      if (cap) {
        if (have >= cap) item.title = `Storage ${fmt(cap)} · full`;
        else if (rate > 0) item.title = `Storage ${fmt(cap)} · full in ${fmtCountdown((cap - have) / rate * 3600000)}`;
        else item.title = `Storage ${fmt(cap)}`;
      }
      rareRow.appendChild(item);
    }
    card.appendChild(rareRow);
  }

  const running = (research || []).filter(r => r.planetId === p.id);
  if (running.length || p.hasLab) {
    card.appendChild(el('div', 'ov-sub', 'Research'));
    if (!running.length) card.appendChild(idle('Research idle', 'No research is running on this planet.'));
    const list = el('div', 'ov-list');
    for (const r of running) {
      const row = el('div', 'ov-row');
      const name = el('span', 'ov-row-name', r.name);
      if (r.level != null) name.appendChild(el('span', 'ov-dim', ` Lv.${r.level}`));
      row.append(name, countdown(r.endsAt));
      list.appendChild(row);
    }
    card.appendChild(list);
  }
  const qHead = p.isMoon || p.queueMax == null ? 'Construction' : `Construction ${p.construction.length}/${p.queueMax}`;
  card.appendChild(el('div', 'ov-sub', qHead));
  if (p.construction.length) {
    const list = el('div', 'ov-list');
    for (const c of p.construction) {
      const row = el('div', 'ov-row');
      const name = el('span', 'ov-row-name', c.name);
      name.appendChild(el('span', 'ov-dim', ` Lv.${c.level}`));
      row.append(name, c.endsAt ? countdown(c.endsAt) : el('span', 'ov-dim', 'Queued'));
      list.appendChild(row);
    }
    card.appendChild(list);
  } else {
    card.appendChild(idle('Queue idle', 'No buildings are currently upgrading.'));
  }
  for (const y of p.shipYards || []) {
    if (!y.items.length) continue;
    card.appendChild(el('div', 'ov-sub', `${y.label} ${y.items.length}/${y.max}`));
    const list = el('div', 'ov-list');
    for (const s of y.items) {
      const row = el('div', 'ov-row');
      row.append(el('span', 'ov-row-name', `${s.repair ? 'Repair ' : ''}${s.quantity}× ${s.name}`),
        s.endsAt ? countdown(s.endsAt) : el('span', 'ov-dim', 'Queued'));
      list.appendChild(row);
    }
    card.appendChild(list);
  }

  const fleetHead = el('div', 'ov-sub ov-fleet-head');
  fleetHead.append(el('span', null, 'Hangar fleet'), el('b', null, `${p.fleet.total.toLocaleString()} ships`));
  card.appendChild(fleetHead);
  const split = el('div', 'ov-split');
  const legend = el('div', 'ov-legend');
  for (const [cls, qty] of Object.entries(p.fleet.classes).sort((a, b) => b[1] - a[1])) {
    if (!qty) continue;
    const seg = el('div', 'ov-split-seg');
    seg.style.flex = String(qty);
    seg.style.background = CLASS_COLORS[cls] || CLASS_COLORS.other;
    seg.title = `${cls}: ${qty.toLocaleString()}`;
    split.appendChild(seg);
    const item = el('span', 'ov-legend-item');
    const dot = el('i', 'ov-legend-dot');
    dot.style.background = CLASS_COLORS[cls] || CLASS_COLORS.other;
    item.append(dot, document.createTextNode(`${cls} ${qty.toLocaleString()}`));
    legend.appendChild(item);
  }
  if (!split.childElementCount) split.classList.add('empty');
  card.append(split, legend);
  return card;
}

function actionsBar() {
  const bar = el('div', 'status-bar show ov-statusbar');
  const stamp = el('span', null, data?.fetchedAt ? `Last refresh: ${new Date(data.fetchedAt).toLocaleString()}` : '');
  const btn = el('button', null, loading ? 'Refreshing…' : 'Refresh');
  btn.disabled = loading;
  btn.addEventListener('click', () => load(false));
  bar.append(stamp, btn);
  return bar;
}

// The automation controls live in the expert tabs; this box mirrors their main switch and status.

const expertMode = () => document.body.classList.contains('expert-mode');

function automationText(statusId) {
  const text = (document.getElementById(statusId)?.textContent || '').trim();
  return text.replace(/^Status:\s*/i, '').replace(/^-$/, '') || 'No status yet';
}

function automationsPanel() {
  const box = section('Automations');
  box.id = 'ov-automations';
  const list = el('div', 'ov-auto-list');
  for (const [label, boxId, statusId] of AUTOMATIONS) {
    const row = el('div', 'ov-auto-row');
    const sw = el('input', 'm-switch');
    sw.type = 'checkbox';
    sw.title = `Toggle ${label.toLowerCase()}`;
    sw.addEventListener('change', () => {
      const source = document.getElementById(boxId);
      if (!source || source.disabled) { sw.checked = !sw.checked; return; }
      source.checked = sw.checked;
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const text = el('div', 'ov-auto-text');
    text.append(el('span', 'ov-auto-name', label), el('span', 'ov-auto-status ov-dim'));
    row.append(sw, text);
    row.dataset.box = boxId;
    row.dataset.status = statusId;
    list.appendChild(row);
  }
  box.appendChild(list);
  return box;
}

function syncAutomations() {
  const panel = document.getElementById('ov-automations');
  if (!panel) return;
  panel.style.display = expertMode() ? '' : 'none';
  if (!expertMode()) return;
  for (const row of panel.querySelectorAll('.ov-auto-row')) {
    const source = document.getElementById(row.dataset.box);
    const sw = row.querySelector('.m-switch');
    const on = !!source?.checked;
    sw.checked = on;
    sw.disabled = !source || source.disabled;
    row.classList.toggle('on', on);
    const status = row.querySelector('.ov-auto-status');
    const msg = automationText(row.dataset.status);
    if (status.textContent !== msg) status.textContent = msg;
    status.title = msg;
  }
}

function render() {
  const host = root();
  if (!host) return;
  tickers = [];
  host.textContent = '';
  host.appendChild(actionsBar());
  host.appendChild(automationsPanel());
  syncAutomations();

  if (!data || data.error) {
    const panel = el('section', 'dashboard-panel global-overview-panel ov-totals');
    const head = el('div', 'ov-totals-head');
    head.append(el('div', 'section-label dashboard-section-label', 'Dashboard'));
    const msg = !data
      ? el('div', 'ov-empty', 'Loading…')
      : el('div', 'ov-empty ov-error', `Could not load data: ${data.error}. Is the game open and are you logged in?`);
    panel.append(head, msg);
    host.appendChild(panel);
    return;
  }

  host.appendChild(totalsPanel(data));

  const top = el('div', 'ov-top');
  top.append(missionsCard(data), researchCard(data), empireCard(data));
  host.appendChild(top);

  const grid = el('div', 'ov-planets');
  for (const p of [...data.planets, ...(data.moons || [])]) grid.appendChild(planetCard(p, data.research));
  host.appendChild(grid);
}

// Automatic refreshes are polite (keep extra rate-limit headroom); the manual button is not.
async function load(polite = true) {
  if (loading) return;
  loading = true;
  if (data) render();
  try {
    const res = await browser.runtime.sendMessage({ type: 'GET_DASHBOARD_OVERVIEW', polite });
    data = res || { error: 'No response from background.' };
  } catch (err) {
    data = { error: err.message };
  }
  loading = false;
  refreshAt = Date.now() + REFRESH_MS;
  render();
}

function tick() {
  if (!visible()) return;
  syncAutomations();
  let finished = false;
  for (const t of tickers) {
    t.update();
    if (t.target <= Date.now() && !t.done) { t.done = true; finished = true; }
  }
  if ((finished || Date.now() >= refreshAt) && !loading && !document.hidden) load();
}

export function initDashboardTab() {
  if (!started) {
    started = true;
    render();
    setInterval(tick, 1000);
    load();
    return;
  }
  syncAutomations();
  if (Date.now() >= refreshAt) load();
}
