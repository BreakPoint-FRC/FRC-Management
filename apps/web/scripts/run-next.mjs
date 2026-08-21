// Starts Next on WEB_PORT.
//
// The root .env is shared by every workspace, so the web app's port is
// WEB_PORT rather than PORT — a bare PORT would also be read by the API and
// both servers would try to bind the same one. Next only understands PORT and
// `-p`, so the translation happens here rather than in the npm script: npm
// scripts cannot expand `$WEB_PORT` on Windows.
//
// Usage: node scripts/run-next.mjs <dev|start>
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const command = process.argv[2];

if (command !== "dev" && command !== "start") {
  console.error(`run-next: expected "dev" or "start", got ${command ?? "nothing"}`);
  process.exit(1);
}

// PORT is still honoured as a fallback so a deployment that only sets PORT —
// the convention nearly every host uses — keeps working.
const port = process.env.WEB_PORT ?? process.env.PORT ?? "3000";

// Run the CLI's entry point with this Node binary rather than spawning a
// shell: no shell means no argument-escaping surprises, and no difference
// between `next` on POSIX and `next.cmd` on Windows.
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");

const child = spawn(process.execPath, [nextBin, command, "-p", port], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
