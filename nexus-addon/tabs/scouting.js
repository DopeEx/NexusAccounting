// Scouting tab: launch probe surveys at the nearest un-surveyed system, and
// list anomalies awaiting investigation with a one-click investigate fleet.
//
// Survey:      POST /api/fleet/survey         { sourcePlanetId, targetSystemId, ships }
// Investigate: POST /api/fleet/investigate    { sourcePlanetId, reportId, ships }
// Collect:     POST /api/fleet/collect-debris { sourcePlanetId, debrisId, ships }
// All routed through the game tab (same-origin) like the asteroid mine call.

import { loadFleetTemplates } from './fleets.js';
import { applySort, attachSortable, confirmDialog, fmtCountdown, fuelEstimate, missionProgress, rememberSelection, rememberedSelections, setStatusMessage, store, setStatusText, ZONE_COLORS } from '../common.js';

let inited = false;
let scPlanets = [];          // [{ id, name, systemId, systemName }]
let scSystems = {};          // systemId → { x, y, name, zone }
let scTemplates = [];

const ZONES = ['sentinel', 'open', 'dead', 'rift'];
const scZoneFilter = new Set();   // empty = any zone
let scPending = [];               // anomalies awaiting investigation
let scReturning = [];             // investigated systems whose fleet is still homebound
let scInvestigating = new Set();  // systemIds with an investigate mission in flight
const scJustSurveyed = new Set(); // systemIds surveyed this session — the missions API lags, so exclude them locally
const scJustInvestigated = new Set(); // same, for investigate missions
let scTick = 0;
let scMissions = [];
let scLastRefreshAt = null;
const maxMissions = 1; // in-flight survey/investigate/collect fleets
let scAutoScanRunning = false;
let scAutoInvestigateRunning = false;
let scAutoSalvageRunning = false;
let scAutoDebrisRunning = false;

// automations are disabled when human verification is required.
function disableAutomaticsOnHumanCheck() {
  const ids = ['sc-auto', 'sc-investigate-auto', 'sc-debris-auto', 'sc-salvage-auto'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.checked = false;
    el.disabled = true;
    rememberSelection(id, false);
  }
}

export function resetScoutingTab() {
  inited = false;
  scPlanets = [];
  scSystems = {};
  scPending = [];
  scReturning = [];
  scInvestigating = new Set();
  scJustSurveyed.clear();
  scJustInvestigated.clear();
  scTick = 0;
  scMissions = [];
  scLastRefreshAt = null;
  scAutoScanRunning = false;
  scAutoInvestigateRunning = false;
  scAutoSalvageRunning = false;
  scAutoDebrisRunning = false;
  scTicks.scan = [];
  scTicks.invest = [];
  scTicks.debris = [];
  scTicks.salvage = [];
}
// Per-surface bar updaters, each rebuilt by its own render. The 1s tick advances
// all of them. Keyed so one render doesn't drop another surface's tickers.
const scTicks = { scan: [], invest: [], debris: [], salvage: [] };

const MISSION_LABELS = { survey: 'Survey', investigate: 'Investigate',
  collect_debris: 'Collect Debris', collect_salvage: 'Collect Salvage' };

// The in-flight mission heading to a system for a given type (or undefined).
function findMission(type, systemId) {
  return scMissions.find(m => m.missionType === type && m.targetSystemId === systemId);
}

// Scanning (survey) fleets have no table of their own, so list them here.
// Investigate / collect_debris / collect_salvage progress is shown inline in
// their respective tables instead.
function renderTransit() {
  const box = document.getElementById('sc-transit-list');
  if (!box) return;
  box.textContent = '';
  scTicks.scan = [];
  const surveys = scMissions.filter(m => m.missionType === 'survey');
  document.getElementById('sc-transit-count').textContent = `${surveys.length} scanning`;
  if (!surveys.length) {
    const d = document.createElement('div');
    d.className = 'sc-transit-empty';
    d.textContent = 'No scanning fleets in transit.';
    box.appendChild(d);
    return;
  }

  const missionTitle = (m) => {
    const source = m.sourceSystemName || m.sourcePlanetName || null;
    const target = m.targetSystemName || m.targetPlanetName || `#${m.targetSystemId}`;
    return source ? `${source} → ${target}` : target;
  };

  for (const m of surveys) {
    const row = document.createElement('div');
    row.className = 'sc-transit-card';

    const main = document.createElement('div');
    main.className = 'sc-mission-main sc-transit-main';

    const left = document.createElement('div');
    left.className = 'sc-transit-left';
    const icon = document.createElement('span');
    icon.className = 'sc-transit-icon';
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('div');
    text.className = 'sc-transit-text';
    const title = document.createElement('div');
    title.className = 'sc-transit-title';
    title.textContent = missionTitle(m);

    const meta = document.createElement('div');
    meta.className = 'sc-transit-meta';
    const status = document.createElement('span');
    status.className = 'sc-transit-status';
    meta.append(status);
    text.append(title, meta);
    left.append(icon, text);

    const eta = document.createElement('div');
    eta.className = 'sc-transit-eta';
    main.append(left, eta);

    const track = document.createElement('div');
    track.className = 'mission-progress-track sc-transit-track';
    const fill = document.createElement('div');
    fill.className = 'mission-progress-fill sc-transit-fill';
    track.appendChild(fill);

    row.append(main, track);
    box.appendChild(row);

    const upd = () => {
      const p = missionProgress(m);
      fill.style.width = `${(p.frac * 100).toFixed(1)}%`;
      fill.style.background = p.gradient || p.color;
      status.textContent = p.label;
      status.style.color = p.color;
      eta.textContent = p.eta > 0 ? fmtCountdown(p.eta) : '—';
    };
    upd();
    scTicks.scan.push(upd);
  }
}

export async function initScoutingTab() {
  if (inited) return;
  inited = true;
  const status = document.getElementById('sc-progress');
  setStatusText(status, 'Loading…');

  const [planets, map] = await Promise.all([
    browser.runtime.sendMessage({ type: 'GET_PLANETS' }),
    browser.runtime.sendMessage({ type: 'GET_GALAXY_MAP' }),
  ]);
  if (map.error) { setStatusText(status, `Error: ${map.error}`); inited = false; return; }
  for (const s of (map.systems || [])) {
    scSystems[s.id] = { x: s.x, y: s.y, name: s.name, zone: s.securityZone || null };
  }
  scPlanets = (planets.planets || []).filter(p => p.systemId != null);

  const pSel = document.getElementById('sc-planet');
  pSel.textContent = '';
  for (const p of scPlanets) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.systemName ? `${p.name} (${p.systemName})` : p.name;
    if (p.isHomeworld) o.selected = true;
    pSel.appendChild(o);
  }
  const savedSel = await rememberedSelections();
  if (savedSel['sc-planet'] && scPlanets.some(p => String(p.id) === savedSel['sc-planet'])) {
    pSel.value = savedSel['sc-planet'];   // remembered planet survives tabs/sessions
  }

  await loadSurveyZone();
  drawZoneToggles();
  await loadDebrisZone();
  drawDebrisZoneToggles();
  await loadInvHistory();
  await refreshTemplates();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.fleet_templates) refreshTemplates();
    if (area === 'local' && changes.nexus_active_server) {
      resetScoutingTab();
      void initScoutingTab();
    }
  });

  document.getElementById('sc-scan').addEventListener('click', launchScan);
  document.getElementById('sc-refresh').addEventListener('click', refreshScoutingData);
  document.getElementById('sc-planet').addEventListener('change', e => { rememberSelection('sc-planet', e.target.value); renderSurveys(); computeDebrisFuel(); computeSalvageFuel(); updateAvail(); });

  document.getElementById('sc-scan-template').addEventListener('change', e => rememberSelection('sc-scan-template', e.target.value));
  document.getElementById('sc-inv-template').addEventListener('change', e => { rememberSelection('sc-inv-template', e.target.value); computeFuel(); });
  document.getElementById('sc-debris-hidden').addEventListener('click', () => { scShowHidden = !scShowHidden; renderDebris(); });
  document.getElementById('sc-debris-invonly').addEventListener('change', e => { scInvestigatedOnly = e.target.checked; renderDebris(); });
  document.getElementById('sc-debris-nearest').checked = savedSel['sc-debris-nearest'] === true;
  document.getElementById('sc-debris-nearest').addEventListener('change', e => { rememberSelection('sc-debris-nearest', e.target.checked); computeDebrisFuel(); });
  document.getElementById('sc-debris-auto').checked = savedSel['sc-debris-auto'] === true;
  document.getElementById('sc-debris-auto').addEventListener('change', e => { rememberSelection('sc-debris-auto', e.target.checked); });
  document.getElementById('sc-auto').checked = savedSel['sc-auto'] === true;
  document.getElementById('sc-auto').addEventListener('change', e => { rememberSelection('sc-auto', e.target.checked); });
  document.getElementById('sc-investigate-auto').checked = savedSel['sc-investigate-auto'] === true;
  document.getElementById('sc-investigate-auto').addEventListener('change', e => { rememberSelection('sc-investigate-auto', e.target.checked); });
  document.getElementById('sc-salvage-auto').checked = savedSel['sc-salvage-auto'] === true;
  document.getElementById('sc-salvage-auto').addEventListener('change', e => { rememberSelection('sc-salvage-auto', e.target.checked); });
  for (const type of ['scan', 'investigate', 'salvage', 'debris']) {
    const id = `sc-max-${type}`;
    const input = document.getElementById(id);
    input.value = savedSel[id] || 1;
    input.addEventListener('change', e => { rememberSelection(id, e.target.value); });
  }
  for (const type of ['salvage', 'debris']) {
    const id = `sc-min-total-${type}`;
    const input = document.getElementById(id);
    input.value = savedSel[id] ?? 0;
    input.addEventListener('change', e => { rememberSelection(id, e.target.value); });
  }
  document.getElementById('sc-slot-reserve').value = savedSel['sc-slot-reserve'] || 0;
  document.getElementById('sc-slot-reserve').addEventListener('change', e => { rememberSelection('sc-slot-reserve', e.target.value); });

  await loadCargoShips();
  updateAvail();

  // Tick the countdowns every second; refetch the list every 30s. Both only
  // while the tab is visible.
  setInterval(() => {
    if (document.getElementById('scouting-content').style.display === 'none') return;
    tickTimers();
    for (const k in scTicks) for (const upd of scTicks[k]) upd();   // advance all progress bars
    if (++scTick % 10 === 0) updateAvail();       // catch returning fleets
    if (scTick % 15 === 0 && document.getElementById('sc-investigate-auto')?.checked) automateInvestigate();
    if (scTick % 15 === 0 && document.getElementById('sc-debris-auto')?.checked) automateDebris();
    if (scTick % 15 === 0 && document.getElementById('sc-salvage-auto')?.checked) automateSalvage();
    if (scTick % 15 === 0 && document.getElementById('sc-auto')?.checked) automateScouting();
    if (scTick % 30 === 0) { void refreshScoutingData(); }   // refresh the list every 30s
  }, 1000);

  setStatusText(status, '');
  refreshScoutingData();
}

