import {
  confirmHelloboxReceiving,
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
  .handler(({ input, ctx }) => explained(() => startHelloboxReceiving(ctx.workspace.id, input.domainId)));

export const confirmReceiving = adminAction("/domains/receiving/confirm")
  .input(z.object({ domainId: z.string() }))
  .handler(async ({ input, ctx }) => ({ on: await explained(() => confirmHelloboxReceiving(ctx.workspace.id, input.domainId)) }));

export const stopReceiving = adminAction("/domains/receiving/stop")
  .input(z.object({ domainId: z.string() }))
  .handler(async ({ input, ctx }) => {
    await explained(() => stopHelloboxReceiving(ctx.workspace.id, input.domainId));
    return { ok: true };
  });

export const receivingActions = {
  "/domains/receiving/start": startReceiving,
  "/domains/receiving/confirm": confirmReceiving,
  "/domains/receiving/stop": stopReceiving,
};
