import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/core/auth";

const handler = (request: Request) => getAuth().handler(request);

export const { GET, POST } = toNextJsHandler(handler);
