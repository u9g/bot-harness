// Resolves conflict hunks left by a cherry-pick with a Z.ai GLM model through
// the Anthropic-compatible messages endpoint. Only the hunks are rewritten;
// the rest of the file is spliced back byte for byte.

export type ConflictRequest = {
  repo: string
  pr: { number: number, title: string, body: string, head: string }
  stackDescription: string
  file: string
  content: string
  prDiff: string
  stackDiff: string
  feedback?: string
}

export type Resolver = { model: string, resolve: (req: ConflictRequest) => Promise<string> }

const START = /^<{7} /
const BASE = /^\|{7}/
const SEP = /^={7}$/
const END = /^>{7} /

type Hunk = { start: number, end: number, text: string }

export function findConflicts (content: string): Hunk[] {
  const lines = content.split('\n')
  const hunks: Hunk[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!START.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && !END.test(lines[j])) {
      if (START.test(lines[j])) throw new Error(`nested conflict markers at line ${j + 1}`)
      j++
    }
    if (j === lines.length) throw new Error(`unterminated conflict starting at line ${i + 1}`)
    hunks.push({ start: i, end: j, text: lines.slice(i, j + 1).join('\n') })
    i = j
  }
  return hunks
}

export function hasMarkers (content: string): boolean {
  return content.split('\n').some(l => START.test(l) || BASE.test(l) || SEP.test(l) || END.test(l))
}

export function splice (content: string, hunks: Hunk[], replacements: Map<number, string>): string {
  const lines = content.split('\n')
  for (let k = hunks.length - 1; k >= 0; k--) {
    const rep = replacements.get(k + 1)
    if (rep === undefined) throw new Error(`no resolution for conflict ${k + 1}`)
    const repLines = rep === '' ? [] : rep.split('\n')
    lines.splice(hunks[k].start, hunks[k].end - hunks[k].start + 1, ...repLines)
  }
  return lines.join('\n')
}

const clip = (s: string, max: number) => s.length > max ? s.slice(0, max) + `\n... (${s.length - max} more bytes cut)` : s

export function buildPrompt (req: ConflictRequest, hunks: Hunk[]): string {
  const parts: string[] = []
  parts.push(`Repository: ${req.repo}`)
  parts.push(`Stack being built: ${req.stackDescription}`)
  parts.push(`Now applying PR #${req.pr.number} (head ${req.pr.head.slice(0, 10)}): ${req.pr.title}`)
  if (req.pr.body.trim()) parts.push(`PR description:\n${clip(req.pr.body.trim(), 6000)}`)
  parts.push(`File: ${req.file}`)
  parts.push(`Diff of this file as PR #${req.pr.number} wants it (from its merge-base to its head):\n\`\`\`diff\n${clip(req.prDiff, 30000)}\n\`\`\``)
  parts.push(`Diff of this file already in the stack (from the PR's merge-base to the current stack tip):\n\`\`\`diff\n${clip(req.stackDiff, 30000)}\n\`\`\``)
  const body = req.content.length <= 160000
    ? `Full file with conflict markers (zdiff3 style: "<<<<<<<" side is the stack, "|||||||" is the common base, ">>>>>>>" side is the PR):\n\`\`\`\n${req.content}\n\`\`\``
    : 'The file is too large to include whole; each conflict is shown below with its markers.'
  parts.push(body)
  parts.push(hunks.map((h, i) => `Conflict ${i + 1} (lines ${h.start + 1}-${h.end + 1}):\n\`\`\`\n${h.text}\n\`\`\``).join('\n\n'))
  if (req.feedback) parts.push(`Your previous answer was rejected: ${req.feedback}. Answer again.`)
  parts.push(`Resolve every conflict so that the file contains both what the stack already has and what PR #${req.pr.number} adds, the way the PR author would if they rebased. Keep indentation and style. Do not drop tests or code from either side unless one side deliberately removed it. Never leave conflict markers.

Answer with one block per conflict and nothing else, exactly in this form (the lines between the two delimiter lines replace the whole marker block, and may be empty):
<<<RESOLVED 1>>>
...replacement lines...
<<<END 1>>>`)
  return parts.join('\n\n')
}

export function parseAnswer (text: string): Map<number, string> {
  const out = new Map<number, string>()
  const re = /^<<<RESOLVED (\d+)>>>\r?\n([\s\S]*?)(?:\r?\n)?^<<<END \1>>>[ \t]*$/gm
  for (const m of text.matchAll(re)) out.set(Number(m[1]), m[2].replace(/\r\n/g, '\n'))
  return out
}

export function makeResolver (): Resolver | null {
  const key = process.env.ZAI_API_KEY
  if (!key) return null
  const baseUrl = (process.env.ZAI_BASE_URL || 'https://api.z.ai/api/anthropic').replace(/\/$/, '')
  const model = process.env.ZAI_MODEL || 'glm-5.3'
  const system = 'You are a careful software engineer resolving git merge conflicts in a Node.js codebase (PrismarineJS Minecraft libraries). You answer only in the requested delimiter format.'

  async function complete (prompt: string): Promise<string> {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${key}`, 'x-api-key': key },
      body: JSON.stringify({ model, max_tokens: 32000, temperature: 0, system, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(600_000)
    })
    if (!res.ok) throw new Error(`Z.ai ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data: any = await res.json()
    const text = (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    if (!text) throw new Error(`Z.ai returned no text (stop_reason ${data.stop_reason})`)
    if (data.stop_reason === 'max_tokens') throw new Error('Z.ai answer hit max_tokens')
    return text
  }

  return {
    model,
    async resolve (req) {
      const hunks = findConflicts(req.content)
      if (hunks.length === 0) throw new Error('no conflict markers in file')
      const answer = await complete(buildPrompt(req, hunks))
      const resolved = splice(req.content, hunks, parseAnswer(answer))
      if (hasMarkers(resolved)) throw new Error('resolution still contains conflict markers')
      return resolved
    }
  }
}
