// How much work one request may do. Limits on a request's size or nesting don't bound this:
// each level of a replace multiplies its text, each lambda round a navigation cycle goes through
// the rows again, and each $expand of one reads them again, so a URL of a few hundred bytes can
// ask for more than the server can do, and a server does one request at a time (see queue.ts).
// So the work is counted as it's done, and the request stops being run when it has done too much.

import { HttpError } from "./query.ts";

// In steps of an expression, by far most of what a request does: a few seconds of them.
const MAX_WORK = 20_000_000;

// How much a $batch's responses may come to, in characters. They're all in memory until the
// last part is done, and a read that costs little work can be repeated in a few bytes.
const MAX_RESPONSE = 64 * 1024 * 1024;

let left = MAX_WORK;

// A new turn in the queue, whose task has all of it to spend
function startWork(): void {
  left = MAX_WORK;
}

const tooMuch = () =>
  new HttpError(
    400,
    "The request takes too much work: ask for less at a time",
    "TooMuchWork",
  );

function spend(steps = 1): void {
  left -= steps;
  if (left < 0) throw tooMuch();
}

// A response as text. V8's strings end at about 512 MB, where JSON.stringify gives up.
function responseText(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch (e) {
    if (e instanceof RangeError) throw tooMuch();
    throw e;
  }
}

// Reading a row, for what isn't an expression: a search's or a group's. Steps of an expression
// are far cheaper, and at one step a row these took half a minute to be stopped.
const ROW_READ = 10;

// Sorting n rows by k terms: the comparisons it takes
const sortWork = (n: number, k = 1) => Math.ceil(n * Math.log2(n + 1) * k);

export {
  MAX_WORK,
  MAX_RESPONSE,
  ROW_READ,
  startWork,
  spend,
  sortWork,
  responseText,
  tooMuch,
};
