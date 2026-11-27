import extensionProxy from "@ext/proxy";
import { NextResponse } from "next/server";
import { signedInRedirect } from "@/core/server/signed-in";

export async function proxy(request: Request) {
  const early = await extensionProxy.before(request);
  if (early) return early;

  if (request.method !== "GET") return undefined;
  const url = new URL(request.url);
  const destination = await signedInRedirect(request, url);
  if (destination) return NextResponse.redirect(new URL(destination, url));
  const cookies = extensionProxy.cookies(request);
  if (cookies.length === 0) return undefined;
  const response = NextResponse.next();
  for (const { name, value, ...options } of cookies) response.cookies.set(name, value, options);
  return response;
}

export const config = {
  // Next caps the bodies of requests that go through here at 10 MB. Support messages carry
  // files, and the mail server SendGrid's Inbound Parse, MailerSend's inbound routes and Mailjet's Parse API post whole emails.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/support/|api/mx/|api/webhooks/sendgrid/|api/webhooks/mailersend/|api/webhooks/mailjet/).*)"],
};