function setLastRefreshTimestamp() {
  const el = document.getElementById('sc-last-refresh');
  if (!el) return;
  el.textContent = scLastRefreshAt ? `Last refresh: ${new Date(scLastRefreshAt).toLocaleString()}` : 'Last refresh: —';
}

async function refreshScoutingData() {
  await Promise.allSettled([loadActiveSurveys(), loadDebris()]);
  scLastRefreshAt = Date.now();
  setLastRefreshTimestamp();
}

function getMaxMissions(type) {
  const el = document.getElementById(`sc-max-${type}`);
  const value = el ? Number(el.value) : NaN;
  return Number.isInteger(value) && value > 0 ? value : maxMissions;
}

function getMinResourceTotal(type) {
  const el = document.getElementById(`sc-min-total-${type}`);
  const value = el ? Number(el.value) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function getReservedFleetSlots() {
  const el = document.getElementById('sc-slot-reserve');
  const value = el ? Number(el.value) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function getEffectiveMaxFleetSlots(mi) {
  if (!mi || mi.maxFleetSlots == null) return null;
  return Math.max(0, mi.maxFleetSlots - getReservedFleetSlots());
}

function reservedSlotMessage() {
  const reserve = getReservedFleetSlots();
  return reserve > 0 ? `; ${reserve} slot${reserve === 1 ? '' : 's'} reserved` : '';
}

async function automateScouting() {
  if (scAutoScanRunning) return;
  scAutoScanRunning = true;
  let maxScanCount = getMaxMissions('scan'); // default max in-flight survey fleets
  try {
    const status = document.getElementById('sc-auto-status');
    // Check salvage count - pause if too many pending salvage entries
    const res = await browser.runtime.sendMessage({ type: 'GET_SURVEY_REPORTS' });
    if (res.error) { setStatusText(status, `Error: ${res.error}`); return; }

    const now = Date.now();
    const SALVAGE_KEYS_LOCAL = ['ore', 'silicates', 'hydrogen', 'alloys', 'cryo_ice', 'quantum_dust', 'plasma_core', 'dark_matter', 'antimatter'];
    const salvagePending = (res.reports || [])
      .map(r => {
        const loot = r.uncollectedLoot || {};
        let total = 0;
        for (const k of SALVAGE_KEYS_LOCAL) { const v = loot[k] || 0; if (v) total += v; }
        return { total, expires: r.salvageExpiresAt || null };
      })
      .filter(s => s.total > 0 && (!s.expires || new Date(s.expires) > now))
      .length;

    if (salvagePending > 10) {
      setStatusText(status, `Paused: too many salvage entries to collect (${salvagePending} > 10).`);
      return;
    }

    const investigatePending = (res.reports || [])
      .filter(r => !r.investigated && (!r.anomalyExpiresAt || new Date(r.anomalyExpiresAt) > now))
      .length;
    if (investigatePending > 10) {
      setStatusText(status, `Paused: too many anomaly reports to investigate (${investigatePending} > 10).`);
      return;
    }

    // To avoid sending more fleets than maxScanCount due to race conditions,
    // re-check missions a few times with short delays before launching.
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    let launched = false;
    for (let attempt = 0; attempt < 3 && !launched; attempt++) {
      const mi = await browser.runtime.sendMessage({ type: 'GET_MISSIONS' });
      if (mi.error) { setStatusText(status, `Error: ${mi.error}`); return; }
      const maxSlots = getEffectiveMaxFleetSlots(mi);
      if (maxSlots != null && maxSlots <= (mi.missions || []).length) {
        setStatusText(status, `Cannot launch survey: ${(mi.missions || []).length}/${mi.maxFleetSlots} fleet slots in use${reservedSlotMessage()}.`, 'warning');
        return;
      }
      const inflight = new Set((mi.missions || [])
        .filter(m => m.missionType === 'survey' && m.targetSystemId != null)
        .map(m => m.targetSystemId));
      // Remove any scJustSurveyed entries that are no longer present in missions
      // (they finished); keep only those still actually inflight to avoid
      // permanently blocking slots when missions complete.
      for (const id of Array.from(scJustSurveyed)) {
        if (inflight.has(id)) continue;
        scJustSurveyed.delete(id);
      }
      // Add remaining just-surveyed ids (only those that still appear inflight)
      for (const id of scJustSurveyed) inflight.add(id);
      const scanCount = inflight.size;
      if (scanCount >= maxScanCount) {
        setStatusText(status, `Waiting for an available fleet slot… ${scanCount}/${maxScanCount} scanning fleets in flight.`);
        // if last attempt, give up; otherwise wait and retry
        if (attempt === 2) return;
        await sleep(1000);
        continue;
      }
      // launch and assume success; if it fails, launchScan will set status
      await launchScan();
      launched = true;
    }
  } finally {
    scAutoScanRunning = false;
  }
}

async function automateInvestigate() {
  if (scAutoInvestigateRunning) return;
  scAutoInvestigateRunning = true;
  let maxInvCount = getMaxMissions('investigate'); // default max in-flight investigate fleets
  try {
    const status = document.getElementById('sc-investigate-status');
    const [mi, res] = await Promise.all([
      browser.runtime.sendMessage({ type: 'GET_MISSIONS' }),
      browser.runtime.sendMessage({ type: 'GET_SURVEY_REPORTS' }),
    ]);
    if (mi.error) { setStatusText(status, `Error: ${mi.error}`); return; }
    if (res.error) { setStatusText(status, `Error: ${res.error}`); return; }

    const maxSlots = getEffectiveMaxFleetSlots(mi);
    if (maxSlots != null && maxSlots <= (mi.missions || []).length) {
      setStatusText(status, `Cannot launch investigation: ${(mi.missions || []).length}/${mi.maxFleetSlots} fleet slots in use${reservedSlotMessage()}.`); return;
    }

    const invCount = (mi.missions || []).filter(m => m.missionType === 'investigate').length;
    if (invCount >= maxInvCount) {
      setStatusText(status, `Waiting for an available investigation fleet slot… ${invCount}/${maxInvCount} investigate fleets in flight.`);
      return;
    }

    const inflight = new Set((mi.missions || [])
      .filter(m => m.missionType === 'investigate' && m.targetSystemId != null)
      .map(m => m.targetSystemId));
    for (const id of scJustInvestigated) inflight.add(id);

    const now = Date.now();
    const pending = (res.reports || [])
      .filter(r => !r.investigated && (!r.anomalyExpiresAt || new Date(r.anomalyExpiresAt) > now)
        && r.systemId != null && !inflight.has(r.systemId))
      .sort((a, b) => {
        const ta = a.createdAt ? Date.parse(a.createdAt) : Infinity;
        const tb = b.createdAt ? Date.parse(b.createdAt) : Infinity;
        return ta - tb;
      });

    if (!pending.length) {
      setStatusText(status, 'No pending anomaly reports to investigate.');
      return;
    }
    await investigate(pending[0]);
  } finally {
    scAutoInvestigateRunning = false;
  }
}

async function automateSalvage() {
  if (scAutoSalvageRunning) return;
  scAutoSalvageRunning = true;
  let maxSalvCount = getMaxMissions('salvage'); // default max in-flight salvage fleets
  const minSalvageTotal = getMinResourceTotal('salvage');
  try {
    const status = document.getElementById('sc-salvage-status');
    const [mi, res] = await Promise.all([
      browser.runtime.sendMessage({ type: 'GET_MISSIONS' }),
      browser.runtime.sendMessage({ type: 'GET_SURVEY_REPORTS' }),
    ]);
    if (mi.error) { setStatusText(status, `Error: ${mi.error}`); return; }
    if (res.error) { setStatusText(status, `Error: ${res.error}`); return; }

    const maxSlots = getEffectiveMaxFleetSlots(mi);
    if (maxSlots != null && maxSlots <= (mi.missions || []).length) {
      setStatusText(status, `Cannot launch salvage: ${(mi.missions || []).length}/${mi.maxFleetSlots} fleet slots in use${reservedSlotMessage()}.`); return;
    }

    const salvCount = (mi.missions || []).filter(m => m.missionType === 'collect_salvage').length;
    if (salvCount >= maxSalvCount) {
      setStatusText(status, `Waiting for an available salvage fleet slot… ${salvCount}/${maxSalvCount} collect_salvage fleets in flight.`);
      return;
    }

    const inflight = new Set((mi.missions || [])
      .filter(m => m.missionType === 'collect_salvage' && m.targetSystemId != null)
      .map(m => m.targetSystemId));
    for (const id of scJustSalvaged) inflight.add(id);

    const now = Date.now();
    const SALVAGE_KEYS_LOCAL = ['ore', 'silicates', 'hydrogen', 'alloys', 'cryo_ice', 'quantum_dust', 'plasma_core', 'dark_matter', 'antimatter'];
    const pending = (res.reports || [])
      .map(r => {
        const loot = r.uncollectedLoot || {};
        let total = 0;
        for (const k of SALVAGE_KEYS_LOCAL) { const v = loot[k] || 0; if (v) total += v; }
        return { reportId: r.id, systemId: r.systemId, system: r.systemName || `#${r.systemId}`, zone: r.securityZone || null, total, expires: r.salvageExpiresAt || null, res: loot };
      })
      .filter(s => s.total >= minSalvageTotal && s.total > 0
        && (!s.expires || new Date(s.expires) > now) && s.systemId != null && !inflight.has(s.systemId))
      .sort((a, b) => b.total - a.total);

    if (!pending.length) { setStatusText(status, 'No uncollected salvage to collect.'); return; }

    // avoid sending two fleets to the same salvage: re-check missions a few times with short delays
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    let chosen = pending[0];
    for (let attempt = 0; attempt < 3; attempt++) {
      // refresh missions to see if someone else took this salvage
      const mi2 = await browser.runtime.sendMessage({ type: 'GET_MISSIONS' });
      if (mi2 && !mi2.error) {
        const inflight2 = new Set((mi2.missions || [])
          .filter(m => m.missionType === 'collect_salvage' && m.targetSystemId != null)
          .map(m => m.targetSystemId));
        for (const id of scJustSalvaged) inflight2.add(id);
        if (inflight2.has(chosen.systemId)) {
          // chosen target already taken, pick next available
          chosen = pending.find(p => !inflight2.has(p.systemId));
          if (!chosen) { setStatusText(status, 'No uncollected salvage to collect (targets taken).'); return; }
        }
      }
      // if last attempt or chosen not taken, break
      if (attempt === 2 || !(await (() => false)())) break; // no-op to allow loop to check attempts
      await sleep(1000);
    }

    await collectSalvage(chosen);
  } finally {
    scAutoSalvageRunning = false;
  }
}

async function automateDebris() {
  if (scAutoDebrisRunning) return;
  scAutoDebrisRunning = true;
  const maxDebrisCount = getMaxMissions('debris');
  const minDebrisTotal = getMinResourceTotal('debris');
  try {
    const status = document.getElementById('sc-debris-status');
    const mi = await browser.runtime.sendMessage({ type: 'GET_MISSIONS' });
    if (mi.error) { setStatusText(status, `Error: ${mi.error}`); return; }

    const maxSlots = getEffectiveMaxFleetSlots(mi);
    if (maxSlots != null && maxSlots <= (mi.missions || []).length) {
      setStatusText(status, `Cannot launch debris collection: ${(mi.missions || []).length}/${mi.maxFleetSlots} fleet slots in use${reservedSlotMessage()}.`);
      return;
    }

    const collecting = (mi.missions || []).filter(m => m.missionType === 'collect_debris');
    if (collecting.length >= maxDebrisCount) {
      setStatusText(status, `Waiting for an available debris fleet slot… ${collecting.length}/${maxDebrisCount} collect_debris fleets in flight.`);
      return;
    }

    const inflight = new Set(collecting.map(m => m.targetSystemId).filter(id => id != null));
    for (const systemId of scCollecting.keys()) inflight.add(systemId);
    const { debris_fields } = await browser.storage.local.get('debris_fields');
    const now = Date.now();
    const pending = (debris_fields || [])
      .map(field => ({ ...field, total: (field.ore || 0) + (field.silicates || 0) + (field.alloys || 0) }))
      .filter(field => field.debrisId != null && field.systemId != null && field.total >= minDebrisTotal && field.total > 0
        && (!field.expires || new Date(field.expires) > now)
        && !inflight.has(field.systemId) && !scJustCollected.has(field.debrisId))
      .sort((a, b) => b.total - a.total);
    if (!pending.length) { setStatusText(status, 'No uncollected debris to collect.'); return; }

    setStatusText(status, `Collecting debris at ${pending[0].system}…`);
    await collectDebris(pending[0], true);
  } finally {
    scAutoDebrisRunning = false;
  }
}


async function refreshTemplates() {
  scTemplates = await loadFleetTemplates();
  scTemplates.sort((a, b) => (a.name || '').localeCompare(b.name || ''));   // alphabetical dropdowns
  const saved = await rememberedSelections();
  for (const id of ['sc-scan-template', 'sc-inv-template']) {
    const sel = document.getElementById(id);
    const want = saved[id] || sel.value;   // remembered choice survives tabs/sessions
    sel.textContent = '';
    if (!scTemplates.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '— none (create in Fleet Templates) —';
      sel.appendChild(o);
      continue;
    }
    for (const t of scTemplates) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name;
      sel.appendChild(o);
    }
    if (want && scTemplates.some(t => String(t.id) === want)) sel.value = want;
  }
}

// Resolve a template's ships, capped to what the source planet actually has.
// Returns { ships, short } or { error }.
async function templateShips(templateId, planetId) {
  const tpl = scTemplates.find(t => String(t.id) === templateId);
  if (!tpl) return { error: 'No fleet template selected — create one in Fleet Templates.' };
  const wanted = Object.entries(tpl.ships || {})
    .map(([shipDefId, quantity]) => ({ shipDefId: Number(shipDefId), quantity }))
    .filter(s => s.quantity > 0);
  if (!wanted.length) return { error: `Template "${tpl.name}" has no ships.` };

  const av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId });
  if (av.error) return { error: av.error };
  const ships = wanted
    .map(s => ({ shipDefId: s.shipDefId, quantity: Math.min(s.quantity, av.available[s.shipDefId] || 0) }))
    .filter(s => s.quantity > 0);
  if (!ships.length) return { error: `None of template "${tpl.name}"'s ships are on this planet.` };
  return { ships, short: wanted.some(s => (av.available[s.shipDefId] || 0) < s.quantity), name: tpl.name };
}

