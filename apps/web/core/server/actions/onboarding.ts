import { getDb, user } from "@hellobox/db";
import { eq } from "drizzle-orm";
import { userAction } from "../builder";

export const completeOnboarding = userAction("/onboarding/complete").handler(async ({ ctx }) => {
  await getDb().update(user).set({ onboardedAt: new Date() }).where(eq(user.id, ctx.user.id));
  return { ok: true };
});

export const onboardingActions = {
  "/onboarding/complete": completeOnboarding,
};
