// Isolated lab admission queue. Financial durability stays in D1 and its journal.
export class CashWriterQueue {
  private pending = 0;
  private active = 0;
  private maxActive = 0;
  private sequence = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly limit = 8) {}
  stats() {
    return {
      pending: this.pending,
      active: this.active,
      maxActive: this.maxActive,
    };
  }
  async run<T>(job: () => Promise<T>) {
    if (this.pending >= this.limit)
      throw Object.assign(new Error("CASH_WRITER_QUEUE_FULL"), { status: 503 });
    const admissionSequence = ++this.sequence;
    const queuedAhead = this.pending++;
    const admitted = Date.now();
    const predecessor = this.tail;
    let release!: () => void;
    // Tail never rejects. A failure must not poison any admitted successor.
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    const started = Date.now();
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const value = await job();
      return {
        value,
        admissionSequence,
        queuedAhead,
        waitMs: started - admitted,
        executionMs: Date.now() - started,
      };
    } finally {
      this.active--;
      this.pending--;
      release();
    }
  }
}
