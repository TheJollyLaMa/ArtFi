export async function fetchNetworkLogs({
  rpcUrl,
  address,
  fromBlock,
  toBlock,
  chunkSize = 20000,
  fetchImpl = fetch,
}) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("ARTFI_NETWORK_CHUNK_SIZE must be a positive safe integer");
  }

  const splitRange = async (start, end) => {
    const midpoint = Math.floor((start + end) / 2);
    // Keep split requests sequential to avoid flooding the public RPC.
    const left = await fetchRange(start, midpoint);
    const right = await fetchRange(midpoint + 1, end);
    return [...left, ...right];
  };

  const fetchRange = async (start, end, attempt = 0) => {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{ address, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }],
      }),
    });
    if (response.status === 413 && start < end) {
      return splitRange(start, end);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await new Promise(resolve => setTimeout(resolve, Math.min(15000, 500 * (2 ** attempt))));
      return fetchRange(start, end, attempt + 1);
    }
    if (!response.ok) throw new Error(`Base RPC log query failed (${response.status}) for blocks ${start}-${end}`);
    const result = await response.json();
    if (result.error) {
      if (start < end) return splitRange(start, end);
      throw new Error(`Base RPC log query failed for blocks ${start}-${end}: ${result.error.message}`);
    }
    if (!Array.isArray(result.result)) {
      throw new Error(`Base RPC log query returned invalid logs for blocks ${start}-${end}`);
    }
    return result.result;
  };

  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(toBlock, start + chunkSize - 1);
    logs.push(...await fetchRange(start, end));
  }
  return logs;
}
