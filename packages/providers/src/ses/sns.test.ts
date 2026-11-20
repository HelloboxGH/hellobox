import { describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { stringToSign, verifySnsMessage, type SnsMessage } from "./sns";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const NOW = new Date("2026-11-08T10:00:00Z");

function signed(overrides: Partial<SnsMessage> = {}): SnsMessage {
  const message: SnsMessage = {
    Type: "Notification",
    MessageId: "m-1",
    TopicArn: "arn:aws:sns:eu-west-1:123456789012:hellobox-inbound",
    Message: JSON.stringify({ notificationType: "Received" }),
    Timestamp: NOW.toISOString(),
    SignatureVersion: "2",
    Signature: "",
    SigningCertURL: "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem",
    ...overrides,
  };
  const signer = createSign("RSA-SHA256");
  signer.update(stringToSign(message));
  return { ...message, Signature: signer.sign(privateKey, "base64"), ...overrides };
}

const options = { fetchCertificate: async () => pem, now: NOW };

describe("verifySnsMessage", () => {
  test("accepts a correctly signed message", async () => {
    const message = await verifySnsMessage(signed(), options);
    expect(message.MessageId).toBe("m-1");
  });

  test("rejects a tampered message", async () => {
    const message = { ...signed(), Message: "{}" };
    await expect(verifySnsMessage(message, options)).rejects.toThrow("Invalid signature");
  });

  test("rejects certificates that aren't from SNS", async () => {
    const message = signed({ SigningCertURL: "https://evil.example.com/cert.pem" });
    await expect(verifySnsMessage(message, options)).rejects.toThrow("isn't from SNS");
  });

  test("rejects old messages", async () => {
    const message = signed({ Timestamp: "2026-11-07T10:00:00Z" });
    await expect(verifySnsMessage(message, options)).rejects.toThrow("too old");
  });

  test("leaves out absent optional fields when signing", () => {
    expect(stringToSign(signed())).not.toContain("Subject");
  });
});
