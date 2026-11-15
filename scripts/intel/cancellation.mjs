import { spawn } from 'node:child_process'

// Every command group is created here; never enumerate or signal unrelated host processes.
export function createHarnessCancellation({ processTarget = process, graceMs = 1000 } = {}) {
  const controller = new AbortController(), active = new Set()
  let signal, cleaning = false
  const group = process.platform !== 'win32'
  const cancelledError = () => Object.assign(new Error('Intel live test cancelled: ' + signal), { name: 'AbortError' })
  const throwIfCancelled = () => { if (signal && !cleaning) throw cancelledError() }
  function cancel(value) {
    if (signal) return
    signal = value
    processTarget.exitCode = 1
    for (const command of active) if (!command.cleanup) command.stop()
    controller.abort(cancelledError())
  }
  const listeners = new Map(['SIGTERM', 'SIGINT', 'SIGHUP'].map(value => [value, () => cancel(value)]))
  for (const [name, handler] of listeners) processTarget.on(name, handler)

  // execFile-compatible interface, using spawn because execFile does not forward detached.
  function execFile(file, args = [], options = {}, callback) {
    throwIfCancelled()
    const command = { cleanup: cleaning }
    let resolveClosed, stopTimer, timeoutTimer, failure, stdoutBytes = 0, stderrBytes = 0
    const stdout = [], stderr = [], maxBuffer = options.maxBuffer ?? 1024 * 1024
    command.closed = new Promise(resolve => { resolveClosed = resolve })
    const send = value => {
      if (!command.child?.pid) return
      try {
        if (group) process.kill(-command.child.pid, value)
        else command.child.kill(value)
      } catch (error) { if (error.code !== 'ESRCH') failure ||= error }
    }
    command.stop = () => {
      if (command.stopped) return
      // Wait for escalation as well as child close: a command may have its own children.
      command.stopped = new Promise(resolve => {
        send('SIGTERM')
        stopTimer = setTimeout(() => { send('SIGKILL'); resolve() }, graceMs)
      })
    }
    const commandSignal = cleaning ? options.signal : options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    command.child = spawn(file, args, { ...options, timeout: undefined, detached: group, signal: commandSignal })
    active.add(command)
    const collect = (chunks, stream) => chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (stream === 'stdout') stdoutBytes += bytes.length
      else stderrBytes += bytes.length
      if ((stream === 'stdout' ? stdoutBytes : stderrBytes) <= maxBuffer) chunks.push(bytes)
      else {
        failure ||= Object.assign(new Error('Intel harness command exceeded maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
        command.stop()
      }
    }
    command.child.stdout.on('data', collect(stdout, 'stdout'))
    command.child.stderr.on('data', collect(stderr, 'stderr'))
    command.child.once('error', error => { failure ||= error; command.stop() })
    command.child.once('close', async (code, exitSignal) => {
      clearTimeout(timeoutTimer)
      if (command.stopped) await command.stopped
      clearTimeout(stopTimer)
      if (!failure && code !== 0) failure = Object.assign(new Error('Intel harness command failed'), { code, signal: exitSignal, killed: Boolean(exitSignal) })
      const output = chunks => options.encoding === null ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(options.encoding || 'utf8')
      active.delete(command)
      try { callback?.(failure, output(stdout), output(stderr)) } finally { resolveClosed() }
    })
    if (options.timeout > 0) timeoutTimer = setTimeout(() => {
      failure ||= Object.assign(new Error('Intel harness command timed out'), { code: 'ETIMEDOUT', killed: true })
      command.stop()
    }, options.timeout)
    return command.child
  }
  const waitForCommands = () => Promise.all([...active].map(command => command.closed))
  const execute = (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
  return {
    execFile, execute, throwIfCancelled,
    get signal() { return signal },
    async beginCleanup() {
      await waitForCommands()
      cleaning = true
    },
    finishCleanup: waitForCommands,
    dispose() { for (const [name, handler] of listeners) processTarget.removeListener(name, handler) }
  }
}
