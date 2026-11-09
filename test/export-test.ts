import assert from 'node:assert';
import miniget, {
  Miniget,
  MinigetError,
  defaultOptions,
  miniget as namedMiniget,
} from '..';

describe('Exports', () => {
  it('Exposes function as default and named export', () => {
    assert.strictEqual(miniget, namedMiniget);
    assert.strictEqual(miniget, Miniget);
    assert.strictEqual(miniget.miniget, miniget);
    assert.strictEqual(miniget.default, miniget);
    assert.strictEqual(miniget.MinigetError, MinigetError);
    assert.strictEqual(miniget.defaultOptions, defaultOptions);
  });
});
