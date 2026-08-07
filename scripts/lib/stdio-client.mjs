// A minimal JSON-RPC-over-stdio client, used to drive a server the way Claude
// Desktop does: spawn the process, write newline-framed messages to its stdin,
// read newline-framed replies off its stdout.
//
// It exists because stdio is the transport nothing else can reach. The Worker
// tests import the dispatch layer directly and the smoke test speaks HTTP, so
// before this file the stdio path and the npm tarball built around it shipped
// without ever being executed.
//
// Replies are matched by JSON-RPC id rather than by arrival order, because the
// spec permits a server to answer out of order and a test that silently depends
// on ordering would be asserting something the protocol does not promise.

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;

export function openStdioServer(command, args, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...spawnOptions } = options;
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...spawnOptions });

  const pending = new Map();
  const lines = [];
  let stderr = "";
  let buffer = "";
  let exitCode = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      lines.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Recorded in `lines` so a test can still assert on the garbage.
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const failAllPending = (err) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    pending.clear();
  };

  child.on("error", (err) => failAllPending(err));
  child.on("exit", (code, signal) => {
    exitCode = code ?? signal;
    failAllPending(
      new Error(`server exited (${exitCode}) with a reply still outstanding. stderr:\n${stderr}`),
    );
  });

  const writeRaw = (text) =>
    new Promise((resolve, reject) => {
      if (exitCode !== null) {
        reject(new Error(`server already exited (${exitCode}). stderr:\n${stderr}`));
        return;
      }
      child.stdin.write(text, (err) => (err ? reject(err) : resolve()));
    });

  // Wait for the reply to an id without sending anything. Needed to test raw
  // framing, where the message goes out through writeRaw rather than through
  // request().
  const awaitReply = (id, label = "") =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for a reply to id ${id} ` +
              `${label}. stderr:\n${stderr}`,
          ),
        );
      }, timeoutMs);
      // Do not hold the event loop open on the timer alone.
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
    });

  return {
    child,
    lines,
    stderr: () => stderr,
    writeRaw,
    awaitReply,

    // Send a message carrying an id and wait for the reply with that id.
    async request(message) {
      const reply = awaitReply(message.id, `(${message.method})`);
      await writeRaw(JSON.stringify(message) + "\n");
      return reply;
    },

    // Send a message that must not be answered. Nothing is awaited here: use
    // `request` afterwards to prove the server kept going.
    notify(message) {
      return writeRaw(JSON.stringify(message) + "\n");
    },

    async close() {
      if (exitCode !== null) return exitCode;
      child.stdin.end();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
        timer.unref?.();
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve(code ?? signal);
        });
      });
    },
  };
}

// A server is well behaved if it answers `initialize` and `tools/list`, and if
// every tool named in tools/list can be called. Shared by the stdio test and the
// tarball check so both prove the same thing about the artifact they hold.
export async function exerciseServer(client, { examplesByTool = new Map(), log = () => {} } = {}) {
  const init = await client.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const serverInfo = init?.result?.serverInfo;
  if (!serverInfo?.name) throw new Error("initialize returned no serverInfo");
  log(`initialize: ${serverInfo.name} v${serverInfo.version}`);

  const list = await client.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = list?.result?.tools ?? [];
  if (tools.length === 0) throw new Error("tools/list returned no tools");
  log(`tools/list: ${tools.length} tools`);

  let id = 3;
  const called = [];
  for (const tool of tools) {
    const example = examplesByTool.get(tool.name);
    if (!example) throw new Error(`no example available for ${tool.name}, so it cannot be called`);
    const res = await client.request({
      jsonrpc: "2.0",
      id: id++,
      method: "tools/call",
      params: { name: tool.name, arguments: example.args },
    });
    if (res?.result?.isError) {
      throw new Error(`${tool.name} returned an error: ${res.result.content?.[0]?.text}`);
    }
    if (!res?.result?.content?.[0]) throw new Error(`${tool.name} returned no content`);
    called.push({ tool: tool.name, result: res.result });
    log(`tools/call: ${tool.name}`);
  }

  return { serverInfo, tools, called };
}
