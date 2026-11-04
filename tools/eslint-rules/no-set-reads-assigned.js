/**
 * altis/no-set-reads-assigned (spec §6.2): in an UPDATE, a SET value must not read a column that an earlier
 * assignment of the same statement sets.
 *
 * MySQL and MariaDB evaluate the assignments of `UPDATE t SET a = 1, b = a + 1` left to right, so `b` reads the new
 * `a`; PostgreSQL, SQLite and the standard read the old one. The statement means two things, and only a test on
 * every dialect would show it. Reading the column an assignment sets itself (`SET count = count + 1`) or one that
 * is assigned later (`SET a = b, b = 2`) is the same everywhere and stays allowed.
 *
 * Checked: the object of `.set({...})`, the object a callback returns (`.set((eb) => ({...}))`, an expression body
 * or `return`s of a block body), and an earlier `.set()` of the same call chain (Kysely merges them into one
 * statement). A property value is searched, however deeply it is nested, for
 *   - `sql.ref('<col>')` and `sql.id('<col>')` (the last argument of `sql.id`);
 *   - `<eb>.ref('<col>')`;
 *   - `<eb>('<col>', ...)`;
 * where `<eb>` is the callback's parameter, or a name `eb` / `expressionBuilder`. The match goes by name, not by
 * binding, and by the column part of the name (`t.a` is `a`), so a join update that reads the other table's
 * column of that name is reported too; silence it with a comment that says so.
 *
 * Not seen: a column passed as a string to `eb.fn.*()`, a `.set()` object built elsewhere, spreads, computed
 * keys and references with a non-literal name. Their columns are unknown to a syntax check.
 */

const DEFAULT_BUILDERS = ['eb', 'expressionBuilder'];

const TS_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ChainExpression',
  'ParenthesizedExpression',
]);

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);

