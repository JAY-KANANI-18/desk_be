import { BadRequestException } from '@nestjs/common';
import { AiGatewayResponse, AiGatewayService } from './ai-gateway.service';

function makeResponse(
  content: string,
  overrides: Partial<AiGatewayResponse> = {},
): AiGatewayResponse {
  return {
    provider: 'mistral',
    model: 'mistral-small-latest',
    content,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    latencyMs: 100,
    ...overrides,
  };
}

describe('AiGatewayService', () => {
  let service: AiGatewayService;

  beforeEach(() => {
    service = new AiGatewayService(
      {} as ConstructorParameters<typeof AiGatewayService>[0],
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('completeJson', () => {
    it('requests provider JSON mode and parses valid JSON', async () => {
      const completeText = jest
        .spyOn(service, 'completeText')
        .mockResolvedValueOnce(makeResponse('{"ok":true}'));

      const result = await service.completeJson<{ ok: boolean }>({
        workspaceId: 'workspace-1',
        operation: 'decision',
        messages: [{ role: 'user', content: 'Return JSON' }],
      });

      expect(result.data).toEqual({ ok: true });
      expect(completeText).toHaveBeenCalledWith(
        expect.objectContaining({
          responseFormat: 'json_object',
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('valid JSON object'),
            }),
          ]),
        }),
      );
    });

    it('repairs malformed provider JSON once before failing the request', async () => {
      const completeText = jest
        .spyOn(service, 'completeText')
        .mockResolvedValueOnce(
          makeResponse('{"items":["Product 1" "Product 2"]}', {
            promptTokens: 2,
            completionTokens: 3,
            totalTokens: 5,
            latencyMs: 20,
          }),
        )
        .mockResolvedValueOnce(
          makeResponse('{"items":["Product 1","Product 2"]}', {
            promptTokens: 7,
            completionTokens: 4,
            totalTokens: 11,
            latencyMs: 30,
          }),
        );

      const result = await service.completeJson<{ items: string[] }>({
        workspaceId: 'workspace-1',
        operation: 'decision',
        messages: [{ role: 'user', content: 'Return JSON' }],
        model: 'mistral-small-latest',
        metadata: { feature: 'workflow_ai_builder' },
      });

      expect(result.data).toEqual({ items: ['Product 1', 'Product 2'] });
      expect(result.raw).toEqual(
        expect.objectContaining({
          promptTokens: 9,
          completionTokens: 7,
          totalTokens: 16,
          latencyMs: 50,
        }),
      );
      expect(completeText).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          provider: 'mistral',
          model: 'mistral-small-latest',
          responseFormat: 'json_object',
          temperature: 0,
          metadata: expect.objectContaining({
            feature: 'workflow_ai_builder',
            jsonRepair: true,
          }),
        }),
      );
    });

    it('throws a clean bad request if JSON repair also fails', async () => {
      jest
        .spyOn(service, 'completeText')
        .mockResolvedValueOnce(makeResponse('{"items":["a" "b"]}'))
        .mockResolvedValueOnce(makeResponse('still not json'));

      await expect(
        service.completeJson({
          workspaceId: 'workspace-1',
          operation: 'decision',
          messages: [{ role: 'user', content: 'Return JSON' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
