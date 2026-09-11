#!/usr/bin/env node
// Local fake CLI process for the real pinned SDK; never performs inference.
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({type:'error',message:'fixture API rejection'}) + '\n');
  setTimeout(() => process.exit(0), 20);
});
