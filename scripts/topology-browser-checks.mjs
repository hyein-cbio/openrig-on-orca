import assert from 'node:assert/strict'

// Synthetic snapshots only; no plugin bridge, native reads, agent sessions or writes.
// Shared by the disposable live suite and the standalone browser regression runner.
export async function checkTopologyDrilldown(evaluate, until, capture = async () => {}) {
  const ids = ['root', 'hub', ...Array.from({ length: 7 }, (_, i) => `worker${i}`), ...Array.from({ length: 7 }, (_, i) => `nested${i}`)]
  const seats = ids.map(id => ({ key: JSON.stringify(['topology-fixture', id]), rigId: 'topology-fixture', rigName: 'Topology fixture',
    logicalId: id, podId: 'fixture-pod', podNamespace: 'fixture', runtime: 'pi', model: 'fixture-model', status: 'running', activity: 'idle', attention: false }))
  const pod = { key: JSON.stringify(['topology-fixture', 'fixture-pod']), rigId: 'topology-fixture', rigName: 'Topology fixture', podId: 'fixture-pod', namespace: 'fixture', label: 'Topology fixture / fixture' }
  const key = id => seats.find(seat => seat.logicalId === id).key
  const relations = { podKey: pod.key, status: 'complete', observedAt: 1000, notes: [], edges: [
    { fromKey: key('root'), toKey: key('hub'), kind: 'delegates_to' },
    ...Array.from({ length: 7 }, (_, i) => ({ fromKey: key('hub'), toKey: key(`worker${i}`), kind: 'delegates_to' })),
    ...Array.from({ length: 7 }, (_, i) => ({ fromKey: key('worker0'), toKey: key(`nested${i}`), kind: 'delegates_to' })),
    { fromKey: key('worker1'), toKey: key('hub'), kind: 'feedback' }
  ] }
  const expression = body => evaluate(`(async()=>{${body}})()`)
  const display = async ({ members = seats, edges = relations, instance = 'fixture-instance', stamp = 1000, selectedPod = pod } = {}) => expression(`const m=await import('/visualizer/app.mjs');m.displayPodSnapshot(${JSON.stringify(selectedPod)},${JSON.stringify(members)},${stamp},${JSON.stringify(edges)},{seatsStale:false,relationsStale:false},${JSON.stringify(instance)});return JSON.stringify(true)`)
  const inspect = () => evaluate(`JSON.stringify({path:document.getElementById('topology-path').textContent,summary:document.getElementById('topology-view-summary').textContent,mainHidden:document.getElementById('topology-main').hidden,backHidden:document.getElementById('topology-back').hidden,nodes:[...document.querySelectorAll('#diagram g.node')].map(n=>n.getAttribute('aria-label')),code:document.getElementById('mermaid-source').value,error:!document.getElementById('error').hidden,selected:document.getElementById('agent-name').textContent})`)
  const expectView = async (path, count) => until(async () => {
    const value = await inspect()
    assert.equal(value.error, false); assert.equal(value.path, path); assert.equal(value.nodes.length, count)
    return value
  })
  const activate = (id, keyboard = false) => expression(`const n=[...document.querySelectorAll('#diagram g.node')].find(n=>n.getAttribute('aria-label').startsWith(${JSON.stringify(`View downstream structure of hub ${id};`)}));if(!n)throw Error('Fixture hub not found');n.dispatchEvent(${keyboard ? `new KeyboardEvent('keydown',{key:${JSON.stringify(keyboard === true ? 'Enter' : keyboard)},bubbles:true})` : "new MouseEvent('click',{bubbles:true})"});return JSON.stringify(true)`)
  const click = id => evaluate(`JSON.stringify(document.getElementById(${JSON.stringify(id)}).click() || true)`)

  await display(); await expectView('Main', 2)
  await expression(`const m=await import('/visualizer/app.mjs');window.topologyNavigationReports=0;m.setReportReader(async()=>{window.topologyNavigationReports++;return {status:'unverified',detail:'Fixture preview'}});return JSON.stringify(true)`)
  let value = await inspect()
  assert.equal(value.mainHidden, true); assert.equal(value.code.includes('worker0'), false)
  assert.match(value.summary, /14 nodes beyond hubs/)
  await capture('main')
  await click('zoom-in')
  await expression(`window.topologyMainCamera={width:document.querySelector('#diagram svg').style.width,left:document.getElementById('viewport').scrollLeft,top:document.getElementById('viewport').scrollTop,viewBox:document.querySelector('#diagram svg').getAttribute('viewBox'),direction:document.getElementById('direction').value,viewportWidth:document.getElementById('viewport').clientWidth};return JSON.stringify(true)`)

  await activate('hub'); await expectView('Main → hub', 8)
  value = await inspect()
  assert.equal(value.mainHidden, false); assert.equal(value.backHidden, true); assert.equal(value.code.startsWith('flowchart TB'), true)
  assert.match(value.summary, /1 arrows into the focus root not drawn/)
  // Test geometry, not merely a direction string: the focus root must be above every child.
  const centers = await evaluate(`JSON.stringify([...document.querySelectorAll('#diagram g.node')].map(n=>{const r=n.getBoundingClientRect();return {label:n.getAttribute('aria-label'),y:r.y+r.height/2}}))`)
  const rootY = centers.find(node => node.label === 'Inspect hub').y
  assert.ok(centers.filter(node => node.label !== 'Inspect hub').every(node => node.y > rootY + 10), 'Focus hub must be above all displayed descendants')
  const layout = await expression(`const v=document.getElementById('viewport'),s=document.querySelector('#diagram svg'),nodes=[...document.querySelectorAll('#diagram g.node')],r=nodes.find(n=>n.getAttribute('aria-label')==='Inspect hub').getBoundingClientRect(),b=v.getBoundingClientRect(),left=v.scrollLeft,top=v.scrollTop;v.scrollTo({left:0,top});const first=Math.min(...nodes.map(n=>n.getBoundingClientRect().left));v.scrollTo({left:v.scrollWidth,top});const last=Math.max(...nodes.map(n=>n.getBoundingClientRect().right));v.scrollTo({left,top});return JSON.stringify({scale:parseFloat(s.style.width)/s.viewBox.baseVal.width,rootVisible:r.left>=b.left&&r.right<=b.right&&r.top>=b.top&&r.bottom<=b.bottom,firstReachable:first>=b.left,lastReachable:last<=b.right})`)
  assert.ok(layout.scale >= .799, 'Focused labels must not shrink to a miniature')
  assert.equal(layout.rootVisible, true); assert.equal(layout.firstReachable, true); assert.equal(layout.lastReachable, true)

  await capture('hub')
  await activate('worker0', true); await expectView('Main → hub → worker0', 8)
  value = await inspect(); assert.equal(value.backHidden, false); assert.equal(value.selected, 'worker0')
  await capture('nested-hub')
  assert.equal(await evaluate('JSON.stringify(window.topologyNavigationReports)'), 0, 'Programmatic navigation focus must not request a report')
  await click('topology-back'); await expectView('Main → hub', 8)

  // Identical observations preserve the SVG object, zoom, selection and navigation.
  await click('zoom-in')
  await expression(`window.topologyRefreshSvg=document.querySelector('#diagram svg');window.topologyRefreshWidth=window.topologyRefreshSvg.style.width;window.topologyRefreshSelected=document.getElementById('agent-name').textContent;return JSON.stringify(true)`)
  await display({ stamp: 61000, edges: { ...relations, observedAt: 61000 } })
  assert.equal(await evaluate(`JSON.stringify(window.topologyRefreshSvg===document.querySelector('#diagram svg')&&window.topologyRefreshWidth===window.topologyRefreshSvg.style.width&&window.topologyRefreshSelected===document.getElementById('agent-name').textContent)`), true)
  await expectView('Main → hub', 8)

  // Changed/reordered membership regenerates agent_N IDs, but not the semantic focus.
  await display({ members: [...seats].reverse().map(seat => ({ ...seat, activity: 'working' })) })
  await expectView('Main → hub', 8)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(window.topologyRefreshSvg!==document.querySelector('#diagram svg'))`), true))
  const reorderedCenters = await evaluate(`JSON.stringify([...document.querySelectorAll('#diagram g.node')].map(n=>({label:n.getAttribute('aria-label'),y:n.getBoundingClientRect().y})))`)
  assert.ok(reorderedCenters.filter(node => node.label !== 'Inspect hub').every(node => node.y > reorderedCenters.find(node => node.label === 'Inspect hub').y))

  // Partial is an observation state, not a collapsed/empty graph claim.
  await display({ edges: { ...relations, status: 'partial', notes: ['Fixture relationship coverage is incomplete'] } })
  await expectView('Main → hub', 8)
  assert.equal(await evaluate(`JSON.stringify(document.getElementById('edge-count').textContent.includes('observed')&&document.getElementById('warnings').textContent.includes('incomplete'))`), true)

  // A completeness-only refresh must preserve geometry but update exported metadata.
  await expression(`window.topologyPartialSvg=document.querySelector('#diagram svg');return JSON.stringify(true)`)
  await display()
  assert.equal(await evaluate(`JSON.stringify(window.topologyPartialSvg===document.querySelector('#diagram svg')&&document.querySelector('#diagram svg > desc').textContent.includes('Relationship observation: complete'))`), true)
  await display({ edges: { ...relations, status: 'partial', notes: ['Fixture relationship coverage is incomplete'] } })
  assert.equal(await evaluate(`JSON.stringify(window.topologyPartialSvg===document.querySelector('#diagram svg')&&document.querySelector('#diagram svg > desc').textContent.includes('Relationship observation: partial'))`), true)

  // Export includes the scope, but never nodes hidden below the next hub.
  await expression(`window.topologyOriginalOrca=window.orca;window.topologyExport=null;window.orca={...(window.orca||{}),files:{saveAs:async value=>{window.topologyExport=value;return {status:'cancelled'}}}};return JSON.stringify(true)`)
  await click('export')
  await until(async () => assert.equal(await evaluate(`JSON.stringify(Boolean(window.topologyExport))`), true))
  const exported = await evaluate('JSON.stringify(window.topologyExport.data)')
  assert.match(exported, /Subdiagram: hub/); assert.match(exported, /nodes beyond hubs/); assert.match(exported, /Relationship observation: partial/)
  assert.equal(exported.includes('nested0'), false)

  await click('topology-main'); await expectView('Main', 2)
  const restoredCamera = await evaluate(`JSON.stringify({actual:{width:document.querySelector('#diagram svg').style.width,left:document.getElementById('viewport').scrollLeft,top:document.getElementById('viewport').scrollTop,viewBox:document.querySelector('#diagram svg').getAttribute('viewBox'),direction:document.getElementById('direction').value,viewportWidth:document.getElementById('viewport').clientWidth},expected:window.topologyMainCamera})`)
  assert.deepEqual(restoredCamera.actual, restoredCamera.expected, 'Back to main restores its camera')

  // Hold the actual Mermaid promise to exercise both review-reported races,
  // rather than relying on a click/refresh happening to land in a narrow window.
  const pauseRender = () => expression(`const m=(await import('/visualizer/mermaid/mermaid.esm.min.mjs')).default,original=m.render;window.topologyRenderRace={started:false,finished:false,errors:[],mermaid:m,original};const state=window.topologyRenderRace,gate=new Promise(resolve=>{state.release=resolve});state.onError=event=>state.errors.push(event.message);window.addEventListener('error',state.onError);m.render=async(...args)=>{m.render=original;state.started=true;await gate;try{return await original.apply(m,args)}finally{state.finished=true}};return JSON.stringify(true)`)
  const renderStarted = () => until(async () => assert.equal(await evaluate('JSON.stringify(window.topologyRenderRace.started)'), true))
  const releaseRender = () => evaluate('JSON.stringify(window.topologyRenderRace.release() || true)')
  const cleanupRender = () => expression(`const state=window.topologyRenderRace;state.release();state.mermaid.render=state.original;window.removeEventListener('error',state.onError);delete window.topologyRenderRace;return JSON.stringify(true)`)

  await pauseRender()
  try {
    await expression(`window.topologyOldHub=[...document.querySelectorAll('#diagram g.node')].find(n=>n.getAttribute('aria-label').startsWith('View downstream structure of hub hub;'));window.topologyRaceSvg=document.querySelector('#diagram svg');return JSON.stringify(true)`)
    await display({ members: seats.filter(seat => seat.logicalId !== 'hub') }); await renderStarted()
    await expression(`window.topologyOldHub.dispatchEvent(new MouseEvent('click',{bubbles:true}));return JSON.stringify(true)`)
    await releaseRender(); await expectView('Main', 8)
    assert.equal(await evaluate(`JSON.stringify(window.topologyRenderRace.finished&&window.topologyRaceSvg!==document.querySelector('#diagram svg')&&window.topologyRenderRace.errors.length===0)`), true, 'An old hub click must not cancel the refreshed SVG or throw')
  } finally { await cleanupRender() }

  await display(); await expectView('Main', 2)
  await pauseRender()
  try {
    await expression(`window.topologyRaceSvg=document.querySelector('#diagram svg');document.getElementById('direction').dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(true)`)
    await renderStarted()
    await display({ edges: { ...relations, status: 'partial', notes: ['Latest in-flight observation'] } })
    assert.equal(await evaluate(`JSON.stringify(window.topologyRaceSvg===document.querySelector('#diagram svg')&&document.getElementById('topology-view-summary').textContent.includes('Relationship observation: partial'))`), true)
    await releaseRender()
    await until(async () => assert.equal(await evaluate(`JSON.stringify(window.topologyRenderRace.finished&&window.topologyRaceSvg!==document.querySelector('#diagram svg'))`), true))
    assert.equal(await evaluate(`JSON.stringify(document.getElementById('topology-view-summary').textContent.includes('Relationship observation: partial')&&document.querySelector('#diagram svg > desc').textContent.includes('Relationship observation: partial')&&document.querySelector('#diagram svg').getAttribute('aria-label').includes('Relationship observation: partial')&&window.topologyRenderRace.errors.length===0)`), true, 'A pending redraw must not restore older completeness metadata')
    await expression(`window.topologyExport=null;return JSON.stringify(true)`); await click('export')
    await until(async () => assert.equal(await evaluate(`JSON.stringify(window.topologyExport?.data.includes('Relationship observation: partial'))`), true))
  } finally { await cleanupRender() }

  // A vanished hub resets to main with an explanation, never another agent_N node.
  await display(); await activate('hub'); await expectView('Main → hub', 8)
  await display({ members: seats.filter(seat => seat.logicalId !== 'hub') })
  await until(async () => { const result = await inspect(); assert.equal(result.path, 'Main'); assert.match(result.summary, /no longer in this snapshot/); assert.equal(result.mainHidden, true) })

  // Even identical geometry in another instance must reset the navigation scope.
  await display(); await expectView('Main', 2); await activate('hub'); await expectView('Main → hub', 8)
  await display({ instance: 'another-fixture-instance' }); await expectView('Main', 2)
  await activate('hub', ' '); await expectView('Main → hub', 8)
  const otherPod = { ...pod, key: JSON.stringify([pod.rigId, 'another-fixture-pod']), podId: 'another-fixture-pod' }
  await display({ instance: 'another-fixture-instance', selectedPod: otherPod, members: seats.map(seat => ({ ...seat, podId: otherPod.podId })), edges: { ...relations, podKey: otherPod.key } })
  await expectView('Main', 2)
  await display(); await expectView('Main', 2)

  // Rapid pending navigation must not allow an older Mermaid promise to win.
  await activate('hub'); await expectView('Main → hub', 8)
  await expression(`document.getElementById('topology-main').click();const m=await import('/visualizer/app.mjs');m.displayPodSnapshot(null);return JSON.stringify(true)`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(document.querySelector('#diagram svg')===null&&document.getElementById('topology-main').hidden&&document.getElementById('topology-path').textContent==='Main')`), true))

  // YAML uses the same drill-down projection; editing it must not navigate an old snapshot.
  const yaml = JSON.stringify({ name: 'YAML hub fixture', pods: [{ id: 'fixture', members: ids.map(id => ({ id, runtime: 'pi' })), edges: relations.edges.map(edge => ({ from: seats.find(seat => seat.key === edge.fromKey).logicalId, to: seats.find(seat => seat.key === edge.toKey).logicalId, kind: edge.kind })) }] })
  await expression(`document.getElementById('yaml-source').value=${JSON.stringify(yaml)};document.getElementById('render').click();return JSON.stringify(true)`)
  await expectView('Main', 2); await activate('hub'); await expectView('Main → hub', 8)
  await expression(`document.getElementById('yaml-source').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('topology-main').click();return JSON.stringify(true)`)
  value = await inspect(); assert.equal(value.path, 'Main → hub')
  assert.equal(await evaluate(`JSON.stringify(document.getElementById('export').disabled&&document.getElementById('topology-main').disabled)`), true)
  await click('render'); await expectView('Main', 2)
  await expression(`const m=await import('/visualizer/app.mjs');m.displayPodSnapshot(null);m.setReportReader(null);window.orca=window.topologyOriginalOrca;delete window.topologyOriginalOrca;delete window.topologyExport;return JSON.stringify(true)`)
}
