import { afterEach, describe, expect, test } from "bun:test";
import { getStorageEnv, isStorageConfigured } from "./index";

const KEYS = [
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
  "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_PUBLIC_ENDPOINT", "S3_REGION", "S3_FORCE_PATH_STYLE",
];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function setEnv(values: Record<string, string>) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

// getStorageEnv caches its first answer, so each case reads the schema through a fresh import.
async function read() {
  const mod = await import(`./index?${Math.random()}`);
  return mod.getStorageEnv() as ReturnType<typeof getStorageEnv>;
}

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("storage settings", () => {
  test("R2 variables still give the R2 endpoint", async () => {
    setEnv({ R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "mail" });
    expect(isStorageConfigured()).toBe(true);
    expect(await read()).toEqual({
      kind: "r2", bucket: "mail", accessKeyId: "id", secretAccessKey: "secret", region: "auto",
      endpoint: "https://acct.r2.cloudflarestorage.com", forcePathStyle: false,
    });
  });

  test("an S3 endpoint uses path-style links unless told otherwise", async () => {
    setEnv({ S3_BUCKET: "hellobox", S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", S3_ENDPOINT: "http://minio:9000", S3_PUBLIC_ENDPOINT: "https://files.example.com" });
    const env = await read();
    expect(env.kind).toBe("s3");
    expect(env.endpoint).toBe("http://minio:9000");
    expect(env.publicEndpoint).toBe("https://files.example.com");
    expect(env.forcePathStyle).toBe(true);
    expect(env.region).toBe("us-east-1");
  });

  test("AWS S3 needs no endpoint, and empty variables count as unset", async () => {
    setEnv({ S3_BUCKET: "hellobox", S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", S3_ENDPOINT: "", S3_PUBLIC_ENDPOINT: "", S3_REGION: "eu-west-1", S3_FORCE_PATH_STYLE: "" });
    const env = await read();
    expect(env.endpoint).toBeUndefined();
    expect(env.forcePathStyle).toBe(false);
    expect(env.region).toBe("eu-west-1");
  });

  test("S3 wins over R2, and incomplete settings are not configured", async () => {
    setEnv({ S3_BUCKET: "a", S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "b" });
    expect((await read()).bucket).toBe("a");
    setEnv({ S3_BUCKET: "a" });
    expect(isStorageConfigured()).toBe(false);
    expect(read()).rejects.toThrow("Object storage isn't set up");
    setEnv({});
    expect(isStorageConfigured()).toBe(false);
  });
});
