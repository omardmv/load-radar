// Bounded FIFO between stages. A full queue makes producers wait (backpressure) or refuse (tryPush).
export interface BoundedQueue<T> {
  capacity: number;
  tryPush(item: T): boolean;
  push(item: T): Promise<void>;
  takeBatch(max: number): { items: T[]; waitsMs: number[] };
  waitForItems(): Promise<void>;
  size(): number;
}

export function createBoundedQueue<T>(capacity: number): BoundedQueue<T> {
  let items: T[] = [];
  let at: number[] = [];
  let head = 0;
  const spaceWaiters: (() => void)[] = [];
  const itemWaiters: (() => void)[] = [];
  const size = () => items.length - head;
  const wake = (ws: (() => void)[]) => { for (const f of ws.splice(0)) f(); };
  const add = (x: T) => { items.push(x); at.push(performance.now()); wake(itemWaiters); };
  return {
    capacity,
    tryPush(x) { if (size() >= capacity) return false; add(x); return true; },
    async push(x) { while (size() >= capacity) await new Promise<void>((r) => spaceWaiters.push(r)); add(x); },
    takeBatch(max) {
      const n = Math.min(max, size());
      const now = performance.now();
      const out = items.slice(head, head + n);
      const waitsMs = at.slice(head, head + n).map((t) => now - t);
      head += n;
      if (head > 4096 && head * 2 > items.length) { items = items.slice(head); at = at.slice(head); head = 0; }
      if (n) wake(spaceWaiters);
      return { items: out, waitsMs };
    },
    waitForItems() { return size() > 0 ? Promise.resolve() : new Promise<void>((r) => itemWaiters.push(r)); },
    size,
  };
}
