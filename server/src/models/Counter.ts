import { Schema, model } from 'mongoose';

/** Named, atomically incremented sequences (e.g. "complaint-2026"). Used for human-readable public IDs. */
const counterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, min: 0, default: 0 },
  },
  { versionKey: false },
);

export const Counter = model('Counter', counterSchema);

/** Returns the next value of the sequence, creating it on first use. Safe under concurrency. */
export async function nextSequence(name: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  return doc!.seq;
}
