/**
 * Tests for the slash command registry.
 *
 * The registry exists to stop the command list from being restated per surface,
 * so the tests that matter most are the structural ones: every command is
 * reachable, every command is discoverable, and nothing can be listed without
 * being runnable.
 */

import {
  buildSlashCommands,
  findSlashCommand,
  completeSlashCommand,
  looksLikeSlashCommand,
  suggestSlashCommands,
  SlashCommandHost,
} from './slash-commands';

/** Records which host capability each command invoked. */
interface HostSpy {
  host: SlashCommandHost;
  calls: string[];
  mentorActive: boolean;
}

/**
 * Builds a host that records calls instead of touching a session.
 *
 * @param mentorActive - Initial mentor mode state.
 * @returns The spy handle.
 */
function makeHost(mentorActive = false): HostSpy {
  const spy: HostSpy = { calls: [], mentorActive, host: null as unknown as SlashCommandHost };
  spy.host = {
    switchModel:       async () => { spy.calls.push('switchModel'); },
    toggleMentor:      async () => { spy.calls.push('toggleMentor'); },
    openCommandPicker: async () => { spy.calls.push('openCommandPicker'); },
    printHelp:         () => { spy.calls.push('printHelp'); },
    exitSession:       () => { spy.calls.push('exitSession'); },
    isMentorActive:    () => spy.mentorActive,
  };
  return spy;
}

