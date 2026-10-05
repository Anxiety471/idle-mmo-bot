import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';
import { isThrottleResponse, rateLimitBackoffMs, throttledPathKey, watchHttp } from './battle-confirm.js';
import { maxDefined, saleConfirmedByGold } from './vendor-sell.js';

function fakeResp(status: number, url: string, method = 'GET') {
  return { status: () => status, url: () => url, request: () => ({ method: () => method }) };
}

describe('round 8 battle throttle detection', () => {
  it('flags 429/503 from the game host only', () => {
    assert.equal(isThrottleResponse(429, 'https://web.idle-mmo.com/combat/battle'), true);
    assert.equal(isThrottleResponse(503, 'https://web.idle-mmo.com/livewire/update'), true);
    assert.equal(isThrottleResponse(200, 'https://web.idle-mmo.com/combat/battle'), false);
    assert.equal(isThrottleResponse(429, 'https://example.com/x'), false);
    assert.equal(isThrottleResponse(429, 'not a url'), false);
  });

  it('backoff defaults to 15 minutes, honours env, caps at 30 minutes', () => {
    assert.equal(rateLimitBackoffMs({}), 900_000);
    assert.equal(rateLimitBackoffMs({ BATTLE_RATE_LIMIT_BACKOFF_MS: '60000' }), 60_000);
    assert.equal(rateLimitBackoffMs({ BATTLE_RATE_LIMIT_BACKOFF_MS: '99999999' }), 1_800_000);
    assert.equal(rateLimitBackoffMs({ BATTLE_RATE_LIMIT_BACKOFF_MS: 'x' }), 900_000);
  });

  it('watchHttp counts throttled responses and Livewire POST statuses, then detaches', () => {
    const page = new EventEmitter();
    const watch = watchHttp(page as unknown as Page);
    page.emit('response', fakeResp(200, 'https://web.idle-mmo.com/livewire-abc/update', 'POST'));
    page.emit('response', fakeResp(429, 'https://web.idle-mmo.com/combat/battle'));
    page.emit('response', fakeResp(429, 'https://web.idle-mmo.com/livewire/update', 'POST'));
    assert.equal(watch.throttled, 2);
    assert.deepEqual(watch.livewire, [200, 429]);
    assert.deepEqual(watch.throttledPaths, ['GET /combat/battle', 'POST /livewire/update']);
    watch.stop();
    page.emit('response', fakeResp(429, 'https://web.idle-mmo.com/combat/battle'));
    assert.equal(watch.throttled, 2);
  });
});

describe('throttledPathKey', () => {
  it('keeps method + path, drops the query, collapses ids', () => {
    assert.equal(throttledPathKey('post', 'https://web.idle-mmo.com/api/34523452/235453253245/x?token=abc'), 'POST /api/:id/:id/x');
    assert.equal(throttledPathKey('GET', 'nope'), undefined);
  });
});

describe('round 8 vendor sale gold verification', () => {
  it('only counts a sale when gold strictly increased', () => {
    assert.equal(saleConfirmedByGold(4908, 4908), false);
    assert.equal(saleConfirmedByGold(4908, undefined), false);
    assert.equal(saleConfirmedByGold(undefined, 5000), false);
    assert.equal(saleConfirmedByGold(4908, 4800), false);
    assert.equal(saleConfirmedByGold(17244, 20444), true);
  });

  it('a stale (lower) gold read falls back to the last confirmed value', () => {
    assert.equal(maxDefined(9148, 12580), 12580);
    assert.equal(maxDefined(undefined, 9148), 9148);
    assert.equal(maxDefined(9300, 9148), 9300);
    assert.equal(maxDefined(undefined, undefined), undefined);
  });
});
