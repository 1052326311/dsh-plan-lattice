import { installLongSystemBoundary } from './common-boundary.js'

export const name = 'long-system-native-boundary'
export const inject = ['tools']

export function apply(ctx) {
  installLongSystemBoundary(ctx)
}
