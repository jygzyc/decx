// A standalone TypeScript tool. Scriptc compiles this into a native executable;
// the DECX installer then treats its verified release archive like any other bin tool.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log('scriptcprobe 1.0.0');
} else {
  console.log(JSON.stringify(args));
}
