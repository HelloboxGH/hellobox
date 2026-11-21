import { describe, expect, test } from "bun:test";
import { mayCreateAccount, signupsClosed } from "./signups";

const invited = (...addresses: string[]) => async (address: string) => addresses.includes(address);

describe("closed sign-ups", () => {
  test("only ALLOW_SIGNUPS=false closes them", () => {
    expect(signupsClosed(undefined)).toBe(false);
    expect(signupsClosed("")).toBe(false);
    expect(signupsClosed("true")).toBe(false);
    expect(signupsClosed("false")).toBe(true);
    expect(signupsClosed(" False ")).toBe(true);
  });

  test("open sign-ups let anyone in", async () => {
    expect(await mayCreateAccount("a@example.com", invited(), { closed: false })).toBe(true);
  });

  test("closed sign-ups let in admins and invited people, in any case", async () => {
    const options = { closed: true, admins: ["boss@example.com"] };
    expect(await mayCreateAccount("Boss@Example.com", invited(), options)).toBe(true);
    expect(await mayCreateAccount(" Friend@example.com ", invited("friend@example.com"), options)).toBe(true);
  });

  test("closed sign-ups turn everyone else away", async () => {
    expect(await mayCreateAccount("stranger@example.com", invited("friend@example.com"), { closed: true, admins: [] })).toBe(false);
  });
});
