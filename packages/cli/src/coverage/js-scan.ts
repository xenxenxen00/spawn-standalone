// One JS module of a Spawn game: its ctx chains, emit topics, builtin imports, exports and object-spec keys.
//
// ctx chains are the outermost member chains rooted in `ctx`. The root is the identifier `ctx`, `<x>.ctx` (a kit's ctx),
// or a local bound to a chain, resolved per lexical scope:
//   const me = ctx.self;  const { self } = ctx;  const { state } = ctx.self;  me = ctx.self;  const m = a || ctx.self
// `ctx.getObject(id)` results are followed through locals the same way and reported as handle chains.
// A chain is counted once per outermost expression: `ctx.self.state.hp` is one use of [self, state, hp]. A declaration that
// binds an alias counts as a read of the chain it names; a bare alias passed on as a value counts for nothing.
// Limits: a ctx passed to a helper under another parameter name is not followed; `for (const x of ...)` declarations leak
// into the enclosing block; a computed key is `[*]`.
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

// acorn's node types are a closed union; the walker reads many shapes, so nodes are handled structurally here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = { type: string; start: number; end: number; loc: { start: { line: number } }; [k: string]: any };

export const ANY = '[*]';

export interface ChainUse {
  /** segments after `ctx` */
  path: string[];
  line: number;
  /** true when the chain starts at the result of `ctx.getObject(...)` (the path is then the handle's) */
  viaResult: boolean;
}

export interface EmitUse {
  /** the literal topic, or null when it is computed */
  topic: string | null;
  line: number;
}

export interface BuiltinImport {
  /** `builtin/physics` */
  module: string;
  /** the imported name; null for a default, namespace or side-effect import */
  name: string | null;
  line: number;
}

export interface ExportFact {
  name: string;
  line: number;
  /** the literal of `export const x = "…"` */
  value?: string;
}

export interface SpecKey {
  /** `physics.collisionGroups`, `projection` */
  path: string;
  value?: string;
  line: number;
}

export interface JsFacts {
  chains: ChainUse[];
  emits: EmitUse[];
  imports: BuiltinImport[];
  exports: ExportFact[];
  specs: SpecKey[];
}

export interface JsScanOptions {
  /** the file is a template module: its exported object literals are object specs */
  isTemplate?: boolean;
}

/** object-spec fields whose own keys are engine surface */
const SPEC_DESCEND: ReadonlySet<string> = new Set([
  'physics', 'layout', 'material', 'primitive', 'light', 'audio', 'fx', 'spline', 'scatter', 'attachment', 'orientation', 'clip', 'render', 'interpolation',
]);

type Binding = { t: 'ctx'; path: string[] } | { t: 'result'; path: string[] } | { t: 'opaque' };

interface Chain {
  root: 'ctx' | 'result';
  path: string[];
  /** computed keys and call nodes met on the way; they are visited separately */
  inner: N[];
}

class Scope {
  readonly vars = new Map<string, Binding>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null) {
    this.parent = parent;
  }
  lookup(name: string): Binding | undefined {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      const b = s.vars.get(name);
      if (b !== undefined) return b;
    }
    return undefined;
  }
  assign(name: string, b: Binding): void {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      if (s.vars.has(name)) {
        s.vars.set(name, b);
        return;
      }
    }
    this.vars.set(name, b);
  }
}

const unwrap = (n: N): N => (n.type === 'ChainExpression' || n.type === 'ParenthesizedExpression' ? unwrap(n['expression'] as N) : n);

function literalText(n: N | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'Literal' && (typeof n['value'] === 'string' || typeof n['value'] === 'boolean' || typeof n['value'] === 'number')) return String(n['value']);
  if (n.type === 'TemplateLiteral' && (n['expressions'] as N[]).length === 0) return String((n['quasis'] as N[])[0]?.['value']?.cooked ?? '');
  return undefined;
}

function propName(p: N): string | null {
  const key = p['key'] as N;
  if (p['computed'] === true) return literalText(key) ?? null;
  return key.type === 'Identifier' ? String(key['name']) : (literalText(key) ?? null);
}

