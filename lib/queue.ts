// Requests one at a time. A request runs to its end without yielding, until its commit is
// saved: persistence is async, and while it saves, another request would see, and build on,
// changes that may yet be rolled back (see Store.settle). So each request waits for the one
// before it, its save included. Reads wait too: a GET can write (a function with a rule).
// One queue per store, shared by the services that serve it.

// How a backend several servers share runs a task (see sharedTurn in persistence.ts): caught up
// with what the others saved first. writes: whether the task may write.
type Turn = <T>(task: () => T | Promise<T>, writes: boolean) => Promise<T>;

class Queue {
  private ready: Promise<unknown>;
  private tail: Promise<unknown>;
  private turn: Turn | undefined;

  // ready: what has to happen before the first task (loading the saved state). Every task
  // waits for it, and fails with its error if it failed.
  constructor(ready: Promise<unknown> = Promise.resolve(), turn?: Turn) {
    this.ready = ready;
    this.tail = ready.catch(() => undefined);
    this.turn = turn;
  }

  // Runs task once every task before it has settled, and settles as it does. A failing task
  // fails its own caller only: the next one still runs. writes: false for a task that isn't
  // expected to write (a GET), which a shared backend runs without holding the others off.
  run<T>(task: () => T | Promise<T>, writes = true): Promise<T> {
    const result = this.tail
      .then(() => this.ready)
      .then(() => (this.turn ? this.turn(task, writes) : task()));
    this.tail = result.catch(() => undefined);
    return result;
  }

  // Settles once every task so far has
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}

export { Queue };
export type { Turn };