describe('the registry as the single source of truth', () => {
  it('makes every command reachable by the name it advertises', () => {
    // This is the drift the registry exists to prevent: a command that appears
    // in a list but that the dispatcher cannot resolve is silently unusable.
    const spy = makeHost();
    const commands = buildSlashCommands(spy.host);

    for (const command of commands) {
      expect(findSlashCommand(commands, command.name)).toBe(command);
    }
  });

  it('gives every command a runnable action', async () => {
    const spy = makeHost();
    const commands = buildSlashCommands(spy.host);

    for (const command of commands) {
      await command.run();
    }

    expect(spy.calls).toHaveLength(commands.length);
  });

  it('gives every command a name starting with a slash and a description', () => {
    const commands = buildSlashCommands(makeHost().host);

    for (const command of commands) {
      expect(command.name.startsWith('/')).toBe(true);
      expect(command.name).toBe(command.name.toLowerCase());
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate names', () => {
    const names = buildSlashCommands(makeHost().host).map((c) => c.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('offers every picker row a hint the picker can render', () => {
    const commands = buildSlashCommands(makeHost().host).filter((c) => c.inPicker);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect((command.hint?.() ?? command.description).length).toBeGreaterThan(0);
    }
  });

  it('keeps /help out of the picker it opens', () => {
    const commands = buildSlashCommands(makeHost().host);
    const help = findSlashCommand(commands, '/help');

    expect(help?.inPicker).toBe(false);
  });
});

describe('findSlashCommand', () => {
  it('routes each command to its own host capability', async () => {
    const spy = makeHost();
    const commands = buildSlashCommands(spy.host);

    await findSlashCommand(commands, '/model')!.run();
    await findSlashCommand(commands, '/mentor')!.run();
    await findSlashCommand(commands, '/help')!.run();
    await findSlashCommand(commands, '/exit')!.run();

    expect(spy.calls).toEqual([
      'switchModel', 'toggleMentor', 'openCommandPicker', 'exitSession',
    ]);
  });

  it('matches case-insensitively', () => {
    const commands = buildSlashCommands(makeHost().host);

    expect(findSlashCommand(commands, '/MODEL')?.name).toBe('/model');
  });

  it('does not resolve an ambiguous prefix', () => {
    // `/m` could be /model or /mentor. Guessing would silently run the wrong
    // command; offering candidates is completion's job, not the dispatcher's.
    const commands = buildSlashCommands(makeHost().host);

    expect(findSlashCommand(commands, '/m')).toBeUndefined();
  });

  it('does not resolve an unknown command', () => {
    const commands = buildSlashCommands(makeHost().host);

    expect(findSlashCommand(commands, '/modle')).toBeUndefined();
  });
});

describe('completeSlashCommand', () => {
  it('narrows as more is typed', () => {
    const commands = buildSlashCommands(makeHost().host);

    expect(completeSlashCommand(commands, '/m').map((c) => c.name))
      .toEqual(['/model', '/mentor']);
    expect(completeSlashCommand(commands, '/mo').map((c) => c.name))
      .toEqual(['/model']);
  });

  it('offers everything for a bare slash, which is what a palette needs', () => {
    const commands = buildSlashCommands(makeHost().host);

    expect(completeSlashCommand(commands, '/')).toHaveLength(commands.length);
  });

  it('offers nothing for input that is not a command attempt', () => {
    const commands = buildSlashCommands(makeHost().host);

    expect(completeSlashCommand(commands, 'model')).toEqual([]);
  });

  it('offers nothing for a prefix that matches no command', () => {
    const commands = buildSlashCommands(makeHost().host);

    expect(completeSlashCommand(commands, '/zzz')).toEqual([]);
  });
});

describe('suggestSlashCommands', () => {
  it('suggests the command a typo most likely meant', () => {
    // The case prefix matching cannot serve: `/modle` is not a prefix of
    // `/model`, so a prefix-only suggestion stays silent when it is needed.
    const commands = buildSlashCommands(makeHost().host);

    expect(suggestSlashCommands(commands, '/modle').map((c) => c.name))
      .toEqual(['/model']);
  });

  it('handles a missing character and a swapped pair', () => {
    const commands = buildSlashCommands(makeHost().host);

    expect(suggestSlashCommands(commands, '/moel')[0]?.name).toBe('/model');
    expect(suggestSlashCommands(commands, '/hlep')[0]?.name).toBe('/help');
  });

  it('prefers prefix matches over near misses', () => {
    const commands = buildSlashCommands(makeHost().host);

    // An incomplete command is a stronger signal than a misspelled one.
    expect(suggestSlashCommands(commands, '/me').map((c) => c.name))
      .toEqual(['/mentor']);
  });

  it('orders near misses by how close they are', () => {
    const commands = buildSlashCommands(makeHost().host);
    const suggestions = suggestSlashCommands(commands, '/mentr');

    expect(suggestions[0]?.name).toBe('/mentor');
  });

  it('stays silent when nothing is close', () => {
    const commands = buildSlashCommands(makeHost().host);

    expect(suggestSlashCommands(commands, '/deploy-to-production')).toEqual([]);
  });

  it('does not suggest for input that is not a command attempt', () => {
    const commands = buildSlashCommands(makeHost().host);

    expect(suggestSlashCommands(commands, 'model')).toEqual([]);
  });
});

describe('looksLikeSlashCommand', () => {
  it('accepts a slash-prefixed single word', () => {
    expect(looksLikeSlashCommand('/modle')).toBe(true);
  });

  it('rejects ordinary prose so a real prompt is never intercepted', () => {
    expect(looksLikeSlashCommand('create a UsersModule')).toBe(false);
    // A path or a sentence containing a slash is a prompt, not a typo.
    expect(looksLikeSlashCommand('/src/app.ts needs a guard')).toBe(false);
  });
});

describe('live state in the registry', () => {
  it('reflects mentor mode in the hint at the moment it is read', () => {
    const spy = makeHost(false);
    const mentor = findSlashCommand(buildSlashCommands(spy.host), '/mentor')!;

    expect(mentor.hint?.()).toContain('OFF');

    // The registry is built once per session, so the hint has to read state
    // lazily rather than capture it at construction time.
    spy.mentorActive = true;
    expect(mentor.hint?.()).toContain('ON');
    expect(mentor.badge?.()).toBe(' [ON]');
  });
});
