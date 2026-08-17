const args = new Set(process.argv.slice(2))

if (args.has('--help')) {
  process.stdout.write('Usage: dsh-declared-bin-fixture --help\n')
} else {
  process.stderr.write('Pass --help for usage.\n')
  process.exitCode = 2
}
