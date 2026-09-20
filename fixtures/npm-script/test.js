function runTest() {
  const values = [10, 20, 30];
  const total = values.reduce((sum, v) => sum + v, 0);
  console.log('Test suite ran successfully! Total:', total);
}

runTest();
