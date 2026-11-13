import path from 'node:path'
import { fail, shellCommand } from './runtime.mjs'

export { EXAMPLE_STEPS } from './example-story.mjs'

const agent = role => `name: example-${role}\nversion: '1.0'\nprofiles:\n  default:\n    uses:\n      skills: []\n      guidance: []\n      subagents: []\n      plugins: []\n      runtime_resources: []\nresources: {}\nstartup:\n  files:\n    - path: role.md\n      delivery_hint: send_text\n      required: true\n  actions: []\n`

export function exampleBundle(kind, id, directory) {
  if (!['demo', 'claude', 'codex'].includes(kind) || !/^[a-f0-9]{12}$/.test(id) || !path.isAbsolute(directory)) throw fail('invalid_example', 'Invalid example bundle')
  const rigName = `orca-example-${kind}-${id}`
  const project = path.join(directory, 'project')
  const terminal = kind === 'demo'
  const runtime = terminal ? 'terminal' : kind === 'claude' ? 'claude-code' : 'codex'
  const members = ['builder', 'reviewer'].map(role => {
    const message = role === 'builder'
      ? 'SIMULATION ONLY | Builder: reproduce -> implement -> request review -> address feedback'
      : 'SIMULATION ONLY | Reviewer: inspect diff -> report missing lower-bound regression -> review fixes'
    return `      - id: ${role}\n        agent_ref: ${terminal ? 'builtin:terminal' : `local:agents/${role}`}\n        profile: ${terminal ? 'none' : 'default'}\n        runtime: ${runtime}\n        cwd: ${JSON.stringify(project)}\n${terminal ? `        startup:\n          actions:\n            - type: send_text\n              value: ${JSON.stringify(`printf '%s\\n' '${message}'`)}\n              phase: after_ready\n              idempotent: true\n` : ''}`
  }).join('')
  const spec = `version: '0.2'\nname: ${rigName}\nsummary: ${terminal ? 'Prerecorded terminal demonstration; no AI or task exchange.' : 'Two-seat build and review example; explicit paid-agent launch required.'}\npods:\n  - id: dev\n    label: Build and Review\n    members:\n${members}    edges:\n      - kind: delegates_to\n        from: builder\n        to: reviewer\nedges: []\n`
  const task = '# Goal\nFix clamp(value, min, max) for values below min. Add a regression test; preserve the existing behavior for valid input and values above max. Run `node --test clamp.test.mjs`. Ask the reviewer to inspect the exact change and address actionable findings. Return the diff, test result and review result. Do not commit, push, publish, or change unrelated files.\n'
  const files = {
    'rig.yaml': spec,
    'README.md': `# Build & Review\n\n${terminal ? '**SIMULATION ONLY.** These are real tmux terminal seats with prerecorded output, not AI agents. No work is delegated or performed.' : `Both seats use ${runtime}. Starting them may incur model charges. Models and credentials come from your existing CLI configuration; this template grants no permission bypass.`}\n\nUser -> Builder -> Reviewer -> Builder -> User acceptance.\n\nThe reviewer role asks for no file changes; this is guidance, not an OS sandbox guarantee. Closing an Orca view does not stop a seat.\n\nSpec: ${path.join(directory, 'rig.yaml')}\n`,
    'project/TASK.md': task,
    'project/clamp.mjs': 'export function clamp(value, min, max) {\n  return Math.min(value, max) // Deliberate teaching defect: missing lower bound.\n}\n',
    'project/clamp.test.mjs': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { clamp } from './clamp.mjs'\ntest('preserves an in-range value', () => assert.equal(clamp(5, 0, 10), 5))\ntest('caps the upper bound', () => assert.equal(clamp(15, 0, 10), 10))\n"
  }
  if (!terminal) {
    for (const role of ['builder', 'reviewer']) files[`agents/${role}/agent.yaml`] = agent(role)
    files['agents/builder/role.md'] = `${task}\nYour reviewer is dev-reviewer@${rigName}. Use rig queue for owned review work and rig send to notify that seat; read rig <command> --help for exact syntax. Do not send an automatic prompt to an unrelated seat.\n`
    files['agents/reviewer/role.md'] = `You are the reviewer of this small clamp example. Wait for a review request from dev-builder@${rigName}. Read the exact candidate and tests, report actionable defects back through OpenRig, and do not edit files. Do not claim a review happened before inspecting a candidate. Do not commit or push.\n`
  }
  return { id, kind, rigName, directory, specPath: path.join(directory, 'rig.yaml'), project, files }
}

export function writeExampleCommand(node, bundle) {
  // A new exclusive directory is the write boundary. No existing project file is overwritten.
  const program = `const fs=require('node:fs'),p=require('node:path');const root=${JSON.stringify(bundle.directory)};fs.mkdirSync(p.dirname(root),{recursive:true});fs.mkdirSync(root);const files=${JSON.stringify(bundle.files)};for(const [name,text] of Object.entries(files)){const file=p.join(root,name);fs.mkdirSync(p.dirname(file),{recursive:true});fs.writeFileSync(file,text,{flag:'wx'})}console.log('Example created: '+root)`
  return shellCommand(node, ['-e', program])
}
