#!/usr/bin/env node
// packages/<name> is upstream <base> plus one squash per open PR, nothing else.
// stack/lock.json names the exact heads a package was built from.
// .stack-mirror holds only upstream objects and may be deleted at any time.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeResolver, type Resolver, type Unmerged } from './resolve.ts'

type StackConfig = { repo: string, base: string, path?: string, nested?: Record<string, string>, include?: number[], exclude?: number[], packageJson?: Record<string, any> }
type Config = { author: string, stacks: Record<string, StackConfig> }
type PrStatus = 'applied' | 'resolved-rerere' | 'resolved-ai' | 'conflict' | 'merged'
type PrLock = { number: number, title: string, head: string, mergeBase: string, status: PrStatus, note?: string }
type StackLock = { repo: string, base: string, baseSha: string, tip: string, tree: string, prs: PrLock[] }
type Lock = { stacks: Record<string, StackLock> }
type Pr = { number: number, title: string, body: string, head: string }

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const mirror = process.env.STACK_MIRROR ? resolve(process.env.STACK_MIRROR) : join(root, '.stack-mirror')
const files = { config: join(here, 'config.json'), lock: join(here, 'lock.json'), rr: join(here, 'rr-cache') }
const dryRun = process.argv.includes('--dry-run')
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',')
const short = (sha: string) => sha.slice(0, 7)

function run (cmd: string, args: string[], opts: { cwd?: string, input?: string, ok?: number[], env?: Record<string, string> } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, input: opts.input, encoding: 'utf8', maxBuffer: 1 << 30, env: opts.env ? { ...process.env, ...opts.env } : process.env })
  if (r.error) throw r.error
  if (!(opts.ok ?? [0]).includes(r.status ?? -1)) throw new Error(`${cmd} ${args.join(' ')} (in ${opts.cwd ?? root}) exited ${r.status}:\n${r.stderr}`)
  return r
}
const git = (args: string[], opts: Parameters<typeof run>[2] = {}) => run('git', args, opts).stdout.replace(/\n$/, '')
const mg = (args: string[], opts: Parameters<typeof run>[2] = {}) => git(args, { cwd: mirror, ...opts })

// ---- GitHub ---------------------------------------------------------------

function ghToken (): string | undefined {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : undefined
}
const token = ghToken()

async function ghJson (path: string): Promise<any> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'bot-harness-stack' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

async function openPrs (cfg: StackConfig, author: string): Promise<Pr[]> {
  const out: Pr[] = []
  for (let page = 1; ; page++) {
    const items = await ghJson(`/repos/${cfg.repo}/pulls?state=open&per_page=100&page=${page}`)
    for (const p of items) {
      const wanted = p.user?.login === author || cfg.include?.includes(p.number)
      if (wanted && !cfg.exclude?.includes(p.number)) out.push({ number: p.number, title: p.title, body: p.body ?? '', head: p.head.sha })
    }
    if (items.length < 100) break
  }
  return out.sort((a, b) => a.number - b.number)
}

// ---- mirror ---------------------------------------------------------------

function initMirror () {
  if (!existsSync(join(mirror, 'HEAD'))) {
    mkdirSync(mirror, { recursive: true })
    git(['init', '-q', '--bare', mirror])
  }
  const cfg: Array<[string, string]> = [
    ['user.name', 'bot-harness stack'], ['user.email', 'stack@bot-harness.invalid'],
    ['rerere.enabled', 'true'], ['rerere.autoupdate', 'true'], ['merge.conflictStyle', 'zdiff3'], ['gc.auto', '0']
  ]
  for (const [k, v] of cfg) mg(['config', k, v])
  mg(['worktree', 'prune'])
  if (existsSync(files.rr)) cpSync(files.rr, join(mirror, 'rr-cache'), { recursive: true, force: false, errorOnExist: false })
}

function fetchStack (id: string, cfg: StackConfig, prs: Pr[]) {
  const specs = [`+refs/heads/${cfg.base}:refs/stacks/${id}/base`, ...prs.map(p => `+refs/pull/${p.number}/head:refs/stacks/${id}/pr/${p.number}`)]
  mg(['fetch', '-q', '--no-tags', `https://github.com/${cfg.repo}.git`, ...specs])
  const keep = new Set(prs.map(p => `refs/stacks/${id}/pr/${p.number}`))
  for (const ref of mg(['for-each-ref', '--format=%(refname)', `refs/stacks/${id}/pr/`]).split('\n').filter(Boolean)) {
    if (!keep.has(ref)) mg(['update-ref', '-d', ref])
  }
}

