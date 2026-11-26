import "@/core/extensions";
import { postMessage } from "@/core/server/support-api/messages";

// A developer's server posts its customers' messages here.
export const POST = (request: Request) => postMessage(request);
