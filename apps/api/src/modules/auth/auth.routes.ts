import type { FastifyInstance, FastifyReply } from "fastify";

import { UnauthorizedError } from "../../lib/http-errors";
import { REFRESH_COOKIE } from "../../plugins/auth";
import { changePasswordSchema, loginSchema } from "./auth.schema";
import { createAuthService } from "./auth.service";

/**
 * Mounted at /auth.
 *
 *   POST /auth/login     { email, password }              -> 200 { accessToken, account } | 400 | 401 | 429
 *   POST /auth/refresh   (refresh cookie)                 -> 200 { accessToken, account } | 401
 *   POST /auth/logout    (refresh cookie)                 -> 204
 *   GET  /auth/me                                         -> 200 { account, roles, groups, permissions } | 401
 *   POST /auth/password  { currentPassword, newPassword } -> 204 | 400 | 401
 *
 * Two tokens, on purpose. The access token is a short-lived JWT the client
 * sends in an Authorization header; the refresh token is a long-lived opaque
 * value in an httpOnly cookie that JavaScript cannot read. A stolen access
 * token expires on its own within minutes, and a stolen refresh token is
 * detectable because using it twice revokes the account's sessions.
 */
export async function authRoutes(app: FastifyInstance) {
  const service = createAuthService(app.prisma);

  // httpOnly so an XSS bug cannot read it; sameSite "none" because the web app
  // is on a different origin than the API, and "none" requires secure. In local
  // development over plain http that combination is rejected by the browser, so
  // there the cookie falls back to lax on the same site.
  const isProduction = process.env.NODE_ENV === "production";

  const setRefreshCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      path: "/auth",
      maxAge: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30) * 24 * 60 * 60,
    });
  };

  // -> 200 { accessToken, account } | 400 invalid body | 401 bad credentials
  app.post(
    "/login",
    {
      // Password guessing is the one thing this endpoint is for, so it is the
      // one endpoint that has to be rate limited. Keyed by IP, which is coarse
      // but is what is available before there is a session.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const input = loginSchema.parse(req.body);
      const account = await service.login(input.email, input.password);

      const refreshToken = await service.issueRefreshToken(account.id, req.headers["user-agent"]);
      setRefreshCookie(reply, refreshToken);

      return { accessToken: app.jwt.sign({ sub: account.id }), account };
    }
  );

  // -> 200 { accessToken, account } | 401 missing, expired, revoked or reused
  app.post("/refresh", async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedError("Oturum bulunamadi");

    const { token: rotated, account } = await service.rotateRefreshToken(
      token,
      req.headers["user-agent"]
    );
    setRefreshCookie(reply, rotated);

    return { accessToken: app.jwt.sign({ sub: account.id }), account };
  });

  // -> 204 always. Logging out is not a place to report that a token was
  // already invalid; the client wanted the session gone and it is gone.
  app.post("/logout", async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) await service.revokeRefreshToken(token);

    reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
    reply.code(204).send();
  });

  // -> 200 | 401
  app.get("/me", { preHandler: app.authenticate }, async (req) => service.profile(req.account.id));

  // -> 204 | 400 weak or unchanged password | 401 wrong current password
  app.post("/password", { preHandler: app.authenticate }, async (req, reply) => {
    const input = changePasswordSchema.parse(req.body);
    await service.changePassword(req.account.id, input);

    // Every session was just revoked, including this one's refresh token.
    reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
    reply.code(204).send();
  });
}
