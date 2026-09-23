export interface AgentInvocation {
  command: string;
  args: string[];
}

/** Generated tools pass user input as argv, never as shell program text. */
export function agentInvocation(
  style: 'local' | 'global',
  local: AgentInvocation,
  platform = process.platform,
): AgentInvocation {
  if (style === 'local') return local;
  // Windows npm command shims require cmd.exe. Use the installed entry point
  // directly instead, retaining the Node launcher and its loader arguments.
  return platform === 'win32' ? local : { command: 'lat', args: [] };
}
