import path from "node:path";

/**
 * Normalizes command line arguments to support both:
 * 1. Documented path-first syntax: `ctx <projectPath> continue [options]`
 * 2. Standard commander syntax:   `ctx continue <projectPath> [options]`
 */
export function normalizeArgv(argv: string[]): string[] {
  if (argv.length < 4) return argv;
  const firstArg = argv[2];
  const knownCommands = [
    "init",
    "status",
    "checkpoint",
    "continue",
    "history",
    "events",
    "memory",
    "doctor",
    "--help",
    "-h",
    "--version",
    "-v",
  ];

  if (!knownCommands.includes(firstArg)) {
    const isPathLike =
      firstArg.includes("/") ||
      firstArg.includes("\\") ||
      firstArg.startsWith(".") ||
      path.isAbsolute(firstArg);
    const subcommand = argv[3];
    if (isPathLike && knownCommands.includes(subcommand)) {
      return [argv[0], argv[1], subcommand, firstArg, ...argv.slice(4)];
    }
  }
  return argv;
}
