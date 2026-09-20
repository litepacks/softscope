function riskyOperation(shouldFail) {
  if (shouldFail) {
    throw new Error('Simulated failure');
  }
  return 'ok';
}

function handleErrors() {
  try {
    riskyOperation(true);
  } catch (err) {
    console.log('Caught expected error:', err.message);
  }
}

handleErrors();

// Trigger uncaught failure if --fatal argument is passed
if (process.argv.includes('--fatal')) {
  riskyOperation(true);
}
