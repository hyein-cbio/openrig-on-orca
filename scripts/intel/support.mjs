import { assertLiveReport } from '../ci-support.mjs'
import { requireIntelMac } from '../../ci/intel/settings.mjs'

export function assertIntelReport(report, options = {}) {
  assertLiveReport(report, options)
  requireIntelMac(report.host?.platform || 'missing', report.host?.arch || 'missing')
  if (report.runtime?.nodeArch !== 'x64' || report.runtime?.worker?.platform !== 'darwin' || report.runtime?.worker?.arch !== 'x64' || report.runtime?.sqlite !== 'ready') {
    throw new Error('Intel report lacks native Node/worker and successful SQLite evidence')
  }
}
