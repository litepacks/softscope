function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchRemoteData() {
  await sleep(60);
  return { status: 200, data: [1, 2, 3] };
}

async function processPipeline() {
  const res = await fetchRemoteData();
  return res.data.length;
}

const count = await processPipeline();
console.log('Async pipeline processed:', count);
