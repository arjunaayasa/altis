/**
 * altis/no-nonliteral-fs (spec §7.5): outside the @altis/platform helpers, fs and path calls must
 * not receive a non-literal path argument.
 *
 * The rule follows bindings by import source instead of by identifier name. A call is checked when
 * its callee resolves (through scope analysis) to a function of `fs`, `fs/promises`, `path`,
 * `path/posix` or `path/win32` (optionally prefixed with `node:`), whichever way it was obtained:
 *   - `import fs from`, `import * as fs from`, `import { readFileSync, promises as fsp } from`;
 *   - TypeScript's `import fs = require('node:fs')`;
 *   - `require('node:fs')`, `await import('node:fs')`, also destructured;
 *   - aliases such as `const fsp = fs.promises` or `const { readFile } = fs.promises`.
 * A variable that merely happens to be called `path` or `fs` is not checked.
 *
 * Checked arguments: every argument of a `path` function (`path.join('/srv/public', p)` builds a path
 * from `p` as much as `path.join(p)` does); the path argument(s) of an `fs` function (both of
 * rename, copyFile, cp, link, symlink), none of one taking a file descriptor.
 */

const MODULES = new Map([
  ['fs', 'fs'],
  ['node:fs', 'fs'],
  ['fs/promises', 'fsPromises'],
  ['node:fs/promises', 'fsPromises'],
  ['path', 'path'],
  ['node:path', 'path'],
  ['path/posix', 'path'],
  ['node:path/posix', 'path'],
  ['path/win32', 'path'],
  ['node:path/win32', 'path'],
]);

/** fs functions that take two path arguments; every one of them is checked. */
const TWO_PATH_FUNCTIONS = new Set([
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'link',
  'linkSync',
  'symlink',
  'symlinkSync',
]);

/** fs functions whose first argument is a file descriptor, not a path. */
const FD_FUNCTIONS = new Set(
  [
    'close',
    'fchmod',
    'fchown',
    'fdatasync',
    'fstat',
    'fsync',
    'ftruncate',
    'futimes',
    'read',
    'readv',
    'write',
    'writev',
  ].flatMap((name) => [name, `${name}Sync`]),
);

const TS_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ChainExpression',
  'ParenthesizedExpression',
]);

const MAX_DEPTH = 8;

function unwrap(node) {
  let current = node;
  while (current && TS_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

/** Static member name of `a.b` / `a['b']`, or null when it cannot be determined. */
function memberName(node) {
  if (node.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return null;
}

/** What `namespace.name` is: a nested namespace (fs.promises, path.posix) or a function. */
function memberOf(namespace, name) {
  if (namespace.module === 'fs' && name === 'promises') return { kind: 'namespace', module: 'fsPromises' };
  if (namespace.module === 'path' && (name === 'posix' || name === 'win32')) {
    return { kind: 'namespace', module: 'path' };
  }
  return { kind: 'function', module: namespace.module, name };
}

function isStaticLiteral(node) {
  const inner = unwrap(node);
  if (inner.type === 'Literal') return true;
  return inner.type === 'TemplateLiteral' && inner.expressions.length === 0;
}

function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return null;
}

/** Indexes of the call arguments that are paths for the resolved function, given its argument count. */
function pathArgumentIndexes(fn, count) {
  if (fn.module === 'path') return Array.from({ length: count }, (_, i) => i);
  if (FD_FUNCTIONS.has(fn.name)) return [];
  return TWO_PATH_FUNCTIONS.has(fn.name) ? [0, 1] : [0];
}

/**
 * The module an import declaration names: the `from` source of an ImportDeclaration, or the
 * `require('...')` of a TypeScript `import x = require('...')`. Null for anything else, such as
 * `import x = Namespace.member` (no module at all).
 */
function importedModuleName(declaration) {
  if (declaration.type === 'TSImportEqualsDeclaration') {
    const reference = declaration.moduleReference;
    if (reference?.type !== 'TSExternalModuleReference') return null;
    const expression = reference.expression;
    return expression?.type === 'Literal' && typeof expression.value === 'string' ? expression.value : null;
  }
  const source = declaration.source;
  return source?.type === 'Literal' && typeof source.value === 'string' ? source.value : null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow fs/path calls with non-literal path arguments (spec §7.5)' },
    schema: [],
    messages: {
      nonLiteral:
        'Non-literal fs/path argument. Do file I/O and path construction only through the @altis/platform ' +
        'helpers (dataPath() and friends); calling fs/path directly with a dataPath() result is still ' +
        'forbidden (spec §7.5).',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    /**
     * Resolves an expression to `{kind:'namespace', module}` or `{kind:'function', module, name}`
     * when it denotes an fs/path module (or a member of one), otherwise null.
     */
    function resolve(node, depth = 0) {
      if (depth > MAX_DEPTH) return null;
      const expr = unwrap(node);
      switch (expr.type) {
        case 'Identifier':
          return resolveIdentifier(expr, depth);
        case 'MemberExpression': {
          const name = memberName(expr);
          if (name === null) return null;
          const object = resolve(expr.object, depth + 1);
          return object?.kind === 'namespace' ? memberOf(object, name) : null;
        }
        case 'CallExpression': {
          const [first] = expr.arguments;
          const isRequire = expr.callee.type === 'Identifier' && expr.callee.name === 'require';
          if (isRequire && expr.arguments.length === 1 && first?.type === 'Literal') {
            const module = MODULES.get(first.value);
            return module ? { kind: 'namespace', module } : null;
          }
          return null;
        }
        case 'AwaitExpression': {
          const argument = unwrap(expr.argument);
          if (argument.type === 'ImportExpression' && argument.source.type === 'Literal') {
            const module = MODULES.get(argument.source.value);
            return module ? { kind: 'namespace', module } : null;
          }
          return null;
        }
        default:
          return null;
      }
    }

    function resolveIdentifier(identifier, depth) {
      const variable = findVariable(sourceCode.getScope(identifier), identifier.name);
      const definition = variable?.defs[0];
      if (!definition) return null;

      if (definition.type === 'ImportBinding') {
        const declaration = definition.parent;
        const specifier = definition.node;
        if (!declaration || declaration.importKind === 'type' || specifier.importKind === 'type') return null;
        const name = importedModuleName(declaration);
        const module = name === null ? undefined : MODULES.get(name);
        if (!module) return null;
        const namespace = { kind: 'namespace', module };
        if (specifier.type !== 'ImportSpecifier') return namespace;
        const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
        return imported === 'default' ? namespace : memberOf(namespace, imported);
      }

      if (definition.type === 'Variable' && definition.node.init) {
        const declarator = definition.node;
        const init = resolve(declarator.init, depth + 1);
        if (!init) return null;
        if (declarator.id.type === 'Identifier') return init;
        if (declarator.id.type === 'ObjectPattern' && init.kind === 'namespace') {
          for (const property of declarator.id.properties) {
            if (property.type !== 'Property') continue;
            const value = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
            if (value.type !== 'Identifier' || value.name !== identifier.name) continue;
            if (!property.computed && property.key.type === 'Identifier') return memberOf(init, property.key.name);
            if (property.key.type === 'Literal') return memberOf(init, String(property.key.value));
          }
        }
      }
      return null;
    }

    return {
      CallExpression(node) {
        const callee = resolve(node.callee);
        if (callee?.kind !== 'function') return;
        for (const index of pathArgumentIndexes(callee, node.arguments.length)) {
          const argument = node.arguments[index];
          if (argument && !isStaticLiteral(argument)) {
            context.report({ node: argument, messageId: 'nonLiteral' });
            return;
          }
        }
      },
    };
  },
};

export default rule;
