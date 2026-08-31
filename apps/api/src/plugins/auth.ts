import { randomBytes } from "node:crypto";

import jwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ForbiddenError, UnauthorizedError } from "../lib/http-errors";

/** The account attached to an authenticated request. */
export interface AuthenticatedAccount {
  id: string;
  email: string;
  fullName: string;
  /**
   * The team this account acts inside, or null for a platform system admin.
   *
   * Every team-scoped service filters on it. It is read from the database on
   * each request rather than carried in the token, for the same reason
   * isActive is: a token outlives the fact it describes.
   */
  teamId: string | null;
  mustChangePassword: boolean;
}

/**
 * Routes an account still on a generated password may reach.
 *
 * Everything else is refused until the password is changed. The list is short
 * on purpose: read who you are, set a password, or leave. A temporary password
 * is a way in, not a credential, and an account that never changes it must not
 * be able to quietly keep working on one.
 */
const PASSWORD_CHANGE_ALLOWED = new Set(["/auth/me", "/auth/password", "/auth/logout"]);

export default fp(async (app: FastifyInstance) => {
  // A missing JWT_SECRET is refused at boot in server.ts, next to the
  // DATABASE_URL check and for the same reason: the plugin has to stay
  // registrable without an .env so the test suite can build the app. The
  // fallback is random per process, which makes tokens useless across restarts
  // -- fine for tests, and unreachable in production because the server exits
  // first.
  const secret = process.env.JWT_SECRET ?? randomBytes(32).toString("hex");

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
          teamId: true,
          mustChangePassword: true,
          isActive: true,
          archivedAt: true,
          team: { select: { isActive: true } },
        },
      });

      if (
        !account ||
        !account.isActive ||
        account.archivedAt !== null ||
        (account.team !== null && !account.team.isActive)
      ) {
        throw new UnauthorizedError("Hesap aktif degil");
      }

      request.account = {
        id: account.id,
        email: account.email,
        fullName: account.fullName,
        teamId: account.teamId,
        mustChangePassword: account.mustChangePassword,
      };

      // 403 rather than 401: the credential is valid, which is exactly why the
      // client must not react by asking for it again. The message is what the
      // web app matches on to send the user to the password screen.
      if (account.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(request.routeOptions.url ?? "")) {
        throw new ForbiddenError("Devam etmek icin sifrenizi degistirmelisiniz");
      }
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
