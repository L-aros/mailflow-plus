import { describe, it, expect } from 'vitest';
import { resolveBuildInfo } from './buildInfo.js';

describe('prepared image source identity', () => {
  it('keeps baked version/SHA and exact source link despite runtime environment drift', () => {
    const sha = 'b'.repeat(40);
    expect(resolveBuildInfo({ version: 'v4.3.0-plus.123', sha }, {
      APP_VERSION: 'wrong', BUILD_SHA: 'a'.repeat(40),
    }, '4.3.0')).toEqual({ version: '4.3.0-plus.123', sha,
      product: 'MailFlow Plus', sourceUrl: `https://github.com/L-aros/mailflow-plus/tree/${sha}` });
  });

  it('uses an explicitly non-immutable branch source for an unprepared checkout', () => {
    const info = resolveBuildInfo({}, { BUILD_SHA: '../../untrusted?query' }, '4.3.0');
    expect(info.sourceUrl).toBe('https://github.com/L-aros/mailflow-plus/tree/mailflow-plus');
    expect(info.version).toBe('4.3.0');
  });
});
