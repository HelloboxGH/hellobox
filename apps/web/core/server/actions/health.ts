import { action } from "nezt";

export const health = action({
  path: "/health",
  method: "GET",
  handler: async () => ({ status: "ok" }),
});
