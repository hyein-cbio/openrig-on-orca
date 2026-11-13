import { defineCheck } from 'orca/testing'
import { installed, missing } from './fixtures'
export default defineCheck({
  'learn-without-agents': { requests: { 'environment.scan': missing, 'examples.list': { examples: [] } } },
  'ready-for-terminal-demo': { requests: { 'environment.scan': installed, 'examples.list': { examples: [] } } },
  'no-workspace': { requests: { 'environment.scan': { ...installed, workspaces: [] }, 'examples.list': { examples: [] } } }
})
