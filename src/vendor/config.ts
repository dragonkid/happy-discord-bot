export type Config = {
    serverUrl: string;
};

export function loadConfig(): Config {
    const serverUrl = (process.env.HAPPY_SERVER_URL ?? 'https://api.cluster-fluster.com').replace(/\/+$/, '');
    return { serverUrl };
}
