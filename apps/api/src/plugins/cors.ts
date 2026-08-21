import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export default fp(async (app: FastifyInstance) => {
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  });
});
