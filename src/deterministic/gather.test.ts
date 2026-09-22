import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isHealthyProducingGather,
  parseCurrentActionProducedCount,
} from './gather.js';

const HEALTHY_COAL = `CURRENT ACTION
02:55:37
Coal Ore
+877
Next item in 0:05
0.23 EXP/s
YOUR PROGRESS
Mining
Lv. 30`;

describe('isHealthyProducingGather', () => {
  it('detects IdleMMO producing coal panel', () => {
    assert.equal(isHealthyProducingGather(HEALTHY_COAL, 'Coal Ore'), true);
    assert.equal(isHealthyProducingGather(HEALTHY_COAL, 'Tin Ore'), false);
    assert.equal(isHealthyProducingGather('idle mining page with Start', 'Coal Ore'), false);
  });
});

describe('parseCurrentActionProducedCount', () => {
  it('parses +N and +N.NK counters', () => {
    assert.equal(parseCurrentActionProducedCount(HEALTHY_COAL), 877);
    assert.equal(
      parseCurrentActionProducedCount('CURRENT ACTION\nCoal Ore\n+1.2K\nNext item in 0:03'),
      1200,
    );
    assert.equal(parseCurrentActionProducedCount('no action'), undefined);
  });
});
