import "@/core/extensions";
import { postSession } from "@/core/server/support-api/sessions";

export const POST = (request: Request) => postSession(request);
