#!/usr/bin/env node
// Exercises the shipped HTML panel in a task-owned Orca browser tab. The bridge
// is synthetic, never calls a worker and cannot prompt, write or start an agent.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { startTopologyPreview } from './preview-topology.mjs'
import { podsFromSeats } from '../src/pods.mjs'
import { configFrom } from '../src/runtime.mjs'

const exec = promisify(execFile)
const cli = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' && !process.env.ORCA_WORKSPACE_ID ? 'orca-ide' : 'orca')
async function orca(args) {
  const { stdout } = await exec(cli, [...args, '--environment', 'local', '--json'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
  const value = JSON.parse(stdout)
  if (!value.ok) throw new Error(`${value.error?.code}: ${value.error?.message}`)
  return value.result
}
async function until(check) {
  const deadline = Date.now() + 12000
  let last
  while (Date.now() < deadline) {
    try { assert.equal(await check(), true); return } catch (error) { last = error; await delay(125) }
  }
  throw last || new Error('Browser check timed out')
}
const seat = { key: JSON.stringify(['fixture', 'leader']), rigId: 'fixture', logicalId: 'leader', rigName: 'Demo', podId: 'pod-fixture', podNamespace: 'demo', runtime: 'pi', session: 'leader@demo', status: 'running', activity: 'idle', attention: false }
const [pod] = podsFromSeats([seat]), connection = { key: 'a'.repeat(64), home: '/fixture/native', source: 'tui', port: '17433', endpoint: 'http://127.0.0.1:17433', matchesConfigured: false }
const inventory = { connection, pods: [pod], seats: [seat], observedAt: Date.now() }
const config = configFrom({ root: '/fixture/openrig', provider: 'none' })
const snapshot = { config, stage: 'ready', installed: true, tools: {}, sqlite: { status: 'ready', detail: 'Fixture only' }, providers: [] }
const relations = { instanceKey: connection.key, podKey: pod.key, memberKeys: [seat.key], observedAt: Date.now(), status: 'complete', edges: [], notes: [] }
const manyColumns = Array.from({ length: 32 }, (_, i) => `Oversize ${i}`), oversizedTable = [manyColumns.join(' | '), manyColumns.map(() => '---').join(' | '), ...Array(40).fill('| Base |')].join('\n')
const events = [{ key: 'prompt', kind: 'user', title: 'You', text: 'Read the deployment notes and summarize the checks.' }, { key: 'tool', kind: 'tool', title: 'read', text: 'docs/README.md', toolId: 'call-1' }, { key: 'tool-2', kind: 'tool', title: 'read', text: 'package.json', toolId: 'call-2' }, { key: 'think', kind: 'thinking', title: 'Thinking', text: 'Consider small side effects.' },
  { key: 'intro', kind: 'assistant', title: 'Pi', text: '## Diagnostic complete\n\n**Markdown** and `code`\n\n<img src="/not-an-allowed-source.png">\n\n[Test link](https://invalid.example)\n\n![Alt &amp; `R&amp;D` \\&amp;](https://invalid.example/ignored-image)\n\nR&amp;D and `R&amp;D`; &notit; and &#12345678; stay literal; &#65; renders.\n\n- First paragraph\n\n  Second paragraph\n- [x] done\n- [ ] pending\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| One | Two | Three |\n\n[reference-only]: https://invalid.example/private-placeholder' },
  ...Array.from({ length: 18 }, (_, i) => ({ key: `msg-${i}`, kind: 'assistant', title: 'Pi', text: `Recorded fixture ${i + 1}\n\nSecond paragraph for scroll anchoring.` })), { key: 'table-overflow', kind: 'assistant', title: 'Pi', text: oversizedTable }]
const { server, url } = await startTopologyPreview()
let page, browserFailure
try {
  page = (await orca(['tab', 'create', '--worktree', 'current', '--url', url])).browserPageId
  const evaluate = async expression => JSON.parse((await orca(['eval', '--page', page, '--expression', expression])).result)
  const inFrame = body => evaluate(`(()=>{const f=document.getElementById('pi-fixture'),d=f?.contentDocument,p=window.piProbe;return JSON.stringify((()=>{${body}})())})()`)
  const settledLayout = () => evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('true'))))`)
  await orca(['viewport', '--page', page, '--width', process.argv.includes('--dark') ? '274' : '390', '--height', '844'])
  await until(() => evaluate('JSON.stringify(Boolean(document.getElementById("view-dashboard")))'))
  const html = (await readFile(new URL('../src/visualizer/plugin.html', import.meta.url), 'utf8')).replace(/(src|href)="([^"]+)"/g, (_, attribute, value) => `${attribute}="${new URL(value, new URL('/visualizer/plugin.html', url)).href}"`)
  await evaluate(`(()=>{
    const f=document.createElement('iframe');f.id='pi-fixture';f.style.cssText='position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2500;background:white';document.body.append(f);
    const d=f.contentDocument; d.open();
    const p=window.piProbe={calls:[],delta:false}; const batch=(id,events)=>({id,events,omittedHistory:true,skippedRecords:0,more:false});
    f.contentWindow.orca={plugin:{request:async(name,input)=>{
      p.calls.push({name,input});
      if(name==='environment.scan') return ${JSON.stringify({ config, snapshot, daemon: { status: 'reachable' }, workspaces: [] })};
      if(name==='examples.list') return {examples:[]};
      if(name==='pods.list') return ${JSON.stringify(inventory)};
      if(name==='pods.edges') return ${JSON.stringify(relations)};
      if(name==='instance.inspect') return ${JSON.stringify({ ...connection, status: 'blocked' })};
      if(name==='pi-live.start') {if(typeof input.id!=='string'||!/^[a-f0-9]{32}$/.test(input.id))throw Error('Missing or invalid fixture follow ID');if(p.active)throw Error('A fixture follow is already active');p.active=input.id;return batch(input.id,${JSON.stringify(events)});}
      if(name==='pi-live.read') {if(input.id!==p.active)throw Error('Read must name the active fixture follow');if(!p.delta)return batch(input.id,[]);p.delta=false;return batch(input.id,[{key:'result',kind:'result',title:'read',text:'Deliberate fixture error.',toolId:'call-1',error:true},{key:'result-2',kind:'result',title:'read',text:'Second fixture result.',toolId:'call-2'},{key:'late',kind:'assistant',title:'Pi',text:'New **result** held below current scroll.'},{key:'marker',kind:'marker',title:'Context compacted',text:''},{key:'shell',kind:'shell',title:'printf fixture',text:'Fixture shell output'}]);}
      if(name==='pi-live.stop') {if(input.id!==p.active)throw Error('Stop must name the active fixture follow');p.active=null;return {stopped:true};}
      throw Error('Unrecognized fixture request');
    }}};
    d.write(${JSON.stringify(html)});d.close();return JSON.stringify(true);
  })()`)
  await until(() => inFrame("return (d.getElementById('dashboard-pod')?.options.length || 0)>1"))
  if (process.argv.includes('--dark')) await inFrame("d.documentElement.classList.add('dark');return true")
  assert.equal(await inFrame(`d.getElementById('view-dashboard').click();const select=d.getElementById('dashboard-pod');select.value=${JSON.stringify(pod.key)};select.dispatchEvent(new Event('change'));return d.getElementById('pi-live').hidden && !p.calls.some(c=>c.name.startsWith('pi-live.'))`), true)
  await until(() => inFrame("return [...d.querySelectorAll('#live-seats button')].some(b=>b.textContent==='Open Live Pi'&&!b.disabled)"))
  await inFrame("p.opener=[...d.querySelectorAll('#live-seats button')].find(b=>b.textContent==='Open Live Pi');p.opener.click();return true")
  await until(() => inFrame("return !d.getElementById('pi-live').hidden && d.querySelector('.pi-esp-assistant strong')?.textContent==='Markdown'"))
  assert.deepEqual(await inFrame("const {id,...scope}=p.calls.find(c=>c.name==='pi-live.start').input;return scope"), { source: 'tui', instanceKey: connection.key, podKey: pod.key, seatKey: seat.key, session: seat.session })
  assert.deepEqual(await inFrame("const user=d.querySelector('.pi-esp-user'),bubble=user.firstElementChild,run=d.querySelector('.pi-esp-run');return {bubbles:d.querySelectorAll('.pi-esp-user-bubble').length,right:Math.abs(bubble.getBoundingClientRect().right-user.getBoundingClientRect().right)<=1&&bubble.getBoundingClientRect().left>user.getBoundingClientRect().left,inline:!d.querySelector('.pi-esp-assistant .pi-esp-user-bubble'),inert:!d.querySelector('#pi-live img, .pi-esp-feed a'),thinking:!d.querySelector('.pi-esp-thinking details').open,oneRun:d.querySelectorAll('.pi-esp-run').length===1,collapsed:!run.open,tools:run.querySelectorAll('.pi-esp-tool').length,label:run.querySelector('summary span').textContent}"), { bubbles: 1, right: true, inline: true, inert: true, thinking: true, oneRun: true, collapsed: true, tools: 2, label: '2 reads' })
  assert.deepEqual(await inFrame("const style=f.contentWindow.getComputedStyle(d.querySelector('.pi-esp-user-bubble'));return [style.maxInlineSize, style.paddingBlockStart, style.paddingInlineStart]"), ['80%', '10px', '14px'])
  assert.deepEqual(await inFrame("const row=d.querySelector('.pi-esp-assistant'),items=[...row.querySelectorAll('li')];return {paragraphs:[...items[0].querySelectorAll('p')].map(n=>n.textContent),done:items[1].textContent,pending:items[2].textContent,prose:[...row.querySelectorAll('p')].find(n=>n.textContent.includes('R&D')).textContent,interactive:!!row.querySelector('input'),linkDefinition:row.textContent.includes('private-placeholder') }"), { paragraphs: ['First paragraph', 'Second paragraph'], done: '[Completed] done', pending: '[Pending] pending', prose: 'R&D and R&amp;D; &notit; and &#12345678; stay literal; A renders.', interactive: false, linkDefinition: false })
  assert.equal(await inFrame("return f.contentWindow.getComputedStyle(d.querySelector('.pi-esp-run > summary'),'::before').content!=='none'"), true)
  assert.deepEqual(await inFrame("return [...d.querySelectorAll('.pi-esp-assistant table :is(th,td)')].map(cell=>f.contentWindow.getComputedStyle(cell).textAlign)"), ['left','center','right','left','center','right'])
  assert.equal(await inFrame("const reply=d.querySelector('.pi-esp-assistant');return reply.textContent.includes('[Image omitted: Alt & R&amp;D &amp;]')&&!reply.textContent.includes('ignored-image')&&!reply.querySelector('img')"), true)
  assert.equal(await inFrame("const row=[...d.querySelectorAll('.pi-esp-assistant')].find(n=>n.textContent.includes('Oversize 31'));return !!row&&!row.querySelector('table')&&row.textContent.includes('| Base |')"), true)
  await inFrame("const log=d.querySelector('.pi-esp-scroll');p.run=log.querySelector('.pi-esp-run');p.tool=p.run.querySelector('.pi-esp-tool');p.run.open=p.tool.open=true;return true")
  // Native details fire toggle asynchronously; settle the initial content before measuring.
  await until(() => inFrame("return p.tool.querySelector('.pi-esp-output')?.textContent==='docs/README.md'"))
  await settledLayout()
  await inFrame("d.querySelector('.pi-esp-scroll').scrollTop=250;return true")
  await until(() => inFrame("return !d.querySelector('.pi-esp-jump').hidden"))
  await inFrame("const log=d.querySelector('.pi-esp-scroll'),top=log.getBoundingClientRect().top;p.anchor=[...log.querySelectorAll('[data-esp-anchor]')].find(n=>n.getClientRects().length&&n.getBoundingClientRect().bottom>top);p.anchorTop=p.anchor.getBoundingClientRect().top-top;p.delta=true;return true")
  await until(() => inFrame("return [...d.querySelectorAll('.pi-esp-assistant strong')].some(n=>n.textContent==='result')"))
  assert.deepEqual(await inFrame("const log=d.querySelector('.pi-esp-scroll'),run=log.querySelector('.pi-esp-run'),tools=run.querySelectorAll('.pi-esp-tool');return {sameRun:p.run===run,sameTool:p.tool===tools[0],open:run.open&&p.tool.open,states:[...tools].map(n=>n.querySelector('.pi-esp-tool-state').textContent),output:p.tool.textContent.includes('Deliberate fixture error.'),notice:log.querySelector('.pi-esp-notice').textContent,shell:[...log.querySelectorAll('.pi-esp-tool-target')].at(-1).textContent,anchor:Math.abs(p.anchor.getBoundingClientRect().top-log.getBoundingClientRect().top-p.anchorTop)<=1,jump:!d.querySelector('.pi-esp-jump').hidden,noOverflow:d.documentElement.scrollWidth<=d.documentElement.clientWidth+1}"), { sameRun: true, sameTool: true, open: true, states: ['Failed', 'Recorded'], output: true, notice: 'Context compacted', shell: 'printf fixture', anchor: true, jump: true, noOverflow: true })
  assert.equal(await inFrame("const jump=d.querySelector('.pi-esp-jump');jump.focus();jump.click();return jump.hidden&&d.activeElement===d.querySelector('.pi-esp-scroll')"), true)
  await inFrame("p.run.open=false;return true")
  await until(() => inFrame("const log=d.querySelector('.pi-esp-scroll');return log.scrollHeight-log.clientHeight-log.scrollTop<=1"))
  await settledLayout()
  await inFrame("p.run.open=true;return true")
  await until(() => inFrame("const log=d.querySelector('.pi-esp-scroll');return log.scrollHeight-log.clientHeight-log.scrollTop<=1&&d.querySelector('.pi-esp-jump').hidden&&p.tool.querySelector('.pi-esp-tool-full-name')?.textContent==='read'"))
  await inFrame("const log=d.querySelector('.pi-esp-scroll');log.scrollTop=240;p.resizeTop=log.scrollTop;return true")
  await until(() => inFrame("return !d.querySelector('.pi-esp-jump').hidden"))
  await inFrame("p.run.open=false;return true")
  await until(() => inFrame("return !d.querySelector('.pi-esp-jump').hidden&&Math.abs(d.querySelector('.pi-esp-scroll').scrollTop-p.resizeTop)<=1"))
  if (process.argv.includes('--capture')) {
    await inFrame("d.getElementById('pi-live').scrollIntoView({block:'start'});d.querySelector('.pi-esp-scroll').scrollTop=0;return true")
    console.log(JSON.stringify({ view: 'Live Pi synthetic fixture', screenshot: await orca(['screenshot', '--page', page]) }))
  }
  const stopsMatch = count => inFrame(`const starts=p.calls.filter(c=>c.name==='pi-live.start'),stops=p.calls.filter(c=>c.name==='pi-live.stop');return p.active===null&&starts.length===${count}&&stops.length===${count}&&stops.every((c,i)=>c.input.id===starts[i].input.id)`)
  await inFrame("d.getElementById('refresh-pods').click();return true")
  await until(() => inFrame("return !p.opener.isConnected&&!d.getElementById('refresh-pods').disabled&&!d.getElementById('pi-live').hidden"))
  await inFrame("const close=d.getElementById('pi-live-close');close.focus();close.click();return true")
  await until(() => inFrame("return d.activeElement===[...d.querySelectorAll('#live-seats button')].find(b=>b.textContent==='Open Live Pi')"))
  await until(() => stopsMatch(1))
  await inFrame("[...d.querySelectorAll('#live-seats button')].find(b=>b.textContent==='Open Live Pi').click();return true")
  await until(() => inFrame("return d.querySelector('.pi-esp-user-bubble')!==null"))
  await inFrame("d.getElementById('pi-live-close').focus();const select=d.getElementById('dashboard-pod');select.value='';select.dispatchEvent(new Event('change'));return true")
  await until(() => inFrame("return d.activeElement.id==='view-dashboard'&&d.getElementById('pi-live').hidden"))
  await until(() => inFrame("return d.getElementById('pi-live').hidden&&d.querySelector('.pi-esp-feed').childElementCount===0"))
  await until(() => stopsMatch(2))
  const selectPod = () => inFrame(`const select=d.getElementById('dashboard-pod');select.value=${JSON.stringify(pod.key)};select.dispatchEvent(new Event('change'));return true`)
  const liveButtonReady = () => inFrame("return [...d.querySelectorAll('#live-seats button')].some(b=>b.textContent==='Open Live Pi'&&!b.disabled)")
  await selectPod(); await until(liveButtonReady)
  await inFrame("const b=d.querySelector('#live-seats [data-live-seat]'),select=d.getElementById('dashboard-pod');b.focus();select.value='';select.dispatchEvent(new Event('change'));return true")
  await until(() => inFrame("return d.activeElement.id==='view-dashboard'&&!d.querySelector('#live-seats [data-live-seat]')"))
  await selectPod(); await until(liveButtonReady)
  await inFrame("[...d.querySelectorAll('#live-seats button')].find(b=>b.textContent==='Open Live Pi').click();return true")
  await until(() => inFrame("return d.querySelector('.pi-esp-user-bubble')!==null"))
  await inFrame("f.style.display='none';return true")
  await until(() => inFrame("return d.querySelector('.pi-esp-feed').childElementCount===0"))
  await until(() => stopsMatch(3))
  const reads = await inFrame("return p.calls.filter(c=>c.name==='pi-live.read').length")
  await delay(2200)
  assert.equal(await inFrame("return p.calls.filter(c=>c.name==='pi-live.read').length"), reads)
  console.log('PASS: Native Chat right-aligned prompts, inert inline Markdown, collapsed tool runs, in-place results, notices and shell rows, scroll anchoring, exact scope, selection reset and hidden-panel cancellation.')
} catch (error) {
  browserFailure = error
  throw error
} finally {
  try { if (page) await orca(['tab', 'close', '--page', page]) }
  catch (error) { if (browserFailure) throw new AggregateError([browserFailure, error], 'The browser test and tab cleanup both failed.'); throw error }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
