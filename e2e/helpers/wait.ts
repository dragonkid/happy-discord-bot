export class TimeoutError extends Error {
    constructor(message: string, public readonly context?: string) {
        super(message);
        this.name = 'TimeoutError';
    }
}

/**
 * Wait for a condition to become true by polling.
 * Returns the result of the predicate when it returns a truthy value.
 */
export async function waitFor<T>(
    predicate: () => T | Promise<T>,
    options: { timeout: number; interval?: number; label?: string; context?: () => string },
): Promise<NonNullable<T>> {
    const { timeout, interval = 1000, label = 'condition', context } = options;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result as NonNullable<T>;
        await sleep(interval);
    }

    const ctx = context?.() ?? '';
    throw new TimeoutError(
        `Timed out waiting for ${label} after ${timeout}ms`,
        ctx,
    );
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a child process to exit.
 */
export function waitForExit(
    proc: import('node:child_process').ChildProcess,
    timeout: number,
): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new TimeoutError(`Process did not exit within ${timeout}ms`));
        }, timeout);

        proc.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });

        // Already exited
        if (proc.exitCode !== null) {
            clearTimeout(timer);
            resolve(proc.exitCode);
        }
    });
}
