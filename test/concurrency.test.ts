import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { mapSettledLimit } from "../src/runtime/concurrency.ts";

test("bounded work overlaps without exceeding its limit and preserves input order", async () => {
  const pair = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  const outcomes = await mapSettledLimit([0, 1, 2, 3], 2, async item => {
    active++;
    maximum = Math.max(maximum, active);
    if (active === 2) pair.resolve();
    await pair.promise;
    await setImmediate();
    active--;
    return item * 10;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(outcomes, [0, 10, 20, 30].map(value => ({ status: "fulfilled", value })));
});

test("a worker failure does not return before its active sibling settles", async () => {
  const sibling = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let finished = false;
  const pending = mapSettledLimit([0, 1], 2, async item => {
    if (item === 0) throw new Error("first worker failed");
    started.resolve();
    await sibling.promise;
    return item;
  }).then(results => { finished = true; return results; });
  await started.promise;
  await setImmediate();
  assert.equal(finished, false);
  sibling.resolve();
  const results = await pending;
  assert.equal(results[0]!.status, "rejected");
  assert.deepEqual(results[1], { status: "fulfilled", value: 1 });
});

test("cancellation prevents queued work from starting while draining an active job", async () => {
  const controller = new AbortController();
  const active = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const invoked: number[] = [];
  const pending = mapSettledLimit([0, 1, 2], 1, async item => {
    invoked.push(item);
    started.resolve();
    await active.promise;
    return item;
  }, controller.signal);
  await started.promise;
  controller.abort(new Error("cancelled"));
  active.resolve();
  const results = await pending;
  assert.deepEqual(invoked, [0]);
  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(results[1]!.status, "rejected");
  assert.equal(results[2]!.status, "rejected");
});

test("invalid concurrency is rejected before any work is started", async () => {
  for (const limit of [0, 33, 1.5, NaN]) await assert.rejects(mapSettledLimit([0], limit, async () => 0), /between 1 and 32/);
});
