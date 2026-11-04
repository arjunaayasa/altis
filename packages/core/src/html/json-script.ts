/**
 * JSON text to put inside an HTML `<script>` element (S6; spec §9.4: JSON-LD): `JSON.stringify(value)` with `<`, `>`,
 * `&`, U+2028 and U+2029 written as `\u` escapes. The script's text then can neither end the element (`</script`),
 * open a comment (`<!--`) nor break an older JavaScript parser, and it is still the same JSON (`JSON.parse` gives the
 * value back). The OPAC's `jsonLdScript` (apps/server/src/opac/catalog/page.tsx) is its one caller on a page.
 *
 * @throws TypeError for a value that has no JSON text (undefined, a function, a symbol) and for what JSON.stringify
 *   refuses (a BigInt, a cycle)
 */
export function jsonForHtmlScript(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new TypeError('jsonForHtmlScript: the value has no JSON text', { cause: error });
  }
  if (typeof text !== 'string') throw new TypeError('jsonForHtmlScript: the value has no JSON text');
  return text.replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
