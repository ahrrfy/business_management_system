type Point = { epoch: number; generation: string };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
type Entry = {
  source: ReturnType<typeof deferred<Point | null>>;
  done: ReturnType<typeof deferred<{ acknowledged: boolean }>>;
};
export class CreditPipelineQueue {
  private readonly generation = crypto.randomUUID();
  private pending = 0;
  private active = 0;
  private maxActive = 0;
  private sequence = 0;
  private tail: Entry | null = null;
  private allowInitialPrefetch = true;
  constructor(private readonly limit = 8) {}
  stats() {
    return {
      pending: this.pending,
      active: this.active,
      maxActive: this.maxActive,
    };
  }
  async run<T extends { status: number }>(
    job: (hooks: {
      prefetched: any;
      generation: string;
      committed(epoch: number): void;
      acknowledged(epoch: number): void;
    }) => Promise<T>,
    prefetch?: (
      expectedEpoch: number | null,
      generation: string,
    ) => Promise<any>,
  ) {
    if (this.pending >= this.limit) throw Error("CASH_WRITER_QUEUE_FULL");
    const admissionSequence = ++this.sequence,
      queuedAhead = this.pending++;
    const admitted = Date.now(),
      previous = this.tail;
    const entry: Entry = { source: deferred(), done: deferred() };
    this.tail = entry;
    const firstAllowed = this.allowInitialPrefetch;
    // This coroutine belongs to the successor's own fetch invocation. The
    // predecessor resolves only a point; it never issues the successor's SQL.
    const reading = (async () => {
      const point = previous
        ? await previous.source.promise
        : firstAllowed
          ? { epoch: null, generation: this.generation }
          : null;
      if (!point || !prefetch) return { point: null, value: null };
      const value = await prefetch(point.epoch, point.generation);
      return { point, value };
    })().then(
      (value) => ({ value, error: null as any }),
      (error) => ({ value: null, error }),
    );
    const predecessor = previous ? await previous.done.promise : null;
    const started = Date.now();
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    let nativeEpoch: number | undefined, ackEpoch: number | undefined;
    let signalled = false,
      goodReply = false,
      acknowledged = false;
    try {
      const captured = await reading;
      if (captured.error) throw captured.error;
      const read = captured.value!;
      if (read.point && previous && !predecessor?.acknowledged)
        throw Error("LOOKAHEAD_PREDECESSOR_UNCONFIRMED");
      if (
        read.point &&
        (read.point.generation !== this.generation ||
          (read.point.epoch !== null && read.value.epoch !== read.point.epoch))
      )
        throw Error("LOOKAHEAD_SNAPSHOT_CHANGED");
      const value = await job({
        prefetched: read.value,
        generation: this.generation,
        committed: (epoch) => {
          if (signalled || !Number.isSafeInteger(epoch) || epoch < 2)
            throw Error("INVALID_LOOKAHEAD_COMMIT_POINT");
          signalled = true;
          nativeEpoch = epoch;
          entry.source.resolve({ epoch, generation: this.generation });
        },
        acknowledged: (epoch) => {
          ackEpoch = epoch;
        },
      });
      goodReply = value.status === 200;
      acknowledged =
        goodReply && nativeEpoch !== undefined && ackEpoch === nativeEpoch;
      return {
        value,
        admissionSequence,
        queuedAhead,
        waitMs: started - admitted,
        executionMs: Date.now() - started,
        lookahead: !!read.point && !!previous,
      };
    } finally {
      if (!signalled) entry.source.resolve(null);
      this.active--;
      this.pending--;
      this.allowInitialPrefetch = goodReply;
      entry.done.resolve({ acknowledged });
      if (this.tail === entry && this.pending === 0) this.tail = null;
    }
  }
}
