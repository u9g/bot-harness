// Hands a conflicted cherry-pick to the pi coding agent
// (@mariozechner/pi-coding-agent) running non-interactively in the worktree
// against a Z.ai GLM model. The agent reads and edits with its own tools;
// this module frames the task, bounds it, and validates what it left behind
// before the builder commits it.
//
// Edits are confined to the paths git left unmerged: the next build replays
// this resolution through git rerere, which only knows about those files, so
// a change anywhere else would vanish on replay. Such a change fails the
// resolution instead of being committed.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Pr = { number: number, title: string, body: string, head: string }
export type Unmerged = { file: string, state: string }

export type ConflictRequest = {
  repo: string
  pr: Pr
  stackDescription: string
  // A worktree of the mirror sitting on the failed cherry-pick, so every ref
  // below is readable from it.
  worktree: string
  mergeBase: string
  tip: string
  unmerged: Unmerged[]
}

export type Resolution = { touched: string[], turns: number, summary: string }
export type Resolver = { model: string, resolve: (req: ConflictRequest) => Promise<Resolution> }

const piBin = process.env.PI_BIN || 'pi'
const model = process.env.ZAI_MODEL || 'glm-5.3'
// GLM 5.3 rejects a request with thinking disabled.
const thinking = process.env.ZAI_THINKING || 'low'
// One PR may not sit in the agent indefinitely, and the whole run has to
// leave the CI job time to install and push: once the budget is spent the
// remaining conflicts are dropped and retried by the next run, with the ones
// already resolved replayed from rerere.
const deadlineMs = Number(process.env.ZAI_DEADLINE_MS ?? 10 * 60_000)
const budgetUntil = Date.now() + Number(process.env.ZAI_BUDGET_MS ?? 35 * 60_000)

const START = /^<{7} /
const BASE = /^\|{7}/
const SEP = /^={7}$/
const END = /^>{7} /
const GAVE_UP = /^CANNOT:\s*(.*)$/m

export function hasMarkers (content: string): boolean {
  return content.split('\n').some(l => START.test(l) || BASE.test(l) || SEP.test(l) || END.test(l))
}

function git (args: string[], cwd: string, ok: number[] = [0]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 })
  if (r.error) throw r.error
  if (!ok.includes(r.status ?? -1)) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr.slice(0, 400)}`)
  return r.stdout
}

export function syntaxError (worktree: string, file: string): string | null {
  if (/\.(c|m)?js$/.test(file)) {
    const r = spawnSync('node', ['--check', file], { cwd: worktree, encoding: 'utf8' })
    if (r.error) throw r.error
    return r.status === 0 ? null : r.stderr.split('\n').slice(0, 8).join('\n')
  }
  if (file.endsWith('.json')) {
    try { JSON.parse(readFileSync(join(worktree, file), 'utf8')); return null } catch (e: any) { return e.message }
  }
  return null
}

const clip = (s: string, max: number) => s.length > max ? s.slice(0, max) + `\n... (${s.length - max} more bytes cut)` : s

// The index as `git ls-files -s` lists it, keyed by path.
function indexListing (wt: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of git(['ls-files', '-s', '-z'], wt).split('\0')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const path = line.slice(tab + 1)
    out.set(path, (out.get(path) ?? '') + line.slice(0, tab) + ';')
  }
  return out
}

// Tracked paths the agent changed since `before` was taken: worktree edits,
// plus anything staged or unstaged despite the rules. The cherry-pick's own
// staged changes are in both index listings and so never count; untracked
// files are left out because the worktree is discarded after the commit.
function changedSince (wt: string, before: Map<string, string>): string[] {
  const changed = new Set(git(['diff', '--name-only'], wt).split('\n').filter(Boolean))
  const after = indexListing(wt)
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) !== after.get(path)) changed.add(path)
  }
  return [...changed].sort()
}

const rules = `You are finishing a git cherry-pick that stopped on conflicts, inside a detached worktree that is yours alone.

