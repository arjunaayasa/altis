/**
 * The add-on keys of the commercial editions. No registry entry of the community edition may use one as a name, as the
 * start of a name, or as a segment of a name (a segment is a part split off by `.`, `_`, `:`, `-` or a camelCase
 * boundary). `multi_branch` is two segments, so it is matched as `multi` followed by `branch`.
 *
 * Shared by the registry checks of `@altis/shared` (edition-names.test.ts) and of the core and server registries.
 */
export const RESERVED_EDITION_TOKENS = Object.freeze(['kiosk', 'iot', 'face', 'sip2', 'integrations', 'multi_branch'] as const);

/**
 * The segments of a registry name, lower-cased: split on `.`, `_`, `:`, `-` and at camelCase boundaries
 * (`arsyaEnabled` → `arsya`, `enabled`; `XMLHttp` → `xml`, `http`). Empty parts are dropped.
 */
export function nameSegments(name: string): string[] {
  return name
    .split(/[._:-]+/)
    .flatMap((part) =>
      part
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(' '),
    )
    .filter((segment) => segment !== '')
    .map((segment) => segment.toLowerCase());
}

/** The reserved token `name` holds as a segment (or a segment sequence), or null when it holds none. */
export function reservedTokenIn(name: string): string | null {
  const segments = nameSegments(name);
  for (const token of RESERVED_EDITION_TOKENS) {
    const parts = token.split('_');
    for (let i = 0; i + parts.length <= segments.length; i += 1) {
      if (parts.every((part, j) => segments[i + j] === part)) return token;
    }
  }
  return null;
}
