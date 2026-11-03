export interface Heap<T> { push(x: T): void; pop(): T | undefined; peek(): T | undefined; size(): number }

export function createHeap<T>(less: (a: T, b: T) => boolean): Heap<T> {
  const a: T[] = [];
  const up = (i: number) => { while (i > 0) { const p = (i - 1) >> 1; if (!less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; } };
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < a.length && less(a[l], a[m])) m = l;
      if (r < a.length && less(a[r], a[m])) m = r;
      if (m === i) return;
      [a[i], a[m]] = [a[m], a[i]]; i = m;
    }
  };
  return {
    push(x) { a.push(x); up(a.length - 1); },
    pop() { if (!a.length) return undefined; const top = a[0]; const last = a.pop()!; if (a.length) { a[0] = last; down(0); } return top; },
    peek: () => a[0],
    size: () => a.length,
  };
}