// Clickable zone toggles, coloured per zone (mirrors the Asteroids filter).
// Empty selection means any zone. `redraw` re-renders this set, `onChange` runs
// extra side effects (e.g. re-filter the debris table).
function drawToggles(boxId, filter, redraw, onChange) {
  const box = document.getElementById(boxId);
  box.textContent = '';
  for (const z of ZONES) {
    const b = document.createElement('button');
    const on = filter.has(z);
    b.type = 'button';
    b.className = `zone-toggle zone-${z}${on ? ' is-selected' : ''}`;
    b.textContent = z;
    b.addEventListener('click', () => {
      if (on) filter.delete(z); else filter.add(z);
      redraw();
      if (onChange) onChange();
    });
    box.appendChild(b);
  }
}

// Survey-target zone filter (top of tab), persisted.
function drawZoneToggles() {
  drawToggles('sc-zone', scZoneFilter, drawZoneToggles, saveSurveyZone);
}

// Debris-table zone filter — independent from the survey filter above, persisted.
function drawDebrisZoneToggles() {
  drawToggles('sc-debris-zone', scDebrisZoneFilter, drawDebrisZoneToggles,
    () => { saveDebrisZone(); renderDebris(); });
}

// Nearest system to the source planet that isn't on survey cooldown and, if any
// zones are selected, sits in one of them.
function nearestTarget(srcSystemId, onCooldown) {
  const src = scSystems[srcSystemId];
  if (!src) return null;
  let best = null, bestD = Infinity;
  for (const [id, s] of Object.entries(scSystems)) {
    const sid = Number(id);
    if (onCooldown.has(sid)) continue;
    if (scZoneFilter.size && !scZoneFilter.has(s.zone)) continue;
    const d = Math.hypot(s.x - src.x, s.y - src.y);
    if (d < bestD) { bestD = d; best = { id: sid, name: s.name, dist: Math.round(d) }; }
  }
  return best;
}

async function launchScan() {
  const status = document.getElementById('sc-progress');
  const planetId = Number(document.getElementById('sc-planet').value);
  const planet = scPlanets.find(p => p.id === planetId);

  setStatusText(status, 'Finding nearest system…');
  const [cd, mi] = await Promise.all([
    browser.runtime.sendMessage({ type: 'GET_SURVEY_COOLDOWNS' }),
    browser.runtime.sendMessage({ type: 'GET_MISSIONS' }),
  ]);
  const maxSlots = getEffectiveMaxFleetSlots(mi);
  if (maxSlots != null && maxSlots <= (mi.missions || []).length) {
    setStatusText(status, `Cannot launch survey: ${(mi.missions || []).length}/${mi.maxFleetSlots} fleet slots in use${reservedSlotMessage()}.`); return;
  }
  if (cd.error) { setStatusText(status, `Error: ${cd.error}`); return; }
  const now = Date.now();
  // Exclude systems on cooldown and systems with a survey already in flight
  // (cooldown only starts once that survey completes).
  const onCooldown = new Set((cd.cooldowns || [])
    .filter(c => new Date(c.cooldownEndsAt) > now).map(c => c.systemId));
  for (const m of (mi.missions || [])) {
    if (m.missionType === 'survey' && m.targetSystemId != null) onCooldown.add(m.targetSystemId);
  }
  for (const id of scJustSurveyed) onCooldown.add(id);

  const target = nearestTarget(planet ? planet.systemId : null, onCooldown);
  if (!target) {
    const zs = scZoneFilter.size ? [...scZoneFilter].join('/') + ' ' : '';
    setStatusMessage(status, `No available ${zs}system to survey.`, 'warning');
    return;
  }

  const r = await templateShips(document.getElementById('sc-scan-template').value, planetId);
  if (r.error) { setStatusText(status, r.error); return; }

  setStatusText(status, `Surveying ${target.name}…`);
  const res = await browser.runtime.sendMessage({
    type: 'SEND_SURVEY', sourcePlanetId: planetId, targetSystemId: target.id, ships: r.ships,
  });
  if (res.error) {
    const msg = `Survey failed: ${res.error}`;
    // If humation is required, show the status message in red
    if (String(res.error).includes('Human verification')) {
      disableAutomaticsOnHumanCheck();
      setStatusText(status, msg, 'error'); return;
    }
    setStatusText(status, msg, 'warning'); return;
  }
  scJustSurveyed.add(target.id);
  setStatusText(status, `Probe sent to ${target.name} ✓`);
  loadActiveSurveys();
  updateAvail();
}

