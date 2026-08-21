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
