import { getEnv } from "@hellobox/config";
import { unsubscribeWithToken } from "@hellobox/mail";

// Both mail apps' one-click requests and the confirm button on the page land here.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await unsubscribeWithToken(token);
  const fromPage = request.headers.get("content-type")?.includes("application/x-www-form-urlencoded") &&
    !(await request.clone().text()).includes("List-Unsubscribe=One-Click");
  if (fromPage) {
    const page = `${getEnv().APP_URL.replace(/\/$/, "")}/unsubscribe/${encodeURIComponent(token)}`;
    return Response.redirect(result ? `${page}?done=1` : page, 303);
  }
  return new Response(null, { status: result ? 200 : 404 });
}
