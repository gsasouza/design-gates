export const COMMANDS = ["init", "status", "save", "history", "compare", "restore", "explore", "switch", "help"] as const;
export type Command = (typeof COMMANDS)[number];

const GLOBAL = `Options for every command:
  --repo <folder>   The design folder to work in (default: the current folder)
  --json            Print one machine-readable result instead of a sentence
  -h, --help        Show help`;

export const COMMAND_HELP: Record<Exclude<Command, "help">, string> = {
  init: `design init
  Start keeping versions of this folder. Safe to run again: it only fills in what is missing.
  Designs already in the folder are saved as the first version.`,
  status: `design status
  Show which design files have changes you have not saved yet.`,
  save: `design save [-m, --message <text>]
  Save the current designs as a new version.
  -m, --message <text>   A short note about this version (default: "Saved <date>")
  When nothing changed there is nothing to save, and that is fine.`,
  history: `design history [file] [--limit <n>]
  List saved versions, newest first, numbered #1, #2, ...
  file         Only versions that changed this design file
  --limit <n>  Show only the newest n versions`,
  compare: `design compare [from] [to] [paths...] [--out <folder>] [--open]
  Make a visual report of what changed between two versions.
  from         The older version (default: the last saved version, #1)
  to           The newer version (default: your unsaved changes)
  paths        Only compare these design files
  --out <folder>  Where to write the report (default: design-diff in the design folder)
  --open       Open the report when it is ready
  How the words after "compare" are read, left to right: each one is a version while
  no file has been seen yet, at most two versions have been taken, and it is a known
  version reference (#n, a version id, an exploration name or main). The first word
  that is not a version is a file, and everything after it is a file too. A word
  that could mean more than one version is an error: be more specific.`,
  restore: `design restore <version> [paths...] [--save-first]
  Bring the designs back to how they were in an earlier version. Nothing is erased
  from history: the restored files simply show up as unsaved changes.
  version        The version to go back to (#n, a version id, an exploration name or main)
  paths          Only restore these design files
  --save-first   Save your unsaved changes as a version first, instead of stopping`,
  explore: `design explore [name]
  With a name: start a separate line of experiments from the current version and move to it.
  Without a name: list your explorations.`,
  switch: `design switch <name|main>
  Move to another exploration, or back to main. Save your changes first.`,
};

export const MAIN_HELP = `Usage: design <command> [options]

Keep versions of your design files, compare them and go back, on this computer only.

Commands:
  init       Start keeping versions of this folder
  status     See what has changed since the last version
  save       Save the current designs as a new version
  history    List saved versions
  compare    Make a visual report of what changed between two versions
  restore    Bring designs back to how they were in an earlier version
  explore    Start or list explorations (separate lines of experiments)
  switch     Move to another exploration, or back to main
  help       Show this help

${GLOBAL}

Versions can be written as:
  #1, #2 ...      the newest saved version is #1
  a version id    for example 3f9a2c1 (at least 4 characters)
  a name          the name of an exploration
  main            the original line of versions

${Object.values(COMMAND_HELP).join("\n\n")}

Exit codes:
  0  it worked (including "nothing to save")
  1  it was stopped to protect your work, or saving was refused
  2  the command was not understood, or a version could not be found

Your versions stay on this computer. Nothing is ever uploaded, earlier versions are never rewritten.
`;

export const commandHelp = (c: Exclude<Command, "help">): string => `${COMMAND_HELP[c]}\n\n${GLOBAL}\n`;
