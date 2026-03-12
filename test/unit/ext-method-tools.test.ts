import test from 'node:test'
import assert from 'node:assert/strict'

import { ExtMethodToolBridge, loadClientToolSpecs } from '../../src/acp/ext-method-tools.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('loadClientToolSpecs rejects duplicate methods', () => {
  assert.throws(
    () =>
      loadClientToolSpecs(
        JSON.stringify([
          { method: '_civilpro/ping' },
          { method: '_civilpro/ping' }
        ])
      ),
    /duplicate client tool method/i
  )
})

test('ExtMethodToolBridge forwards custom methods and injects sessionId', async () => {
  const original = process.env.PI_ACP_CLIENT_TOOLS
  process.env.PI_ACP_CLIENT_TOOLS = JSON.stringify([
    {
      method: '_civilpro/ping',
      toolName: 'civilpro_ping',
      description: 'Ping the ACP client',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' }
        },
        required: ['message'],
        additionalProperties: false
      }
    }
  ])

  const conn = new FakeAgentSideConnection()
  conn.extMethodHandler = async (_method, params) => ({ text: `pong:${String(params.message ?? '')}` })

  const bridge = ExtMethodToolBridge.fromEnv()
  const spawn = await bridge.prepareSpawn()

  try {
    assert.ok(spawn)
    bridge.bindToken(spawn.token, 'sess-1', asAgentConn(conn))

    const response = await fetch(spawn.env.PI_ACP_CLIENT_TOOLS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pi-acp-token': spawn.token
      },
      body: JSON.stringify({
        method: '_civilpro/ping',
        params: { message: 'hello' }
      })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      result: { text: 'pong:hello' }
    })
    assert.equal(conn.extMethodCalls.length, 1)
    assert.equal(conn.extMethodCalls[0]?.method, 'civilpro/ping')
    assert.deepEqual(conn.extMethodCalls[0]?.params, {
      message: 'hello',
      _meta: { sessionId: 'sess-1' }
    })
  } finally {
    bridge.dispose()
    if (original === undefined) {
      delete process.env.PI_ACP_CLIENT_TOOLS
    } else {
      process.env.PI_ACP_CLIENT_TOOLS = original
    }
  }
})
