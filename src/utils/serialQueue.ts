/**
 * Run async jobs one at a time, in call order. A job that rejects does not
 * block later ones. Used to keep two decodes from racing on one backend.
 */
export type SerialQueue = <T>(job: () => Promise<T>) => Promise<T>;

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };
}
