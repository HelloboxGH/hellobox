import "@/core/extensions";
import { setConversationStatus } from "@/core/server/support-api/read";

export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  setConversationStatus(request, (await params).id);
