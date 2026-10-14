import assert from "node:assert/strict";
import test from "node:test";
import { finalizeAdversarial } from "../src/tasks/adversarial/result.ts";
import type { AdversarialResult } from "../src/shared/types.ts";

const result = (): AdversarialResult => ({ status: "incomplete", investigation: null, generation: null,
  evidence: [], findings: [], errors: [], coverage: [
    { path: "src/server.mjs", status: "examined", reason: "Read and traced the server." },
    { path: "examples/audio.mp3", status: "skipped", reason: "Binary fixture." },
    { path: "package-lock.json", status: "skipped", reason: "Generated lock metadata." },
    { path: "LICENSE", status: "skipped", reason: "Legal text with no executable behavior." },
    { path: "documentation/.gitkeep", status: "skipped", reason: "Empty placeholder." },
  ] });

test("non-source assets and generated metadata remain visible without failing complete source examination", () => {
  const review = result();
  finalizeAdversarial(review);
  assert.equal(review.status, "completed");
  assert.deepEqual(review.errors, []);
  assert.equal(review.coverage[0]!.applicable, true);
  assert.ok(review.coverage.slice(1).every(entry => entry.applicable === false && entry.status === "skipped"));
});

test("skipped or unreported application source still makes the adversarial task incomplete", () => {
  const review = result();
  review.coverage[0]!.status = "skipped";
  finalizeAdversarial(review);
  assert.equal(review.status, "incomplete");
  assert.match(review.errors.join(), /0\/1 selected source paths/);
  review.coverage[0]!.status = "unreported";
  finalizeAdversarial(review);
  assert.match(review.errors.join(), /1 unreported/);
  assert.equal(review.errors.length, 1);
});

test("metadata applicability cannot clear a real execution failure", () => {
  const review = result();
  review.errors.push("Probe startup failed");
  finalizeAdversarial(review);
  assert.equal(review.status, "incomplete");
  assert.deepEqual(review.errors, ["Probe startup failed"]);
});
