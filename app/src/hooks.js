import { useCallback, useEffect, useRef, useState } from 'react';

/** Run an async loader whenever `deps` change; exposes { data, error, loading, reload }.
 *  Stale results (a slower earlier call) never overwrite a newer one. */
export function useAsync(loader, deps, { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled });
  const seq = useRef(0);
  const run = useCallback(() => {
    if (!enabled) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(loader)
      .then((data) => { if (seq.current === id) setState({ data, error: null, loading: false }); })
      .catch((error) => { if (seq.current === id) setState((s) => ({ data: s.data, error, loading: false })); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

/** Debounced callback — the last call within `ms` wins. */
export function useDebounced(fn, ms) {
  const timer = useRef(null);
  const latest = useRef(fn);
  useEffect(() => { latest.current = fn; });
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback((...args) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(...args), ms);
  }, [ms]);
}
