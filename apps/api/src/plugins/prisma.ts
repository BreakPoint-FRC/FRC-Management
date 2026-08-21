import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { prisma as defaultPrisma, type PrismaClient } from "@breakpoint/db";

export interface PrismaPluginOptions {
  // Lets tests supply a stub; production uses the shared singleton.
  prisma?: PrismaClient;
}

export default fp<PrismaPluginOptions>(
  async (app: FastifyInstance, opts: PrismaPluginOptions) => {
    const client = opts.prisma ?? defaultPrisma;

    app.decorate("prisma", client);

    app.addHook("onClose", async () => {
      await client.$disconnect();
    });
  }
);

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
