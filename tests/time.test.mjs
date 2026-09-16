import test from 'node:test';
import assert from 'node:assert/strict';
import {dateKey, dayRange, formatDateTime, timestamp, waitingLabel} from '../lib/time.ts';

test('server timezone controls dates regardless of browser timezone', () => {
  const instant='2026-09-15T16:30:00Z';
  assert.equal(formatDateTime(instant,'Asia/Shanghai'),'2026-09-16 00:30:00');
  assert.equal(formatDateTime(instant,'UTC'),'2026-09-15 16:30:00');
  assert.equal(dateKey(instant,'America/Los_Angeles'),'2026-09-15');
  assert.equal(formatDateTime('2026-09-16T00:30:00+08:00','Asia/Shanghai'),'2026-09-16 00:30:00');
});
test('server calendar ranges handle day, month, year and DST boundaries', () => {
  assert.deepEqual(dayRange(Date.parse('2026-01-01T00:30:00Z'),'UTC',30),{start:'2025-12-03',end:'2026-01-01'});
  assert.deepEqual(dayRange(Date.parse('2026-09-15T16:30:00Z'),'Asia/Shanghai',90),{start:'2026-06-19',end:'2026-09-16'});
  assert.deepEqual(dayRange(Date.parse('2026-03-09T03:30:00Z'),'America/New_York',2),{start:'2026-03-07',end:'2026-03-08'});
});
test('missing timestamps are not invented and waiting time uses server now', () => {
  assert.equal(formatDateTime(undefined,'UTC'),'未记录');
  assert.equal(formatDateTime('invalid','UTC'),'未记录');
  assert.equal(dateKey('invalid','UTC'),'');
  assert.equal(waitingLabel('2026-09-16T00:00:00Z',Date.parse('2026-09-16T00:42:00Z')),'最早一笔已等待 42 分钟');
  assert.equal(waitingLabel('2026-09-17T00:00:00Z',Date.parse('2026-09-16T00:42:00Z')),'最早一笔等待不足 1 分钟');
});
test('PostgreSQL offset timestamps normalize without browser-dependent parsing', () => {
  for(const value of ['2026-09-16 00:30:00.123456+08','2026-09-16T00:30:00.123+0800','2026-09-16T00:30:00.123+08:00']) {
    assert.equal(timestamp(value),Date.parse('2026-09-15T16:30:00.123Z'));
    assert.equal(formatDateTime(value,'UTC'),'2026-09-15 16:30:00');
  }
  assert.equal(Number.isNaN(timestamp('2026-09-16 00:30:00')),true);
});
