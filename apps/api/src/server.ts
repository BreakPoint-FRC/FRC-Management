import { buildApp } from "./app";

// Checked here rather than in @breakpoint/db so the package stays importable
// without a database (the test suite builds the app with no .env loaded).
if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Copy .env.example to .env for local development, " +
      "or set it in the environment before starting the server."
  );
  process.exit(1);
}

// Checked here for the same reason: plugins/auth has to stay registrable
// without an .env so the test suite can build the app, and it falls back to a
// random per-process secret when this is unset. That fallback must never be
// what a real deployment runs on -- tokens would silently stop working on every
// restart -- so the server refuses to start instead.
if (!process.env.JWT_SECRET) {
  console.error(
    "JWT_SECRET is not set. Generate one with `openssl rand -hex 32` and add it " +
      "to .env before starting the server."
  );
  process.exit(1);
}

const app = buildApp();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    try {
      // Runs the onClose hook, which disconnects Prisma.
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
}

app
  // API_PORT, not PORT: the root .env is shared by every workspace, and a bare
  // PORT would also be picked up by `next dev` and bind the web app here too.
  .listen({ port: Number(process.env.API_PORT ?? 4000), host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