- Resolve every conflict the way the PR author would if they rebased: the result must keep what the stack already has AND what this PR adds. Do not drop code or tests from either side unless that side deliberately removed them. Keep the surrounding style and indentation, and do not reformat or refactor code the merge did not touch.
- Edit only the paths listed as unmerged. The build replays your resolution through git rerere, which records only those files, so a change anywhere else would be lost. If a correct result needs a change elsewhere, make no edits and answer with one line starting with "CANNOT:" saying what is needed.
- Read before you edit, and never invent the contents of a file you have not read. Use git against the refs you are given (diff, show, log) to see what each side intends.
- Do not commit, stage, reset, rebase, or stash, and do not run package installs or test suites. Leave no conflict markers.
- When done, answer with one line summarizing how you resolved it.`

function prompt (req: ConflictRequest): string {
  const parts: string[] = []
  parts.push(`Repository: ${req.repo}`)
  parts.push(`Stack you are applying onto: ${req.stackDescription}`)
  parts.push(`PR #${req.pr.number}: ${req.pr.title}`)
  if (req.pr.body.trim()) parts.push(`PR description:\n${clip(req.pr.body.trim(), 6000)}`)
  parts.push(`Refs (all readable with git here): common ancestor ${req.mergeBase}, stack tip ${req.tip} (HEAD), PR head ${req.pr.head}. "git diff ${req.mergeBase.slice(0, 10)} ${req.pr.head.slice(0, 10)} -- <path>" shows what the PR wants; "git diff ${req.mergeBase.slice(0, 10)} HEAD -- <path>" shows what the stack already changed.`)
  parts.push(`Cherry-picking the PR left these paths unmerged, and they are the only ones you may edit:\n${req.unmerged.map(u => `- ${u.file} (${u.state})`).join('\n')}`)
  parts.push('The files carry zdiff3 markers: "<<<<<<<" starts what the stack has, "|||||||" the common ancestor, "=======" then what the PR wants up to ">>>>>>>". Resolve them all.')
  return parts.join('\n\n')
}

type Event = { type: string, message?: { role?: string, content?: Array<{ type: string, text?: string }>, stopReason?: string, errorMessage?: string } }

export function makeResolver (): Resolver | null {
  const key = process.env.ZAI_API_KEY
  if (!key) return null
  const probe = spawnSync(piBin, ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    throw new Error(`ZAI_API_KEY is set but "${piBin}" does not run (${probe.error?.message ?? probe.stderr.trim()}); install @mariozechner/pi-coding-agent or point PI_BIN at it`)
  }
  return {
    model: `zai/${model} through pi ${(probe.stdout || probe.stderr).trim()}`,
    async resolve (req) {
      const wt = req.worktree
      const timeout = Math.min(deadlineMs, budgetUntil - Date.now())
      if (timeout <= 0) throw new Error('the AI time budget for this run is spent; retried by the next run')
      const editable = new Set(req.unmerged.map(u => u.file))
      const indexBefore = indexListing(wt)

      const r = spawnSync(piBin, [
        '-p', '--mode', 'json', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
        '--tools', 'read,bash,edit,write,grep,find,ls',
        '--model', `zai/${model}`, '--thinking', thinking,
        '--append-system-prompt', rules,
        prompt(req)
      ], { cwd: wt, encoding: 'utf8', maxBuffer: 1 << 30, timeout, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ZAI_API_KEY: key } })
      if (r.signal || (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`pi ran out of time after ${Math.round(timeout / 1000)}s`)
      if (r.error) throw r.error
      if (r.status !== 0) throw new Error(`pi exited ${r.status}: ${clip(r.stderr.trim(), 600)}`)

      let turns = 0
      let answer = ''
      for (const line of r.stdout.split('\n')) {
        let event: Event
        try { event = JSON.parse(line) } catch { continue }
        if (event.type === 'turn_end') turns++
        if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue
        if (event.message.stopReason === 'error') throw new Error(`model error: ${clip(event.message.errorMessage ?? 'unknown', 400)}`)
        const text = (event.message.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim()
        if (text) answer = text
      }
      const gaveUp = GAVE_UP.exec(answer)
      if (gaveUp) throw new Error(`agent gave up: ${gaveUp[1].trim() || 'no reason given'}`)

      // A commit the agent made anyway folds back into the index.
      if (git(['rev-parse', 'HEAD'], wt).trim() !== req.tip) git(['reset', '-q', '--soft', req.tip], wt)
      const outside = changedSince(wt, indexBefore).filter(p => !editable.has(p))
      if (outside.length) throw new Error(`edited outside the unmerged paths: ${outside.join(', ')}`)
      for (const f of editable) {
        const abs = join(wt, f)
        if (!existsSync(abs)) continue
        const buf = readFileSync(abs)
        if (buf.subarray(0, 8000).includes(0)) continue
        if (hasMarkers(buf.toString('utf8'))) throw new Error(`${f} still contains conflict markers`)
        const err = syntaxError(wt, f)
        if (err) throw new Error(`${f} no longer parses:\n${err}`)
      }
      git(['add', '-A', '--', ...editable], wt)
      const unmerged = git(['diff', '--name-only', '--diff-filter=U'], wt).split('\n').filter(Boolean)
      if (unmerged.length) throw new Error(`still unmerged: ${unmerged.join(', ')}`)
      const summary = answer.split('\n').filter(Boolean).pop() ?? 'no summary'
      return { touched: [...editable].sort(), turns, summary: clip(summary, 200) }
    }
  }
}
