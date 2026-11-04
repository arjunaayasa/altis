import { describe, expect, it } from 'vitest';
import { analyzeXff, xffClientAt } from '../src/diagnostics/xff.js';

// The browser's X-Forwarded-For test of Diagnostik (spec §11, P15; decision C22): a clean poll (no X-Forwarded-For of
// its own) and a forged one (`X-Forwarded-For: 203.0.113.77`) through the host's proxies. The proxies append one entry
// each to what arrives, so the clean chain's length is the number of hops to trust; the forged value becoming the
// client IP means the configured hops trust an entry the client wrote itself.

const FORGED = '203.0.113.77';

describe('analyzeXff', () => {
  it('a hosting proxy (one entry) with hops 1: not spoofable, suggested 1', () => {
    expect(
      analyzeXff({ cleanXff: ['198.51.100.7'], forgedXff: [FORGED, '198.51.100.7'], forged: FORGED, forgedDerived: '198.51.100.7' }),
    ).toEqual({ spoofable: false, suggestedHops: 1 });
  });

  it('hops set too high: the forged entry became the client IP → spoofable, suggested 1', () => {
    expect(
      analyzeXff({ cleanXff: ['198.51.100.7'], forgedXff: [FORGED, '198.51.100.7'], forged: FORGED, forgedDerived: FORGED }),
    ).toEqual({ spoofable: true, suggestedHops: 1 });
  });

  it('Cloudflare in front of the hosting proxy (two entries): suggested 2', () => {
    expect(
      analyzeXff({
        cleanXff: ['198.51.100.7', '172.68.1.1'],
        forgedXff: [FORGED, '198.51.100.7', '172.68.1.1'],
        forged: FORGED,
        forgedDerived: '198.51.100.7',
      }),
    ).toEqual({ spoofable: false, suggestedHops: 2 });
  });

  it('no proxy at all (no entry arrives): suggested 0', () => {
    expect(analyzeXff({ cleanXff: [], forgedXff: [FORGED], forged: FORGED, forgedDerived: '198.51.100.7' })).toEqual({
      spoofable: false,
      suggestedHops: 0,
    });
  });

  it('compares the addresses as addresses: blanks and an IPv4-mapped IPv6 form still count as the forged value', () => {
    expect(analyzeXff({ cleanXff: [' 198.51.100.7 '], forgedXff: [], forged: FORGED, forgedDerived: `::ffff:${FORGED}` }).spoofable).toBe(true);
    expect(analyzeXff({ cleanXff: [], forgedXff: [], forged: FORGED, forgedDerived: ` ${FORGED} ` }).spoofable).toBe(true);
    expect(analyzeXff({ cleanXff: [], forgedXff: [], forged: FORGED, forgedDerived: '' }).spoofable).toBe(false);
  });

  it('counts only entries that are not blank, and never suggests more than 10 hops', () => {
    expect(analyzeXff({ cleanXff: ['198.51.100.7', '', ' '], forgedXff: [], forged: FORGED, forgedDerived: '198.51.100.7' }).suggestedHops).toBe(1);
    const many = Array.from({ length: 12 }, (_, i) => `198.51.100.${i + 1}`);
    expect(analyzeXff({ cleanXff: many, forgedXff: [], forged: FORGED, forgedDerived: '198.51.100.1' }).suggestedHops).toBe(10);
  });
});

describe('xffClientAt (the wizard judges its forged poll at the hops confirmed in POST config)', () => {
  it('the hops-th entry from the right, as http/client-ip.ts derives it; the socket peer (\'\') at hops 0 or past the chain', () => {
    const forged = [FORGED, '198.51.100.7'];
    expect(xffClientAt(forged, 0)).toBe('');
    expect(xffClientAt(forged, 1)).toBe('198.51.100.7');
    expect(xffClientAt(forged, 2)).toBe(FORGED);
    expect(xffClientAt(forged, 3)).toBe('');
    expect(xffClientAt([FORGED], 1)).toBe(FORGED);
    expect(xffClientAt([], 1)).toBe('');
  });

  it('no proxy in front: hops 0 is not spoofable, hops 1 is (whatever the pre-install hops derived)', () => {
    const judged = (hops: number) => analyzeXff({ cleanXff: [], forgedXff: [FORGED], forged: FORGED, forgedDerived: xffClientAt([FORGED], hops) });
    expect(judged(0)).toEqual({ spoofable: false, suggestedHops: 0 });
    expect(judged(1)).toEqual({ spoofable: true, suggestedHops: 0 });
  });
});
