import { answerDelegateQuestion } from './delegation-broker';
import { openTurn, resetDelegationRegistry, type DelegationLedger } from './delegation-registry';
import type { Mandate } from './mandate';

const mandate: Mandate = {
  userRequest: 'quiero que mejores los skills tuyos, revisalos y sugerime cambios',
  objective: 'Review every skill under skills/ and propose concrete improvements.',
  knownContext: ['The route is read-only; no file may be written this turn.'],
  inScope: ['The markdown guides under skills/'],
  outOfScope: ['The general architecture of the project, which is already settled.'],
  definitionOfDone: 'A research artifact listing each skill and its proposed change.',
  conventions: ['Everything written into the repository is in English.'],
  budget: { toolCalls: 14, questions: 2 },
};

function ledgerWithMandate(): DelegationLedger {
  const ledger = openTurn('thread-a', 'turn-1', 50);
  ledger.mandates.set('researcher#1', mandate);
  return ledger;
}

describe('answerDelegateQuestion', () => {
  beforeEach(() => resetDelegationRegistry());

  it('answers from the order without involving anyone, when the order covers it', async () => {
    const askOperator = jest.fn();
    const answer = await answerDelegateQuestion(
      ledgerWithMandate(),
      'researcher#1',
      'Should I review the general architecture of the project?',
      askOperator,
    );

    expect(answer.source).toBe('mandate');
    expect(askOperator).not.toHaveBeenCalled();
  });

  it('quotes the order verbatim instead of paraphrasing it', async () => {
    const answer = await answerDelegateQuestion(
      ledgerWithMandate(),
      'researcher#1',
      'Is the general architecture of the project in scope?',
    );

    expect(answer.text).toContain('The general architecture of the project, which is already settled.');
    expect(answer.text).toContain('out of scope');
  });

  it('escalates to the operator when the order says nothing about it', async () => {
    const askOperator = jest.fn().mockResolvedValue('Solo el contenido, no el cargador.');
    const answer = await answerDelegateQuestion(
      ledgerWithMandate(),
      'researcher#1',
      'Does improving mean rewriting the loader mechanism?',
      askOperator,
    );

    expect(askOperator).toHaveBeenCalledTimes(1);
    expect(answer).toEqual({ source: 'human', text: 'Solo el contenido, no el cargador.' });
  });

  it('carries the operator answer forward for the delegates that follow', async () => {
    const ledger = ledgerWithMandate();
    await answerDelegateQuestion(
      ledger,
      'researcher#1',
      'Does improving mean rewriting the loader mechanism?',
      jest.fn().mockResolvedValue('Solo el contenido.'),
    );

    expect(ledger.findings.join('\n')).toContain('Solo el contenido.');
  });

  it('stops asking once the allowance is spent, and says what to do instead', async () => {
    const ledger = ledgerWithMandate();
    const askOperator = jest.fn().mockResolvedValue('sí');
    const ask = () => answerDelegateQuestion(
      ledger,
      'researcher#1',
      'Does improving mean rewriting the loader mechanism?',
      askOperator,
    );

    await ask();
    await ask();
    const third = await ask();

    expect(askOperator).toHaveBeenCalledTimes(2);
    expect(third.source).toBe('unanswered');
    expect(third.text).toContain('unknowns');
  });

  it('never reports a missing operator channel as an answer', async () => {
    const answer = await answerDelegateQuestion(
      ledgerWithMandate(),
      'researcher#1',
      'Does improving mean rewriting the loader mechanism?',
    );

    expect(answer.source).toBe('unanswered');
    expect(answer.text).toContain('Do not treat this as an answer');
  });

  it('never reports a cancelled prompt as an answer', async () => {
    const answer = await answerDelegateQuestion(
      ledgerWithMandate(),
      'researcher#1',
      'Does improving mean rewriting the loader mechanism?',
      jest.fn().mockResolvedValue(undefined),
    );

    expect(answer.source).toBe('unanswered');
    expect(answer.text).toContain('state the assumption you made');
  });

  it('spends the allowance even when the operator declines to answer', async () => {
    const ledger = ledgerWithMandate();
    await answerDelegateQuestion(
      ledger,
      'researcher#1',
      'Does improving mean rewriting the loader mechanism?',
      jest.fn().mockResolvedValue(undefined),
    );

    expect(ledger.questionsAsked.get('researcher#1')).toBe(1);
  });

  it('refuses to answer a delegation that holds no mandate at all', async () => {
    const answer = await answerDelegateQuestion(
      openTurn('thread-a', 'turn-1', 50),
      'coder#1',
      'Where do the DTOs live?',
      jest.fn().mockResolvedValue('anywhere'),
    );

    expect(answer.source).toBe('unanswered');
  });

  it('does not quote the order for a question that merely shares filler words', async () => {
    const answer = await answerDelegateQuestion(
      ledgerWithMandate(),
      'researcher#1',
      'What should I do with this?',
      jest.fn().mockResolvedValue('decidí vos'),
    );

    expect(answer.source).not.toBe('mandate');
  });
});
