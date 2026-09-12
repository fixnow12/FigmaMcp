import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationTimings } from '../src/operation-timings.mjs';

test('замер разделяет ожидание, выполнение и накладное время; повторное завершение не меняет этап', async () => {
  let clock = 100;
  const timing = createOperationTimings('patch_nodes', { now: () => clock });
  const resolved = timing.start('resolveTarget');
  clock = 110;
  resolved();
  clock = 112;
  const result = await timing.measure('execute', async () => { clock = 142; return 'applied'; });
  assert.equal(result, 'applied');
  resolved('error');
  clock = 150;
  assert.deepEqual(timing.snapshot(), {
    version: 1, scope: 'bridge_operation', operation: 'patch_nodes', totalMs: 50,
    stages: [{ name: 'resolveTarget', durationMs: 10, status: 'ok' }, { name: 'execute', durationMs: 30, status: 'ok' }],
  });
});

test('ошибки измеряются и пробрасываются без потери исходного объекта и статуса', async () => {
  let clock = 0;
  const timing = createOperationTimings('recreate_screen', { scope: 'reconstruction_handler', now: () => clock });
  const failure = Object.assign(new Error('Запись прервана'), { operationStatus: 'unknown' });
  await assert.rejects(timing.measure('write', async () => { clock = 25; throw failure; }), error => error === failure);
  assert.throws(() => timing.measureSync('compile', () => { clock = 30; throw failure; }), error => error === failure);
  assert.deepEqual(timing.snapshot().stages, [
    { name: 'write', durationMs: 25, status: 'error' },
    { name: 'compile', durationMs: 5, status: 'error' },
  ]);
  assert.equal(failure.operationStatus, 'unknown');
});

test('параллельные запросы имеют независимые замеры; снимок метрик не меняется задним числом', () => {
  let clock = 0;
  const first = createOperationTimings('inspect_selection', { now: () => clock });
  const second = createOperationTimings('render_screen', { now: () => clock });
  first.measureSync('execute', () => { clock = 7; });
  const saved = first.snapshot();
  second.measureSync('execute', () => { clock = 20; });
  first.measureSync('screenshot', () => { clock = 35; });
  assert.deepEqual(saved.stages, [{ name: 'execute', durationMs: 7, status: 'ok' }]);
  assert.deepEqual(second.snapshot().stages, [{ name: 'execute', durationMs: 13, status: 'ok' }]);
});
