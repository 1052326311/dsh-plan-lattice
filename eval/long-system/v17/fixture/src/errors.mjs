// Exit-code taxonomy shared by the whole CLI:
//   UsageError / InputError -> exit 2 (malformed input, unknown flags/commands,
//     duplicate flags, missing values, unreadable JSON, bad shapes/values,
//     unsupported command types, malformed durable state)
//   StateError              -> exit 3 (valid command rejected by state or
//     optimistic concurrency)
//   AuthError               -> exit 4 (authorization failure)
export class CliError extends Error {
  constructor(message) {
    super(message)
    this.name = this.constructor.name
  }
}

export class UsageError extends CliError {}
export class InputError extends CliError {}
export class StateError extends CliError {}
export class AuthError extends CliError {}
