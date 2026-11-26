import "@/core/extensions";
import { listConversations } from "@/core/server/support-api/read";

export const GET = (request: Request) => listConversations(request);
