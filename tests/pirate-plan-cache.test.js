import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NEVER, cacheKey, enemySignature, fingerprintOf, newRecord, pruneCache, recordResult,
} from '../nexus-addon/pirate-plan-cache.js';

test('results narrow the known bounds', () => {
  let rec = newRecord();
  rec = recordResult(rec, 40, false);
  rec = recordResult(rec, 80, true);
  rec = recordResult(rec, 60, true);
  rec = recordResult(rec, 50, false, true);
  assert.equal(rec.lo, 50);
  assert.equal(rec.hi, 60);
  assert.equal(rec.scaled, true);
  assert.equal(newRecord().hi, NEVER);
});

test('enemy signature ignores order, fingerprint ignores key order', () => {
  assert.equal(
    enemySignature([{ shipDefId: 'b', quantity: 2 }, { shipDefId: 'a', quantity: 1 }]),
    enemySignature([{ shipDefId: 'a', quantity: 1 }, { shipDefId: 'b', quantity: 2 }]),
  );
  assert.equal(fingerprintOf({ a: 1, b: { c: 2, d: 3 } }), fingerprintOf({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(fingerprintOf({ a: 1 }), fingerprintOf({ a: 2 }));
});

test('cache key separates ship types and bonus profiles', () => {
  const base = { fingerprint: 'x', zone: 3, signature: 's', shipDefId: 'a' };
  assert.notEqual(cacheKey(base), cacheKey({ ...base, shipDefId: 'b' }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, fingerprint: 'y' }));
});

test('pruneCache drops stale entries and caps the size', () => {
  const now = Date.now();
  const entries = { old: { ...newRecord(), at: now - 61 * 24 * 3600 * 1000 } };
  for (let i = 0; i < 600; i++) entries[`k${i}`] = { ...newRecord(), at: now - i };
  const pruned = pruneCache(entries, now);
  assert.equal(pruned.old, undefined);
  assert.equal(Object.keys(pruned).length, 500);
  assert.ok(pruned.k0);
});
