import { cleanLine, cleanText, type SupportMessage } from "@hellobox/mail";
import { z } from "zod";
import { SupportError } from "./http";

const MAX_METADATA_BYTES = 4 * 1024;

const id = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}\p{Cs}]+$/u, "Use printable characters only");
const line = (max: number) => z.string().max(max).transform(cleanLine);
const metadataText = z.string().transform(cleanText);

const metadata = z
  .record(z.string().min(1).max(100).transform(cleanLine), z.union([metadataText, z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 20, "Use up to 20 keys")
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_METADATA_BYTES, "Keep it under 4 KB");

export const userSchema = z.object({
  id: id(200).optional(),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  name: line(200).optional(),
});

export const messageSchema = z
  .object({
    user: userSchema,
    text: z
      .string()
      .max(50_000)
      .transform(cleanText)
      .refine((value) => value.trim().length > 0, "Write a message"),
    subject: line(200).optional(),
    conversationId: id(100).optional(),
    idempotencyKey: id(200),
    metadata: metadata.optional(),
  })
  .refine((value) => !value.conversationId || value.user.id, {
    path: ["conversationId"],
    message: "Continuing a conversation needs user.id",
  });

/** Parses and checks JSON, with an error a developer can act on. */
export function parseJson<T>(schema: z.ZodType<T>, text: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SupportError(400, "invalid_request", "The body isn't valid JSON");
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const [issue] = result.error.issues;
  const path = issue?.path.join(".");
  throw new SupportError(400, "invalid_request", `${path ? `${path}: ` : ""}${issue?.message ?? "Invalid request"}`);
}

export const parseMessage = (text: string): SupportMessage => {
  const { user, subject, ...rest } = parseJson(messageSchema, text);
  return { ...rest, user: { ...user, name: user.name || undefined }, subject: subject || undefined };
};
