import cors from "@fastify/cors";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

export default fp(async (app: FastifyInstance) => {
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    // The refresh token is an httpOnly cookie and the web app is on a different
    // origin, so the browser only sends it when both sides opt in: this flag
    // here, and `credentials: "include"` on the fetch. A wildcard origin is not
    // allowed together with credentials, which is why WEB_ORIGIN is an exact
    // origin rather than "*".
    credentials: true,
  });
});