async function loadActiveSurveys() {
  const [res, mi] = await Promise.all([
    browser.runtime.sendMessage({ type: 'GET_SURVEY_REPORTS' }),
    browser.runtime.sendMessage({ type: 'GET_MISSIONS' }),
  ]);
  if (res.error) { document.getElementById('sc-count').textContent = `Error: ${res.error}`; return; }
  if (mi.maxFleetSlots != null) {
    const reserve = getReservedFleetSlots();
    document.getElementById('sc-slots').textContent = reserve > 0
      ? `${(mi.missions || []).length}/${mi.maxFleetSlots} fleet slots in use (${reserve} reserved)`
      : `${(mi.missions || []).length}/${mi.maxFleetSlots} fleet slots`;
  }
  scMissions = (mi.missions || []).filter(m => MISSION_LABELS[m.missionType]);
  renderTransit();
  scInvestigating = new Set((mi.missions || [])
    .filter(m => m.missionType === 'investigate' && m.targetSystemId != null)
    .map(m => m.targetSystemId));
  for (const id of scJustInvestigated) scInvestigating.add(id);
  const now = Date.now();
  const exp = r => (r.anomalyExpiresAt ? new Date(r.anomalyExpiresAt).getTime() : Infinity);
  scPending = (res.reports || [])
    .filter(r => !r.investigated && (!r.anomalyExpiresAt || new Date(r.anomalyExpiresAt) > now))
    .sort((a, b) => exp(a) - exp(b));   // soonest expiry first

  // Keep a row for systems whose investigate fleet is still out/returning even
  // after the report leaves scPending (investigation done), until it's home.
  const pendingSys = new Set(scPending.map(r => r.systemId));
  const reportBySys = {};
  for (const r of (res.reports || [])) if (r.systemId != null && !(r.systemId in reportBySys)) reportBySys[r.systemId] = r;
  scReturning = scMissions
    .filter(m => m.missionType === 'investigate' && m.targetSystemId != null && !pendingSys.has(m.targetSystemId))
    .map(m => {
      const rep = reportBySys[m.targetSystemId] || {};
      return {
        systemId: m.targetSystemId,
        systemName: m.targetSystemName || rep.systemName || `#${m.targetSystemId}`,
        eventTitle: rep.eventTitle || rep.eventType || '—',
        securityZone: rep.securityZone || null,
      };
    });
  let histChanged = false;
  for (const r of (res.reports || [])) {
    if (r.investigated && r.systemId != null && !scInvHistory.has(r.systemId)) {
      scInvHistory.set(r.systemId, Date.parse(r.createdAt) || Date.now()); histChanged = true;
    }
  }
  if (pruneInvHistory()) histChanged = true;
  if (histChanged) saveInvHistory();

  // Investigated reports with loot still on the ground and a live salvage timer.
  scSalvage = (res.reports || [])
    .map(r => {
      const loot = r.uncollectedLoot || {};
      const res_ = {};
      let total = 0;
      for (const k of SALVAGE_KEYS) { const v = loot[k] || 0; if (v) { res_[k] = v; total += v; } }
      return { reportId: r.id, systemId: r.systemId, system: r.systemName || `#${r.systemId}`,
        zone: r.securityZone || null, res: res_, total, expires: r.salvageExpiresAt || null };
    })
    .filter(s => s.total > 0 && (!s.expires || new Date(s.expires) > now))
    .sort((a, b) => b.total - a.total);

  renderSurveys();
  renderSalvage();
  renderDebris();   // repaint so debris progress bars reflect the just-fetched missions
}

function renderSurveys() {
  const list = document.getElementById('sc-surveys-list');
  list.textContent = '';
  scTicks.invest = []; // Reset the invest ticks for new render
  document.getElementById('sc-count').textContent =
    `${scPending.length} awaiting investigation` + (scReturning.length ? ` · ${scReturning.length} returning` : '');
  const now = Date.now();

  const mountProgress = (host, systemId, statusHost, etaHost) => {
    const track = document.createElement('div');
    track.className = 'mission-progress-track sc-transit-track sc-inv-progress-track';
    const fill = document.createElement('div');
    fill.className = 'mission-progress-fill sc-transit-fill sc-inv-progress-fill';
    track.appendChild(fill);
    host.appendChild(track);

    const m = systemId != null ? findMission('investigate', systemId) : null;
    if (!m) {
      fill.style.width = '0%';
      if (statusHost) statusHost.textContent = '—';
      if (etaHost) etaHost.textContent = '—';
      return;
    }

    const upd = () => {
      const p = missionProgress(m);
      fill.style.width = `${(p.frac * 100).toFixed(1)}%`;
      fill.style.background = p.gradient || p.color;
      if (statusHost) {
        statusHost.textContent = p.label;
        statusHost.style.color = p.color;
      }
      if (etaHost) etaHost.textContent = p.eta > 0 ? fmtCountdown(p.eta) : '—';
    };
    upd();
    scTicks.invest.push(upd);
  };

  const makeMetaItem = (label, value, extraClass) => {
    const d = document.createElement('div');
    d.className = 'sc-inv-meta-item';
    const k = document.createElement('span');
    k.className = 'sc-inv-meta-key';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = `sc-inv-meta-val${extraClass ? ` ${extraClass}` : ''}`;
    v.textContent = value;
    d.append(k, v);
    return d;
  };

  for (const r of scPending) {
    const card = document.createElement('div');
    card.className = 'sc-inv-card';
    card.dataset.system = r.systemId;
    if (r.anomalyExpiresAt) card.dataset.expires = r.anomalyExpiresAt;

    const action = document.createElement('div');
    action.className = 'sc-inv-action';
    const btn = document.createElement('button');
    const busy = scInvestigating.has(r.systemId);
    btn.disabled = busy;
    btn.className = busy ? 'sc-inv-icon-btn sc-inv-icon-btn-disabled' : 'sc-inv-icon-btn sc-inv-icon-btn-launch';
    btn.setAttribute('aria-label', busy ? 'Investigating' : 'Launch Investigation');
    btn.title = busy ? 'Investigating…' : 'Launch Investigation';
    if (!busy) btn.addEventListener('click', () => investigate(r));
    action.appendChild(btn);

    const meta = document.createElement('div');
    meta.className = 'sc-inv-meta-grid';
    const systemItem = makeMetaItem('System', r.systemName || `#${r.systemId}`);
    const status = document.createElement('span');
    status.className = 'sc-transit-status sc-inv-system-status';
    status.textContent = '—';
    systemItem.appendChild(status);
    const zoneItem = makeMetaItem('Zone', r.securityZone || '—', r.securityZone ? 'sc-zone-val' : '');
    if (r.securityZone) {
      const zoneVal = zoneItem.querySelector('.sc-inv-meta-val');
      if (zoneVal) zoneVal.style.color = ZONE_COLORS[r.securityZone] || ZONE_COLORS.unknown;
    }
    meta.append(
      systemItem,
      makeMetaItem('Anomaly', r.eventTitle || r.eventType || '—'),
      zoneItem,
      makeMetaItem('Fuel Cost', '…', 'sc-fuel'),
      makeMetaItem('Travel Time', '…', 'sc-time'),
      makeMetaItem('Expires in', r.anomalyExpiresAt ? fmtCountdown(new Date(r.anomalyExpiresAt) - now) : '—', 'sc-timer'),
    );

    const progressEtaItem = makeMetaItem('Progress ETA', '—', 'sc-inv-progress-eta');
    progressEtaItem.classList.add('sc-eta-grid-item');
    const eta = progressEtaItem.querySelector('.sc-inv-meta-val');
    meta.append(progressEtaItem);

    const prog = document.createElement('div');
    prog.className = 'sc-inv-progress';
    mountProgress(prog, r.systemId, status, eta);

    const body = document.createElement('div');
    body.className = 'sc-mission-main sc-inv-main';
    body.append(action, meta);

    card.append(body, prog);
    list.appendChild(card);
  }

  // Returning fleets: investigation done, keep the row (with the returning
  // progress bar) until the fleet is home. No launch button, no fuel/expiry.
  for (const r of scReturning) {
    const card = document.createElement('div');
    card.className = 'sc-inv-card';
    card.dataset.system = r.systemId;

    const action = document.createElement('div');
    action.className = 'sc-inv-action';
    const btn = document.createElement('button');
    btn.disabled = true;
    btn.className = 'sc-inv-icon-btn sc-inv-icon-btn-disabled';
    btn.setAttribute('aria-label', 'Returning');
    btn.title = 'Returning…';
    action.appendChild(btn);

    const meta = document.createElement('div');
    meta.className = 'sc-inv-meta-grid';
    const systemItem = makeMetaItem('System', r.systemName);
    const status = document.createElement('span');
    status.className = 'sc-transit-status sc-inv-system-status';
    status.textContent = '—';
    systemItem.appendChild(status);
    const zoneItem = makeMetaItem('Zone', r.securityZone || '—', r.securityZone ? 'sc-zone-val' : '');
    if (r.securityZone) {
      const zoneVal = zoneItem.querySelector('.sc-inv-meta-val');
      if (zoneVal) zoneVal.style.color = ZONE_COLORS[r.securityZone] || ZONE_COLORS.unknown;
    }
    meta.append(
      systemItem,
      makeMetaItem('Anomaly', r.eventTitle || '—'),
      zoneItem,
      makeMetaItem('Fuel Cost', '—'),
      makeMetaItem('Travel Time', '—'),
      makeMetaItem('Expires in', '—'),
    );

    const progressEtaItem = makeMetaItem('Progress ETA', '—', 'sc-inv-progress-eta');
    progressEtaItem.classList.add('sc-eta-grid-item');
    const eta = progressEtaItem.querySelector('.sc-inv-meta-val');
    meta.append(progressEtaItem);

    const prog = document.createElement('div');
    prog.className = 'sc-inv-progress';
    mountProgress(prog, r.systemId, status, eta);

    const body = document.createElement('div');
    body.className = 'sc-mission-main sc-inv-main';
    body.append(action, meta);

    card.append(body, prog);
    list.appendChild(card);
  }
  computeFuel();
}

