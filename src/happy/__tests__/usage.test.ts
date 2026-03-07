import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryUsage } from '../usage.js';
import type { HappyClient } from '../client.js';

function mockHappy(): HappyClient {
    return {
        request: vi.fn(),
    } as unknown as HappyClient;
}

describe('queryUsage', () => {
    let happy: HappyClient;

    beforeEach(() => {
        happy = mockHappy();
    });

    it('sends POST to /v1/usage/query with query params', async () => {
        vi.mocked(happy.request).mockResolvedValueOnce(
            new Response(JSON.stringify({ usage: [], groupBy: 'day', totalReports: 0 })),
        );

        await queryUsage(happy, { sessionId: 'sess-1' });

        expect(happy.request).toHaveBeenCalledWith('/v1/usage/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'sess-1' }),
        });
    });

    it('returns parsed usage result', async () => {
        const data = {
            usage: [{
                timestamp: 1709712345,
                tokens: { total: 1000, input: 400, output: 600, cache_creation: 0, cache_read: 0 },
                cost: { total: 0.015, input: 0.005, output: 0.01 },
                reportCount: 2,
            }],
            groupBy: 'hour',
            totalReports: 2,
        };
        vi.mocked(happy.request).mockResolvedValueOnce(new Response(JSON.stringify(data)));

        const result = await queryUsage(happy, { startTime: 1709712000, groupBy: 'hour' });

        expect(result.usage).toHaveLength(1);
        expect(result.usage[0].tokens.total).toBe(1000);
        expect(result.groupBy).toBe('hour');
    });

    it('omits undefined query fields from request body', async () => {
        vi.mocked(happy.request).mockResolvedValueOnce(
            new Response(JSON.stringify({ usage: [], groupBy: 'day', totalReports: 0 })),
        );

        await queryUsage(happy, { groupBy: 'day' });

        const body = JSON.parse(vi.mocked(happy.request).mock.calls[0][1]!.body as string);
        expect(body).not.toHaveProperty('sessionId');
        expect(body).not.toHaveProperty('startTime');
        expect(body.groupBy).toBe('day');
    });

    it('throws on non-ok response', async () => {
        vi.mocked(happy.request).mockResolvedValueOnce(
            new Response('Not Found', { status: 404 }),
        );

        await expect(queryUsage(happy, {})).rejects.toThrow('Usage query failed (404)');
    });
});
