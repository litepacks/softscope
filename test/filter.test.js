import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createFilter } from '../src/instrument/filter.js';

test('Filter: project root, extensions, node_modules, and glob rules', () => {
  const root = '/Users/test/my-project';
  const filter = createFilter({
    projectRoot: root,
    include: ['src/**'],
    exclude: ['**/*.spec.js', 'src/vendor/**'],
    includeNodeModules: false
  });

  // Allowed project source files
  assert.equal(filter(path.join(root, 'src/index.js')), true);
  assert.equal(filter(path.join(root, 'src/utils/math.ts')), true);

  // Excluded by pattern
  assert.equal(filter(path.join(root, 'src/index.spec.js')), false);
  assert.equal(filter(path.join(root, 'src/vendor/lib.js')), false);

  // Not matching include
  assert.equal(filter(path.join(root, 'test/index.js')), false);

  // Outside project root
  assert.equal(filter('/Users/test/other-project/src/index.js'), false);

  // node_modules excluded by default
  assert.equal(filter(path.join(root, 'node_modules/pkg/index.js')), false);

  // Unsupported extensions
  assert.equal(filter(path.join(root, 'src/styles.css')), false);
  assert.equal(filter(path.join(root, 'src/data.json')), false);
});