// Fill the Fuel Cost column: one fuel-estimate per row for the selected
// investigate template's ships (capped to the source planet). A generation
// guard discards results from a superseded render/selection.
let fuelGen = 0;
async function computeFuel() {
  const gen = ++fuelGen;
  const planetId = Number(document.getElementById('sc-planet').value);
  const fuelCells = () => document.querySelectorAll('#sc-surveys-list .sc-fuel');
  const timeCells = () => document.querySelectorAll('#sc-surveys-list .sc-time');
  // Estimate uses the template as designed (not capped to the planet's stock).
  const tpl = scTemplates.find(t => String(t.id) === document.getElementById('sc-inv-template').value);
  const ships = Object.entries(tpl ? tpl.ships : {})
    .map(([shipDefId, quantity]) => ({ shipDefId: Number(shipDefId), quantity }))
    .filter(s => s.quantity > 0);
  if (!ships.length) {
    fuelCells().forEach(c => { c.textContent = '—'; c.title = tpl ? 'Template has no ships' : 'No template selected'; });
    timeCells().forEach(c => { c.textContent = '—'; });
    return;
  }

  for (const tr of document.querySelectorAll('#sc-surveys-list .sc-inv-card')) {
    if (gen !== fuelGen) return;
    const cell = tr.querySelector('.sc-fuel');
    const timeCell = tr.querySelector('.sc-time');
    const sysId = Number(tr.dataset.system);
    if (!cell || !sysId) continue;
    const est = await fuelEstimate(planetId, sysId, ships);
    if (gen !== fuelGen) return;
    if (est.error) { cell.textContent = '—'; cell.title = est.error; if (timeCell) timeCell.textContent = '—'; continue; }
    cell.textContent = `${est.fuelCost}`;
    cell.style.color = est.inRange === false ? '#ff7b72' : '';
    cell.title = est.inRange === false ? 'Out of range' : `distance ${est.distance.toFixed(1)} ly`;
    if (timeCell) timeCell.textContent = est.travelTime != null ? fmtCountdown(est.travelTime * 1000) : '—';
  }
}

// Update countdown cells in place; drop rows that just expired.
function tickTimers() {
  const now = Date.now();
  let expired = false;
  document.querySelectorAll('#sc-surveys-list .sc-inv-card').forEach(tr => {
    if (!tr.dataset.expires) return;
    const ms = new Date(tr.dataset.expires) - now;
    if (ms <= 0) { tr.remove(); expired = true; return; }
    const cell = tr.querySelector('.sc-timer');
    if (cell) cell.textContent = fmtCountdown(ms);
  });
  if (expired) {
    scPending = scPending.filter(r => !r.anomalyExpiresAt || new Date(r.anomalyExpiresAt) > now);
    document.getElementById('sc-count').textContent = `${scPending.length} awaiting investigation`;
  }

  let debrisExpired = false;
  document.querySelectorAll('#sc-debris-list .sc-debris-card').forEach(card => {
    if (!card.dataset.expires) return;
    const ms = new Date(card.dataset.expires) - now;
    if (ms <= 0) { card.remove(); debrisExpired = true; return; }
    const cell = card.querySelector('.sc-debris-timer');
    if (cell) cell.textContent = fmtCountdown(ms);
  });
  if (debrisExpired) {
    scDebris = scDebris.filter(f => !f.expires || new Date(f.expires) > now);
    renderDebris();
  }

  let salvExpired = false;
  document.querySelectorAll('#sc-salvage-list .sc-salvage-card').forEach(tr => {
    if (!tr.dataset.expires) return;
    const ms = new Date(tr.dataset.expires) - now;
    if (ms <= 0) { tr.remove(); salvExpired = true; return; }
    const cell = tr.querySelector('.sc-salvage-timer');
    if (cell) cell.textContent = fmtCountdown(ms);
  });
  if (salvExpired) {
    scSalvage = scSalvage.filter(s => !s.expires || new Date(s.expires) > now);
    document.getElementById('sc-salvage-count').textContent = `${scSalvage.length} awaiting collection`;
  }
}

async function investigate(report) {
  const status = document.getElementById('sc-progress');
  const planetId = Number(document.getElementById('sc-planet').value);

  const r = await templateShips(document.getElementById('sc-inv-template').value, planetId);
  if (r.error) { setStatusText(status, r.error); return; }

  setStatusText(status, `Investigating ${report.systemName}…`);
  const res = await browser.runtime.sendMessage({
    type: 'SEND_INVESTIGATE', sourcePlanetId: planetId, reportId: report.id, ships: r.ships,
  });
  if (res.error) {
    const msg = `Investigate failed: ${res.error}`;
    // If humation is required, show the status message in red
    if (String(res.error).includes('Human verification')) {
      disableAutomaticsOnHumanCheck();
      setStatusText(status, msg, 'error'); return;
    }
    setStatusText(status, msg, 'warning'); return;
  }
  scJustInvestigated.add(report.systemId);
  scInvestigating.add(report.systemId);
  setStatusText(status, `Fleet sent to ${report.systemName} ✓`);
  loadActiveSurveys();
  setTimeout(loadActiveSurveys, 2000);   // retry for post-POST API lag → prompt bar
  updateAvail();
}

// ── Live debris fields ─────────────────────────────────────────────────────

let scDebris = [];   // live debris fields from the latest scrape
const scJustCollected = new Set();   // debrisIds collected this session — keep the button disabled
// systemId → { field, seenRun }: a field we launched a collection on, kept
// visible even while the game drops it from debris_fields mid-flight, so the
// row doesn't flicker out. Dropped once its collect run finishes.
const scCollecting = new Map();
const scHiddenDebris = new Set();    // field ids the user hid from the table
let scShowHidden = false;            // reveal hidden rows (dimmed) for unhiding
let scInvestigatedOnly = false;      // restrict debris to systems in the investigation history
const scDebrisZoneFilter = new Set(); // debris-table zone filter (independent of survey filter)
let scInvHistory = new Map();        // systemId → investigation report time (ms); expires after 2h
const INV_HISTORY_TTL_MS = 2 * 60 * 60 * 1000;
const scDebrisSort = { key: 'total', dir: -1 };
attachSortable('sc-debris-head', scDebrisSort, () => renderDebris());

// Uncollected survey salvage: after a partial-recovery investigation, loot sits
// in-system (survey report `uncollectedLoot`) until `salvageExpiresAt`. Collected
// with the same cargo haulers as debris, via POST /api/fleet/collect-salvage.
const SALVAGE_KEYS = ['ore', 'silicates', 'hydrogen', 'alloys', 'cryo_ice', 'quantum_dust', 'plasma_core', 'dark_matter', 'antimatter'];
let scSalvage = [];                  // [{ reportId, systemId, system, zone, res, total, expires }]
const scJustSalvaged = new Set();    // reportIds launched this session — keep the button disabled
const scSalvageSort = { key: 'total', dir: -1 };
attachSortable('sc-salvage-head', scSalvageSort, () => renderSalvage());

// Investigation history persists across sessions: survey reports rotate out, so
// we accumulate investigated systemIds (→ report time) here. An entry drops when
// debris there is collected, or once it's older than INV_HISTORY_TTL_MS.
async function loadInvHistory() {
  const { debris_inv_history } = await browser.storage.local.get('debris_inv_history');
  scInvHistory = new Map(Object.entries(debris_inv_history || {}).map(([k, v]) => [Number(k), v]));
  if (pruneInvHistory()) saveInvHistory();
}
async function saveInvHistory() {
  await browser.storage.local.set({ debris_inv_history: Object.fromEntries(scInvHistory) });
}
// Drop entries past the TTL. Returns true if anything was removed.
function pruneInvHistory() {
  const cutoff = Date.now() - INV_HISTORY_TTL_MS;
  let changed = false;
  for (const [sysId, ts] of scInvHistory) {
    if (!(ts > cutoff)) { scInvHistory.delete(sysId); changed = true; }
  }
  return changed;
}

// Debris zone filter persists across sessions.
async function loadDebrisZone() {
  const { debris_zone_filter } = await browser.storage.local.get('debris_zone_filter');
  scDebrisZoneFilter.clear();
  for (const z of (debris_zone_filter || [])) scDebrisZoneFilter.add(z);
}
function saveDebrisZone() {
  browser.storage.local.set({ debris_zone_filter: [...scDebrisZoneFilter] });
}

// Survey-target zone filter persists across sessions.
async function loadSurveyZone() {
  const { survey_zone_filter } = await browser.storage.local.get('survey_zone_filter');
  scZoneFilter.clear();
  for (const z of (survey_zone_filter || [])) scZoneFilter.add(z);
}
function saveSurveyZone() {
  browser.storage.local.set({ survey_zone_filter: [...scZoneFilter] });
}

