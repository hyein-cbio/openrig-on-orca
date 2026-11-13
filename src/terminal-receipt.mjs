// Recording metadata is secondary to an already accepted terminal operation.
export async function persistTerminalReceipt(storage, key, value, receipt) {
  try { await storage.set(key, value); return receipt }
  catch {
    const warning = 'The terminal was opened, but its metadata could not be saved. Inspect that terminal before retrying; use OpenRig directly if the example record is unavailable.'
    return { ...receipt, warning }
  }
}
