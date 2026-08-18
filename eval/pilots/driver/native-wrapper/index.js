import { installIcaeCommonBoundary } from './common-boundary.js'

export const name = 'icae-native-boundary'
export const inject = ['tools']

export function apply(ctx) {
  installIcaeCommonBoundary(ctx)
}
