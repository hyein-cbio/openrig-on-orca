import { defineCheck, hostError } from 'orca/testing'
import { installed, missing, ready } from './fixtures'

export default defineCheck({
  'fresh-install': { requests: { 'environment.scan': missing } },
  'agent-deferred': { requests: { 'environment.scan': installed } },
  'ready': { requests: { 'environment.scan': ready } },
  'no-workspace': { requests: { 'environment.scan': { ...installed, workspaces: [] } } },
  'probe-error': { requests: { 'environment.scan': () => { throw hostError('unavailable', 'Host environment is unavailable. Retry without installing anything.') } } }
})
