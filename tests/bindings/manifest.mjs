// The facade's manifest, and the check that both bindings cover it.
//
// The facade is declared once, in Rust (core/swift/src). This script reads those declarations (every exported
// function, every method of the three objects, every record and enum), writes them down in a neutral form
// (tests/bindings/manifest.json, in the repository), and compares with it:
//   - the Rust sources themselves: a call that changed without the manifest fails here, so a change is deliberate;
//   - the TypeScript declarations (core/wasm/js/trommi-core.d.ts): the same calls, argument names and types;
//   - the JavaScript layer (core/wasm/js/trommi-core.js) and the wasm-bindgen exports (core/wasm/src/lib.rs);
//   - the generated Swift (core/swift/TrommiCoreRust/Sources/TrommiCoreRust/TrommiCoreRust.swift), if it was built.
//
//   node tests/bindings/manifest.mjs            check
//   node tests/bindings/manifest.mjs --write    write manifest.json from the Rust sources, then check
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = file => fs.readFileSync(path.join(repo, file), 'utf8')
const camel = name => name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase())
const problems = []
const problem = text => problems.push(text)

// ---- the neutral form of a type -----------------------------------------------------------------------------------
// bytes, text, number, bool, void, list<T>, optional<T>, or the name of a record or enum.

/** Splits at the commas that are not inside <>, () or []. */
function split(text) {
  const parts = []
  let depth = 0, start = 0
  for (let at = 0; at < text.length; at++) {
    if ('<([{'.includes(text[at])) depth++
    if ('>)]}'.includes(text[at])) depth--
    if (text[at] === ',' && depth === 0) { parts.push(text.slice(start, at)); start = at + 1 }
  }
  parts.push(text.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

function fromRust(type) {
  type = type.trim()
  let inner
  if ((inner = /^Result<(.*), CoreError>$/s.exec(type))) return fromRust(inner[1])
  if (type === 'std::sync::Arc<dyn crate::store::CoreStore>') return 'CoreStore'
  if (type === 'Vec<u8>') return 'bytes'
  if ((inner = /^Vec<(.*)>$/s.exec(type))) return `list<${fromRust(inner[1])}>`
  if ((inner = /^Option<(.*)>$/s.exec(type))) return `optional<${fromRust(inner[1])}>`
  return { String: 'text', u64: 'number', u32: 'number', u8: 'number', bool: 'bool', '()': 'void', Self: 'self' }[type] ?? type
}

function fromTs(type) {
  type = type.trim()
  let inner
  if ((inner = /^Promise<(.*)>$/s.exec(type))) return fromTs(inner[1])
  const alternatives = type.split('|').map(part => part.trim())
  if (alternatives.length > 1) {
    const rest = alternatives.filter(part => part !== 'null' && part !== 'undefined')
    if (rest.length === 1 && alternatives.includes('null')) return `optional<${fromTs(rest[0])}>`
    return type
  }
  if ((inner = /^(.*)\[\]$/s.exec(type))) return `list<${fromTs(inner[1])}>`
  return { Uint8Array: 'bytes', string: 'text', number: 'number', boolean: 'bool', void: 'void' }[type] ?? type
}

function fromSwift(type) {
  type = type.trim()
  let inner
  if ((inner = /^(.*)\?$/s.exec(type))) return `optional<${fromSwift(inner[1])}>`
  if ((inner = /^\[(.*)\]$/s.exec(type))) return `list<${fromSwift(inner[1])}>`
  return { Data: 'bytes', String: 'text', UInt64: 'number', UInt32: 'number', UInt8: 'number', Bool: 'bool', '': 'void' }[type] ?? type
}

// ---- the Rust declarations ----------------------------------------------------------------------------------------

const EXPORT = /#\[cfg_attr\(feature = "uniffi", uniffi::export\)\]/
const signature = /pub fn (\w+)\(([^)]*)\)(?:\s*->\s*([^{]+?))?\s*\{/gs

function argumentsOf(text, type) {
  return split(text).filter(argument => argument !== '&self').map(argument => {
    const at = argument.indexOf(':')
    return { name: camel(argument.slice(0, at).trim()), type: type(argument.slice(at + 1)) }
  })
}

function fromSources() {
  const manifest = { functions: {}, objects: {}, records: {}, enums: {} }
  const folder = path.join(repo, 'core/swift/src')
  for (const file of fs.readdirSync(folder).sort()) {
    const source = fs.readFileSync(path.join(folder, file), 'utf8')
    // Records and enums, as the macros of macros.rs take them.
    for (const [, body] of source.matchAll(/^record! \{\n(.*?)\n\}\n/gms)) {
      const [, name, fields] = /pub struct (\w+) \{(.*)\}/s.exec(body)
      manifest.records[name] = Object.fromEntries([...fields.matchAll(/^\s*pub (\w+): (.*),$/gm)].map(([, field, type]) => [camel(field), fromRust(type)]))
    }
    for (const [, body] of source.matchAll(/^choice! \{\n(.*?)\n\}\n/gms)) {
      const [, name, cases] = /pub enum (\w+) \{(.*)\}/s.exec(body)
      manifest.enums[name] = Object.fromEntries([...cases.matchAll(/^\s*(\w+) = "([^"]*)",$/gm)].map(([, variant, text]) => [variant[0].toLowerCase() + variant.slice(1), text]))
    }
    // Exported items: a function, or an impl block whose methods all are.
    const pieces = source.split(/^(?=#\[cfg_attr\(feature = "uniffi", uniffi::export\)\]\n|#\[uniffi::export\]\n)/m).slice(1)
    for (const piece of pieces) {
      const head = piece.split('\n')[1]
      const object = /^impl (\w+) \{/.exec(head)
      if (!object) {
        const [[, name, args, returns]] = piece.matchAll(signature)
        manifest.functions[camel(name)] = { arguments: argumentsOf(args, fromRust), returns: fromRust(returns ?? '()') }
        continue
      }
      const block = piece.slice(0, piece.indexOf('\n}\n'))
      const methods = manifest.objects[object[1]] ??= {}
      for (const [, name, args, returns] of block.matchAll(signature)) {
        methods[camel(name)] = { arguments: argumentsOf(args, fromRust), returns: fromRust(returns ?? '()') }
      }
    }
  }
  return manifest
}

// ---- the TypeScript declarations ----------------------------------------------------------------------------------

function fromTypings() {
  const source = read('core/wasm/js/trommi-core.d.ts').replace(/\/\*\*.*?\*\//gs, '').replace(/^\s*\/\/.*$/gm, '')
  const found = { functions: {}, objects: {}, records: {}, enums: {} }
  const args = text => split(text).map(argument => {
    const [, name, optional, type] = /^(\w+)(\??): (.*)$/s.exec(argument)
    let neutral = fromTs(type.replace(/\| undefined/, '').trim())
    if (optional && !neutral.startsWith('optional<')) neutral = `optional<${neutral}>`
    return { name, type: neutral }
  })
  for (const [, name, parameters, returns] of source.matchAll(/^export function (\w+)\(([^)]*)\): (.*)$/gm)) {
    found.functions[name] = { arguments: args(parameters), returns: fromTs(returns) }
  }
  for (const [, name, body] of source.matchAll(/^export class (\w+)(?: extends \w+)? \{\n(.*?)^\}/gms)) {
    const methods = found.objects[name] = {}
    for (const [, modifier, method, parameters, returns] of body.matchAll(/^  (static |private )?(\w+)\(([^)]*)\)(?:: (.*))?$/gm)) {
      if (modifier === 'private ') continue
      methods[method] = { arguments: args(parameters), returns: fromTs(returns ?? 'self'), static: modifier === 'static ' }
    }
  }
  for (const [, name, body] of source.matchAll(/^export interface (\w+) \{\n(.*?)^\}/gms)) {
    found.records[name] = Object.fromEntries([...body.matchAll(/^  (\w+)(\??): (.*)$/gm)].map(([, field, optional, type]) => {
      const neutral = fromTs(type)
      return [field, optional && !neutral.startsWith('optional<') ? `optional<${neutral}>` : neutral]
    }))
  }
  for (const [, name, body] of source.matchAll(/^export type (\w+) =((?:\s*\|? ?'[^']*')+)/gm)) {
    found.enums[name] = [...body.matchAll(/'([^']*)'/g)].map(([, text]) => text)
  }
  return found
}

// ---- the comparisons ----------------------------------------------------------------------------------------------

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sources = fromSources()
const manifestFile = path.join(repo, 'tests/bindings/manifest.json')
if (process.argv.includes('--write')) fs.writeFileSync(manifestFile, JSON.stringify(sources, null, 2) + '\n')
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
if (!same(manifest, sources)) problem('the Rust facade is not what manifest.json says: review the change, then run this with --write')

// What a binding names an object and its constructors.
const TS_OBJECT = { CoreDevice: 'Device', FileEncryptor: 'FileEncryptor', FileDecryptor: 'FileDecryptor' }
// The store's own types are the host's to implement: in TypeScript they are the interface Store.
const call = ({ arguments: args, returns }) => `(${args.map(argument => `${argument.name}: ${argument.type}`).join(', ')}) -> ${returns}`

// TypeScript.
const typings = fromTypings()
for (const [name, declared] of Object.entries(manifest.functions)) {
  const found = typings.functions[name]
  if (!found) problem(`trommi-core.d.ts lacks the function ${name}`)
  else if (call(found) !== call(declared)) problem(`trommi-core.d.ts: ${name}${call(found)}, the facade has ${name}${call(declared)}`)
}
for (const name of Object.keys(typings.functions)) if (!manifest.functions[name] && name !== 'init') problem(`trommi-core.d.ts has a function the facade lacks: ${name}`)
for (const [object, methods] of Object.entries(manifest.objects)) {
  const found = typings.objects[TS_OBJECT[object]] ?? {}
  for (const [name, declared] of Object.entries(methods)) {
    if (name === 'new') { if (!found.constructor || !same(found.constructor.arguments, declared.arguments)) problem(`trommi-core.d.ts: the constructor of ${object} differs`); continue }
    if (name === 'create' || name === 'open') { if (!found[name]?.static) problem(`trommi-core.d.ts lacks ${object}.${name}`); continue }
    if (!found[name]) problem(`trommi-core.d.ts lacks ${object}.${name}`)
    else if (call(found[name]) !== call(declared)) problem(`trommi-core.d.ts: ${object}.${name}${call(found[name])}, the facade has ${call(declared)}`)
  }
  for (const name of Object.keys(found)) if (!methods[name] && name !== 'constructor') problem(`trommi-core.d.ts has ${object}.${name}, the facade does not`)
}
for (const [name, fields] of Object.entries(manifest.records)) {
  if (!typings.records[name]) problem(`trommi-core.d.ts lacks the record ${name}`)
  else if (!same(typings.records[name], fields)) problem(`trommi-core.d.ts: the record ${name} is ${JSON.stringify(typings.records[name])}, the facade has ${JSON.stringify(fields)}`)
}
for (const [name, cases] of Object.entries(manifest.enums)) {
  if (!same(typings.enums[name], Object.values(cases))) problem(`trommi-core.d.ts: the enum ${name} differs from the facade's`)
}

// The JavaScript layer and the wasm-bindgen exports: the same names (their arguments pass through unchanged).
const layer = read('core/wasm/js/trommi-core.js')
const exported = [...layer.matchAll(/^export const (\w+) = plain\('(\w+)'\)$/gm)]
for (const [, name, raw] of exported) if (camel(raw) !== name) problem(`trommi-core.js exports ${name} for ${raw}`)
const layerFunctions = exported.map(([, name]) => name).sort()
if (!same(layerFunctions, Object.keys(manifest.functions).sort())) problem('trommi-core.js does not export exactly the facade\'s functions')
const deviceCalls = [.../const DEVICE_CALLS = \[(.*?)\]/s.exec(layer)[1].matchAll(/'(\w+)'/g)].map(([, name]) => camel(name)).sort()
const deviceMethods = Object.keys(manifest.objects.CoreDevice).filter(name => !['create', 'open', 'close'].includes(name)).sort()
if (!same(deviceCalls, deviceMethods)) problem('trommi-core.js does not list exactly the device\'s calls')
const wasm = read('core/wasm/src/lib.rs')
const wasmFunctions = [.../functions! \{(.*?)\n\}/s.exec(wasm)[1].matchAll(/(?:plain|fallible) (\w+)\(/g)].map(([, name]) => camel(name)).sort()
if (!same(wasmFunctions, Object.keys(manifest.functions).sort())) problem('core/wasm/src/lib.rs does not export exactly the facade\'s functions')
const wasmDevice = [.../methods!\(RawDevice \{(.*?)\}\);/s.exec(wasm)[1].matchAll(/(\w+)\(/g)].map(([, name]) => camel(name)).sort()
if (!same(wasmDevice, deviceMethods)) problem('core/wasm/src/lib.rs does not export exactly the device\'s calls')

// Swift, as UniFFI generated it.
const swiftFile = 'core/swift/TrommiCoreRust/Sources/TrommiCoreRust/TrommiCoreRust.swift'
let swiftChecked = false
if (fs.existsSync(path.join(repo, swiftFile))) {
  swiftChecked = true
  const swift = read(swiftFile).replace(/\/\*\*.*?\*\//gs, '')
  const swiftArgs = text => split(text).map(argument => {
    // UniFFI's own helpers take unnamed arguments (`_ value: T`): they are no call of the facade.
    const [, name, type] = /^`?(\w+)`?: (.*)$/s.exec(argument) ?? [null, '_', '']
    return { name, type: fromSwift(type) }
  })
  const functions = {}
  for (const [, name, parameters, returns] of swift.matchAll(/^public func `?(\w+)`?\(([^)]*)\)\s*(?:throws)?\s*(?:-> ([^{]+?))?\s*\{/gm)) {
    functions[name] = { arguments: swiftArgs(parameters), returns: fromSwift(returns ?? '') }
  }
  for (const [name, declared] of Object.entries(manifest.functions)) {
    if (!functions[name]) problem(`the Swift API lacks the function ${name}`)
    else if (call(functions[name]) !== call(declared)) problem(`Swift: ${name}${call(functions[name])}, the facade has ${call(declared)}`)
  }
  for (const [object, methods] of Object.entries(manifest.objects)) {
    // The class runs up to its converter: the generated file is not indented in a way that tells where it ends.
    const body = new RegExp(`^open class ${object}: .*?\\n(.*?)^public struct FfiConverterType${object}`, 'ms').exec(swift)?.[1] ?? ''
    const found = {}
    for (const [, name, parameters, returns] of body.matchAll(/^\s*(?:open|public static) func `?(\w+)`?\(([^)]*)\)\s*(?:throws)?\s*(?:-> ([^{]+?))?\s*\{/gm)) {
      found[name] = { arguments: swiftArgs(parameters), returns: fromSwift(returns ?? '') }
    }
    const initialiser = /public convenience init\(([^)]*)\)/.exec(body)
    for (const [name, declared] of Object.entries(methods)) {
      if (name === 'new') { if (!initialiser || !same(swiftArgs(initialiser[1]), declared.arguments)) problem(`Swift: the initialiser of ${object} differs`); continue }
      const returns = declared.returns === 'self' ? object : declared.returns
      const wanted = { arguments: declared.arguments, returns }
      if (!found[name]) problem(`the Swift API lacks ${object}.${name}`)
      else if (call(found[name]) !== call(wanted)) problem(`Swift: ${object}.${name}${call(found[name])}, the facade has ${call(wanted)}`)
    }
  }
  for (const [name, fields] of Object.entries(manifest.records)) {
    const body = new RegExp(`^public struct ${name}: .*?\\n(.*?)^    public init`, 'ms').exec(swift)?.[1]
    const found = body && Object.fromEntries([...body.matchAll(/^    public var `?(\w+)`?: (.*)$/gm)].map(([, field, type]) => [field, fromSwift(type)]))
    if (!same(found, fields)) problem(`Swift: the record ${name} is ${JSON.stringify(found)}, the facade has ${JSON.stringify(fields)}`)
  }
  for (const [name, cases] of Object.entries(manifest.enums)) {
    const body = new RegExp(`^public enum ${name}: .*?\\n(.*?)^}`, 'ms').exec(swift)?.[1] ?? ''
    const found = [...body.matchAll(/^\s*case `?(\w+)`?$/gm)].map(([, variant]) => variant)
    if (!same(found, Object.keys(cases))) problem(`Swift: the enum ${name} has ${found}, the facade has ${Object.keys(cases)}`)
  }
} else if (process.argv.includes('--swift')) {
  problem(`${swiftFile} is not there: run core/swift/build.sh host`)
}

for (const text of problems) console.error(`FAILED: ${text}`)
const count = Object.keys(manifest.functions).length + Object.values(manifest.objects).reduce((sum, methods) => sum + Object.keys(methods).length, 0)
console.log(`${count} calls, ${Object.keys(manifest.records).length} records, ${Object.keys(manifest.enums).length} enums: TypeScript, the JavaScript layer and the wasm exports ${swiftChecked ? 'and the generated Swift ' : ''}compared${swiftChecked ? '' : ' (the Swift file is not built: not compared)'}`)
process.exit(problems.length ? 1 : 0)
