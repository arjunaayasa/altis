import fs from 'node:fs';
import path from 'node:path';

// Small path helpers shared by the data-directory modules (datadir, docroot, datapath).

/** Follow at most this many symbolic links while resolving a path whose target does not exist (the kernel's own limit is 40). */
const MAX_LINK_HOPS = 40;

/**
 * `fs.realpathSync` that also reports the real letter case of existing segments on a case-insensitive file
 * system (macOS, Windows): the native variant asks the OS, the JavaScript one only resolves links. An error
 * other than "does not exist" from the native variant (some FUSE and network file systems refuse it) is
 * retried with the JavaScript one.
 */
function realpath(p: string): string {
  const native = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : null;
  if (native === null) return fs.realpathSync(p);
  try {
    return native(p);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw error;
    return fs.realpathSync(p);
  }
}

/** True when `p` exists (symbolic links are followed) and is a directory. */
export function isDirectory(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * True when `child` is `parent` or lies below it. Both must be absolute and normalised (use
 * {@link realpathNearest} first when symbolic links matter). Compares whole segments, so `/a/bc` is not
 * inside `/a/b`.
 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The real path of `p`, also when `p` (or its last few segments) does not exist yet: the nearest existing
 * ancestor is resolved with `fs.realpathSync.native` and the missing remainder is appended. A symbolic link whose
 * target does not exist is followed to where the target would be, so that a link into a forbidden directory
 * is not mistaken for a harmless new leaf. Relative paths are resolved against the working directory.
 *
 * Never throws: a component that cannot be resolved for any other reason (permissions, a link loop) is
 * treated like a missing one, which leaves the path as it was written from that point on.
 */
export function realpathNearest(p: string): string {
  return resolveNearest(path.resolve(p), 0);
}

function resolveNearest(abs: string, hops: number): string {
  const rest: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return path.join(realpath(current), ...rest);
    } catch {
      // not resolvable as it stands: look at the link itself, then go one level up
    }
    const target = readLink(current);
    if (target !== null) {
      if (hops >= MAX_LINK_HOPS) return abs;
      return resolveNearest(path.resolve(realParent(current), target, ...rest), hops + 1);
    }
    const parent = path.dirname(current);
    if (parent === current) return path.join(current, ...rest); // nothing on the way exists
    rest.unshift(path.basename(current));
    current = parent;
  }
}

/** The target of the symbolic link at `p`, or null when `p` is not a symbolic link (or does not exist). */
function readLink(p: string): string | null {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : null;
  } catch {
    return null;
  }
}

/** The real directory that contains `p`; a relative link target is relative to it, not to the path as written. */
function realParent(p: string): string {
  const parent = path.dirname(p);
  try {
    return realpath(parent);
  } catch {
    return parent;
  }
}
