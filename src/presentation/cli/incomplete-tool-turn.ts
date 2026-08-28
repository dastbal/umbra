/**
 * Identifies persisted conversations that stopped after a tool response.
 *
 * LangGraph checkpoints must end with an assistant response before a new user
 * message is appended. A terminal tool message means the previous provider
 * request failed after the tool completed, so that checkpoint cannot safely be
 * continued as a normal conversation.
 */
export function hasIncompleteToolTurn(messages: readonly unknown[]): boolean {
  const lastMessage = messages.at(-1) as {
    getType?: () => string;
    type?: string;
  } | undefined;

  return lastMessage?.getType?.() === 'tool' || lastMessage?.type === 'tool';
}
