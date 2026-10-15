const AUTOMATION_INTERVAL_MS = 15_000;
const automationTasks = new Map();
let automationTimer = null;
let activeCycle = null;

export function registerAutomationTask(name, run) {
  if (typeof name !== 'string' || !name || typeof run !== 'function') {
    throw new TypeError('Automation tasks require a name and a runner function.');
  }
  if (automationTasks.has(name)) {
    throw new Error(`Automation task "${name}" is already registered.`);
  }

  automationTasks.set(name, run);
  return () => {
    if (automationTasks.get(name) === run) automationTasks.delete(name);
  };
}

export function runAutomationCycle() {
  if (activeCycle) return activeCycle;

  activeCycle = (async () => {
    for (const [name, run] of automationTasks) {
      try {
        await run();
      } catch (error) {
        console.error(`[NexusOverseer] Automation task "${name}" failed:`, error);
      }
    }
  })().finally(() => {
    activeCycle = null;
  });
  return activeCycle;
}

export function startAutomationScheduler() {
  if (automationTimer !== null) return;
  automationTimer = setInterval(() => { void runAutomationCycle(); }, AUTOMATION_INTERVAL_MS);
  void runAutomationCycle();
}

export function stopAutomationScheduler() {
  if (automationTimer === null) return;
  clearInterval(automationTimer);
  automationTimer = null;
}
