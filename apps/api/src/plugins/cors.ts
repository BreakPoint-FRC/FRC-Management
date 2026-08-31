import cors from "@fastify/cors";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

export default fp(async (app: FastifyInstance) => {
  await app.register(cors, {
    // An exact origin rather than "*". Nothing here rides on a cookie any more
    // -- both tokens travel in bodies and headers -- so credentials stay off,
    // but naming the one origin allowed to call the API is worth keeping on its
    // own: it means a page on someone else's domain cannot read the responses.
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: false,
  });
});
