import {
  checkTakeover,
  DomainClaimError,
  keepDomain,
  requestDomainAccess,
  startTakeover,
  withdrawTakeover,
} from "@hellobox/mail";
import { badRequest } from "nezt";
import { z } from "zod";
import { adminAction } from "../builder";

// Claiming a domain another workspace has on, and asking that workspace for access. See
// packages/mail/src/takeovers.ts for the rules. Agents don't get these.
const explained = async <T>(run: () => Promise<T>) => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DomainClaimError) throw badRequest(error.message);
    throw error;
  }
};

export const startDomainClaim = adminAction("/domains/claim/start")
  .input(z.object({ domainId: z.string() }))
  .handler(({ input, ctx }) =>
    explained(() => startTakeover({ workspaceId: ctx.workspace.id, domainId: input.domainId, userId: ctx.user.id })),
  );

export const checkDomainClaim = adminAction("/domains/claim/check")
  .input(z.object({ id: z.string() }))
  .handler(({ input, ctx }) => explained(() => checkTakeover({ workspaceId: ctx.workspace.id, takeoverId: input.id })));

export const withdrawDomainClaim = adminAction("/domains/claim/withdraw")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    await explained(() => withdrawTakeover({ workspaceId: ctx.workspace.id, takeoverId: input.id, userId: ctx.user.id }));
    return { ok: true };
  });

// The holder's side: an admin keeps a domain someone is claiming.
export const keepClaimedDomain = adminAction("/domains/claim/keep")
  .input(z.object({ id: z.string() }))
  .handler(async ({ input, ctx }) => {
    await explained(() => keepDomain({ workspaceId: ctx.workspace.id, takeoverId: input.id, userId: ctx.user.id }));
    return { ok: true };
  });

export const requestAccessToDomain = adminAction("/domains/request-access")
  .input(z.object({ domainId: z.string() }))
  .handler(async ({ input, ctx }) => {
    await explained(() => requestDomainAccess({ workspaceId: ctx.workspace.id, domainId: input.domainId, userId: ctx.user.id }));
    return { ok: true };
  });

export const domainClaimActions = {
  "/domains/claim/start": startDomainClaim,
  "/domains/claim/check": checkDomainClaim,
  "/domains/claim/withdraw": withdrawDomainClaim,
  "/domains/claim/keep": keepClaimedDomain,
  "/domains/request-access": requestAccessToDomain,
};
