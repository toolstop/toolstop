// stdio transport, sharing the same dispatch as the Worker.
//
// Kept for local use and Claude Desktop, but note: stdio traffic is invisible to
// us by design: it runs on the user's machine and we deliberately do not phone
// home. Remote HTTP is the observable path and the one the directories accept.

import { dispatch } from "./http.mjs";

export async function runStdio(server) {
  const meta = { transport: "stdio" };
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      // env is undefined on stdio, so recordEvent is a no-op.
      const response = await dispatch({ message, server, env: undefined, meta });
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    }
  });

  process.stdin.on("end", () => process.exit(0));
}
