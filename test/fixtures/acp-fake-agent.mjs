#!/usr/bin/env node
// Fake ACP agent used only by tests. It proves the bridge speaks real ACP
// (initialize -> session/new -> session/prompt -> agent_message_chunk).
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk'

const review = {
  verdict: 'pass',
  summary: 'fake ACP transport smoke',
  strengths: [{ point: 'ACP bridge ran', evidence: 'fake agent replied with a session update' }],
  issues: [],
  recommendations: [],
  assessment: 'fake agent used for transport tests only',
}

const app = agent({ name: 'dsh-fake-acp-agent' })

app.onRequest(methods.agent.initialize, () => ({
  protocolVersion: 1,
  agentCapabilities: { sessionCapabilities: { systemPrompt: { mode: { append: {} } } } },
  authMethods: [],
}))

let seenSystemPrompt = null
let seenMeta = null
app.onRequest(methods.agent.session.new, (ctx) => {
  seenSystemPrompt = ctx.params?.systemPrompt ?? null
  seenMeta = ctx.params?._meta ?? null
  return { sessionId: 'fake-acp-session' }
})

app.onRequest(methods.agent.session.setMode, () => ({}))

app.onRequest(methods.agent.session.prompt, async (ctx) => {
  const ask = async (kind) => {
    const response = await ctx.client.request(methods.client.session.requestPermission, {
      sessionId: ctx.params.sessionId,
      toolCall: { toolCallId: `fake-${kind}`, title: `fake ${kind}`, kind, status: 'pending' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const outcome = response?.outcome
    return outcome?.outcome === 'selected' && outcome.optionId === 'allow'
  }
  const permissions = { read: await ask('read'), edit: await ask('edit') }
  let fsRead = null
  let fsWriteDenied = false
  const fsPath = process.env.ACP_SMOKE_FILE
  if (fsPath) {
    const response = await ctx.client.request(methods.client.fs.readTextFile, { sessionId: ctx.params.sessionId, path: fsPath, line: 2, limit: 2 })
    fsRead = response?.content ?? null
    try {
      await ctx.client.request(methods.client.fs.writeTextFile, { sessionId: ctx.params.sessionId, path: `${fsPath}.out`, content: 'should be denied' })
    } catch {
      fsWriteDenied = true
    }
  }
  const payload = { ...review, permissions, fsRead, fsWriteDenied, systemPrompt: seenSystemPrompt, sessionMeta: seenMeta }
  await ctx.client.notify(methods.client.session.update, {
    sessionId: ctx.params.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: JSON.stringify(payload) },
    },
  })
  return { stopReason: 'end_turn' }
})

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
