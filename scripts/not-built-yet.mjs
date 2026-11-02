// Placeholder for top-level scripts that later phases replace. It fails loudly on purpose, so nothing
// can look like it works before it does.
const [name = "this command", phase = "?"] = process.argv.slice(2);
console.error(`"npm run ${name}" is not built yet. It arrives in Phase ${phase} (see docs/DECISIONS.md).`);
process.exit(1);
