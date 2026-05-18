#!/usr/bin/env node
// Minimal MCP server for integration tests. Implements only what the
// MCPManager calls: initialize, tools/list, tools/call (with one tool).
// JSON-RPC 2.0 over stdio; one message per line (newline-delimited).
//
// This is NOT a production MCP server — no real protocol nuance, no
// resources/prompts/sampling, no notifications. It's enough to prove
// the manager handshake + tool routing works.

import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") {
    return; // notifications get no response
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo back the input text. Used for MCP integration tests.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `echo: ${args.text ?? ""}` }] },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `unknown tool ${name}` },
      });
    }
    return;
  }
  // Unknown method — generic JSON-RPC error
  if (msg.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `method ${msg.method} not implemented` },
    });
  }
});
