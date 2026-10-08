import { execSync } from 'node:child_process'
const files = execSync('git ls-files', { encoding: 'utf8' }).trim().split('\n')
const top = ['app/web', 'connector', 'connector-rs', 'hub', 'hub-rs', 'shared', 'dev']
const tree = list => {
  const root = {}
  for (const f of list) { let n = root; for (const p of f.split('/')) n = n[p] ??= {} }
  const out = []
  const walk = (n, pre) => {
    const ks = Object.keys(n).sort((a, b) => (Object.keys(n[b]).length > 0) - (Object.keys(n[a]).length > 0) || a.localeCompare(b))
    ks.forEach((k, i) => {
      const last = i === ks.length - 1, dir = Object.keys(n[k]).length > 0
      out.push(pre + (last ? '└── ' : '├── ') + k + (dir ? '/' : ''))
      if (dir) walk(n[k], pre + (last ? '    ' : '│   '))
    })
  }
  walk(root, ''); return out.join('\n')
}
let md = "<!-- trees:start -->\n### File trees\n\nEvery tracked file per main folder (`git ls-files`; generated files are not in git). Regenerate with `node dev/readme-trees.mjs`.\n"
for (const t of top) {
  const list = files.filter(f => f.startsWith(t + '/')).map(f => f.slice(t.length + 1))
  md += `\n<details><summary><code>${t}/</code> · ${list.length} files</summary>\n\n\`\`\`\n${tree(list)}\n\`\`\`\n\n</details>\n`
}
md += '<!-- trees:end -->'
import { readFileSync, writeFileSync } from 'node:fs'
const readme = readFileSync('README.md', 'utf8')
const next = /<!-- trees:start -->[\s\S]*<!-- trees:end -->/.test(readme)
  ? readme.replace(/<!-- trees:start -->[\s\S]*<!-- trees:end -->/, md)
  : readme.replace('\n## Tests', '\n' + md + '\n\n## Tests')
writeFileSync('README.md', next)
