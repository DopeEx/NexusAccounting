// Suggests an attack fleet for a pirate camp: for each ship type available on the
// source planet, binary-searches the smallest count that the game's own combat
// simulator reports as a win without any own losses, then adds a safety margin.

const SAFETY_MARGIN = 0.1;
const MAX_CANDIDATE_TYPES = 5;
// The simulator was ~11 points optimistic on remaining HP in a real comparison.
const MIN_REMAINING_HP = 50;

let bootPromise = null;
const minCache = new Map();

function loadBoot() {
  if (!bootPromise) {
    bootPromise = browser.runtime.sendMessage({ type: 'SIM_BOOTSTRAP' }).then(res => {
      if (!res || res.error) throw new Error(res?.error || 'No response from the combat simulator.');
      return res.data || res;
    }).catch(error => {
      bootPromise = null;
      throw error;
    });
  }
  return bootPromise;
}

function reportOf(response) {
  const result = response?.ok && response.data ? response.data : (response?.data || response);
  return result?.report ? result : null;
}

async function simulate(camp, shipDefId, quantity) {
  const response = await browser.runtime.sendMessage({
    type: 'SIM_RUN',
    attacker: {
      type: 'player', fleet: [{ shipDefId, quantity }], useOwnBonuses: true,
      attachLeadership: false, hangarAssignments: {},
    },
    defender: {
      type: 'pirate', pirateZone: camp.securityZone,
      fleet: camp.fleetIntel.map(s => ({ shipDefId: s.shipDefId, quantity: s.quantity })),
    },
  });
  if (response?.error) throw new Error(response.error);
  const result = reportOf(response);
  if (!result) throw new Error('The simulator reply did not contain a combat report.');
  const outcome = result.exact?.outcome || result.report.outcome;
  const losses = Array.isArray(result.report.attackerLosses)
    ? result.report.attackerLosses
    : Object.values(result.report.attackerLosses || {});
  const lossFree = !losses.some(l => Number(l?.lost ?? l) > 0);
  const rounds = result.report.rounds || [];
  const hpPercent = Number(rounds[rounds.length - 1]?.attackerHpPercent ?? 0);
  return { clean: outcome === 'attacker_won' && lossFree && hpPercent >= MIN_REMAINING_HP, scaled: result.scale?.mode === 'scaled' };
}

// Smallest quantity in [1, max] with a clean win, or null if even `max` is not enough.
async function minCleanQuantity(camp, shipDefId, max) {
  const sig = camp.fleetIntel.map(s => `${s.shipDefId}x${s.quantity}`).join(',');
  const key = `${camp.id}|${camp.securityZone}|${sig}|${shipDefId}|${max}`;
  if (minCache.has(key)) return minCache.get(key);

  const top = await simulate(camp, shipDefId, max);
  let scaled = top.scaled;
  let result = null;
  if (top.clean) {
    let lo = 1;
    let hi = max;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await simulate(camp, shipDefId, mid);
      scaled = scaled || r.scaled;
      if (r.clean) hi = mid; else lo = mid + 1;
    }
    result = { quantity: lo, scaled };
  }
  minCache.set(key, result);
  return result;
}

// available: {shipDefId → count on the source planet}. Resolves to
// { ships, note } or { error }.
export async function suggestAttackFleet(camp, available) {
  if (!camp.hasFleetIntel || !(camp.fleetIntel || []).length) {
    return { error: 'Scout the camp first — no fleet intel.' };
  }
  let boot;
  try { boot = await loadBoot(); } catch (error) { return { error: error.message }; }

  const candidates = (boot.playerShips || [])
    .filter(s => !s.isNpc && Number(s.attack) > 0 && (available[s.id] || 0) > 0)
    .sort((a, b) => (b.attack * ((b.hp || 0) + (b.shieldHp || 0))) - (a.attack * ((a.hp || 0) + (a.shieldHp || 0))))
    .slice(0, MAX_CANDIDATE_TYPES);
  if (!candidates.length) return { error: 'No attack ships on this planet.' };

  const options = [];
  try {
    for (const def of candidates) {
      const r = await minCleanQuantity(camp, def.id, available[def.id]);
      if (r) options.push({ def, ...r });
    }
  } catch (error) {
    return { error: `Simulation failed: ${error.message}` };
  }
  if (!options.length) {
    return { error: `No single ship type on this planet wins with ≥${MIN_REMAINING_HP}% HP left.` };
  }

  options.sort((a, b) => a.quantity - b.quantity);
  const best = options[0];
  const quantity = Math.min(available[best.def.id], Math.ceil(best.quantity * (1 + SAFETY_MARGIN)));
  const alt = options.slice(1, 3).map(o => `${o.quantity}× ${o.def.name}`).join(', ');
  const note = `Suggested: ${quantity}× ${best.def.name} (minimum ${best.quantity} for ≥${MIN_REMAINING_HP}% HP left, +${SAFETY_MARGIN * 100}% margin).`
    + (alt ? `\nAlternatives: ${alt}` : '')
    + (best.scaled ? '\nLarge battle — simulator values are estimates.' : '');
  return { ships: { [best.def.id]: quantity }, note };
}
