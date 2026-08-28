const mockCreateChatModel = jest.fn((model: string, temperature: number) => ({
  model,
  temperature,
}));

jest.mock('../llm/provider', () => ({
  LLMProvider: { createChatModel: mockCreateChatModel },
}));

import { ModelFactory } from './model-factory';

describe('ModelFactory', () => {
  it('delegates Claude-on-Vertex construction to the shared provider factory', () => {
    expect(ModelFactory.create('vertex-anthropic:claude-sonnet-5', 0.2)).toEqual({
      model: 'vertex-anthropic:claude-sonnet-5',
      temperature: 0.2,
    });
    expect(mockCreateChatModel).toHaveBeenCalledWith(
      'vertex-anthropic:claude-sonnet-5',
      0.2,
    );
  });
});
