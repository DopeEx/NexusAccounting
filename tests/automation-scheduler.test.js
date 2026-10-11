import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAutomationTask, runAutomationCycle } from '../nexus-addon/automation-scheduler.js';

test('automation tasks run in registration order and can be unregistered', async () => {
  const calls = [];
  const removeFirst = registerAutomationTask('first-test', async () => { calls.push('first'); });
  const removeSecond = registerAutomationTask('second-test', async () => { calls.push('second'); });

  await runAutomationCycle();
  removeFirst();
  removeSecond();

  assert.deepEqual(calls, ['first', 'second']);
});

test('automation cycles do not overlap', async () => {
  let calls = 0;
  let finishTask;
  const removeTask = registerAutomationTask('overlap-test', () => {
    calls++;
    return new Promise(resolve => { finishTask = resolve; });
  });

  const firstCycle = runAutomationCycle();
  const secondCycle = runAutomationCycle();
  assert.equal(secondCycle, firstCycle);
  assert.equal(calls, 1);

  finishTask();
  await firstCycle;
  removeTask();
});
