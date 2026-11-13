import { describe, expect, it } from 'vitest';
import { baseUrlClass } from '../../src/accreditation/providers/base-url.js';

// How reachable the installation is, judged from its configured base address alone (no name lookup, no network): not
// set, this computer only, a local network, or a public name. Loopback is decided before the private ranges, because
// the outbound guard counts loopback among them.

describe('baseUrlClass', () => {
  it('no address, an empty one or one that does not parse is unset', () => {
    expect(baseUrlClass(null)).toEqual({ class: 'unset', host: null });
    expect(baseUrlClass('')).toEqual({ class: 'unset', host: null });
    expect(baseUrlClass('   ')).toEqual({ class: 'unset', host: null });
    expect(baseUrlClass('perpus sekolah')).toEqual({ class: 'unset', host: null });
    expect(baseUrlClass('http://')).toEqual({ class: 'unset', host: null });
  });

  it('localhost names, the loopback range and ::1 are this computer only', () => {
    expect(baseUrlClass('http://localhost:8080')).toEqual({ class: 'localhost', host: 'localhost' });
    expect(baseUrlClass('http://perpus.localhost/')).toEqual({ class: 'localhost', host: 'perpus.localhost' });
    expect(baseUrlClass('http://127.0.0.2')).toEqual({ class: 'localhost', host: '127.0.0.2' });
    expect(baseUrlClass('http://127.0.0.1:3000/altis')).toEqual({ class: 'localhost', host: '127.0.0.1' });
    expect(baseUrlClass('http://[::1]')).toEqual({ class: 'localhost', host: '::1' });
    expect(baseUrlClass('http://LOCALHOST.')).toEqual({ class: 'localhost', host: 'localhost' });
  });

  it('private, shared and other non-public addresses, single-label names and local suffixes are a local network', () => {
    for (const url of ['http://192.168.1.10', 'http://10.0.0.5', 'http://100.64.1.1', 'http://172.16.4.2:8080', 'http://[fd00::5]', 'http://169.254.10.1']) {
      expect(baseUrlClass(url).class, url).toBe('private');
    }
    expect(baseUrlClass('http://perpus.local')).toEqual({ class: 'private', host: 'perpus.local' });
    expect(baseUrlClass('http://perpus')).toEqual({ class: 'private', host: 'perpus' });
    for (const url of ['http://perpus.lan', 'http://altis.internal', 'http://altis.intranet', 'https://perpus.home.arpa']) {
      expect(baseUrlClass(url).class, url).toBe('private');
    }
  });

  it('a public name or a public address is public', () => {
    expect(baseUrlClass('https://perpus.sma-contoh.sch.id')).toEqual({ class: 'public', host: 'perpus.sma-contoh.sch.id' });
    expect(baseUrlClass('https://Perpus.SMA-Contoh.sch.id/opac?x=1')).toEqual({ class: 'public', host: 'perpus.sma-contoh.sch.id' });
    expect(baseUrlClass('http://203.0.113.0.example.org')).toEqual({ class: 'public', host: '203.0.113.0.example.org' });
    expect(baseUrlClass('http://8.8.8.8')).toEqual({ class: 'public', host: '8.8.8.8' });
    expect(baseUrlClass('http://[2001:4860::8888]')).toEqual({ class: 'public', host: '2001:4860::8888' });
  });

  it('only a web address counts: another scheme is unset', () => {
    expect(baseUrlClass('ftp://perpus.sma-contoh.sch.id')).toEqual({ class: 'unset', host: null });
    expect(baseUrlClass('file:///srv/altis')).toEqual({ class: 'unset', host: null });
  });
});
