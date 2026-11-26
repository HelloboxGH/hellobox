import "@/core/extensions";
import { receiveMessage } from "@/core/server/mx/handlers";

// The mail server posts each accepted message here, and answers the sender with our result.
export const POST = (request: Request) => receiveMessage(request);
