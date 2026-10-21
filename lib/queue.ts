// Requests one at a time. A request runs to its end without yielding, until its commit is
// saved: persistence is async, and while it saves, another request would see, and build on,
// changes that may yet be rolled back (see Store.settle). So each request waits for the one
// before it, its save included. Reads wait too: a GET can write (a function with a rule).
// One queue per store, shared by the services that serve it.

class Queue {
  private tail: Promise<unknown> = Promise.resolve();

  // Runs task once every task before it has settled, and settles as it does. A failing task
  // fails its own caller only: the next one still runs.
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export { Queue };
