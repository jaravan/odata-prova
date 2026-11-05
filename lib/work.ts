// How much work one request may do. Limits on a request's size or nesting don't bound this:
// each level of a replace multiplies its text, each lambda round a navigation cycle goes through
// the rows again, and each $expand of one reads them again, so a URL of a few hundred bytes can
// ask for more than the server can do, and a server does one request at a time (see queue.ts).
// So the work is counted as it's done, and the request stops being run when it has done too much.

import { HttpError } from "./query.ts";

// In steps of an expression, by far most of what a request does: a few seconds of them.
const MAX_WORK = 20_000_000;

let left = MAX_WORK;

// A new turn in the queue, whose task has all of it to spend
function startWork(): void {
  left = MAX_WORK;
}

function spend(steps = 1): void {
  left -= steps;
  if (left < 0)
    throw new HttpError(
      400,
      "The request takes too much work: ask for less at a time",
      "TooMuchWork",
    );
}

export { MAX_WORK, startWork, spend };