// Cargo haulers the user can pick to collect debris. Loaded from the shipyard
// (real cargoCapacity, scales with race/tech), filtered to these keys.
const CARGO_KEYS = ['ore_freighter', 'bulk_carrier', 'freighter', 'transport_shuttle'];
let scCargoShips = [];               // [{ shipDefId, name, imageUrl, cap }]
let scAllShips = [];                 // every ship def: [{ shipDefId, name, imageUrl }]
let scCargoAvail = {};               // shipDefId → on-planet count for active planet
const scCargoSel = new Set();        // selected shipDefIds

async function loadCargoShips() {
  const [res, stored, me] = await Promise.all([
    browser.runtime.sendMessage({ type: 'GET_SHIP_DEFS' }),
    browser.storage.local.get('research'),
    browser.runtime.sendMessage({ type: 'GET_AUTH_ME' }),
  ]);
  const bonus = cargoBonuses(stored.research || []);
  const commander = me?.user?.activeLeaderBonuses?.cargoBonus || 0;   // leader cargo bonus
  scAllShips = (res.ships || []).map(s => ({ shipDefId: s.shipDefId, name: s.name, imageUrl: s.imageUrl }));
  scCargoShips = (res.ships || [])
    .filter(s => CARGO_KEYS.includes(s.key) && s.cargoCapacity > 0)
    .map(s => {
      // cargo_bonus + commander lift every hauler; shuttle_cargo_bonus adds on top.
      const b = bonus.general + commander + (s.key === 'transport_shuttle' ? bonus.shuttle : 0);
      return { shipDefId: s.shipDefId, name: s.name, imageUrl: s.imageUrl, cap: Math.floor(s.cargoCapacity * (1 + b)) };
    })
    .sort((a, b) => b.cap - a.cap);
  // Restore the remembered cargo-type selection (survives tabs/sessions).
  const saved = (await rememberedSelections())['sc-cargo-ships'];
  if (Array.isArray(saved)) {
    scCargoSel.clear();
    for (const id of saved) if (scCargoShips.some(s => s.shipDefId === id)) scCargoSel.add(id);
  }
  renderCargoToggles();
}

// Sum researched cargo bonuses (value × level) by effect type.
function cargoBonuses(research) {
  let general = 0, shuttle = 0;
  for (const r of research) {
    const lvl = r.level || 0;
    if (!lvl) continue;
    for (const e of (r.effects || [])) {
      if (e.type === 'cargo_bonus') general += (e.value || 0) * lvl;
      else if (e.type === 'shuttle_cargo_bonus') shuttle += (e.value || 0) * lvl;
    }
  }
  return { general, shuttle };
}

function renderCargoToggles() {
  const box = document.getElementById('sc-debris-ships');
  box.textContent = '';
  for (const s of scCargoShips) {
    const on = scCargoSel.has(s.shipDefId);
    const qty = scCargoAvail[s.shipDefId] || 0;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-cargo-toggle';
    b.dataset.shipDefId = String(s.shipDefId);
    b.title = `${s.name} — ${qty.toLocaleString()} on this planet`;
    b.classList.toggle('is-selected', on);
    b.classList.toggle('is-empty', qty <= 0);
    if (s.imageUrl) {
      const img = document.createElement('img');
      img.src = s.imageUrl;
      b.appendChild(img);
    }

    const label = document.createElement('span');
    label.className = 'sc-cargo-label';

    const count = document.createElement('span');
    count.className = 'sc-cargo-count';
    count.textContent = String(qty);
    label.appendChild(count);

    if (!s.imageUrl) {
      const text = document.createElement('span');
      text.textContent = s.name;
      label.appendChild(text);
    }
    b.appendChild(label);

    b.addEventListener('click', () => {
      if (on) scCargoSel.delete(s.shipDefId); else scCargoSel.add(s.shipDefId);
      rememberSelection('sc-cargo-ships', [...scCargoSel]);
      renderCargoToggles();
      computeDebrisFuel();
      computeSalvageFuel();
    });
    box.appendChild(b);
  }
}

// Selected haulers as [{ shipDefId, cap }].
function selectedCargo() {
  return scCargoShips.filter(s => scCargoSel.has(s.shipDefId));
}

// Short ship labels for tight UI columns: "Transport Shuttle" -> "TS".
function shipShortName(name) {
  const parts = String(name || '').split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) {
    const clean = parts[0].replace(/[^a-z0-9]/gi, '');
    return (clean.slice(0, 2) || clean || '?').toUpperCase();
  }
  return parts.map(p => (p[0] || '').toUpperCase()).join('');
}

// Nearest owned planet to a target system (Euclidean on galaxy-map coords).
function nearestPlanet(systemId) {
  const t = scSystems[systemId];
  if (!t) return null;
  let best = null, bd = Infinity;
  for (const p of scPlanets) {
    const s = scSystems[p.systemId];
    if (!s) continue;
    const d = Math.hypot(s.x - t.x, s.y - t.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
// Source planet for a debris field: nearest owned planet when the toggle is on,
// else the selected planet.
function debrisSourcePlanet(systemId) {
  if (document.getElementById('sc-debris-nearest').checked) return nearestPlanet(systemId);
  const id = Number(document.getElementById('sc-planet').value);
  return scPlanets.find(p => p.id === id) || null;
}

// Ships stationed on the selected planet, shown above both tables (one fetch):
// cargo-only above the debris table, every type above the investigation table.
async function updateAvail() {
  const planetId = Number(document.getElementById('sc-planet').value);
  if (!planetId || !scAllShips.length) {
    scCargoAvail = {};
    renderCargoToggles();
    return;
  }
  const av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId });
  if (av.error) {
    scCargoAvail = {};
    renderCargoToggles();
    return;
  }
  scCargoAvail = av.available || {};
  renderCargoToggles();
}

// Fewest selected haulers (largest-first, smallest fills the tail) to carry
// `total` cargo. Returns [{ shipDefId, quantity }].
function planFleet(total, ships) {
  const sorted = ships.filter(s => s.cap > 0).sort((a, b) => b.cap - a.cap);
  if (!sorted.length || total <= 0) return [];
  let rem = total;
  const out = [];
  for (let i = 0; i < sorted.length && rem > 0; i++) {
    const { shipDefId, cap } = sorted[i];
    const n = i === sorted.length - 1 ? Math.ceil(rem / cap) : Math.floor(rem / cap);
    if (n > 0) { out.push({ shipDefId, quantity: n }); rem -= n * cap; }
  }
  return out;
}

async function loadDebris() {
  const { debris_fields } = await browser.storage.local.get('debris_fields');
  scDebris = (debris_fields || []).map(f => ({ ...f, total: (f.ore || 0) + (f.silicates || 0) + (f.alloys || 0) }));
  renderDebris();
}

function renderDebris() {
  const list = document.getElementById('sc-debris-list');
  list.textContent = '';
  scTicks.debris = [];

  if (pruneInvHistory()) saveInvHistory();   // expire stale history between polls

  // Header "show hidden" toggle reflects how many rows are hidden.
  const toggle = document.getElementById('sc-debris-hidden');
  toggle.style.display = scHiddenDebris.size ? '' : 'none';
  toggle.textContent = scShowHidden ? `Hide hidden (${scHiddenDebris.size})` : `Show hidden (${scHiddenDebris.size})`;

  // Systems with a collect fleet already in flight (persisted across reloads),
  // so a field isn't offered for collection twice.
  const collectingSystems = new Set((store.debris_active_runs || []).map(r => r.system_id).filter(v => v != null));

  // Keep just-launched fields on screen through the window where the game has
  // dropped them from debris_fields but the collect run hasn't shown up yet.
  // Drop a kept field once its run has been seen and then finished.
  const present = new Set(scDebris.map(f => f.systemId).filter(v => v != null));
  const kept = [];
  for (const [sys, ent] of scCollecting) {
    if (collectingSystems.has(sys)) ent.seenRun = true;
    else if (ent.seenRun) { scCollecting.delete(sys); continue; }   // run finished → field collected
    if (!present.has(sys)) kept.push(ent.field);
  }
  const source = kept.length ? scDebris.concat(kept) : scDebris;

  // Independent debris zone filter (empty = all zones) and the
  // investigation-history-only switch.
  const sorted = applySort('sc-debris-head', source, scDebrisSort, 'system')
    .filter(f => !scDebrisZoneFilter.size || scDebrisZoneFilter.has(f.zone))
    .filter(f => !scInvestigatedOnly || (f.systemId != null && scInvHistory.has(f.systemId)));
  const rows = scShowHidden ? sorted : sorted.filter(f => !scHiddenDebris.has(f.id));
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'sc-transit-empty';
    empty.textContent = !scDebris.length ? 'No debris fields currently visible.'
      : (scDebrisZoneFilter.size || scInvestigatedOnly) ? 'No debris matches the current filter.'
      : 'All debris fields hidden.';
    list.appendChild(empty);
    return;
  }

  const mountDebrisProgress = (host, systemId, statusHost, etaHost) => {
    const track = document.createElement('div');
    track.className = 'mission-progress-track sc-transit-track sc-debris-progress-track';
    const fill = document.createElement('div');
    fill.className = 'mission-progress-fill sc-transit-fill sc-debris-progress-fill';
    track.appendChild(fill);
    host.appendChild(track);

    const mission = systemId != null ? findMission('collect_debris', systemId) : null;
    if (!mission) {
      fill.style.width = '0%';
      if (statusHost) statusHost.textContent = '—';
      if (etaHost) etaHost.textContent = '—';
      return;
    }

    const update = () => {
      const progress = missionProgress(mission);
      fill.style.width = `${(progress.frac * 100).toFixed(1)}%`;
      fill.style.background = progress.gradient || progress.color;
      if (statusHost) {
        statusHost.textContent = progress.label;
        statusHost.style.color = progress.color;
      }
      if (etaHost) etaHost.textContent = progress.eta > 0 ? fmtCountdown(progress.eta) : '—';
    };
    update();
    scTicks.debris.push(update);
  };

  const makeMetaItem = (label, value, extraClass) => {
    const item = document.createElement('div');
    item.className = 'sc-debris-meta-item';
    const key = document.createElement('span');
    key.className = 'sc-debris-meta-key';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = `sc-debris-meta-val${extraClass ? ` ${extraClass}` : ''}`;
    val.textContent = value;
    item.append(key, val);
    return item;
  };

  for (const f of rows) {
    const card = document.createElement('div');
    card.className = 'sc-debris-card';
    if (f.systemId != null) card.dataset.system = f.systemId;
    card.dataset.total = f.total || 0;
    if (f.expires) card.dataset.expires = f.expires;
    const hidden = scHiddenDebris.has(f.id);
    if (hidden) card.style.opacity = '0.45';

    const action = document.createElement('div');
    action.className = 'sc-debris-action';
    const btn = document.createElement('button');
    const busy = f.debrisId != null && (scJustCollected.has(f.debrisId) || (f.systemId != null && collectingSystems.has(f.systemId)));
    const ok = f.debrisId != null && !busy;
    btn.disabled = !ok;
    btn.className = ok ? 'sc-salvage-icon-btn sc-debris-icon-btn-launch' : 'sc-salvage-icon-btn sc-debris-icon-btn-disabled';
    btn.setAttribute('aria-label', busy ? 'Collecting' : ok ? 'Collect Debris' : 'Unavailable');
    btn.title = busy ? 'Collecting…' : ok ? 'Collect Debris' : 'Unavailable';
    if (ok) btn.addEventListener('click', () => collectDebris(f));
    action.appendChild(btn);

    const hideButton = document.createElement('button');
    hideButton.className = 'sc-debris-hide-btn';
    hideButton.textContent = hidden ? '↩' : '✕';
    hideButton.title = hidden ? 'Unhide field' : 'Hide field';
    hideButton.setAttribute('aria-label', hideButton.title);
    hideButton.addEventListener('click', () => {
      if (hidden) scHiddenDebris.delete(f.id); else scHiddenDebris.add(f.id);
      renderDebris();
    });
    action.appendChild(hideButton);

    const meta = document.createElement('div');
    meta.className = 'sc-debris-meta-grid';
    const systemItem = makeMetaItem('System', f.system);
    const status = document.createElement('span');
    status.className = 'sc-transit-status sc-debris-system-status';
    status.textContent = '—';
    systemItem.appendChild(status);
    const zoneItem = makeMetaItem('Zone', f.zone || '—');
    if (f.zone) {
      const zoneValue = zoneItem.querySelector('.sc-debris-meta-val');
      if (zoneValue) zoneValue.style.color = ZONE_COLORS[f.zone] || ZONE_COLORS.unknown;
    }
    const resourcesLeft = [
      ['Ore', f.ore],
      ['Sil', f.silicates],
      ['Alloy', f.alloys],
    ].filter(([, value]) => value).map(([label, value]) => `${label} ${value.toLocaleString()}`).join(', ');
    meta.append(
      systemItem,
      zoneItem,
      makeMetaItem('Resources left', resourcesLeft || '—', 'sc-debris-breakdown'),
      makeMetaItem('Total', (f.total || 0).toLocaleString()),
      makeMetaItem('Number of Ships', '…', 'sc-debris-shipn'),
      makeMetaItem('Fuel Cost', '…', 'sc-debris-fuel'),
      makeMetaItem('Travel Time', '…', 'sc-debris-time'),
      makeMetaItem('Expires in', f.expires ? fmtCountdown(new Date(f.expires) - Date.now()) : '—', 'sc-debris-timer'),
    );

    const progressEtaItem = makeMetaItem('Progress ETA', '—', 'sc-debris-progress-eta');
    progressEtaItem.classList.add('sc-eta-grid-item');
    const progressEta = progressEtaItem.querySelector('.sc-debris-meta-val');
    meta.append(progressEtaItem);

    const body = document.createElement('div');
    body.className = 'sc-mission-main sc-debris-main';
    body.append(action, meta);

    const progress = document.createElement('div');
    progress.className = 'sc-debris-progress';
    mountDebrisProgress(progress, f.systemId, status, progressEta);

    card.append(body, progress);
    list.appendChild(card);
  }
  computeDebrisFuel();
}

