import { ORCA } from '../settings.mjs'

export const ORCA_INTEL = Object.freeze({
  ...ORCA,
  url: 'https://github.com/stablyai/orca/releases/download/v1.4.258/orca-macos-x64.dmg',
  sha256: 'e28a685c42a62e0d9b35f3be3b41bde3db654342521d7194490b5ae37931cb3d'
})
export function requireIntelMac(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || arch !== 'x64') throw new Error('Intel-only validation requires native macOS x64; use the original commands for Apple Silicon')
}
