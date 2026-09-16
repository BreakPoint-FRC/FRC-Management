import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-deploy-env.mjs", import.meta.url));
const validEnv = {
  POSTGRES_USER: "breakpoint_app",
  POSTGRES_PASSWORD: "0123456789abcdef0123456789abcdef",
  POSTGRES_DB: "breakpoint-prod_2026",
  JWT_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  WEB_ORIGIN: "https://frc1234.example",
  NEXT_PUBLIC_API_URL: "https://api.frc1234.example",
};

function run(overrides = {}) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, ...validEnv, ...overrides },
    encoding: "utf8",
  });
}

test("accepts the documented generated-secret and identifier format", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deploy preflight: ok/);
});

for (const password of [
  "change-me-before-deploying",
  "long-password-%40-literal",
  "long-password-@-literal",
  "long-password-:-literal",
  "long-password-/-literal",
  "long-password-?-literal",
  "long-password-#-literal",
]) {
  test(`rejects unsafe Postgres password ${JSON.stringify(password)}`, () => {
    const result = run({ POSTGRES_PASSWORD: password });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /POSTGRES_PASSWORD/);
  });
}

for (const user of ["break:point", "break%40point", "9breakpoint"]) {
  test(`rejects unsafe Postgres user ${JSON.stringify(user)}`, () => {
    const result = run({ POSTGRES_USER: user });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /POSTGRES_USER/);
  });
}

for (const database of ["break?point", "break#point", "break%2Fpoint", "/breakpoint"]) {
  test(`rejects unsafe Postgres database ${JSON.stringify(database)}`, () => {
    const result = run({ POSTGRES_DB: database });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /POSTGRES_DB/);
  });
}

for (const [name, value] of [
  ["WEB_ORIGIN", "https://frc1234.example/path"],
  ["WEB_ORIGIN", "https://frc1234.example/"],
  ["NEXT_PUBLIC_API_URL", "ftp://api.frc1234.example"],
  ["NEXT_PUBLIC_API_URL", "not-a-url"],
]) {
  test(`rejects non-origin ${name} ${JSON.stringify(value)}`, () => {
    const result = run({ [name]: value });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(name));
  });
}
