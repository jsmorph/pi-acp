import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent prepends standing instructions from PI_ACP_INSTRUCTIONS_FILE', async () => {
  const path = join(tmpdir(), `pi-acp-standing-instructions-${process.pid}.md`)
  writeFileSync(path, 'Attorney instructions.\nFile the narrowest truthful submission.')
  const original = process.env.PI_ACP_INSTRUCTIONS_FILE
  process.env.PI_ACP_INSTRUCTIONS_FILE = path
  try {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess() as any
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

    await agent.prompt({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'Court instructions.' }]
    } as any)

    assert.equal(proc.prompts.length, 1)
    assert.match(proc.prompts[0]!.message, /^Attorney instructions\.\nFile the narrowest truthful submission\.\n\nCourt instructions\.$/)
  } finally {
    if (original === undefined) delete process.env.PI_ACP_INSTRUCTIONS_FILE
    else process.env.PI_ACP_INSTRUCTIONS_FILE = original
    unlinkSync(path)
  }
})
