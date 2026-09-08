// Hands a conflicted cherry-pick to a Z.ai GLM model as an agent working in the
// worktree: it reads whatever it wants, edits the unmerged paths in whatever
// order, and calls finish when it believes the PR is applied. Every finish is
// validated here - nothing unmerged, no conflict markers, every file it touched
// still parses - and a failed check goes back as one more turn.
//
// Edits are confined to the paths git left unmerged: the next build replays
// this resolution through git rerere, which only knows about those files, so
// a change anywhere else would vanish on replay.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'

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

const START = /^<{7} /
const BASE = /^\|{7}/
const SEP = /^={7}$/
const END = /^>{7} /

const maxTurns = Number(process.env.ZAI_MAX_TURNS ?? 40)
// One PR may not sit in the agent loop indefinitely, and the whole run has to
// leave the CI job time to install and push: once the budget is spent the
// remaining conflicts are dropped and retried by the next run, with the ones
// already resolved replayed from rerere.
const deadlineMs = Number(process.env.ZAI_DEADLINE_MS ?? 10 * 60_000)
const budgetUntil = Date.now() + Number(process.env.ZAI_BUDGET_MS ?? 35 * 60_000)
const clipResult = 24000
// Old tool results are elided once the conversation grows past this many
// characters, oldest first; the model can read a file again if it needs it.
const contextChars = 400_000

export function hasMarkers (content: string): boolean {
  return content.split('\n').some(l => START.test(l) || BASE.test(l) || SEP.test(l) || END.test(l))
}

function git (args: string[], cwd: string, ok: number[] = [0]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 })
  if (r.error) throw r.error
  if (!ok.includes(r.status ?? -1)) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr.slice(0, 400)}`)
  return r.stdout
}

function gitBytes (args: string[], cwd: string): Buffer {
  const r = spawnSync('git', args, { cwd, maxBuffer: 1 << 30 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr.toString().slice(0, 400)}`)
  return r.stdout
}

// Keeps the model inside the checkout: no absolute paths, no ".." escapes and
// nothing under .git. Returns the normalised repository-relative path.
function insidePath (worktree: string, p: string): string {
  const abs = resolvePath(worktree, p)
  const rel = relative(worktree, abs)
  if (rel === '' || rel.startsWith('..') || rel.split('/')[0] === '.git') throw new Error(`path outside the worktree: ${p}`)
  return rel
}

