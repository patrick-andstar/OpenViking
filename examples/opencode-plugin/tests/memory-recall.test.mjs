import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createMemoryRecall } from "../lib/memory-recall.mjs"

async function withRecallServer(fn) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ""
    req.setEncoding("utf8")
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, body })

    res.setHeader("Content-Type", "application/json")
    if (req.url === "/health") {
      res.end(JSON.stringify({ status: "ok" }))
    } else if (req.url === "/api/v1/search/recall") {
      res.end(JSON.stringify({
        status: "ok",
        result: { rendered: "Remember the deployment preference." },
      }))
    } else {
      res.statusCode = 404
      res.end(JSON.stringify({ status: "error", error: { message: "not found" } }))
    }
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const { port } = server.address()
    return await fn({ endpoint: `http://127.0.0.1:${port}`, requests })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function recallConfig(endpoint) {
  return {
    endpoint,
    timeoutMs: 5000,
    autoRecall: { enabled: true },
    minQueryLength: 3,
    recallLimit: 6,
    scoreThreshold: 0.35,
    recallMaxContentChars: 500,
    recallTokenBudget: 2000,
    recallPreferAbstract: true,
    recallPeerScope: "all",
    peerId: "",
    effectivePeer: null,
    bypassSession: false,
    bypassSessionPatterns: [],
  }
}

test("auto recall uses the first user message after synthetic session context", async () => {
  await withRecallServer(async ({ endpoint, requests }) => {
    const recall = createMemoryRecall({ config: recallConfig(endpoint) })
    const sessionContext = '<openviking-context source="session-start">Session context</openviking-context>'
    const userText = "Recall the deployment preference"
    const output = {
      message: { sessionID: "oc-session-1", id: "msg-user-1" },
      parts: [
        { id: "session-context", type: "text", text: sessionContext, synthetic: true },
        { id: "user-text", type: "text", text: userText },
      ],
    }

    await recall.injectRelevantMemories({ sessionID: "oc-session-1", messageID: "msg-user-1" }, output)

    const recallRequests = requests.filter((request) => request.url === "/api/v1/search/recall")
    assert.equal(recallRequests.length, 1)
    assert.equal(JSON.parse(recallRequests[0].body).query, userText)
    assert.equal(output.parts[0].synthetic, true)
    assert.match(output.parts[0].text, /Remember the deployment preference/)
    assert.equal(output.parts[1].text, sessionContext)
    assert.equal(output.parts[2].text, userText)
  })
})

test("auto recall ignores non-synthetic OpenViking context", async () => {
  await withRecallServer(async ({ endpoint, requests }) => {
    const recall = createMemoryRecall({ config: recallConfig(endpoint) })
    const output = {
      parts: [
        { type: "text", text: "<openviking-context>Injected context</openviking-context>" },
        { type: "text", text: "Recall the deployment preference" },
      ],
    }

    await recall.injectRelevantMemories({ sessionID: "oc-session-2", messageID: "msg-user-2" }, output)

    assert.equal(requests.length, 0)
  })
})
