import "@/core/extensions";
import { getAttachment } from "@/core/server/support-api/read";

export const GET = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  getAttachment(request, (await params).id);
