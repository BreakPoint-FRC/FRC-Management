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
    // @fastify/cors otherwise defaults to GET, HEAD and POST. The web app is
    // served from a different origin than the API and uses PUT/PATCH/DELETE
    // for ordinary edits, so browsers preflight those requests. Without this
    // explicit list the preflight succeeds with a 204 but advertises no
    // permission for the requested method; the browser then blocks the real
    // request before it reaches Fastify and fetch misleadingly looks offline.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
});
