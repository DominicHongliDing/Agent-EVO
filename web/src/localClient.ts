let session: Promise<{ token: string; interpreter: string }> | undefined
export function localSession() {
  return session ||= fetch('/api/local-evaluations/bootstrap', { headers: { 'X-EVO-Bootstrap': '1', 'X-EVO-Token': sessionStorage.getItem('evo_access_token') || '' }, cache: 'no-store' }).then(async response => {
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('本地服务未返回有效响应，请检查服务是否启动。')
    const value = await response.json()
    if (!response.ok) throw new Error(value.detail || '本地会话建立失败')
    return value
  }).catch(e => { session = undefined; throw e })
}
export async function localRequest<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const info = await localSession(), headers = new Headers(init.headers)
  headers.set('X-EVO-Local-Token', info.token)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch('/api/local-evaluations' + path, { ...init, headers, cache: 'no-store' })
  if (response.status === 401 && retry) { session = undefined; return localRequest(path, init, false) }
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('服务响应格式异常，请刷新后重试。')
  const value = await response.json()
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '操作未完成')
  return value
}
