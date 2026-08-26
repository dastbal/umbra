/**
 * @module SlashCommands
 *
 * The single registry of chat slash commands.
 *
 * Every surface that needs to know what commands exist derives from this file:
 * the dispatcher that runs them, the interactive `/help` picker, the static
 * `/help` text, and — once it exists — Tab completion and the `/` palette.
 *
 * ## Why a registry
 *
 * Before this module the command list was written out in four places: the
 * dispatcher's `if` chain, the picker's rows, the help text, and a TSDoc list.
 * Adding a command meant four edits, and missing one failed *silently* — a
 * command absent from the dispatcher is unreachable, and a command absent from
 * the picker is undiscoverable. Neither breaks a test or a build. The lists had
 * already drifted.
 *
 * With one registry, adding a command is one entry, and every surface updates
 * with it. That is what makes the `/` palette cheap to add later rather than a
 * fifth copy of the same list.
 *
 * ## Why a host interface
 *
 * The commands need to *do* things that live on `ChatSession` — swap the model,
 * toggle mentor mode, end the session. Taking a {@link SlashCommandHost} instead
 * of importing `ChatSession` keeps the dependency pointing one way and lets the
 * registry be tested with a fake host, with no agent and no terminal.
 *
 * @example
 * ```ts
 * const commands = buildSlashCommands(host);
 * const command = findSlashCommand(commands, '/model');
 * if (command) await command.run();
 * ```
 */

/**
 * The capabilities a slash command may invoke on its owning session.
 *
 * Implemented by `ChatSession`. Each member is one thing a command can do, so
 * a new command that needs a new capability adds a member here and the compiler
 * points at the implementation.
 */
export interface SlashCommandHost {
  /** Opens the model switcher and hot-swaps the agent. */
  switchModel(): Promise<void>;
  /** Turns deep mentor mode on or off. */
  toggleMentor(): Promise<void>;
  /** Opens the interactive command picker. */
  openCommandPicker(): Promise<void>;
  /** Prints the static command list. */
  printHelp(): void;
  /** Ends the session. */
  exitSession(): void;
  /** Whether deep mentor mode is currently on. Used for a live hint. */
  isMentorActive(): boolean;
}

/**
 * One chat slash command.
 */
export interface SlashCommand {
  /** What the user types, leading slash included. */
  name: string;
  /** One-line description, shown in the static help text. */
  description: string;
  /**
   * Whether the command appears in the interactive picker.
   *
   * `/help` sets this to `false`: it is the command that *opens* the picker, so
   * listing it inside itself is a loop with nothing to offer.
   */
  inPicker: boolean;
  /** Runs the command. */
  run(): Promise<void> | void;
  /**
   * Optional live detail for the picker row, evaluated at open time so it can
   * reflect current state (mentor mode being on, for instance).
   *
   * @returns The hint text.
   */
  hint?(): string;
  /**
   * Optional live suffix for the static help line, such as an on/off badge.
   *
   * @returns The badge text, already styled by the caller's convention.
   */
  badge?(): string;
}

/**
 * Builds the command registry bound to a session.
 *
 * @param host - The session capabilities the commands act through.
 * @returns Every command, in the order they should be presented.
 */
export function buildSlashCommands(host: SlashCommandHost): SlashCommand[] {
  return [
    {
      name: '/model',
      description: 'Switch the active LLM model (Ollama / Vertex AI)',
      inPicker: true,
      hint: () => 'switch the active LLM model',
      run: () => host.switchModel(),
    },
    {
      name: '/mentor',
      description: 'Toggle deep mentor mode (trade-offs, root causes, Socratic gates)',
      inPicker: true,
      hint: () =>
        host.isMentorActive()
          ? 'deep mentor mode is ON — turn it off'
          : 'deep mentor mode is OFF — turn it on',
      badge: () => (host.isMentorActive() ? ' [ON]' : ' [OFF]'),
      run: () => host.toggleMentor(),
    },
    {
      name: '/exit',
      description: 'End the session (same as Ctrl+C)',
      inPicker: true,
      hint: () => 'same as Ctrl+C',
      run: () => host.exitSession(),
    },
    {
      name: '/help',
      description: 'Show the available commands',
      // Excluded from the picker it opens — see `inPicker`.
      inPicker: false,
      run: () => host.openCommandPicker(),
    },
  ];
}

/**
 * Resolves typed input to a command.
 *
 * Matching is exact and case-insensitive. It is deliberately **not** a prefix
 * match: `/m` is ambiguous between `/model` and `/mentor`, and guessing which
 * one the user meant would silently run the wrong thing. Prefix handling
 * belongs in completion, which offers candidates instead of picking one.
 *
 * @param commands - The registry to search.
 * @param input - Raw user input, already trimmed.
 * @returns The matching command, or `undefined` when the input is not one.
 */
