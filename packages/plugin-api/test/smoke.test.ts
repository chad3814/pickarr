import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_API_VERSION } from '@pickarr/plugin-api';

test('plugin-api resolves through the development condition', () => {
  assert.equal(PLUGIN_API_VERSION, 1);
});
