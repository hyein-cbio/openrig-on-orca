import { Button, Callout, Code, CodeView, Stack, Text } from 'orca'
import type { TerminalReceipt } from './protocol'

export function TerminalStatus({ receipt, busy, onReveal }: { receipt: TerminalReceipt; busy: boolean; onReveal: () => unknown }) {
  const shown = receipt.visibility === 'shown'
  return <Callout tone={shown ? 'neutral' : 'warning'} title={shown ? 'Terminal tab connected' : 'Terminal created · tab not verified'} icon="terminal">
    <Stack gap="sm">
      <Text>Created terminal {receipt.terminalId}{receipt.workspaceName ? ` in ${receipt.workspaceName}` : ''}. This is not proof that the command succeeded. Inspect its output, then Recheck environment.</Text>
      {receipt.title && <Text size="xs">Action: {receipt.title}</Text>}
      <Text size="xs">The destination workspace may differ from this panel’s current workspace. Do not repeat the original action just because its tab is hidden.</Text>
      {receipt.workspaceId && <Code>{receipt.workspaceId}</Code>}
      {receipt.visibilityDetail && <Text size="xs">{receipt.visibilityDetail}</Text>}
      {receipt.warning && <Text tone="warning">{receipt.warning}</Text>}
      <Button size="sm" variant="outline" disabled={busy} onPress={onReveal}>Show / recover existing terminal</Button>
      {receipt.recoveryCommand && <CodeView label="Manual terminal recovery · does not rerun the action" code={receipt.recoveryCommand} language="shell" wrap />}
    </Stack>
  </Callout>
}
