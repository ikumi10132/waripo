import { configure } from './wsso-client';

export interface AppConfig {
  /** 同じサイトの /api (CloudFront が API Gateway に転送する) */
  apiUrl: string;
  ssoUrl: string;
  wssoClientId: string;
  region: string;
}

let config: AppConfig | undefined;

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('config.json が見つかりません。ローカル開発時は web/public/config.json を作成してください');
  config = (await res.json()) as AppConfig;
  configure({ ssoUrl: config.ssoUrl, userPoolClientId: config.wssoClientId, region: config.region, appId: 'waripo', storageKey: 'wp.session' });
  return config;
}

export function getConfig(): AppConfig {
  if (!config) throw new Error('config が読み込まれていません');
  return config;
}
