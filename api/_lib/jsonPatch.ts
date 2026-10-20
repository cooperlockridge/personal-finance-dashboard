/* RFC 6902 JSON Patch over plain JSON values, for the catch-all budget tool
   (2026-10-19). Never mutates its input: every operation works on a deep
   copy, so a patch that fails halfway leaves nothing behind. Errors are
   PatchError with a message the model can read and correct from. */

export type PatchOp =
  | { op: 'add' | 'replace' | 'test', path: string, value: unknown }
  | { op: 'remove', path: string }
  | { op: 'move' | 'copy', from: string, path: string }

export class PatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchError'
  }
}

type Container = Record<string, unknown> | unknown[]

function parsePointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new PatchError(`Path "${pointer}" must start with "/".`)
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null
}

/* The parent of the last segment, and that segment. */
function locate(doc: unknown, pointer: string): { parent: Container, key: string } {
  const parts = parsePointer(pointer)
  if (parts.length === 0) throw new PatchError('Replacing the whole document is not allowed; patch its fields.')
  let node: unknown = doc
  for (const [i, part] of parts.slice(0, -1).entries()) {
    node = child(node, part, parts.slice(0, i + 1))
  }
  if (!isContainer(node)) throw new PatchError(`"${pointer}" does not point inside an object or array.`)
  return { parent: node, key: parts[parts.length - 1] }
}

function child(node: unknown, part: string, trail: string[]): unknown {
  const where = `/${trail.join('/')}`
  if (Array.isArray(node)) {
    const index = arrayIndex(node, part, false, where)
    return node[index]
  }
  if (isContainer(node) && Object.prototype.hasOwnProperty.call(node, part)) return (node as Record<string, unknown>)[part]
  throw new PatchError(`Nothing at "${where}".`)
}

function arrayIndex(array: unknown[], part: string, forInsert: boolean, where: string): number {
  if (forInsert && part === '-') return array.length
  if (!/^(0|[1-9]\d*)$/.test(part)) throw new PatchError(`"${part}" in "${where}" is not an array index.`)
  const index = Number(part)
  if (index > array.length || (!forInsert && index === array.length)) {
    throw new PatchError(`Index ${index} in "${where}" is out of range (length ${array.length}).`)
  }
  return index
}

function get(doc: unknown, pointer: string): unknown {
  const parts = parsePointer(pointer)
  let node = doc
  for (const [i, part] of parts.entries()) node = child(node, part, parts.slice(0, i + 1))
  return node
}

function add(doc: unknown, pointer: string, value: unknown) {
  const { parent, key } = locate(doc, pointer)
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, true, pointer), 0, value)
  else parent[key] = value
}

function remove(doc: unknown, pointer: string): unknown {
  const { parent, key } = locate(doc, pointer)
  if (Array.isArray(parent)) return parent.splice(arrayIndex(parent, key, false, pointer), 1)[0]
  if (!Object.prototype.hasOwnProperty.call(parent, key)) throw new PatchError(`Nothing at "${pointer}" to remove.`)
  const old = parent[key]
  delete parent[key]
  return old
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function applyPatch<T>(document: T, ops: unknown): T {
  if (!Array.isArray(ops) || ops.length === 0) throw new PatchError('operations must be a non-empty array.')
  if (ops.length > 100) throw new PatchError('At most 100 operations per patch.')
  const doc = clone(document)
  for (const [i, raw] of ops.entries()) {
    const label = `Operation ${i + 1}`
    if (!isContainer(raw) || Array.isArray(raw)) throw new PatchError(`${label} must be an object.`)
    const op = raw as Record<string, unknown>
    if (typeof op.path !== 'string') throw new PatchError(`${label} needs a string "path".`)
    try {
      switch (op.op) {
        case 'add':
          if (!('value' in op)) throw new PatchError('needs a "value".')
          add(doc, op.path, clone(op.value))
          break
        case 'remove':
          remove(doc, op.path)
          break
        case 'replace':
          if (!('value' in op)) throw new PatchError('needs a "value".')
          get(doc, op.path)
          remove(doc, op.path)
          add(doc, op.path, clone(op.value))
          break
        case 'move': {
          if (typeof op.from !== 'string') throw new PatchError('needs a string "from".')
          if (op.path.startsWith(`${op.from}/`)) throw new PatchError('cannot move a value into itself.')
          add(doc, op.path, remove(doc, op.from))
          break
        }
        case 'copy':
          if (typeof op.from !== 'string') throw new PatchError('needs a string "from".')
          add(doc, op.path, clone(get(doc, op.from)))
          break
        case 'test':
          if (!same(get(doc, op.path), op.value)) {
            throw new PatchError(`test failed: the value at "${op.path}" is ${JSON.stringify(get(doc, op.path))?.slice(0, 200)}.`)
          }
          break
        default:
          throw new PatchError('"op" must be add, remove, replace, move, copy or test.')
      }
    } catch (error) {
      if (error instanceof PatchError && !error.message.startsWith('Operation ')) {
        throw new PatchError(`${label} (${String(op.op)} ${op.path}): ${error.message}`)
      }
      throw error
    }
  }
  return doc
}
