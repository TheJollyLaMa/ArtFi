import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSampleProofHash, loadSampleCidsFromIndex, normalizeCid, pinCids, sampleCids } from "../scripts/nodeKeeper.mjs";

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

test("loads active sample CIDs from an ArtFi network index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "artfi-node-keeper-"));
  const indexPath = join(dir, "index.json");
  await writeFile(indexPath, JSON.stringify({
    publications: [
      { cid: "ipfs://bafyone", active: true },
      { cid: "bafytwo", active: true },
      { cid: "ipfs://bafyone", active: true },
      { cid: "ipfs://inactive", active: false },
    ],
  }));
  assert.equal(normalizeCid("ipfs://bafyone"), "bafyone");
  assert.deepEqual(await loadSampleCidsFromIndex({ indexPath }), ["bafyone", "bafytwo"]);
  assert.deepEqual(await loadSampleCidsFromIndex({ indexPath, limit: 1 }), ["bafyone"]);
});

test("pins normalized CIDs through the local Kubo API", async () => {
  const calls = [];
  const pinned = await pinCids({
    cids: ["ipfs://bafyone", "bafytwo"],
    apiUrl: "http://kubo.local",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options?.method });
      return new Response(JSON.stringify({ Pins: [url] }), { status: 200 });
    },
  });
  assert.deepEqual(pinned, ["bafyone", "bafytwo"]);
  assert.deepEqual(calls.map(call => call.method), ["POST", "POST"]);
  assert.ok(calls[0].url.includes("/api/v0/pin/add?arg=bafyone"));
  await assert.rejects(() => pinCids({
    cids: ["missing"],
    fetchImpl: async () => new Response("", { status: 500 }),
  }), /Could not pin/);
});
