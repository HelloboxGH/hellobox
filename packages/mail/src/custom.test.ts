import { expect, test } from "bun:test";
import { customSpecProblems } from "./custom";

const spec = {
  version: 1,
  name: "Acme",
  send: { method: "POST", url: "https://<REGION>.acme.example/send", headers: { Authorization: "Bearer <API_KEY>" } },
};

test("asks for a value for each <NAME>, and keeps only the ones the spec uses", () => {
  expect(customSpecProblems(spec, { API_KEY: "k" })).toEqual({ problems: ["Enter a value for <REGION>"] });
  const checked = customSpecProblems(spec, { API_KEY: "k", REGION: "eu", OLD: "x" });
  expect("secrets" in checked && checked.secrets).toEqual({ REGION: "eu", API_KEY: "k" });
});

test("passes on the spec's own problems", () => {
  expect(customSpecProblems({ version: 2 }, {}).problems?.length).toBeGreaterThan(0);
});
