// Browser equivalents for the desktop IPC boundary.
let logging = false;
let logs: unknown[] = [];
export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  let result: unknown;
  if (cmd === 'open_url') {
    const url = new URL(String(args.url));
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('不支持的链接');
    window.open(url.href, '_blank', 'noopener,noreferrer');
  } else if (cmd === 'debug_log' || cmd === 'set_orientation' || cmd === 'plugin:app|exit') {
    result = null;
  } else if (cmd.startsWith('playback_log_')) {
    if (cmd === 'playback_log_set') { logging = !!args.enabled; logs = []; }
    if (cmd === 'playback_log_write' && logging) {
      // Keep timing and event names only; never persist media URLs or credentials.
      logs.push(...(args.entries as {event: string}[]).map(e => ({event: e.event, at: new Date().toISOString()})));
      logs = logs.slice(-1000);
    }
    result = cmd === 'playback_log_read' ? logs.map(x => JSON.stringify(x)).join('\n') : {enabled: logging, path: null, error: null};
  } else {
    const response = await fetch('/api/rpc', {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({cmd,args}), credentials:'same-origin'});
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `请求失败 (${response.status})`);
    result = payload.data;

  }
  return result as T;
}
export const addPluginListener = async (_plugin: string, _event: string, _cb: () => void) => ({unregister: async () => {}});
