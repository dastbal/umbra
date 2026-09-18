import { classifySmallTalk, type SmallTalkKind } from '../../core/agent/task-classifier';
import { suggestSlashCommands, type SlashCommand } from './slash-commands';
import { colors } from './theme';

/** Prints a local acknowledgement for conversational input that does not need an agent turn. */
export function replyToSmallTalk(kind: SmallTalkKind): void {
  const lines: Record<SmallTalkKind, string> = {
    greeting: 'Ready when you are. Describe a task, or type /help.',
    thanks: 'Any time.',
    farewell: 'Still here — type /exit to close the session.',
  };

  console.log('');
  console.log(`  ${colors.primary('⬡')}  ${lines[kind]}`);
  console.log('');
}

/** Answers small talk locally and reports whether the input must stay out of the agent loop. */
export function handleSmallTalk(input: string): boolean {
  const kind = classifySmallTalk(input);
  if (kind === null) return false;
  replyToSmallTalk(kind);
  return true;
}

/** Prints an unknown-command explanation with nearest command suggestions. */
export function reportUnknownCommand(commands: readonly SlashCommand[], input: string): void {
  const near = suggestSlashCommands(commands, input);
  console.log('');
  console.log(colors.warning(`  Unknown command: ${input}`));
  if (near.length > 0) {
    console.log(colors.muted(`  Did you mean: ${near.map((command) => command.name).join(', ')}`));
  } else {
    console.log(colors.muted('  Type /help to see the available commands.'));
  }
  console.log('');
}

/** Displays the static slash-command list for non-interactive help. */
export function showHelp(commands: readonly SlashCommand[], mentorModeActive: boolean): void {
  const width = Math.max(...commands.map((command) => command.name.length));

  console.log('');
  console.log(colors.secondary.bold('  Available slash commands:'));
  for (const command of commands) {
    const badge = command.badge?.() ?? '';
    const styledBadge = badge
      ? (mentorModeActive ? colors.accent.bold(badge) : colors.muted(badge))
      : '';
    const name = colors.primary.bold(command.name.padEnd(width));
    console.log(`  ${name}${styledBadge}  — ${command.description}`);
  }
  console.log(`  ${colors.muted('Ctrl+C'.padEnd(width))}  — Exit the session`);
  console.log('');
}
