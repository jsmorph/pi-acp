import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  async create() {
    throw new Error('pi should not be spawned when no auth is configured')
  }
}

class RecordingSessions {
  createCalls = 0

  async create() {
    this.createCalls += 1
    return {
      sessionId: 'session-1',
      proc: {
        async getState() {
          return {
            model: {
              provider: 'xproxy',
              id: 'anthropic://claude-opus-4-6'
            },
            thinkingLevel: 'medium'
          }
        },
        async getAvailableModels() {
          return {
            models: [
              {
                provider: 'xproxy',
                id: 'anthropic://claude-opus-4-6',
                name: 'Anthropic Claude Opus 4.6'
              }
            ]
          }
        },
        async getCommands() {
          return { commands: [] }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }
  }

  closeAllExcept() {}
}

test('PiAcpAgent: newSession returns AUTH_REQUIRED without spawning pi when no auth configured', async () => {
  const prev = process.env.PI_CODING_AGENT_DIR
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-auth-'))

  // Create empty auth/models files in a temp agent dir.
  writeFileSync(join(dir, 'auth.json'), '{}', 'utf-8')
  writeFileSync(join(dir, 'models.json'), '{}', 'utf-8')

  // Also ensure typical env vars are not set for this test.
  const savedEnv: Record<string, string | undefined> = {}
  const keys = [
    'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'CEREBRAS_API_KEY',
    'XAI_API_KEY',
    'OPENROUTER_API_KEY',
    'AI_GATEWAY_API_KEY',
    'ZAI_API_KEY',
    'MISTRAL_API_KEY',
    'MINIMAX_API_KEY',
    'MINIMAX_CN_API_KEY',
    'HF_TOKEN',
    'OPENCODE_API_KEY',
    'KIMI_API_KEY',
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY'
  ]
  for (const k of keys) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }

  process.env.PI_CODING_AGENT_DIR = dir

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions() as any

    await assert.rejects(
      () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
      (e: any) => e?.code === -32000
    )
  } finally {
    if (prev == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev

    for (const k of keys) {
      if (savedEnv[k] == null) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  }
})

test('PiAcpAgent: newSession skips pre-spawn auth gate when PI_ACP_PI_COMMAND is set', async () => {
  const prevDir = process.env.PI_CODING_AGENT_DIR
  const prevCmd = process.env.PI_ACP_PI_COMMAND
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-auth-'))

  writeFileSync(join(dir, 'auth.json'), '{}', 'utf-8')
  writeFileSync(join(dir, 'models.json'), '{}', 'utf-8')

  const savedEnv: Record<string, string | undefined> = {}
  const keys = [
    'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'CEREBRAS_API_KEY',
    'XAI_API_KEY',
    'OPENROUTER_API_KEY',
    'AI_GATEWAY_API_KEY',
    'ZAI_API_KEY',
    'MISTRAL_API_KEY',
    'MINIMAX_API_KEY',
    'MINIMAX_CN_API_KEY',
    'HF_TOKEN',
    'OPENCODE_API_KEY',
    'KIMI_API_KEY',
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY'
  ]
  for (const k of keys) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }

  process.env.PI_CODING_AGENT_DIR = dir
  process.env.PI_ACP_PI_COMMAND = '/tmp/fake-pi-wrapper'

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    const sessions = new RecordingSessions()
    ;(agent as any).sessions = sessions as any

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    assert.equal(res.sessionId, 'session-1')
    assert.equal(sessions.createCalls, 1)
  } finally {
    if (prevDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevDir
    if (prevCmd == null) delete process.env.PI_ACP_PI_COMMAND
    else process.env.PI_ACP_PI_COMMAND = prevCmd

    for (const k of keys) {
      if (savedEnv[k] == null) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  }
})
