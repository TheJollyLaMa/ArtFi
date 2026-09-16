import test from "node:test";
import assert from "node:assert/strict";

import { createSampleProofHash, sampleCids } from "../scripts/nodeKeeper.mjs";

test("samples CIDs through Kubo and creates a deterministic proof hash", async () => {
  const calls = [];
  const results = await sampleCids({
    cids: ["bafyone", "baftwo"],
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(url.endsWith("bafyone") ? "one" : "two", { status: 200 });
    },
  });
  assert.deepEqual(results, [{ cid: "bafyone", size: 3 }, { cid: "baftwo", size: 3 }]);
  assert.equal(calls.length, 2);
  assert.equal(createSampleProofHash(results), createSampleProofHash(results));
  await assert.rejects(() => sampleCids({
    cids: ["missing"],
    fetchImpl: async () => new Response("", { status: 404 }),
  }), /Could not retrieve/);
});
