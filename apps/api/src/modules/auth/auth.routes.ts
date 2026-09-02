import type { FastifyInstance } from "fastify";

import { changePasswordSchema, loginSchema, refreshSchema } from "./auth.schema";
import { createAuthService } from "./auth.service";

/**
 * Mounted at /auth.
 *
 *   POST /auth/login     { email, password }              -> 200 { accessToken, refreshToken, account } | 400 | 401 | 429
 *   POST /auth/refresh   { refreshToken }                 -> 200 { accessToken, refreshToken, account } | 400 | 401
 *   POST /auth/logout    { refreshToken? }                -> 204
 *   GET  /auth/me                                         -> 200 { account, roles, groups, permissions } | 401
 *   POST /auth/password  { currentPassword, newPassword } -> 204 | 400 | 401
 *
 * Two tokens, on purpose. The access token is a short-lived JWT the client
 * sends in an Authorization header; the refresh token is a long-lived opaque
 * value that buys a new one. A stolen access token expires on its own within
 * minutes, and a stolen refresh token is detectable because using it twice
 * revokes the account's sessions.
 *
 * Both are handed to the client in the response body and neither is stored on
 * the device -- see the client's api-client.ts for why. This app deliberately
 * keeps nothing on disk, so there is no cookie to set and no session to
 * restore: closing the tab ends it. That costs a sign-in per visit and is the
 * whole point; do not "fix" it by adding a cookie back.
 */
export async function authRoutes(app: FastifyInstance) {
  const service = createAuthService(app.prisma);

  // -> 200 { accessToken, refreshToken, account } | 400 invalid body | 401 bad credentials
  app.post(
    "/login",
    {
      // Password guessing is the one thing this endpoint is for, so it is the
      // one endpoint that has to be rate limited. Keyed by IP, which is coarse
      // but is what is available before there is a session.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      const input = loginSchema.parse(req.body);
      const account = await service.login(input.email, input.password);

      const refreshToken = await service.issueRefreshToken(account.id, req.headers["user-agent"]);

      return { accessToken: app.jwt.sign({ sub: account.id }), refreshToken, account };
    }
  );

  // -> 200 { accessToken, refreshToken, account } | 400 missing | 401 expired, revoked or reused
  app.post("/refresh", async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);

    const { token: rotated, account } = await service.rotateRefreshToken(
      refreshToken,
      req.headers["user-agent"]
    );

    return { accessToken: app.jwt.sign({ sub: account.id }), refreshToken: rotated, account };
  });

  // -> 204 always. Logging out is not a place to report that a token was
  // already invalid; the client wanted the session gone and it is gone. A
  // client that never got a token, or lost it to a reload, still passes here.
  app.post("/logout", async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (parsed.success) await service.revokeRefreshToken(parsed.data.refreshToken);

    reply.code(204).send();
  });

  // -> 200 | 401
  app.get("/me", { preHandler: app.authenticate }, async (req) => service.profile(req.account.id));

  // -> 204 | 400 weak or unchanged password | 401 wrong current password
  app.post("/password", { preHandler: app.authenticate }, async (req, reply) => {
    const input = changePasswordSchema.parse(req.body);
    await service.changePassword(req.account.id, input);

    // Every session was just revoked server-side, including this one's refresh
    // token; the client drops its copy when the next refresh is refused.
    reply.code(204).send();
  });
}
