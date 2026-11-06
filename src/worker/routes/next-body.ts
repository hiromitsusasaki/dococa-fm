import { z } from "zod";

const nextBody = z.object({
  dial: z.number().min(0).max(1).optional(),
  first: z.boolean().optional(),
  letterId: z.string().min(1).max(100).optional(),
});
export type NextBody = z.infer<typeof nextBody>;

/**
 * The body of a "next" request (`{ dial?, first?, letterId? }`, JSON). No body, or one that is not JSON (a form post),
 * is `{}`; JSON of the wrong shape is null, which the route answers with 400.
 */
export async function readNextBody(req: Request): Promise<NextBody | null> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.trim() === "" ? null : JSON.parse(text);
  } catch {
    return {};
  }
  if (raw === null) return {};
  const parsed = nextBody.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
