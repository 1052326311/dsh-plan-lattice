import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { strictSeatbeltConfine } from './strict-seatbelt-profile.js'

export class StrictSeatbeltSandboxProvider extends SandboxProvider {
  confine(argv, policy) {
    return strictSeatbeltConfine(argv, policy)
  }
}

export default StrictSeatbeltSandboxProvider
