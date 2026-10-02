/**
 * Graph algorithms over adjacency lists of node indices. All are iterative so
 * very large or deep graphs cannot overflow the stack.
 */

/** Tarjan's strongly connected components. Components are returned in reverse topological order. */
export function stronglyConnectedComponents(adjacency: ReadonlyArray<readonly number[]>): number[][] {
  const n = adjacency.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    // Explicit call stack of [node, next edge position].
    const work: Array<[number, number]> = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const [v, i] = frame;
      const edges = adjacency[v]!;
      if (i < edges.length) {
        frame[1]++;
        const w = edges[i]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]![0];
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        const component: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          component.push(w);
        } while (w !== v);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * A shortest cycle through `start` that stays inside `members` (BFS), as a
 * list of nodes beginning and ending with `start`. Null when there is none.
 */
export function shortestCycle(adjacency: ReadonlyArray<readonly number[]>, start: number, members: ReadonlySet<number>): number[] | null {
  const parent = new Map<number, number>();
  const queue: number[] = [];
  for (const w of adjacency[start] ?? []) {
    if (w === start) return [start, start];
    if (members.has(w) && !parent.has(w)) {
      parent.set(w, start);
      queue.push(w);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    for (const w of adjacency[v] ?? []) {
      if (w === start) {
        const path = [v];
        let p = parent.get(v)!;
        while (p !== start) {
          path.push(p);
          p = parent.get(p)!;
        }
        return [start, ...path.reverse(), start];
      }
      if (members.has(w) && !parent.has(w)) {
        parent.set(w, v);
        queue.push(w);
      }
    }
  }
  return null;
}
