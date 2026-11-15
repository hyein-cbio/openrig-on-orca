import type { OrcaWorkerApi } from 'orca/worker'
import activateOriginal from '../worker'
import { intelHost } from './runtime.mjs'

// The default manifest still loads the original worker. Only stage-intel selects this entry.
export default function activate(orca: OrcaWorkerApi): void {
  activateOriginal(intelHost(orca))
}
