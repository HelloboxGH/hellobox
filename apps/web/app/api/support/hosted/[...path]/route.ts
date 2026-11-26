import "@/core/extensions";
import { hosted } from "@/core/server/support-api/hosted";

type Context = { params: Promise<{ path: string[] }> };

// The hosted page's own calls. Same origin only: no CORS, and the session is a header.
export const GET = async (request: Request, { params }: Context) => hosted(request, (await params).path);
export const POST = async (request: Request, { params }: Context) => hosted(request, (await params).path);
