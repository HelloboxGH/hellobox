import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { action } from "../src";

const post = () => {
  const body = new FormData();
  body.append("name", "Ada");
  return new Request("http://x/", { method: "POST", body });
};

describe("forms", () => {
  test("are read by an action that asks for one", async () => {
    const save = action({ input: { formData: z.instanceof(FormData) }, handler: ({ input }) => ({ name: input.formData.get("name") }) });
    const response = await save.toRouteHandler()(post());
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("Ada");
  });
  test("aren't read by any other", async () => {
    let ran = false;
    const save = action({ input: z.object({ name: z.string() }), handler: () => { ran = true; } });
    const request = post();
    expect((await save.toRouteHandler()(request)).status).toBe(400);
    expect(ran).toBe(false);
    expect(request.bodyUsed).toBe(false);
  });
});
