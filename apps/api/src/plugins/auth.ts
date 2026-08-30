import { randomBytes } from "node:crypto";

import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { UnauthorizedError } from "../lib/http-errors";

/**
 * Name of the refresh cookie. Short and unremarkable on purpose -- it says
 * nothing about the stack behind it.
 */
export const REFRESH_COOKIE = "bp_rt";

/** The account attached to an authenticated request. */
export interface AuthenticatedAccount {
  id: string;
  email: string;
  fullName: string;
}

export default fp(async (app: FastifyInstance) => {
  // A missing JWT_SECRET is refused at boot in server.ts, next to the
  // DATABASE_URL check and for the same reason: the plugin has to stay
  // registrable without an .env so the test suite can build the app. The
  // fallback is random per process, which makes tokens useless across restarts
  // -- fine for tests, and unreachable in production because the server exits
  // first.
  const secret = process.env.JWT_SECRET ?? randomBytes(32).toString("hex");

  await app.register(cookie);
  await app.register(jwt, {
    secret,
    sign: { expiresIn: process.env.JWT_ACCESS_TTL ?? "15m" },
  });

  /**
   * preHandler for every route that needs a signed-in account.
   *
   * Re-reads the account on each request rather than trusting the token's
   * claims. An access token lives for fifteen minutes; suspending someone has
   * to take effect now, not fifteen minutes from now.
   */
  app.decorate(
    "authenticate",
    // Takes only the request: failures are thrown, not written to the reply, so
    // the app error handler shapes every 401 the same way.
    async (request: FastifyRequest): Promise<void> => {
      try {
        await request.jwtVerify();
      } catch {
        throw new UnauthorizedError("Oturum acmaniz gerekiyor");
      }

      const accountId = (request.user as { sub?: unknown }).sub;
      if (typeof accountId !== "string") {
        throw new UnauthorizedError("Gecersiz oturum");
      }

      const account = await app.prisma.account.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          email: true,
          fullName: true,
          isActive: true,
          archivedAt: true,
        },
      });

      if (!account || !account.isActive || account.archivedAt !== null) {
        throw new UnauthorizedError("Hesap aktif degil");
      }

      request.account = {
        id: account.id,
        email: account.email,
        fullName: account.fullName,
      };
    }
  );
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    // Set by `authenticate`. Reading it in a route that is not behind that
    // preHandler is a bug, which is why it is not optional -- the type says the
    // route is authenticated, and the preHandler is what makes that true.
    account: AuthenticatedAccount;
  }
}
