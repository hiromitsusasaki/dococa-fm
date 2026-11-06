import { VEC_DIMS } from "../../src/worker/db/items";

type Run = (model: string, input: { text: string[] }) => Promise<unknown>;

/** A Workers AI binding that answers with `run`; by default every text gets the same vector along the first axis. */
export function fakeAi(run?: Run): { AI: Ai; calls: Array<{ model: string; text: string[] }> } {
  const calls: Array<{ model: string; text: string[] }> = [];
  const answer: Run = run ?? (async (_m, input) => ({ shape: [input.text.length, VEC_DIMS], data: input.text.map(() => Array.from(axis(0))) }));
  const AI = {
    run: async (model: string, input: { text: string[] }) => {
      calls.push({ model, text: [...input.text] });
      return answer(model, input);
    },
  } as unknown as Ai;
  return { AI, calls };
}

/** A unit vector at `angle` radians from the first axis towards the second. */
export function angled(angle: number): Float32Array {
  const v = new Float32Array(VEC_DIMS);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

/** The unit vector along axis `i`. */
export function axis(i: number): Float32Array {
  const v = new Float32Array(VEC_DIMS);
  v[i] = 1;
  return v;
}
