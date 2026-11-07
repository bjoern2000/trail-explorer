// Tiny typed pub/sub state (Phase 0, then frozen). No dependency.
// createStore(initial) → { get, set(partial), subscribe(keys, fn) }.

export interface Store<T extends object> {
  get(): Readonly<T>;
  set(partial: Partial<T>): void;
  subscribe(keys: (keyof T)[], fn: (state: Readonly<T>) => void): () => void;
}

interface Sub<T> {
  keys: (keyof T)[];
  fn: (state: Readonly<T>) => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state: T = { ...initial };
  const subs = new Set<Sub<T>>();

  function get(): Readonly<T> {
    return state;
  }

  function set(partial: Partial<T>): void {
    const changed: (keyof T)[] = [];
    for (const k of Object.keys(partial) as (keyof T)[]) {
      if (!Object.is(state[k], partial[k])) changed.push(k);
    }
    if (changed.length === 0) return;
    state = { ...state, ...partial };
    for (const sub of subs) {
      if (sub.keys.some((k) => changed.includes(k))) sub.fn(state);
    }
  }

  function subscribe(keys: (keyof T)[], fn: (state: Readonly<T>) => void): () => void {
    const sub: Sub<T> = { keys, fn };
    subs.add(sub);
    return () => {
      subs.delete(sub);
    };
  }

  return { get, set, subscribe };
}
