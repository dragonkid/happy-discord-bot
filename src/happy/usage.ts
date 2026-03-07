import type { HappyClient } from './client.js';

export interface UsageDataPoint {
    timestamp: number;
    tokens: {
        total: number;
        input: number;
        output: number;
        cache_creation: number;
        cache_read: number;
    };
    cost: {
        total: number;
        input: number;
        output: number;
    };
    reportCount: number;
}

export interface UsageResult {
    usage: UsageDataPoint[];
    groupBy: 'hour' | 'day';
    totalReports: number;
}

export interface UsageQuery {
    sessionId?: string;
    startTime?: number;
    endTime?: number;
    groupBy?: 'hour' | 'day';
}

export async function queryUsage(happy: HappyClient, query: UsageQuery): Promise<UsageResult> {
    const body: Record<string, unknown> = {};
    if (query.sessionId) body.sessionId = query.sessionId;
    if (query.startTime) body.startTime = query.startTime;
    if (query.endTime) body.endTime = query.endTime;
    if (query.groupBy) body.groupBy = query.groupBy;

    const resp = await happy.request('/v1/usage/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        throw new Error(`Usage query failed (${resp.status})`);
    }

    return (await resp.json()) as UsageResult;
}
