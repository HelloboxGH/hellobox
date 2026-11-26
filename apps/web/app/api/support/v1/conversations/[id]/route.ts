import "@/core/extensions";
import { getConversation } from "@/core/server/support-api/read";

export const GET = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  getConversation(request, (await params).id);
