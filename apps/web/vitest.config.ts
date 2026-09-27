import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors tsconfig.json's "@/*": ["./*"], which Next.js's own bundler
  // already resolves -- vitest does not read tsconfig paths on its own, so
  // any test that pulls in a module using this alias (hooks/use-api.ts's own
  // "@/lib/api-client" import, for one) fails to resolve without this.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { exclude: [...configDefaults.exclude, "e2e/**"] },
});
