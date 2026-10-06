import test from "node:test";
import assert from "node:assert/strict";
import { fetchNetworkLogs } from "../scripts/networkLogs.mjs";

const options = {
  rpcUrl: "https://rpc.example",
  address: "0x4e70AC13Ea266D76d872411DA8b4E80460Af4423",
  fromBlock: 51430773,
  toBlock: 51431397,
};
const getRange = request => {
  const filter = JSON.parse(request.body).params[0];
  assert.equal(filter.address, options.address);
  return [Number(filter.fromBlock), Number(filter.toBlock)];
};
const json = value => new Response(JSON.stringify(value));

for (const failure of ["HTTP 413", "JSON-RPC error"]) {
  test(`splits the failing 625-block range below 1000 blocks on ${failure}`, async () => {
    const successfulRanges = [];
    const logs = await fetchNetworkLogs({
      ...options,
      fetchImpl: async (_, request) => {
        const [start, end] = getRange(request);
        if (end - start + 1 > 100) {
          return failure === "HTTP 413"
            ? new Response("", { status: 413 })
            : json({ error: { code: -32005, message: "block range too large" } });
        }
        successfulRanges.push([start, end]);
        return json({ result: [{ blockNumber: start }, { blockNumber: end }] });
      },
    });
    assert.equal(successfulRanges[0][0], options.fromBlock);
    assert.equal(successfulRanges.at(-1)[1], options.toBlock);
    for (let i = 1; i < successfulRanges.length; i++) {
      assert.equal(successfulRanges[i][0], successfulRanges[i - 1][1] + 1);
    }
    assert.deepEqual(logs.map(log => log.blockNumber), successfulRanges.flat());
  });
}

test("splits down to single blocks without gaps or duplicates", async () => {
  const logs = await fetchNetworkLogs({
    ...options,
    fromBlock: 10,
    toBlock: 14,
    fetchImpl: async (_, request) => {
      const [start, end] = getRange(request);
      return start === end
        ? json({ result: [{ blockNumber: start }] })
        : new Response("", { status: 413 });
    },
  });
  assert.deepEqual(logs.map(log => log.blockNumber), [10, 11, 12, 13, 14]);
});

test("stops with a useful error when a single block is still rejected", async () => {
  await assert.rejects(fetchNetworkLogs({
    ...options,
    toBlock: options.fromBlock,
    fetchImpl: async () => new Response("", { status: 413 }),
  }), /failed \(413\) for blocks 51430773-51430773/);
  await assert.rejects(fetchNetworkLogs({
    ...options,
    toBlock: options.fromBlock,
    fetchImpl: async () => json({ error: { message: "invalid query" } }),
  }), /51430773-51430773: invalid query/);
});

test("preserves chunk boundaries and accepts empty log arrays", async () => {
  const ranges = [];
  const logs = await fetchNetworkLogs({
    ...options,
    fromBlock: 10,
    toBlock: 14,
    chunkSize: 2,
    fetchImpl: async (_, request) => {
      ranges.push(getRange(request));
      return json({ result: [] });
    },
  });
  assert.deepEqual(ranges, [[10, 11], [12, 13], [14, 14]]);
  assert.deepEqual(logs, []);
});

test("retries a rate-limited request without changing its range", async () => {
  const ranges = [];
  const logs = await fetchNetworkLogs({
    ...options,
    fetchImpl: async (_, request) => {
      ranges.push(getRange(request));
      return ranges.length === 1
        ? new Response("", { status: 429 })
        : json({ result: [] });
    },
  });
  assert.deepEqual(ranges, [
    [options.fromBlock, options.toBlock],
    [options.fromBlock, options.toBlock],
  ]);
  assert.deepEqual(logs, []);
});

test("does not silently treat malformed RPC results as an empty index", async () => {
  await assert.rejects(fetchNetworkLogs({
    ...options,
    fetchImpl: async () => json({}),
  }), /returned invalid logs/);
});

test("rejects invalid chunk sizes before making requests", async () => {
  for (const chunkSize of [0, -1, 1.5, NaN]) {
    await assert.rejects(fetchNetworkLogs({
      ...options,
      chunkSize,
      fetchImpl: async () => assert.fail("must not fetch"),
    }), /must be a positive safe integer/);
  }
});