function isBinary (buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
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

// ---- tools ----------------------------------------------------------------

type ToolDef = { name: string, description: string, input_schema: Record<string, any> }

const str = (description: string) => ({ type: 'string', description })
const side = (description: string) => ({ type: 'string', enum: ['base', 'stack', 'pr'], description })

const tools: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a file from the worktree as it stands right now, with 1-based line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        path: str('Path relative to the repository root.'),
        offset: { type: 'integer', description: 'First line to show (default 1).' },
        limit: { type: 'integer', description: 'How many lines to show (default the whole file).' }
      },
      required: ['path']
    }
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in one of the unmerged files. old_string must appear exactly once unless replace_all is true. Prefer this over write_file.',
    input_schema: {
      type: 'object',
      properties: {
        path: str('Path relative to the repository root; must be one of the unmerged paths.'),
        old_string: str('Exact text to replace, copied from a read_file result without the line numbers.'),
        new_string: str('Replacement text. Empty deletes the old text.'),
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'write_file',
    description: 'Write the whole contents of one of the unmerged files, creating it if one side deleted it.',
    input_schema: {
      type: 'object',
      properties: { path: str('Path relative to the repository root; must be one of the unmerged paths.'), content: str('Full new contents.') },
      required: ['path', 'content']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete one of the unmerged files, for instance when the PR removes a file the stack still has.',
    input_schema: { type: 'object', properties: { path: str('Path relative to the repository root; must be one of the unmerged paths.') }, required: ['path'] }
  },
  {
    name: 'take_version',
    description: 'Overwrite one of the unmerged files with one whole side of the conflict. Use it for binary files or when one side simply wins.',
    input_schema: {
      type: 'object',
      properties: {
        path: str('Path relative to the repository root; must be one of the unmerged paths.'),
        side: side('base = the common ancestor, stack = what the stack already has, pr = what this PR wants.')
      },
      required: ['path', 'side']
    }
  },
  {
    name: 'show_version',
    description: 'Show any path as one side has it, without touching the worktree.',
    input_schema: {
      type: 'object',
      properties: {
        path: str('Path relative to the repository root.'),
        side: side('base = the common ancestor, stack = the stack tip, pr = this PR head.')
      },
      required: ['path', 'side']
    }
  },
  {
    name: 'diff',
    description: 'Diff from the common ancestor to one side, optionally limited to some paths. This is how you see what the PR intends and what the stack already changed.',
    input_schema: {
      type: 'object',
      properties: {
        side: { type: 'string', enum: ['stack', 'pr'], description: 'stack = ancestor..stack tip, pr = ancestor..PR head.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Limit the diff to these paths.' }
      },
      required: ['side']
    }
  },
  {
    name: 'search',
    description: 'Search the worktree with git grep (basic regex, line numbers included). Use it to check that what you keep is consistent with its call sites.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: str('Regular expression.'),
        paths: { type: 'array', items: { type: 'string' }, description: 'Limit the search to these pathspecs.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'list_files',
    description: 'List tracked files matching a pathspec, for instance "viewer/lib/*.js".',
    input_schema: { type: 'object', properties: { pathspec: str('Glob pathspec (default everything).') } }
  },
  {
    name: 'check',
    description: 'Run the same validation finish runs: anything still unmerged, any leftover conflict marker, any file that stopped parsing. Call it before finish.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'finish',
    description: 'Declare the cherry-pick resolved. Rejected, with the reasons, if validation still fails. Call it on its own, after your last edit.',
    input_schema: {
      type: 'object',
      properties: { summary: str('One line on how you resolved it.') },
      required: ['summary']
    }
  },
  {
    name: 'abort',
    description: 'Give up on this PR: applying it correctly would need changes outside the unmerged files, or the two sides cannot be reconciled. The PR is left out of the stack and its author is told why.',
    input_schema: {
      type: 'object',
      properties: { reason: str('One line on what blocks the resolution.') },
      required: ['reason']
    }
  }
]

// ---- the agent ------------------------------------------------------------

type Block = { type: string, text?: string, id?: string, name?: string, input?: any }
type ToolResult = { type: 'tool_result', tool_use_id: string, content: string, is_error?: boolean }
type Message = { role: 'user' | 'assistant', content: string | Block[] | ToolResult[] }

// Drops the text of the oldest tool results until the conversation fits,
// never touching the two most recent user turns.
export function trimContext (messages: Message[], limit = contextChars): void {
  const size = () => messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0)
  if (size() <= limit) return
  const userTurns = messages.filter(m => m.role === 'user' && Array.isArray(m.content))
  for (const m of userTurns.slice(0, -2)) {
    for (const block of m.content as ToolResult[]) {
      if (block.type === 'tool_result' && block.content.length > 200) block.content = '(elided: an earlier result; read again if needed)'
    }
    if (size() <= limit) return
  }
}

export function makeResolver (): Resolver | null {
  const key = process.env.ZAI_API_KEY
  if (!key) return null
  const baseUrl = (process.env.ZAI_BASE_URL || 'https://api.z.ai/api/anthropic').replace(/\/$/, '')
  const model = process.env.ZAI_MODEL || 'glm-5.3'
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${key}`, 'x-api-key': key }
  const system = `You are a careful software engineer finishing a git cherry-pick in a Node.js repository (PrismarineJS Minecraft libraries).

A PR is being replayed on top of a stack of other PRs and git could not merge it on its own. You are working directly in the conflicted worktree. Read whatever you need before you edit, and never invent the contents of a file you have not read.

Finish the cherry-pick the way the PR author would if they rebased: the tree must keep what the stack already has AND what this PR adds. Do not drop code or tests from either side unless that side deliberately removed them. Keep the surrounding style and indentation, and do not reformat or refactor code the merge did not touch.

You may read any file and any side of the history, but you may only edit the paths git left unmerged. If a correct result would need a change anywhere else, call abort and say what it is instead of committing a half-applied PR. Leave no conflict markers.

Call check when you think you are done, fix anything it reports, then call finish on its own.`

  async function complete (messages: Message[]): Promise<Block[]> {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 32000, temperature: 0, system, tools, messages }),
      signal: AbortSignal.timeout(600_000)
    })
    if (!res.ok) throw new Error(`Z.ai ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data: any = await res.json()
    if (data.stop_reason === 'max_tokens') throw new Error('Z.ai answer hit max_tokens')
    return (data.content ?? []) as Block[]
  }

  return {
    model,
    async resolve (req) {
      if (Date.now() > budgetUntil) throw new Error('the AI time budget for this run is spent; retried by the next run')
      const wt = req.worktree
      const refs: Record<string, string> = { base: req.mergeBase, stack: req.tip, pr: req.pr.head }
      const editable = new Set(req.unmerged.map(u => insidePath(wt, u.file)))
      const touched = new Set<string>()

      const readable = (p: string) => join(wt, insidePath(wt, p))
      const writable = (p: string): string => {
        const rel = insidePath(wt, p)
        if (!editable.has(rel)) throw new Error(`${rel} is not one of the unmerged paths (${[...editable].join(', ')}); only those may be edited. Call abort if the PR cannot be applied without changing it.`)
        return rel
      }

      const stage = (rel: string) => {
        touched.add(rel)
        if (existsSync(join(wt, rel))) git(['add', '--', rel], wt)
        else git(['rm', '-q', '-f', '--ignore-unmatch', '--', rel], wt, [0, 128])
      }

      const readText = (path: string): string => {
        const abs = readable(path)
        if (!existsSync(abs)) throw new Error(`no such file in the worktree: ${path}`)
        const buf = readFileSync(abs)
        if (isBinary(buf)) throw new Error(`${path} is binary; use take_version to pick a side`)
        return buf.toString('utf8')
      }

      const unmergedNow = () => git(['diff', '--name-only', '--diff-filter=U'], wt).split('\n').filter(Boolean)

      const validate = (): string[] => {
        const out: string[] = []
        for (const f of unmergedNow()) out.push(`${f} is still unmerged - edit it (or take_version it) so it is resolved`)
        for (const f of editable) {
          const abs = join(wt, f)
          if (!existsSync(abs)) continue
          const buf = readFileSync(abs)
          if (isBinary(buf)) continue
          if (hasMarkers(buf.toString('utf8'))) out.push(`${f} still contains conflict markers`)
          const err = syntaxError(wt, f)
          if (err) out.push(`${f} no longer parses:\n${err}`)
        }
        return out
      }

      const call = (name: string, input: any): string => {
        switch (name) {
          case 'read_file': {
            const lines = readText(input.path).split('\n')
            const from = Math.max(1, Number(input.offset ?? 1))
            const to = input.limit ? from + Number(input.limit) - 1 : lines.length
            const shown = lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n')
            const tail = to < lines.length ? `\n... (${lines.length - to} more lines)` : ''
            return shown.length ? shown + tail : '(empty file)'
          }
          case 'edit_file': {
            const rel = writable(input.path)
            const oldString = String(input.old_string ?? '')
            const newString = String(input.new_string ?? '')
            if (!oldString) throw new Error('old_string is empty; use write_file to write a whole file')
            const before = readText(rel)
            const count = before.split(oldString).length - 1
            if (count === 0) throw new Error('old_string does not appear in the file; read it again and copy the text exactly')
            if (count > 1 && !input.replace_all) throw new Error(`old_string appears ${count} times; add more context or pass replace_all`)
            const after = input.replace_all ? before.split(oldString).join(newString) : before.replace(oldString, () => newString)
            writeFileSync(join(wt, rel), after)
            stage(rel)
            return `edited ${rel} (${count} replacement${count === 1 ? '' : 's'})`
          }
          case 'write_file': {
            const rel = writable(input.path)
            const abs = join(wt, rel)
            mkdirSync(dirname(abs), { recursive: true })
            writeFileSync(abs, String(input.content ?? ''))
            stage(rel)
            return `wrote ${rel}`
          }
          case 'delete_file': {
            const rel = writable(input.path)
            const abs = join(wt, rel)
            if (existsSync(abs)) rmSync(abs)
            stage(rel)
            return `deleted ${rel}`
          }
          case 'take_version': {
            const ref = refs[input.side]
            if (!ref) throw new Error(`unknown side ${input.side}`)
            const rel = writable(input.path)
            const abs = join(wt, rel)
            mkdirSync(dirname(abs), { recursive: true })
            writeFileSync(abs, gitBytes(['show', `${ref}:${rel}`], wt))
            stage(rel)
            return `${rel} is now the ${input.side} version`
          }
          case 'show_version': {
            const ref = refs[input.side]
            if (!ref) throw new Error(`unknown side ${input.side}`)
            const rel = insidePath(wt, input.path)
            const buf = gitBytes(['show', `${ref}:${rel}`], wt)
            if (isBinary(buf)) return `${rel} is binary on the ${input.side} side (${buf.length} bytes)`
            return buf.toString('utf8')
          }
          case 'diff': {
            const ref = refs[input.side === 'pr' ? 'pr' : 'stack']
            const paths: string[] = Array.isArray(input.paths) ? input.paths : []
            const out = git(['diff', req.mergeBase, ref, ...(paths.length ? ['--', ...paths] : [])], wt)
            return out.trim() ? out : '(no changes on that side)'
          }
          case 'search': {
            const paths: string[] = Array.isArray(input.paths) ? input.paths : []
            const out = git(['grep', '-n', '-I', '-e', String(input.pattern), ...(paths.length ? ['--', ...paths] : [])], wt, [0, 1])
            return out.trim() ? out : '(no matches)'
          }
          case 'list_files': {
            const out = git(['ls-files', '--', ...(input.pathspec ? [String(input.pathspec)] : [])], wt)
            return out.trim() ? out : '(no files match)'
          }
          case 'check': {
            const problems = validate()
            return problems.length ? `Not resolved yet:\n- ${problems.join('\n- ')}` : 'Everything checks out: nothing unmerged, no markers, everything parses.'
          }
          default:
            throw new Error(`unknown tool ${name}`)
        }
      }

      const messages: Message[] = [{ role: 'user', content: initialPrompt(req) }]
      const until = Math.min(Date.now() + deadlineMs, budgetUntil)
      for (let turn = 1; turn <= maxTurns; turn++) {
        if (Date.now() > until) throw new Error(`ran out of time after ${turn - 1} turns`)
        trimContext(messages)
        const blocks = await complete(messages)
        if (!blocks.length) throw new Error('Z.ai returned an empty answer')
        messages.push({ role: 'assistant', content: blocks })
        const calls = blocks.filter(b => b.type === 'tool_use')
        if (!calls.length) {
          messages.push({ role: 'user', content: 'Keep going with the tools, and call finish once check passes.' })
          continue
        }
        const results: ToolResult[] = []
        // Edits in the same turn land before finish is judged, whatever order
        // the model emitted them in.
        for (const c of calls) {
          if (c.name === 'finish' || c.name === 'abort') continue
          try {
            results.push({ type: 'tool_result', tool_use_id: c.id!, content: clip(call(c.name!, c.input ?? {}), clipResult) })
          } catch (e: any) {
            results.push({ type: 'tool_result', tool_use_id: c.id!, is_error: true, content: String(e.message ?? e) })
          }
        }
        for (const c of calls) {
          if (c.name === 'abort') throw new Error(`agent gave up: ${String(c.input?.reason ?? '').trim() || 'no reason given'}`)
          if (c.name !== 'finish') continue
          const problems = validate()
          if (problems.length) {
            results.push({ type: 'tool_result', tool_use_id: c.id!, is_error: true, content: `Not finished:\n- ${problems.join('\n- ')}` })
            continue
          }
          return { touched: [...touched].sort(), turns: turn, summary: String(c.input?.summary ?? '').trim() }
        }
        messages.push({ role: 'user', content: results })
      }
      throw new Error(`gave up after ${maxTurns} turns`)
    }
  }
}

function initialPrompt (req: ConflictRequest): string {
  const parts: string[] = []
  parts.push(`Repository: ${req.repo}`)
  parts.push(`Stack you are applying onto: ${req.stackDescription}`)
  parts.push(`PR #${req.pr.number} (head ${req.pr.head.slice(0, 10)}): ${req.pr.title}`)
  if (req.pr.body.trim()) parts.push(`PR description:\n${clip(req.pr.body.trim(), 6000)}`)
  parts.push(`Cherry-picking it left these paths unmerged, and they are the only ones you may edit:\n${req.unmerged.map(u => `- ${u.file} (${u.state})`).join('\n')}`)
  parts.push('Nothing is inlined for you: read the conflicted files yourself with read_file, and pull up whatever else you need. They are on disk with zdiff3 markers - "<<<<<<<" is what the stack has, "|||||||" the common ancestor, ">>>>>>>" what the PR wants.')
  parts.push('Resolve it. Look at what each side changed, edit the unmerged files, then check and finish.')
  return parts.join('\n\n')
}