export function findSlashCommand(
  commands: SlashCommand[],
  input: string,
): SlashCommand | undefined {
  const normalized = input.toLowerCase();
  return commands.find((command) => command.name === normalized);
}

/**
 * Lists the commands a partially typed input could become.
 *
 * This is the primitive both Tab completion and a `/` palette need: given what
 * the user has typed so far, which commands are still reachable. A bare `/`
 * matches everything, which is what makes a palette possible without a second
 * source of truth.
 *
 * @param commands - The registry to search.
 * @param partial - What the user has typed so far, including the slash.
 * @returns The matching commands, registry order preserved.
 */
export function completeSlashCommand(
  commands: SlashCommand[],
  partial: string,
): SlashCommand[] {
  const normalized = partial.toLowerCase();
  if (!normalized.startsWith('/')) return [];
  return commands.filter((command) => command.name.startsWith(normalized));
}

/**
 * Edit distance that counts a transposition as one edit
 * (Damerau-Levenshtein, optimal string alignment variant).
 *
 * Used to suggest a command for a typo. Two choices here are deliberate:
 *
 * - **Not prefix matching.** A typo is rarely a prefix of what was meant —
 *   `/modle` shares nothing beyond `/mod` with `/model` — so a suggestion built
 *   on {@link completeSlashCommand} stays silent exactly when it is needed.
 * - **Not plain Levenshtein.** It scores a swapped pair as two edits, which
 *   pushes `/hlep` out of range of `/help`. Transposing two letters is the most
 *   common keyboard slip there is, so counting it as one edit is the difference
 *   between a suggestion that fires and one that does not.
 *
 * Keeps three rows rather than a full matrix; the transposition case is the
 * reason two previous rows are needed instead of one.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns The minimum number of edits, a transposition counting as one.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        current[j - 1] + 1,      // insertion
        previous[j] + 1,         // deletion
        previous[j - 1] + cost,  // substitution
      );
      // Transposition: the two characters are swapped relative to each other.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, twoBack[j - 2] + 1);
      }
      current[j] = best;
    }
    twoBack = previous;
    previous = current;
  }

  return previous[b.length];
}

/**
 * Suggests the commands a mistyped input most likely meant.
 *
 * Prefix matches come first — an incomplete command is a stronger signal than a
 * misspelled one — followed by near misses by edit distance. The threshold
 * scales with length so short names do not match everything: two edits on a
 * six-character command is a plausible slip, on a three-character one it is a
 * different word.
 *
 * @param commands - The registry to search.
 * @param input - The unrecognised input, including the slash.
 * @returns The suggested commands, most likely first. Empty when nothing is close.
 */
export function suggestSlashCommands(
  commands: SlashCommand[],
  input: string,
): SlashCommand[] {
  const normalized = input.toLowerCase();
  if (!normalized.startsWith('/')) return [];

  const prefixMatches = completeSlashCommand(commands, normalized);
  if (prefixMatches.length > 0) return prefixMatches;

  const threshold = Math.max(1, Math.floor(normalized.length / 3));

  return commands
    .map((command) => ({ command, distance: editDistance(normalized, command.name) }))
    .filter(({ distance }) => distance <= threshold)
    .sort((x, y) => x.distance - y.distance)
    .map(({ command }) => command);
}

/**
 * The shape `readline` expects from a completer: the candidates, and the
 * substring they replace.
 */
export type Completer = (line: string) => [string[], string];

/**
 * Builds a Tab-completion function for `readline`.
 *
 * `readline` calls this with the line typed so far. Returning one candidate
 * makes Tab complete it; returning several makes Tab list them and fill in the
 * longest common prefix. Returning none leaves the line untouched, which is
 * what must happen for ordinary prose — `arreglá /src/app.ts` is a prompt, not
 * a half-typed command, and Tab has no business rewriting it.
 *
 * This is deliberately built on {@link completeSlashCommand} rather than on its
 * own list: Tab is the fourth surface to read the registry, and the reason the
 * registry exists is that the fourth copy of a list is the one that goes stale.
 *
 * Note this is completion, not resolution: it offers candidates and never picks
 * one. Ambiguity is the user's to settle — see {@link findSlashCommand}.
 *
 * @param commands - The registry to complete against.
 * @returns A completer suitable for `readline`'s `completer` option.
 */
export function buildSlashCompleter(commands: SlashCommand[]): Completer {
  return (line: string) => {
    const candidates = completeSlashCommand(commands, line).map((c) => c.name);
    return [candidates, line];
  };
}

/**
 * Reports whether input looks like an attempt at a slash command.
 *
 * Used to tell an unknown command apart from an ordinary message, so a typo
 * such as `/modle` can be answered with a correction instead of being sent to
 * the agent as a prompt.
 *
 * @param input - Raw user input, already trimmed.
 * @returns True when the input starts with a slash and has no whitespace.
 */
export function looksLikeSlashCommand(input: string): boolean {
  return input.startsWith('/') && !/\s/.test(input);
}
