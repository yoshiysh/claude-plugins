import { parse } from 'acorn';

function literal(node) {
  if (node.type === 'Literal' && !node.regex && !node.bigint) return node.value;
  if (node.type === 'ArrayExpression') return node.elements.map(literal);
  if (node.type === 'ObjectExpression') {
    const result = Object.create(null);
    for (const p of node.properties) {
      if (p.type !== 'Property' || p.computed || p.method || p.shorthand || p.kind !== 'init')
        throw new Error('meta must contain only literal values');
      const key = p.key.name ?? p.key.value;
      if (Object.hasOwn(result, key)) throw new Error('duplicate meta key');
      result[key] = literal(p.value);
    }
    return result;
  }
  throw new Error('meta must contain only literal values');
}

export function compileSource(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
  const first = ast.body[0];
  const declaration = first?.declaration;
  const binding = declaration?.declarations?.[0];
  if (first?.type !== 'ExportNamedDeclaration' || declaration?.kind !== 'const' ||
      declaration.declarations.length !== 1 || binding.id.name !== 'meta' || binding.init.type !== 'ObjectExpression')
    throw new Error('first statement must be export const meta = {...}');
  const meta = literal(binding.init);
  if (typeof meta.name !== 'string' || !meta.name || typeof meta.description !== 'string' || !meta.description)
    throw new Error('meta requires name and description');
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['ImportExpression', 'ImportDeclaration', 'ExportAllDeclaration', 'ExportDefaultDeclaration', 'ExportNamedDeclaration'].includes(node.type))
      throw new Error('module loading and additional exports are unsupported');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  ast.body.slice(1).forEach(visit);
  return { meta, body: source.slice(first.end) };
}
