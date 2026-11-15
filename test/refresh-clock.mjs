export function testClock() {
  let time = 1000000, next = 0
  const timers = new Map()
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return { now: () => time, setTimeout: (callback, delay) => { const id = ++next; timers.set(id, { at: time + delay, callback }); return id }, clearTimeout: id => timers.delete(id),
    async advance(ms) {
      const target = time + ms
      for (;;) {
        const found = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target)
        if (!found) break
        time = found[1].at; timers.delete(found[0]); void found[1].callback(); await flush()
      }
      time = target; await flush()
    }, flush, pending: () => timers.size }
}
