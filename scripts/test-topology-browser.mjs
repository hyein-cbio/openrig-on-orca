#!/usr/bin/env node
// Run against an already-running Orca. Opens/closes only a task-owned static preview tab.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startTopologyPreview } from './preview-topology.mjs'
import { checkTopologyDrilldown } from './topology-browser-checks.mjs'

const exec = promisify(execFile)
const cli = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' && !process.env.ORCA_WORKSPACE_ID ? 'orca-ide' : 'orca')
async function orca(args) {
  const { stdout } = await exec(cli, [...args, '--json'], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 })
  const value = JSON.parse(stdout)
  if (!value.ok) throw new Error(`${value.error?.code}: ${value.error?.message}`)
  return value.result
}
async function until(check) {
  const deadline = Date.now() + 20000
  let last
  while (Date.now() < deadline) {
    try { return await check() } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  throw last || new Error('Browser check timed out')
}
const { server, url } = await startTopologyPreview()
let page
try {
  page = (await orca(['tab', 'create', '--url', url])).browserPageId
  const evaluate = async expression => JSON.parse((await orca(['eval', '--page', page, '--expression', expression])).result)
  const narrow = process.argv.includes('--narrow')
  await until(async () => assert.equal(await evaluate('JSON.stringify(Boolean(document.getElementById("view-dashboard")))'), true))
  for (const view of ['messages', 'preparation', 'dashboard']) {
    await evaluate(`JSON.stringify(document.getElementById("view-${view}").click() || true)`)
    if (view === 'messages') {
      assert.equal(await evaluate('JSON.stringify(document.getElementById("messages-actions").hidden)'), true)
      await evaluate('JSON.stringify(document.getElementById("messages-dashboard").click() || true)')
      assert.equal(await evaluate('JSON.stringify(document.activeElement.id)'), 'view-dashboard')
    }
    if (view === 'preparation') {
      assert.equal(await evaluate('JSON.stringify(document.getElementById("team-spec").closest("details").open)'), false)
      await evaluate('JSON.stringify(document.getElementById("team-spec").closest("details").querySelector("summary").click() || true)')
      assert.equal(await evaluate('JSON.stringify(document.getElementById("team-spec").getClientRects().length > 0)'), true)
    }
  }
  await orca(['viewport', '--page', page, '--width', narrow ? '390' : '1200', '--height', narrow ? '844' : '1000'])
  if (process.argv.includes('--dark')) await evaluate('JSON.stringify((document.documentElement.classList.remove("light"),document.documentElement.classList.add("dark"),true))')
  // The tab strip and its active control share one sticky surface; the title does not.
  for (const [view, control] of [['preparation', 'scan-environment'], ['dashboard', 'dashboard-pod'], ['messages', 'messages-dashboard']]) {
    await evaluate(`JSON.stringify(document.getElementById("view-${view}").click() || true)`)
    assert.equal(await evaluate(`JSON.stringify(document.getElementById("${control}").closest(".panel-bar") !== null && document.getElementById("${control}").getClientRects().length > 0 && document.querySelectorAll(".context-row[id$='-context-bar']:not([hidden])").length === 1)`), true)
    if (view !== 'messages') {
      await evaluate('JSON.stringify(scrollTo(0, 200) || true)')
      await until(async () => assert.equal(await evaluate('JSON.stringify(scrollY > 0 && document.querySelector(".plugin-heading").getBoundingClientRect().bottom < 0 && Math.abs(document.querySelector(".panel-bar").getBoundingClientRect().top) < 1)'), true))
      await evaluate('JSON.stringify(scrollTo(0, 0) || true)')
    }
  }
  await evaluate('JSON.stringify(document.getElementById("view-dashboard").click() || true)')
  const capture = async name => {
    if (!process.argv.includes('--capture')) return
    await evaluate('JSON.stringify(document.querySelector(".map-card").scrollIntoView({block:"start"}) || true)')
    console.log(JSON.stringify({ view: name, screenshot: await orca(['screenshot', '--page', page]) }))
  }
  await checkTopologyDrilldown(evaluate, until, capture)
  console.log('PASS: topology drill-down, nested keyboard navigation, actual TB geometry, camera/history, refresh/reorder, partial observations, scoped SVG export, removed roots, instance changes, pending renders and YAML editing.')
} finally {
  try { if (page) await orca(['tab', 'close', '--page', page]) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