// Application order: a PR whose head contains another PR's head goes after it,
// otherwise ascending PR number.
function order (prs: Array<Pr & { head: string }>): Array<Pr & { head: string }> {
  const remaining = [...prs].sort((a, b) => a.number - b.number)
  const out: typeof prs = []
  const contains = (a: string, b: string) => a !== b && run('git', ['merge-base', '--is-ancestor', b, a], { cwd: mirror, ok: [0, 1] }).status === 0
  while (remaining.length) {
    const i = remaining.findIndex(p => !remaining.some(q => q !== p && contains(p.head, q.head)))
    out.push(...remaining.splice(i < 0 ? 0 : i, 1))
  }
  return out
}

const unmergedStates: Record<string, string> = {
  DD: 'both deleted', AU: 'added by us', UD: 'deleted by them', UA: 'added by them',
  DU: 'deleted by us', AA: 'both added', UU: 'both modified'
}

function unmergedPaths (wt: string): Unmerged[] {
  const out: Unmerged[] = []
  for (const entry of git(['status', '--porcelain=v1', '-z'], { cwd: wt }).split('\0')) {
    const state = unmergedStates[entry.slice(0, 2)]
    if (state && entry.length > 3) out.push({ file: entry.slice(3), state })
  }
  return out
}

type Applied = { tip: string, status: PrStatus, note?: string }

async function applyWithWorktree (id: string, cfg: StackConfig, tip: string, squash: string, pr: Pr, mergeBase: string, message: string, appliedSoFar: number[], baseSha: string, resolver: Resolver | null): Promise<Applied> {
  const wt = mkdtempSync(join(tmpdir(), `stack-${id}-`))
  rmSync(wt, { recursive: true })
  mg(['worktree', 'add', '--detach', '-q', wt, tip])
  const w = (args: string[], opts: Parameters<typeof run>[2] = {}) => git(args, { cwd: wt, ...opts })
  try {
    run('git', ['cherry-pick', '--no-commit', squash], { cwd: wt, ok: [0, 1] })
    const unmerged = unmergedPaths(wt)
    let how: PrStatus = 'resolved-rerere'
    let note: string | undefined
    if (unmerged.length) {
      if (!resolver) return { tip, status: 'conflict', note: `no resolver for ${unmerged.map(u => u.file).join(', ')}` }
      how = 'resolved-ai'
      try {
        const res = await resolver.resolve({
          repo: cfg.repo,
          pr,
          stackDescription: `upstream ${cfg.base} ${short(baseSha)} + PRs ${appliedSoFar.map(n => '#' + n).join(', ') || '(none yet)'}`,
          worktree: wt,
          mergeBase,
          tip,
          unmerged
        })
        note = `${res.summary} (${res.touched.join(', ')}; ${res.turns} turns)`
      } catch (e: any) {
        return { tip, status: 'conflict', note: `${unmerged.map(u => u.file).join(', ')}: ${e.message}` }
      }
    }
    w(['commit', '-q', '--no-verify', '-m', message])
    return { tip: w(['rev-parse', 'HEAD']), status: how, note }
  } finally {
    mg(['worktree', 'remove', '--force', wt])
  }
}

async function buildStack (id: string, cfg: StackConfig, prs: Pr[], prev: StackLock | undefined, resolver: Resolver | null): Promise<StackLock> {
  const baseSha = mg(['rev-parse', `refs/stacks/${id}/base`])
  const heads = prs.map(p => ({ ...p, head: mg(['rev-parse', `refs/stacks/${id}/pr/${p.number}`]) }))
  if (prev && prev.baseSha === baseSha && prev.prs.length === heads.length &&
      heads.every(h => prev.prs.find(p => p.number === h.number)?.head === h.head) &&
      !(resolver && prev.prs.some(p => p.status === 'conflict')) &&
      run('git', ['cat-file', '-e', `${prev.tip}^{commit}`], { cwd: mirror, ok: [0, 1, 128] }).status === 0) {
    return prev
  }
  let tip = baseSha
  const out: PrLock[] = []
  for (const pr of order(heads)) {
    const mergeBase = mg(['merge-base', baseSha, pr.head])
    const entry: PrLock = { number: pr.number, title: pr.title, head: pr.head, mergeBase, status: 'applied' }
    out.push(entry)
    if (mergeBase === pr.head) { entry.status = 'merged'; continue }
    const message = `${cfg.repo}#${pr.number}: ${pr.title}\n\nSquash of ${pr.head}`
    const squash = mg(['commit-tree', `${pr.head}^{tree}`, '-p', mergeBase, '-m', message])
    const r = run('git', ['merge-tree', '--write-tree', `--merge-base=${mergeBase}`, tip, squash], { cwd: mirror, ok: [0, 1] })
    if (r.status === 0) {
      tip = mg(['commit-tree', r.stdout.trim().split('\n')[0], '-p', tip, '-m', message])
      continue
    }
    const applied = out.filter(p => p !== entry && (p.status === 'applied' || p.status.startsWith('resolved'))).map(p => p.number)
    const res = await applyWithWorktree(id, cfg, tip, squash, pr, mergeBase, message, applied, baseSha, resolver)
    tip = res.tip
    entry.status = res.status
    if (res.note) entry.note = res.note
    console.log(`  ${cfg.repo}#${pr.number}: ${res.status}${res.note ? ' (' + res.note + ')' : ''}`)
  }
  return { repo: cfg.repo, base: cfg.base, baseSha, tip, tree: mg(['rev-parse', `${tip}^{tree}`]), prs: out }
}

