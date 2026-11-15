import path from 'node:path'
import { configFrom } from '../runtime.mjs'

export const isIntelMac = (platform = process.platform, arch = process.arch) => platform === 'darwin' && arch === 'x64'

// Reuse the original configuration/path machinery; only the opt-in Intel worker adds this path.
export function intelConfig(input, platform = process.platform, arch = process.arch) {
  if (!isIntelMac(platform, arch)) return input
  const config = configFrom(input || {})
  const paths = config.extraPath.split(path.delimiter).filter(Boolean)
  if (!paths.includes('/opt/local/bin')) paths.push('/opt/local/bin')
  return { ...config, extraPath: paths.join(path.delimiter) }
}

export function intelHost(orca, platform = process.platform, arch = process.arch) {
  if (!isIntelMac(platform, arch)) return orca
  // Orca freezes its API objects. Proxy a fresh facade, never the frozen API target.
  const storage = new Proxy({}, {
    get(_target, property) {
      const target = orca.storage
      if (property === 'get') return async key => {
        const value = await target.get(key)
        return key === 'config.v1' ? intelConfig(value, platform, arch) : value
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return Object.create(orca, { storage: { value: storage } })
}