// Fill the debris Fuel Cost column for the auto-planned fleet (selected haulers
// sized to carry the whole field) from the selected planet.
let debrisFuelGen = 0;
async function computeDebrisFuel() {
  const gen = ++debrisFuelGen;
  const sel = q => () => document.querySelectorAll(`#sc-debris-list .${q}`);
  const fuelCells = sel('sc-debris-fuel');
  const shipCells = sel('sc-debris-shipn');
  const timeCells = sel('sc-debris-time');
  const cargo = selectedCargo();
  if (!cargo.length) {
    fuelCells().forEach(c => { c.textContent = '—'; c.title = 'Select cargo ships above'; });
    shipCells().forEach(c => { c.textContent = '—'; c.title = ''; });
    timeCells().forEach(c => { c.textContent = '—'; });
    return;
  }
  const nameOf = id => (scCargoShips.find(c => c.shipDefId === id) || {}).name || '#' + id;
  for (const tr of document.querySelectorAll('#sc-debris-list .sc-debris-card')) {
    if (gen !== debrisFuelGen) return;
    const ships = planFleet(Number(tr.dataset.total) || 0, cargo);
    const named = ships.map(s => `${s.quantity}× ${nameOf(s.shipDefId)}`).join(', ');
    const shortNamed = ships.map(s => `${s.quantity}× ${shipShortName(nameOf(s.shipDefId))}`).join(', ');
    const nCell = tr.querySelector('.sc-debris-shipn');
    if (nCell) {
      nCell.textContent = ships.length ? shortNamed : '—';
      nCell.title = ships.length ? named : '';
    }

    const cell = tr.querySelector('.sc-debris-fuel');
    const timeCell = tr.querySelector('.sc-debris-time');
    const sysId = Number(tr.dataset.system);
    const srcId = debrisSourcePlanet(sysId)?.id;
    if (!cell || !sysId || !srcId) continue;
    if (!ships.length) { cell.textContent = '—'; if (timeCell) timeCell.textContent = '—'; continue; }
    const est = await fuelEstimate(srcId, sysId, ships);
    if (gen !== debrisFuelGen) return;
    if (est.error) { cell.textContent = '—'; cell.title = est.error; if (timeCell) timeCell.textContent = '—'; continue; }
    cell.textContent = `${est.fuelCost}`;
    cell.style.color = est.inRange === false ? '#ff7b72' : '';
    cell.title = est.inRange === false ? 'Out of range' : `distance ${est.distance.toFixed(1)} ly`;
    if (timeCell) timeCell.textContent = est.travelTime != null ? fmtCountdown(est.travelTime * 1000) : '—';
  }
}

async function collectDebris(field, automated = false) {
  const status = document.getElementById('sc-progress');
  const planet = debrisSourcePlanet(field.systemId);
  if (!planet) { setStatusText(status, 'No source planet found for this field.'); return; }
  const planetId = planet.id;

  const cargo = selectedCargo();
  const plan = planFleet(field.total, cargo);
  if (!plan.length) { setStatusText(status, 'Select cargo ships above first.'); return; }

  // Cap to what the source planet actually has; warn if that can't carry it all.
  const av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId });
  if (av.error) { setStatusText(status, `Error: ${av.error}`); return; }
  const capOf = id => (scCargoShips.find(s => s.shipDefId === id) || {}).cap || 0;
  const ships = plan
    .map(s => ({ shipDefId: s.shipDefId, quantity: Math.min(s.quantity, av.available[s.shipDefId] || 0) }))
    .filter(s => s.quantity > 0);
  if (!ships.length) { setStatusText(status, 'None of the selected cargo ships are on this planet.'); return; }
  const carried = ships.reduce((sum, s) => sum + s.quantity * capOf(s.shipDefId), 0);
  const short = carried < field.total;

  if (!automated && !await confirmDialog(`Collect debris at ${field.system} (${field.total.toLocaleString()} cargo)?\n\n` +
    `From: ${planet ? planet.name : planetId}` +
    (short ? `\n\n⚠ Selected ships on this planet only carry ${carried.toLocaleString()} — collecting what fits.` : ''), ships)) return;

  setStatusText(status, `Collecting at ${field.system}…`);
  const res = await browser.runtime.sendMessage({
    type: 'COLLECT_DEBRIS', sourcePlanetId: planetId, debrisId: field.debrisId, ships,
  });
  if (res.error) {
    const msg = `Collect failed: ${res.error}`;
    // If humation is required, show the status message in red
    if (String(res.error).includes('Human verification')) {
      disableAutomaticsOnHumanCheck();
      setStatusText(status, msg, 'error'); return;
    }
    setStatusText(status, msg, 'warning'); return;
  }
  scJustCollected.add(field.debrisId);
  if (field.systemId != null) scCollecting.set(field.systemId, { field: { ...field }, seenRun: false });
  // Loot claimed — drop this system from the investigation history.
  if (field.systemId != null && scInvHistory.delete(field.systemId)) saveInvHistory();
  setStatusText(status, `Fleet sent to ${field.system} ✓`);
  renderDebris();
  updateAvail();
  // Pull the new mission in so the progress bar shows promptly; retry once for
  // the game's brief post-POST API lag.
  loadActiveSurveys();
  setTimeout(loadActiveSurveys, 2000);
}

// ── Uncollected salvage ─────────────────────────────────────────────────────

