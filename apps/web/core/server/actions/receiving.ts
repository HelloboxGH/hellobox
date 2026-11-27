import {
  addHelloboxTxtToCloudflare,
  cloudflareStatus,
  confirmHelloboxReceiving,
  pointMxToHellobox,
  removeHelloboxMxFromCloudflare,
  ReceivingError,
  startHelloboxReceiving,
  stopHelloboxReceiving,
} from "@hellobox/mail";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";

// Receiving a domain's mail with HelloBox's own mail server instead of the provider. DNS
// control is proven with a TXT record first, so the server knows the domain before its MX
// record moves. See packages/mail/src/mx.ts. Agents don't get these.
const explained = async <T>(run: () => Promise<T>) => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ReceivingError) throw badRequest(error.message);
    throw error;
  }
};

export const startReceiving = adminAction("/domains/receiving/start")
  .input(z.object({ domainId: z.string() }))
  .handler(({ input, ctx }) =>
    explained(async () => {
      const setup = await startHelloboxReceiving(ctx.workspace.id, input.domainId);
      return { ...setup, cloudflare: await cloudflareStatus(ctx.workspace.id, setup.mx.name) };
    }),
  );

export const confirmReceiving = adminAction("/domains/receiving/confirm")
  .input(z.object({ domainId: z.string() }))
  .handler(async ({ input, ctx }) => ({ on: await explained(() => confirmHelloboxReceiving(ctx.workspace.id, input.domainId)) }));

export const stopReceiving = adminAction("/domains/receiving/stop")
  .input(z.object({ domainId: z.string() }))
  .handler(async ({ input, ctx }) => {
    await explained(() => stopHelloboxReceiving(ctx.workspace.id, input.domainId));
    return { ok: true };
  });

// The same records written to Cloudflare, when the workspace connected it. Failures come back
// as a message, and the records can still be added by hand.
export const receivingCloudflareTxt = adminAction("/domains/receiving/cloudflare-txt")
  .input(z.object({ domainId: z.string() }))
  .handler(({ input, ctx }) => explained(() => addHelloboxTxtToCloudflare(ctx.workspace.id, input.domainId)));

// Without replace, other MX records on the name are only reported, never touched.
export const receivingCloudflareMx = adminAction("/domains/receiving/cloudflare-mx")
  .input(z.object({ domainId: z.string(), replace: z.boolean().optional() }))
  .handler(({ input, ctx }) => explained(() => pointMxToHellobox(ctx.workspace.id, input.domainId, input.replace ?? false)));

export const receivingCloudflareRemoveMx = adminAction("/domains/receiving/cloudflare-remove-mx")
  .input(z.object({ domainId: z.string() }))
  .handler(({ input, ctx }) => explained(() => removeHelloboxMxFromCloudflare(ctx.workspace.id, input.domainId)));

export const receivingActions = {
  "/domains/receiving/cloudflare-txt": receivingCloudflareTxt,
  "/domains/receiving/cloudflare-mx": receivingCloudflareMx,
  "/domains/receiving/cloudflare-remove-mx": receivingCloudflareRemoveMx,
  "/domains/receiving/start": startReceiving,
  "/domains/receiving/confirm": confirmReceiving,
  "/domains/receiving/stop": stopReceiving,
};