// The package tree is the stack's tree with each nested gitlink replaced by
// that stack's own composed tree, and package.json shallow-merged with the
// configured packageJson fields (each top-level key replaces or, for objects,
// merges into the upstream value).
function compose (id: string, config: Config, lock: Lock): string {
  const cfg = config.stacks[id]
  const tree = lock.stacks[id].tree
  if (!cfg.nested && !cfg.packageJson) return tree
  const nested = cfg.nested ?? {}
  const entries = mg(['ls-tree', tree]).split('\n').filter(Boolean)
  const replaced = new Set<string>()
  const lines = entries.map(line => {
    const [meta, name] = line.split('\t')
    if (nested[name]) {
      replaced.add(name)
      return `040000 tree ${compose(nested[name], config, lock)}\t${name}`
    }
    if (name === 'package.json' && cfg.packageJson) {
      const pkg = JSON.parse(mg(['cat-file', 'blob', meta.split(' ')[2]]))
      for (const [k, v] of Object.entries(cfg.packageJson)) {
        pkg[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(pkg[k] ?? {}), ...v } : v
      }
      const blob = mg(['hash-object', '-w', '--stdin'], { input: JSON.stringify(pkg, null, 2) + '\n' })
      return `100644 blob ${blob}\tpackage.json`
    }
    return line
  })
  for (const name of Object.keys(nested)) {
    if (!replaced.has(name)) lines.push(`040000 tree ${compose(nested[name], config, lock)}\t${name}`)
  }
  return mg(['mktree'], { input: lines.join('\n') + '\n' })
}

function exportRerere () {
  const src = join(mirror, 'rr-cache')
  if (!existsSync(src)) return
  for (const dir of readdirSync(src)) {
    const from = join(src, dir)
    let names: string[]
    try { names = readdirSync(from) } catch { continue }
    if (!names.some(n => /^postimage(\.\d+)?$/.test(n))) continue
    mkdirSync(join(files.rr, dir), { recursive: true })
    for (const n of names) if (/^(pre|post)image(\.\d+)?$/.test(n)) cpSync(join(from, n), join(files.rr, dir, n))
  }
}