function unwrap(node) {
  let current = node;
  while (current && TS_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

/** The text of a string literal or a template literal without substitutions; null for anything else. */
function stringValue(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0 && n.quasis.length === 1) {
    return n.quasis[0].value.cooked ?? null;
  }
  return null;
}

/** The column part of a possibly qualified name: `t.a` is `a`. */
function columnOf(name) {
  return name.slice(name.lastIndexOf('.') + 1);
}

/** The name a member access or a property key spells out (`.name`, `['name']`, `{ 'name': 1 }`), or null. */
function propertyName(computed, key) {
  if (!computed && key.type === 'Identifier') return key.name;
  const text = stringValue(key);
  if (text !== null) return text;
  if (key.type === 'Literal' && typeof key.value === 'number') return String(key.value);
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow an UPDATE SET value that reads a column assigned earlier in the same statement (spec §6.2)' },
    schema: [],
    messages: {
      readsAssigned:
        'UPDATE SET reads {{column}}, assigned earlier in the same statement (MySQL evaluates left to right)',
    },
  },
  create(context) {
    const visitorKeys = context.sourceCode.visitorKeys;

    /** Calls `visit` for `node` and every node below it. */
    function walk(node, visit) {
      if (!node || typeof node.type !== 'string') return;
      visit(node);
      for (const key of visitorKeys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) for (const item of child) walk(item, visit);
        else walk(child, visit);
      }
    }

    /** `.set(...)` with a single argument: the object form of Kysely's UpdateQueryBuilder.set(). */
    function isSetCall(node) {
      if (node.type !== 'CallExpression' || node.arguments.length !== 1) return false;
      const callee = unwrap(node.callee);
      if (callee?.type !== 'MemberExpression') return false;
      if (node.arguments[0].type === 'SpreadElement') return false;
      return propertyName(callee.computed, callee.property) === 'set';
    }

    /** The expressions a function returns: its expression body, or its `return`s (not those of nested functions). */
    function returned(fn) {
      if (fn.body.type !== 'BlockStatement') return [fn.body];
      const found = [];
      const visit = (node) => {
        if (!node || typeof node.type !== 'string' || FUNCTIONS.has(node.type)) return;
        if (node.type === 'ReturnStatement') {
          if (node.argument) found.push(node.argument);
          return;
        }
        for (const key of visitorKeys[node.type] ?? []) {
          const child = node[key];
          if (Array.isArray(child)) child.forEach(visit);
          else visit(child);
        }
      };
      fn.body.body.forEach(visit);
      return found;
    }

    /** The objects a `.set()` call assigns with, and the expression-builder names its values may use. */
    function assignments(call) {
      const argument = unwrap(call.arguments[0]);
      if (argument.type === 'ObjectExpression') return { objects: [argument], builders: new Set(DEFAULT_BUILDERS) };
      if (argument.type !== 'ArrowFunctionExpression' && argument.type !== 'FunctionExpression') {
        return { objects: [], builders: new Set() };
      }
      const builders = new Set(DEFAULT_BUILDERS);
      const [parameter] = argument.params;
      if (parameter?.type === 'Identifier') builders.add(parameter.name);
      const objects = returned(argument)
        .map(unwrap)
        .filter((n) => n?.type === 'ObjectExpression');
      return { objects, builders };
    }

    /** The column a property assigns: `a`, `'a'`, `['a']`, `[`a`]`; null when its name is not known statically. */
    function assignedColumn(property) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.method) return null;
      const name = propertyName(property.computed, property.key);
      return name === null ? null : columnOf(name);
    }

    /** The columns a call reads by name, as [node, column] pairs, in the order they appear. */
    function columnReads(value, builders) {
      const reads = [];
      walk(value, (node) => {
        if (node.type !== 'CallExpression') return;
        const callee = unwrap(node.callee);
        const args = node.arguments;
        if (callee?.type === 'Identifier') {
          // eb('col', op, value)
          const column = builders.has(callee.name) && args[0] ? stringValue(args[0]) : null;
          if (column !== null) reads.push([node, columnOf(column)]);
          return;
        }
        if (callee?.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return;
        const method = propertyName(callee.computed, callee.property);
        const owner = callee.object.name;
        let column = null;
        if (method === 'ref' && (owner === 'sql' || builders.has(owner)) && args[0]) column = stringValue(args[0]);
        // sql.id('t', 'col') is "t"."col": the column is the last part.
        if (method === 'id' && owner === 'sql' && args.length > 0) column = stringValue(args[args.length - 1]);
        if (column !== null) reads.push([node, columnOf(column)]);
      });
      return reads;
    }

    /** The columns the `.set()` calls earlier in the same chain assign (Kysely merges them into one SET). */
    function earlierAssignments(call) {
      const assigned = new Set();
      // Walk down the chain: `db.updateTable('t').set(...).where(...).set(<call>)` is a call of a member of a call.
      let current = unwrap(unwrap(call.callee).object);
      while (current) {
        if (current.type === 'CallExpression') {
          if (isSetCall(current)) {
            for (const object of assignments(current).objects) {
              for (const property of object.properties) {
                const column = assignedColumn(property);
                if (column !== null) assigned.add(column);
              }
            }
          }
          const callee = unwrap(current.callee);
          current = callee?.type === 'MemberExpression' ? unwrap(callee.object) : null;
        } else if (current.type === 'MemberExpression') {
          current = unwrap(current.object);
        } else {
          current = null;
        }
      }
      return assigned;
    }

    return {
      CallExpression(node) {
        if (!isSetCall(node)) return;
        const { objects, builders } = assignments(node);
        if (objects.length === 0) return;
        const assigned = earlierAssignments(node);
        for (const object of objects) {
          const here = new Set(assigned);
          for (const property of object.properties) {
            if (property.type === 'Property') {
              for (const [read, column] of columnReads(property.value, builders)) {
                if (here.has(column)) context.report({ node: read, messageId: 'readsAssigned', data: { column } });
              }
            }
            // Assigned only after its own value was checked: a value may read its own column.
            const column = assignedColumn(property);
            if (column !== null) here.add(column);
          }
        }
      },
    };
  },
};

export default rule;
