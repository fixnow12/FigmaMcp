import { performance } from 'node:perf_hooks';

// Local, monotonic durations only: no canvas content, logging, retries or I/O.
export function createOperationTimings(operation, { scope = 'bridge_operation', now = () => performance.now() } = {}) {
  const startedAt = now();
  const stages = [];
  const elapsed = start => Math.round(Math.max(0, now() - start) * 1000) / 1000;

  function start(name) {
    const beganAt = now();
    const stage = { name };
    stages.push(stage);
    let ended = false;
    return (status = 'ok') => {
      if (ended) return;
      ended = true;
      Object.assign(stage, { durationMs: elapsed(beganAt), status });
    };
  }

  async function measure(name, action) {
    const end = start(name);
    try {
      const result = await action();
      end();
      return result;
    } catch (error) {
      end('error');
      throw error;
    }
  }

  function measureSync(name, action) {
    const end = start(name);
    try {
      const result = action();
      end();
      return result;
    } catch (error) {
      end('error');
      throw error;
    }
  }

  function snapshot() {
    return { version: 1, scope, operation,
      totalMs: elapsed(startedAt), stages: stages.map(stage => ({ ...stage })) };
  }

  return { start, measure, measureSync, snapshot };
}
