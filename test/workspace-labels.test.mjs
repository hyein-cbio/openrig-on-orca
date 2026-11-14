import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceLabel, workspaceOptions } from '../src/workspace-labels.mjs'

const workspace = { id: 'alpha-main', project: 'Alpha', name: 'main', path: '/projects/alpha', hostId: 'local' }

test('main worktrees are labelled with their actual Orca project names and keep their IDs', () => {
  assert.deepEqual(workspaceOptions([
    workspace,
    { ...workspace, id: 'beta-main', project: 'Beta', path: '/projects/beta' }
  ]), [
    { value: 'alpha-main', label: 'Alpha / main' },
    { value: 'beta-main', label: 'Beta / main' }
  ])
})

test('custom project and worktree display names are preserved rather than inferred from paths', () => {
  assert.equal(workspaceLabel({ ...workspace, project: 'My Research', name: 'Fix / parser', path: '/worktrees/opaque-42' }), 'My Research / Fix / parser')
})

test('missing project metadata falls back to the directory name for folder/older hosts', () => {
  for (const project of [undefined, null, '', '  ']) {
    assert.equal(workspaceLabel({ ...workspace, project, path: '/projects/alpha/' }), 'alpha / main')
  }
  assert.equal(workspaceLabel(undefined), 'Unknown workspace')
})

test('duplicate project/worktree names append paths and only exact path duplicates need IDs', () => {
  const options = workspaceOptions([
    workspace,
    { ...workspace, id: 'alpha-2', path: '/second/alpha' },
    { ...workspace, id: 'alpha-3', path: '/second/alpha' }
  ])
  assert.deepEqual(options, [
    { value: 'alpha-main', label: 'Alpha / main — /projects/alpha' },
    { value: 'alpha-2', label: 'Alpha / main — /second/alpha (alpha-2)' },
    { value: 'alpha-3', label: 'Alpha / main — /second/alpha (alpha-3)' }
  ])
  assert.equal(new Set(options.map(option => option.label)).size, options.length)
})

test('remote workspaces stay excluded and do not trigger local duplicate suffixes', () => {
  assert.deepEqual(workspaceOptions([
    workspace,
    { ...workspace, id: 'remote', hostId: 'ssh:host' },
    { ...workspace, id: 'null-host', project: 'Beta', hostId: null }
  ]), [
    { value: 'alpha-main', label: 'Alpha / main' },
    { value: 'null-host', label: 'Beta / main' }
  ])
})
