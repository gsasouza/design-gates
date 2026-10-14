#!/usr/bin/env node

const USAGE = `Usage: design-gates [options]

Options:
  --help    Show this help
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
process.stderr.write(USAGE);
process.exit(2);
