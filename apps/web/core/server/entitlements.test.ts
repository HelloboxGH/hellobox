import { beforeEach, describe, expect, test } from "bun:test";
import { type Entitlements, install, resetExtensions, UNLIMITED } from "@hellobox/extensions";
import { entitlements, fullWorkspaceError, requireFeature, requireRoom, roomError } from "./entitlements";

const small: Entitlements = {
  plan: "small",
  limits: { ...UNLIMITED.limits, members: 3 },
  features: { team: false, roles: false, instantEmail: false },
  prompts: true,
};
const ctx = (e: Entitlements) => ({ role: "owner", entitlements: e });

// A stand-in for cloud's billing slot: it only says what was refused.
const billing = {
  entitlements: async () => small,
  denied: (_ctx: object, refusal: object) => Object.assign(new Error("denied"), { refusal }),
};

const refusalOf = (run: () => void) => {
  try {
    run();
  } catch (error) {
    return (error as { refusal?: object; message: string }).refusal ?? error;
  }
  return null;
};

beforeEach(resetExtensions);

describe("with a billing slot", () => {
  beforeEach(() => install({ billing }));

  test("entitlements come from the slot", async () => {
    expect(await entitlements("w1")).toBe(small);
  });

  test("requireFeature refuses a feature that is off, through the slot", () => {
    expect(refusalOf(() => requireFeature(ctx(small), "team", "teammates", "Needs a paid plan"))).toEqual({
      feature: "team",
      featureName: "teammates",
      message: "Needs a paid plan",
    });
    expect(refusalOf(() => requireFeature(ctx({ ...small, features: { ...small.features, team: true } }), "team", "x", "m"))).toBeNull();
  });

  test("requireRoom lets the last place in and refuses the next", () => {
    expect(refusalOf(() => requireRoom(ctx(small), "members", 2, "Full"))).toBeNull();
    expect(refusalOf(() => requireRoom(ctx(small), "members", 3, "Full"))).toEqual({
      limit: "members",
      current: 3,
      max: 3,
      needed: 4,
      message: "Full",
    });
    // A bigger ask than one more, like an import.
    expect(refusalOf(() => requireRoom(ctx(small), "members", 1, "Full", 5))).toMatchObject({ needed: 5 });
  });

  test("roomError and fullWorkspaceError build the slot's errors", () => {
    expect(roomError(ctx(small), "domains", 4, "No room")).toMatchObject({ refusal: { limit: "domains", current: 4, needed: 5 } });
    expect(fullWorkspaceError("Full")).toMatchObject({ refusal: { verbatim: true, message: "Full" } });
  });
});

describe("without a billing slot", () => {
  beforeEach(() => install({}));

  test("everything is allowed", async () => {
    expect(await entitlements("w1")).toBe(UNLIMITED);
    expect(refusalOf(() => requireFeature(ctx(UNLIMITED), "roles", "roles", "m"))).toBeNull();
    expect(refusalOf(() => requireRoom(ctx(UNLIMITED), "storageBytes", 10 ** 15, "m"))).toBeNull();
    expect(refusalOf(() => requireRoom(ctx(UNLIMITED), "domains", 10_000, "m"))).toBeNull();
  });
});
