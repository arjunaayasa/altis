import { describe, expect, it } from 'vitest';
import { dublinCoreMeta, formatCitation, openGraph, recordJsonLd, toBibtex, toOaiDc, toRis } from '../../src/catalog/render/index.js';
import { RENDER_OPTIONS, recordData, urlAttachment } from '../support/record-data-fixtures.js';

// S4 (Global Constraints "URLs from untrusted data"): a URL that came from a file, an SRU answer or a migration is
// stored only when it is http/https, and every renderer checks the scheme again before it writes the URL.

const GOOD = 'https://repo.example.org/laskar-pelangi.pdf';

function hostile() {
  const d = recordData({
    attachments: [
      urlAttachment('javascript:x'),
      urlAttachment(GOOD, { title: 'Teks lengkap' }),
      urlAttachment('JAVASCRIPT:alert(1)'),
      urlAttachment(' javascript:x'),
      urlAttachment('data:text/html,<script>x</script>'),
      urlAttachment('vbscript:msgbox(1)'),
      urlAttachment('https://staff-only.example.org/', { access: 'staff' }),
      urlAttachment('https://bad host.example.org/'),
      urlAttachment(`https://long.example.org/${'a'.repeat(2000)}`),
      { id: '01JRENDERFILEATTACH0000001', kind: 'file', fileId: '01JRENDERFILE0000000000001', url: null, title: 'Berkas', access: 'public', mime: 'application/pdf' },
    ],
    links: [
      { url: 'javascript:x', title: 'x' },
      { url: GOOD, title: 'Teks lengkap' },
    ],
  });
  return d;
}

/** Every text the renderers write for `d`. */
function outputs(d: ReturnType<typeof recordData>, o: typeof RENDER_OPTIONS): Record<string, string> {
  const out: Record<string, string> = {
    ris: toRis(d, o),
    bibtex: toBibtex(d, o),
    jsonLd: JSON.stringify(recordJsonLd(d, o)),
    dc: JSON.stringify(dublinCoreMeta(d, o)),
    og: JSON.stringify(openGraph(d, o)),
    oaiDc: toOaiDc(d, o),
  };
  for (const style of ['apa', 'mla', 'chicago'] as const) out[style] = JSON.stringify(formatCitation(d, style, o.locale));
  return out;
}

describe('S4: renderers write only http(s) attachment URLs', () => {
  it('a javascript:, data: or vbscript: attachment appears in no output; a staff or malformed one neither', () => {
    for (const [name, text] of Object.entries(outputs(hostile(), { ...RENDER_OPTIONS, coverUrl: 'javascript:cover' }))) {
      expect(text, name).not.toMatch(/javascript|vbscript|data:/i);
      expect(text, name).not.toContain('staff-only');
      expect(text, name).not.toContain('bad host');
      expect(text, name).not.toContain('long.example.org');
    }
  });

  it('the http(s) attachment is written where an attachment URL belongs: RIS UR, JSON-LD, Dublin Core', () => {
    const out = outputs(hostile(), RENDER_OPTIONS);
    expect(out.ris!.split('\r\n')).toContain(`UR  - ${GOOD}`);
    expect(recordJsonLd(hostile(), RENDER_OPTIONS).associatedMedia).toEqual([{ '@type': 'MediaObject', name: 'Teks lengkap', url: GOOD }]);
    expect(dublinCoreMeta(hostile(), RENDER_OPTIONS)).toContainEqual({ name: 'DC.identifier', content: GOOD });
    // oai_dc's identifiers are the §10 list (OPAC URL, urn:isbn, urn:issn, DOI); attachments are not among them.
    expect(out.oaiDc).not.toContain(GOOD);
  });

  it('a cover URL that is not http(s) is no image', () => {
    const o = { ...RENDER_OPTIONS, coverUrl: 'javascript:cover' };
    expect(recordJsonLd(recordData(), o)).not.toHaveProperty('image');
    expect(openGraph(recordData(), o).some((m) => m.property.startsWith('og:image'))).toBe(false);
  });
});
