// Drives the resolver with a scripted stand-in for the model over a real
// conflicted cherry-pick.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeResolver, trimContext, type ConflictRequest } from './resolve.ts'

function git (cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0 && !(args[0] === 'cherry-pick' && r.status === 1)) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// base: a.js and b.js; stack and pr both rewrite the same line of a.js.
function conflictedRepo (): { wt: string, base: string, stack: string, pr: string } {
  const wt = mkdtempSync(join(tmpdir(), 'resolve-test-'))
  git(wt, 'init', '-q')
  git(wt, 'config', 'user.name', 't'); git(wt, 'config', 'user.email', 't@t'); git(wt, 'config', 'merge.conflictStyle', 'zdiff3')
  writeFileSync(join(wt, 'a.js'), 'module.exports = 1\n')
  writeFileSync(join(wt, 'b.js'), 'module.exports = require("./a.js")\n')
  git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'base')
  const base = git(wt, 'rev-parse', 'HEAD')
  writeFileSync(join(wt, 'a.js'), 'module.exports = 2 // stack\n')
  git(wt, 'commit', '-q', '-am', 'stack')
  const stack = git(wt, 'rev-parse', 'HEAD')
  git(wt, 'checkout', '-q', base)
  writeFileSync(join(wt, 'a.js'), 'module.exports = 3 // pr\n')
  git(wt, 'commit', '-q', '-am', 'pr')
  const pr = git(wt, 'rev-parse', 'HEAD')
  git(wt, 'checkout', '-q', stack)
  git(wt, 'cherry-pick', '--no-commit', pr)
  assert.equal(git(wt, 'diff', '--name-only', '--diff-filter=U'), 'a.js')
  return { wt, base, stack, pr }
}

type Turn = Array<{ name: string, input: any }>

// Answers each request with the next scripted turn and keeps every request.
async function fakeModel (turns: Turn[]): Promise<{ server: Server, requests: any[], url: string }> {
  const requests: any[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      const turn = turns[requests.length - 1]
      if (!turn) { res.writeHead(500); res.end('script exhausted'); return }
      const content = turn.map((t, i) => ({ type: 'tool_use', id: `t${requests.length}-${i}`, name: t.name, input: t.input }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content, stop_reason: 'tool_use' }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return { server, requests, url: `http://127.0.0.1:${port}` }
}

function request (repo: ReturnType<typeof conflictedRepo>): ConflictRequest {
  return {
    repo: 'x/y',
    pr: { number: 7, title: 'pr', body: '', head: repo.pr },
    stackDescription: 'test stack',
    worktree: repo.wt,
    mergeBase: repo.base,
    tip: repo.stack,
    unmerged: [{ file: 'a.js', state: 'both modified' }]
  }
}

const lastResults = (req: any) => req.messages.at(-1).content as Array<{ tool_use_id: string, content: string, is_error?: boolean }>

test('the agent reads, is held to the unmerged paths, and finish is validated', async () => {
  const repo = conflictedRepo()
  const { server, requests, url } = await fakeModel([
    [{ name: 'read_file', input: { path: 'a.js' } }],
    [{ name: 'edit_file', input: { path: 'b.js', old_string: 'a.js', new_string: 'c.js' } }],
    [{ name: 'finish', input: { summary: 'too early' } }, { name: 'write_file', input: { path: 'a.js', content: '<<<<<<< x\nmodule.exports = 5 // both\n' } }],
    [{ name: 'edit_file', input: { path: 'a.js', old_string: '<<<<<<< x\n', new_string: '' } }, { name: 'check', input: {} }],
    [{ name: 'finish', input: { summary: 'kept both' } }]
  ])
  process.env.ZAI_API_KEY = 'test'
  process.env.ZAI_BASE_URL = url
  try {
    const res = await makeResolver()!.resolve(request(repo))
    assert.deepEqual(res, { touched: ['a.js'], turns: 5, summary: 'kept both' })
    assert.equal(readFileSync(join(repo.wt, 'a.js'), 'utf8'), 'module.exports = 5 // both\n')
    assert.equal(readFileSync(join(repo.wt, 'b.js'), 'utf8'), 'module.exports = require("./a.js")\n')
    assert.equal(git(repo.wt, 'diff', '--name-only', '--diff-filter=U'), '')
    assert.equal(git(repo.wt, 'diff', '--cached', '--name-only'), 'a.js')

    assert.equal(requests.length, 5)
    assert.match(requests[0].messages[0].content, /a\.js \(both modified\)/)
    assert.match(lastResults(requests[1])[0].content, /<<<<<<< /)
    const refused = lastResults(requests[2])[0]
    assert.equal(refused.is_error, true)
    assert.match(refused.content, /b\.js is not one of the unmerged paths/)
    // The write in the same turn landed before finish was judged, so the only
    // complaint is the marker it left behind.
    const [wrote, early] = lastResults(requests[3])
    assert.equal(wrote.content, 'wrote a.js')
    assert.equal(early.is_error, true)
    assert.match(early.content, /a\.js still contains conflict markers/)
    assert.doesNotMatch(early.content, /still unmerged/)
    assert.match(lastResults(requests[4])[1].content, /Everything checks out/)
  } finally {
    server.close()
  }
})

test('abort drops the PR with the agent\'s reason', async () => {
  const repo = conflictedRepo()
  const { server, url } = await fakeModel([[{ name: 'abort', input: { reason: 'needs b.js changed too' } }]])
  process.env.ZAI_API_KEY = 'test'
  process.env.ZAI_BASE_URL = url
  try {
    await assert.rejects(makeResolver()!.resolve(request(repo)), /agent gave up: needs b\.js changed too/)
  } finally {
    server.close()
  }
})

test('trimContext elides the oldest tool results first and spares the last two turns', () => {
  const big = 'x'.repeat(1000)
  const turn = (i: number) => [
    { role: 'assistant' as const, content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: {} }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: `t${i}`, content: big }] }
  ]
  const messages = [{ role: 'user' as const, content: 'go' }, ...turn(1), ...turn(2), ...turn(3), ...turn(4)]
  trimContext(messages, 3000)
  const results = messages.filter(m => m.role === 'user' && Array.isArray(m.content)).map(m => (m.content as any)[0].content)
  assert.equal(results[0].length < 100, true)
  assert.equal(results[1].length < 100, true)
  assert.equal(results[2], big)
  assert.equal(results[3], big)
})