const RES_LABEL = { ore: 'Ore', silicates: 'Sil', hydrogen: 'Hyd', alloys: 'Alloy',
  cryo_ice: 'Cryo-Ice', quantum_dust: 'Q.Dust', plasma_core: 'Plasma', dark_matter: 'D.Matter', antimatter: 'Antim' };

function renderSalvage() {
  const list = document.getElementById('sc-salvage-list');
  list.textContent = '';
  scTicks.salvage = [];
  document.getElementById('sc-salvage-count').textContent = `${scSalvage.length} awaiting collection`;
  const now = Date.now();

  const sorted = applySort('sc-salvage-head', scSalvage, scSalvageSort, 'system');
  if (!sorted.length) {
    const d = document.createElement('div');
    d.className = 'sc-transit-empty';
    d.textContent = 'No uncollected salvage.';
    list.appendChild(d);
    return;
  }

  const mountSalvageProgress = (host, systemId, statusHost, etaHost) => {
    const track = document.createElement('div');
    track.className = 'mission-progress-track sc-transit-track sc-salvage-progress-track';
    const fill = document.createElement('div');
    fill.className = 'mission-progress-fill sc-transit-fill sc-salvage-progress-fill';
    track.appendChild(fill);
    host.appendChild(track);

    const m = systemId != null ? findMission('collect_salvage', systemId) : null;
    if (!m) {
      fill.style.width = '0%';
      if (statusHost) statusHost.textContent = '—';
      if (etaHost) etaHost.textContent = '—';
      return;
    }

    const upd = () => {
      const p = missionProgress(m);
      fill.style.width = `${(p.frac * 100).toFixed(1)}%`;
      fill.style.background = p.gradient || p.color;
      if (statusHost) {
        statusHost.textContent = p.label;
        statusHost.style.color = p.color;
      }
      if (etaHost) etaHost.textContent = p.eta > 0 ? fmtCountdown(p.eta) : '—';
    };
    upd();
    scTicks.salvage.push(upd);
  };

  const makeMetaItem = (label, value, extraClass) => {
    const d = document.createElement('div');
    d.className = 'sc-salvage-meta-item';
    const k = document.createElement('span');
    k.className = 'sc-salvage-meta-key';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = `sc-salvage-meta-val${extraClass ? ` ${extraClass}` : ''}`;
    v.textContent = value;
    d.append(k, v);
    return d;
  };

  for (const s of sorted) {
    const card = document.createElement('div');
    card.className = 'sc-salvage-card';
    if (s.systemId != null) card.dataset.system = s.systemId;
    card.dataset.total = s.total || 0;
    if (s.expires) card.dataset.expires = s.expires;

    const action = document.createElement('div');
    action.className = 'sc-salvage-action';
    const btn = document.createElement('button');
    const mission = s.systemId != null ? findMission('collect_salvage', s.systemId) : null;
    const busy = scJustSalvaged.has(s.reportId) || !!mission;
    btn.disabled = busy;
    btn.className = busy ? 'sc-salvage-icon-btn sc-salvage-icon-btn-disabled' : 'sc-salvage-icon-btn sc-salvage-icon-btn-launch';
    btn.setAttribute('aria-label', busy ? 'Collecting' : 'Collect Salvage');
    btn.title = busy ? 'Collecting…' : 'Collect Salvage';
    if (!busy) btn.addEventListener('click', () => collectSalvage(s));
    action.appendChild(btn);

    const breakdown = Object.entries(s.res)
      .map(([k, v]) => `${RES_LABEL[k] || k} ${v.toLocaleString()}`).join(', ');

    const meta = document.createElement('div');
    meta.className = 'sc-salvage-meta-grid';
    const systemItem = makeMetaItem('System', s.system);
    const status = document.createElement('span');
    status.className = 'sc-transit-status sc-salvage-system-status';
    status.textContent = '—';
    systemItem.appendChild(status);
    const zoneItem = makeMetaItem('Zone', s.zone || '—');
    if (s.zone) {
      const zoneVal = zoneItem.querySelector('.sc-salvage-meta-val');
      if (zoneVal) zoneVal.style.color = ZONE_COLORS[s.zone] || ZONE_COLORS.unknown;
    }
    meta.append(
      systemItem,
      zoneItem,
      makeMetaItem('Resources left', breakdown || '—', 'sc-salvage-breakdown'),
      makeMetaItem('Total', (s.total || 0).toLocaleString()),
      makeMetaItem('Number of Ships', '…', 'sc-salvage-shipn'),
      makeMetaItem('Fuel Cost', '…', 'sc-salvage-fuel'),
      makeMetaItem('Travel Time', '…', 'sc-salvage-time'),
      makeMetaItem('Expires in', s.expires ? fmtCountdown(new Date(s.expires) - now) : '—', 'sc-salvage-timer'),
    );

    const progressEtaItem = makeMetaItem('Progress ETA', '—', 'sc-salvage-progress-eta');
    progressEtaItem.classList.add('sc-eta-grid-item');
    const eta = progressEtaItem.querySelector('.sc-salvage-meta-val');
    meta.append(progressEtaItem);

    const body = document.createElement('div');
    body.className = 'sc-mission-main sc-salvage-main';
    body.append(action, meta);

    const prog = document.createElement('div');
    prog.className = 'sc-salvage-progress';
    mountSalvageProgress(prog, s.systemId, status, eta);

    card.append(body, prog);
    list.appendChild(card);
  }
  computeSalvageFuel();
}

// Mirror computeDebrisFuel: plan the selected haulers to carry the whole salvage
// and estimate fuel/time from the source planet.
let salvageFuelGen = 0;
async function computeSalvageFuel() {
  const gen = ++salvageFuelGen;
  const planetId = Number(document.getElementById('sc-planet').value);
  const sel = q => () => document.querySelectorAll(`#sc-salvage-list .${q}`);
  const fuelCells = sel('sc-salvage-fuel');
  const shipCells = sel('sc-salvage-shipn');
  const timeCells = sel('sc-salvage-time');
  const cargo = selectedCargo();
  if (!cargo.length) {
    fuelCells().forEach(c => { c.textContent = '—'; c.title = 'Select cargo ships above'; });
    shipCells().forEach(c => { c.textContent = '—'; c.title = ''; });
    timeCells().forEach(c => { c.textContent = '—'; });
    return;
  }
  const nameOf = id => (scCargoShips.find(c => c.shipDefId === id) || {}).name || '#' + id;
  for (const tr of document.querySelectorAll('#sc-salvage-list .sc-salvage-card')) {
    if (gen !== salvageFuelGen) return;
    const ships = planFleet(Number(tr.dataset.total) || 0, cargo);
    const named = ships.map(s => `${s.quantity}× ${nameOf(s.shipDefId)}`).join(', ');
    const shortNamed = ships.map(s => `${s.quantity}× ${shipShortName(nameOf(s.shipDefId))}`).join(', ');
    const nCell = tr.querySelector('.sc-salvage-shipn');
    if (nCell) {
      nCell.textContent = ships.length ? shortNamed : '—';
      nCell.title = ships.length ? named : '';
    }

    const cell = tr.querySelector('.sc-salvage-fuel');
    const timeCell = tr.querySelector('.sc-salvage-time');
    const sysId = Number(tr.dataset.system);
    if (!cell || !sysId) continue;
    if (!ships.length) { cell.textContent = '—'; if (timeCell) timeCell.textContent = '—'; continue; }
    const est = await fuelEstimate(planetId, sysId, ships);
    if (gen !== salvageFuelGen) return;
    if (est.error) { cell.textContent = '—'; cell.title = est.error; if (timeCell) timeCell.textContent = '—'; continue; }
    cell.textContent = `${est.fuelCost}`;
    cell.style.color = est.inRange === false ? '#ff7b72' : '';
    cell.title = est.inRange === false ? 'Out of range' : `distance ${est.distance.toFixed(1)} ly`;
    if (timeCell) timeCell.textContent = est.travelTime != null ? fmtCountdown(est.travelTime * 1000) : '—';
  }
}

async function collectSalvage(salvage) {
  const status = document.getElementById('sc-progress');
  const planetId = Number(document.getElementById('sc-planet').value);

  const cargo = selectedCargo();
  const plan = planFleet(salvage.total, cargo);
  if (!plan.length) { setStatusText(status, 'Select cargo ships above first.'); return; }

  // Cap to what the source planet has; warn if that can't carry it all.
  const av = await browser.runtime.sendMessage({ type: 'GET_PLANET_SHIPS', planetId });
  if (av.error) { setStatusText(status, `Error: ${av.error}`); return; }
  const ships = plan
    .map(s => ({ shipDefId: s.shipDefId, quantity: Math.min(s.quantity, av.available[s.shipDefId] || 0) }))
    .filter(s => s.quantity > 0);
  if (!ships.length) { setStatusText(status, 'None of the selected cargo ships are on this planet.'); return; }

  setStatusText(status, `Collecting salvage at ${salvage.system}…`);
  const res = await browser.runtime.sendMessage({
    type: 'COLLECT_SALVAGE', sourcePlanetId: planetId, reportId: salvage.reportId, ships,
  });
  if (res.error) {
    const msg = `Collect failed: ${res.error}`;
    // If humation is required, show the status message in red
    if (String(res.error).includes('Human verification')) {
      disableAutomaticsOnHumanCheck();
      setStatusText(status, msg, 'error'); return;
    }
    setStatusText(status, msg, 'warning'); return;
  }
  scJustSalvaged.add(salvage.reportId);
  setStatusText(status, `Fleet sent to ${salvage.system} ✓`);
  renderSalvage();
  updateAvail();
  // Pull the new mission in so the progress bar shows promptly (retry for lag).
  loadActiveSurveys();
  setTimeout(loadActiveSurveys, 2000);
}
