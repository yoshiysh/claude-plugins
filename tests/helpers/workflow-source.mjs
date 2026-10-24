import { globSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
// acorn はリポジトリ直下ではなく runner の runtime にだけ install される。パッケージ名で、runtime の位置から解決する。
const { parse } = createRequire(join(repoRoot, 'plugins', 'workflow', 'skills', 'dynamic-workflow-runner', 'scripts', 'runtime', 'package.json'))('acorn')

// runner の source.mjs と同じ構文の条件で読む。
export function parseModule(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })
}

export function isMetaDeclaration(statement) {
  const declaration = statement?.declaration
  return statement?.type === 'ExportNamedDeclaration' && declaration?.kind === 'const'
    && declaration.declarations.length === 1 && declaration.declarations[0].id.name === 'meta'
}

function isPropertyName(node, parent) {
  if (!parent) return false
  if (parent.type === 'MemberExpression') return parent.property === node && !parent.computed
  if (parent.type === 'Property') return parent.key === node && !parent.computed && !parent.shorthand
  if (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') return parent.key === node && !parent.computed
  if (parent.type === 'MetaProperty') return true
  return ['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && parent.label === node
}

// native Workflow は export const meta を本体のスコープに置かないので、本体の識別子 meta は ReferenceError になる。
export function bodyMetaReferences(source) {
  const ast = parseModule(source)
  const offsets = new Set()
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'Identifier' && node.name === 'meta' && !isPropertyName(node, parent)) offsets.add(node.start)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => visit(child, node))
      else if (value && typeof value === 'object') visit(value, node)
    }
  }
  const [first, ...body] = ast.body
  if (!isMetaDeclaration(first)) visit(first, ast)
  body.forEach((statement) => visit(statement, ast))
  return [...offsets].sort((a, b) => a - b)
}

function literalValue(node) {
  if (node.type === 'Literal' && !node.regex) return node.value
  if (node.type === 'UnaryExpression' && node.operator === '-') return -literalValue(node.argument)
  if (node.type === 'ArrayExpression') return node.elements.map(literalValue)
  if (node.type === 'ObjectExpression') {
    return Object.fromEntries(node.properties.map((p) => {
      if (p.type !== 'Property' || p.computed || p.shorthand || p.kind !== 'init') throw new Error('body constant must be a literal')
      return [p.key.name ?? p.key.value, literalValue(p.value)]
    }))
  }
  throw new Error(`body constant must be a literal, got ${node.type}`)
}

// 本体の top-level の `const NAME = <literal>` の値。meta は本体を参照できないので、写しの一致はテストで照らす。
export function bodyLiteral(source, name) {
  for (const statement of parseModule(source).body.slice(1)) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue
    const declarator = statement.declarations.find((d) => d.id.type === 'Identifier' && d.id.name === name)
    if (declarator) return literalValue(declarator.init)
  }
  throw new Error(`body constant ${name} is missing`)
}

// 置き場は best-practices.md §13「script の置き場」の 2 段。scripts/ の .js は Workflow source でないものも混ざるので
// 先頭の文で選び、workflows/ の .js は全てを Workflow source として扱う（runner が全てを source として読むため）。
// globSync は symlink のディレクトリを辿らないので、.agents/skills/ 側から拾えるのは未公開の実体だけになる（公開済みは plugins/ 側で拾う）。
const SCRIPT_GLOBS = ['plugins/*/skills/*/scripts/*.js', '.agents/skills/*/scripts/*.js']
const WORKFLOW_GLOBS = ['plugins/*/workflows/*.js']

export function workflowSources(root) {
  const found = new Map()
  const add = (path) => {
    const real = realpathSync(join(root, path))
    if (!found.has(real)) found.set(real, relative(root, real))
  }
  for (const path of SCRIPT_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root }))) {
    let first
    try {
      first = parseModule(readFileSync(join(root, path), 'utf8')).body[0]
    } catch (error) {
      throw new Error(`${path}: cannot parse (${error.message})`)
    }
    if (isMetaDeclaration(first)) add(path)
  }
  for (const path of WORKFLOW_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root }))) add(path)
  return [...found.values()].sort()
}
