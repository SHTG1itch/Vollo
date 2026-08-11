import assert from 'node:assert/strict';
import test from 'node:test';
import { unexpectedHighAdvisories } from '../../scripts/audit-mobile-dependencies.mjs';

test('dependency audit accepts only the reviewed image-size advisory chain', () => {
  const report = {
    vulnerabilities: {
      'image-size': {
        severity: 'high',
        via: [{ source: 1138808 }, { source: 1138809 }],
      },
      metro: { severity: 'high', via: ['image-size', 'metro-config'] },
      'metro-config': { severity: 'high', via: ['metro'] },
      unrelated: { severity: 'high', via: [{ source: 42 }] },
      moderate: { severity: 'moderate', via: [{ source: 7 }] },
    },
  };

  assert.deepEqual(unexpectedHighAdvisories(report), [{ name: 'unrelated', sources: ['42'] }]);
  delete report.vulnerabilities.unrelated;
  assert.deepEqual(unexpectedHighAdvisories(report), []);
});