function describeChanges (id: string, config: Config, before: Lock, after: Lock): string[] {
  const out: string[] = []
  const walk = (sid: string) => {
    const a = before.stacks[sid]
    const b = after.stacks[sid]
    const name = b.repo.replace(/^.*\//, '')
    const label = (n: number) => `${name}#${n}`
    if (!a) {
      out.push(`vendor ${name} ${b.base} ${short(b.baseSha)} + ${b.prs.filter(p => p.status !== 'merged' && p.status !== 'conflict').length} PRs`)
    } else {
      if (a.baseSha !== b.baseSha) out.push(`${name} ${b.base} ${short(a.baseSha)}..${short(b.baseSha)}`)
      for (const p of b.prs) {
        const q = a.prs.find(x => x.number === p.number)
        if (!q) out.push(`${label(p.number)} added (${p.status}): ${p.title}`)
        else if (q.head !== p.head) out.push(`${label(p.number)} ${short(q.head)}..${short(p.head)} (${p.status}): ${p.title}`)
        else if (q.status !== p.status) out.push(`${label(p.number)} ${q.status} -> ${p.status}`)
      }
      for (const q of a.prs) if (!b.prs.find(x => x.number === q.number)) out.push(`${label(q.number)} gone: ${q.title}`)
    }
    for (const n of Object.values(config.stacks[sid].nested ?? {})) walk(n)
  }
  walk(id)
  return out
}

function commitPackage (id: string, cfg: StackConfig, tree: string, lock: Lock, before: Lock, config: Config) {
  const result = mg(['commit-tree', tree, '-m', `stack ${id}`])
  mg(['update-ref', `refs/stacks/${id}/result`, result])
  git(['fetch', '-q', '--no-tags', mirror, `refs/stacks/${id}/result`])
  git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', cfg.path!])
  git(['read-tree', `--prefix=${cfg.path}/`, tree])
  writeFileSync(files.lock, JSON.stringify(lock, null, 2) + '\n')
  git(['add', '--', 'stack/lock.json', ...(existsSync(files.rr) ? ['stack/rr-cache'] : [])])
  const changes = describeChanges(id, config, before, lock)
  const name = cfg.path!.replace(/^packages\//, '')
  const brief = changes.map(c => c.replace(/^([\w.-]+)#/, (m, r) => r === name ? '#' : m).replace(/:.*$/, ''))
  let subject = `${name}: ${brief.join(', ') || 'rebuild the package tree'}`
  if (subject.length > 96) subject = `${name}: ${brief[0]} and ${brief.length - 1} more`
  git(['commit', '-q', '--no-verify', '-m', subject, '-m', changes.join('\n')])
  git(['reset', '-q', '--hard', 'HEAD'])
  console.log(`committed ${subject}`)
}

async function main () {
  const config: Config = JSON.parse(readFileSync(files.config, 'utf8'))
  const before: Lock = existsSync(files.lock) ? JSON.parse(readFileSync(files.lock, 'utf8')) : { stacks: {} }
  const lock: Lock = { stacks: { ...before.stacks } }
  const resolver = makeResolver()
  if (!dryRun && git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('working tree has uncommitted changes; commit or discard them first')
  console.log(`resolver: ${resolver ? resolver.model : 'none (ZAI_API_KEY unset; conflicting PRs are dropped)'}`)
  initMirror()

  const done = new Set<string>()
  const build = async (id: string) => {
    if (done.has(id)) return
    const cfg = config.stacks[id]
    for (const n of Object.values(cfg.nested ?? {})) await build(n)
    const prs = await openPrs(cfg, config.author)
    fetchStack(id, cfg, prs)
    const t0 = Date.now()
    lock.stacks[id] = await buildStack(id, cfg, prs, before.stacks[id], resolver)
    const s = lock.stacks[id]
    const count = (st: PrStatus) => s.prs.filter(p => p.status === st).length
    console.log(`${id}: ${cfg.repo} ${cfg.base} ${short(s.baseSha)}, ${s.prs.length} PRs: ${count('applied')} applied, ${count('resolved-rerere')} rerere, ${count('resolved-ai')} ai, ${count('conflict')} conflict, ${count('merged')} merged (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    done.add(id)
  }
  const ids = Object.keys(config.stacks).filter(id => !only || only.includes(id))
  for (const id of ids) await build(id)

  exportRerere()
  const summary: string[] = []
  for (const id of ids) {
    const cfg = config.stacks[id]
    if (!cfg.path) continue
    const tree = compose(id, config, lock)
    const current = run('git', ['rev-parse', '-q', '--verify', `HEAD:${cfg.path}`], { ok: [0, 1] }).stdout.trim()
    if (current === tree) continue
    const changes = describeChanges(id, config, before, lock)
    summary.push(`**${cfg.path}** updated:\n${changes.map(c => `- ${c}`).join('\n')}`)
    if (dryRun) { console.log(`would update ${cfg.path}:\n  ${changes.join('\n  ')}`); continue }
    commitPackage(id, cfg, tree, lock, before, config)
  }
  if (!dryRun) {
    writeFileSync(files.lock, JSON.stringify(lock, null, 2) + '\n')
    if (git(['status', '--porcelain', '--', 'stack'])) {
      git(['add', '--', 'stack'])
      git(['commit', '-q', '--no-verify', '-m', 'stack: record the current PR heads and statuses'])
      console.log('committed lock update')
    }
  }
  const conflicts = Object.entries(lock.stacks).flatMap(([id, s]) => s.prs.filter(p => p.status === 'conflict').map(p => `- ${s.repo}#${p.number} ${p.title}: ${p.note ?? ''}`))
  if (conflicts.length) summary.push(`**Dropped for unresolved conflicts:**\n${conflicts.join('\n')}`)
  if (!summary.length) summary.push('No changes.')
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n\n') + '\n', { flag: 'a' })
  console.log(summary.join('\n\n'))
}

main().catch(e => { console.error(e.stack ?? e); process.exit(1) })