export function scanJs(source: string, options: JsScanOptions = {}): JsFacts {
  const parseOpts = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true } as const;
  let ast: N;
  try {
    ast = acorn.parse(source, { ...parseOpts, sourceType: 'module' }) as unknown as N;
  } catch (moduleError) {
    // a few older files are scripts; when neither parse works, the module error is the one worth reporting
    try {
      ast = acorn.parse(source, { ...parseOpts, sourceType: 'script' }) as unknown as N;
    } catch {
      throw moduleError;
    }
  }
  const out: JsFacts = { chains: [], emits: [], imports: [], exports: [], specs: [] };
  const lineOf = (n: N): number => n.loc.start.line;

  /** the ctx chain an expression is, or null */
  const chainOf = (raw: N, scope: Scope): Chain | null => {
    const n = unwrap(raw);
    if (n.type === 'Identifier') {
      const name = String(n['name']);
      const b = scope.lookup(name);
      if (b !== undefined) return b.t === 'opaque' ? null : { root: b.t, path: [...b.path], inner: [] };
      return name === 'ctx' ? { root: 'ctx', path: [], inner: [] } : null;
    }
    if (n.type === 'MemberExpression') {
      const obj = n['object'] as N;
      const prop = n['property'] as N;
      const computed = n['computed'] === true;
      const base = chainOf(obj, scope);
      if (base === null) {
        // `<x>.ctx`: a kit's ctx
        if (!computed && prop.type === 'Identifier' && prop['name'] === 'ctx') return { root: 'ctx', path: [], inner: [obj] };
        return null;
      }
      if (!computed) base.path.push(prop.type === 'Identifier' || prop.type === 'PrivateIdentifier' ? String(prop['name']) : ANY);
      else if (prop.type === 'Literal' && typeof prop['value'] === 'string') base.path.push(String(prop['value']));
      else {
        base.path.push(ANY);
        base.inner.push(prop);
      }
      return base;
    }
    if (n.type === 'CallExpression') {
      const callee = chainOf(n['callee'] as N, scope);
      if (callee !== null && callee.root === 'ctx' && callee.path.length === 1 && callee.path[0] === 'getObject') return { root: 'result', path: [], inner: [n] };
    }
    return null;
  };

  /** the chain an alias initialiser names: `a`, `a || {}`, `a ?? b` */
  const aliasChain = (raw: N, scope: Scope): Chain | null => {
    const n = unwrap(raw);
    if (n.type === 'LogicalExpression' && (n['operator'] === '||' || n['operator'] === '??')) return aliasChain(n['left'] as N, scope);
    return chainOf(n, scope);
  };

  const binding = (c: Chain): Binding => ({ t: c.root, path: c.path });
  const record = (c: Chain | { root: 'ctx' | 'result'; path: string[] }, line: number): void => {
    if (c.path.length > 0) out.chains.push({ path: c.path, line, viaResult: c.root === 'result' });
  };

  type Visit = (n: N, s: Scope) => void;

  /** declare the names of a pattern; with a ctx binding, each destructured leaf is a read of its chain */
  const bindPattern = (pattern: N, scope: Scope, b: Binding | null, c: Visit, leaves: boolean): void => {
    switch (pattern.type) {
      case 'Identifier': {
        const name = String(pattern['name']);
        // a parameter or local named `ctx` stays the root
        if (name === 'ctx' && b === null) scope.vars.delete(name);
        else scope.vars.set(name, b ?? { t: 'opaque' });
        return;
      }
      case 'ObjectPattern':
        for (const p of pattern['properties'] as N[]) {
          if (p.type === 'RestElement') {
            bindPattern(p['argument'] as N, scope, null, c, false);
            continue;
          }
          const name = propName(p);
          let target = p['value'] as N;
          if (target.type === 'AssignmentPattern') {
            c(target['right'] as N, scope);
            target = target['left'] as N;
          }
          let child: Binding | null = null;
          if (b !== null && b.t !== 'opaque' && name !== null) child = { t: b.t, path: [...b.path, name] };
          if (child !== null && child.t !== 'opaque' && target.type === 'Identifier' && leaves) record({ root: child.t, path: child.path }, lineOf(p));
          bindPattern(target, scope, child, c, leaves);
        }
        return;
      case 'ArrayPattern':
        for (const e of pattern['elements'] as Array<N | null>) if (e) bindPattern(e.type === 'AssignmentPattern' ? (e['left'] as N) : e, scope, null, c, false);
        return;
      case 'AssignmentPattern':
        c(pattern['right'] as N, scope);
        bindPattern(pattern['left'] as N, scope, b, c, leaves);
        return;
      case 'RestElement':
        bindPattern(pattern['argument'] as N, scope, null, c, false);
        return;
      default:
        return;
    }
  };

  /** the keys of an object-spec literal: top-level keys, plus the members of the structured fields */
  const specKeys = (obj: N): void => {
    for (const p of obj['properties'] as N[]) {
      if (p.type !== 'Property') continue;
      const key = propName(p);
      if (key === null) continue;
      const value = p['value'] as N;
      const entry: SpecKey = { path: key, line: lineOf(p) };
      const text = literalText(value);
      if (text !== undefined) entry.value = text;
      out.specs.push(entry);
      if (SPEC_DESCEND.has(key) && value.type === 'ObjectExpression') {
        for (const q of value['properties'] as N[]) {
          if (q.type !== 'Property') continue;
          const sub = propName(q);
          if (sub === null) continue;
          const subEntry: SpecKey = { path: `${key}.${sub}`, line: lineOf(q) };
          const subText = literalText(q['value'] as N);
          if (subText !== undefined) subEntry.value = subText;
          out.specs.push(subEntry);
        }
      }
    }
  };

  const visitors = {
    Function(node: N, scope: Scope, c: Visit) {
      const inner = new Scope(scope);
      const id = node['id'] as N | null;
      if (id && node.type === 'FunctionExpression') bindPattern(id, inner, null, c, false);
      for (const p of node['params'] as N[]) bindPattern(p, inner, null, c, false);
      const body = node['body'] as N;
      if (body.type === 'BlockStatement') for (const s of body['body'] as N[]) c(s, inner);
      else c(body, inner);
    },
    FunctionDeclaration(node: N, scope: Scope, c: (n: N, s: Scope, type?: string) => void) {
      const id = node['id'] as N | null;
      if (id) bindPattern(id, scope, null, c, false);
      c(node, scope, 'Function');
    },
    BlockStatement(node: N, scope: Scope, c: Visit) {
      const inner = new Scope(scope);
      for (const s of node['body'] as N[]) c(s, inner);
    },
    VariableDeclarator(node: N, scope: Scope, c: Visit) {
      const id = node['id'] as N;
      const init = node['init'] as N | null;
      const chain = init ? aliasChain(init, scope) : null;
      if (init) {
        if (chain !== null && id.type === 'ObjectPattern') {
          // a destructuring reads its keys, not the chain it destructures
          for (const x of chain.inner) c(x, scope);
        } else c(init, scope);
      }
      bindPattern(id, scope, chain !== null ? binding(chain) : null, c, true);
    },
    AssignmentExpression(node: N, scope: Scope, c: Visit) {
      const left = node['left'] as N;
      const right = node['right'] as N;
      c(right, scope);
      if (left.type === 'Identifier') {
        const name = String(left['name']);
        if (node['operator'] === '=') {
          const chain = aliasChain(right, scope);
          if (chain !== null && name !== 'ctx') scope.assign(name, binding(chain));
          else if (scope.lookup(name) !== undefined) scope.assign(name, { t: 'opaque' });
        }
        return;
      }
      if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') return;
      c(left, scope);
    },
    CallExpression(node: N, scope: Scope, c: Visit) {
      const callee = node['callee'] as N;
      const args = node['arguments'] as N[];
      const chain = chainOf(callee, scope);
      if (chain !== null && chain.root === 'ctx' && chain.path.length === 1) {
        const verb = chain.path[0];
        if (verb === 'emit') out.emits.push({ topic: literalText(args[0]) ?? null, line: lineOf(node) });
        if (verb === 'spawn') {
          const spec = args.find((a) => a.type === 'ObjectExpression');
          if (spec) specKeys(spec);
        }
      }
      c(callee, scope);
      for (const a of args) c(a, scope);
    },
    MemberExpression(node: N, scope: Scope, c: Visit) {
      const chain = chainOf(node, scope);
      if (chain !== null) {
        record(chain, lineOf(node));
        for (const x of chain.inner) c(x, scope);
        return;
      }
      c(node['object'] as N, scope);
      if (node['computed'] === true) c(node['property'] as N, scope);
    },
  };

  // module-level facts: imports and exports
  for (const stmt of ast['body'] as N[]) {
    if (stmt.type === 'ImportDeclaration') {
      const from = String((stmt['source'] as N)['value']);
      if (!from.startsWith('builtin/')) continue;
      const specs = stmt['specifiers'] as N[];
      if (specs.length === 0) out.imports.push({ module: from, name: null, line: lineOf(stmt) });
      for (const s of specs) {
        const name = s.type === 'ImportSpecifier' ? (literalText(s['imported'] as N) ?? String((s['imported'] as N)['name'])) : null;
        out.imports.push({ module: from, name, line: lineOf(s) });
      }
    } else if (stmt.type === 'ExportNamedDeclaration') {
      const decl = stmt['declaration'] as N | null;
      if (decl) {
        if (decl.type === 'VariableDeclaration') {
          for (const d of decl['declarations'] as N[]) {
            const id = d['id'] as N;
            if (id.type !== 'Identifier') continue;
            const fact: ExportFact = { name: String(id['name']), line: lineOf(d) };
            const text = literalText(d['init'] as N | null);
            if (text !== undefined) fact.value = text;
            out.exports.push(fact);
            const init = d['init'] as N | null;
            if (options.isTemplate && init && unwrap(init).type === 'ObjectExpression') specKeys(unwrap(init));
          }
        } else if (decl['id']) out.exports.push({ name: String((decl['id'] as N)['name']), line: lineOf(decl) });
      }
      for (const s of stmt['specifiers'] as N[]) {
        const e = s['exported'] as N;
        out.exports.push({ name: e.type === 'Identifier' ? String(e['name']) : String(e['value']), line: lineOf(s) });
      }
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      out.exports.push({ name: 'default', line: lineOf(stmt) });
      const d = stmt['declaration'] as N;
      if (options.isTemplate && d.type === 'ObjectExpression') specKeys(d);
    }
  }

  walk.recursive(ast as unknown as acorn.Node, new Scope(null), visitors as unknown as walk.RecursiveVisitors<Scope>);
  return out;
}
