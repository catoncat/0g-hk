import test from 'node:test';
import assert from 'node:assert';
import { ctEq } from '../src/util.js';

test('ctEq - equal strings', () => {
  assert.strictEqual(ctEq('hello', 'hello'), true);
  assert.strictEqual(ctEq('', ''), true);
  assert.strictEqual(ctEq('a', 'a'), true);
});

test('ctEq - different strings of same length', () => {
  assert.strictEqual(ctEq('hello', 'world'), false);
  assert.strictEqual(ctEq('abc', 'abd'), false);
  assert.strictEqual(ctEq('abc', 'axc'), false);
});

test('ctEq - different lengths', () => {
  assert.strictEqual(ctEq('hello', 'helloo'), false);
  assert.strictEqual(ctEq('helloo', 'hello'), false);
  assert.strictEqual(ctEq('a', ''), false);
  assert.strictEqual(ctEq('', 'a'), false);
});

test('ctEq - non-string inputs', () => {
  // @ts-ignore
  assert.strictEqual(ctEq(null, 'hello'), false);
  // @ts-ignore
  assert.strictEqual(ctEq('hello', null), false);
  // @ts-ignore
  assert.strictEqual(ctEq(undefined, undefined), false);
  // @ts-ignore
  assert.strictEqual(ctEq(123, 123), false);
  // @ts-ignore
  assert.strictEqual(ctEq({}, {}), false);
});

test('ctEq - special characters and unicode', () => {
  assert.strictEqual(ctEq('!@#$%^&*()', '!@#$%^&*()'), true);
  assert.strictEqual(ctEq('你好', '你好'), true);
  assert.strictEqual(ctEq('你好', '你好吗'), false);
  assert.strictEqual(ctEq('🚀', '🚀'), true);
  assert.strictEqual(ctEq('🚀', '🛸'), false);
});
