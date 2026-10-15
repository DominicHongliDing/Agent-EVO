import { publicMode, personalMode, snapshotRequest, readJson } from './publicSnapshot'
import { personalRequest } from './personalWorkspace'
import { localSession } from './localClient'
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (publicMode) return snapshotRequest<T>(path, init)
  if (personalMode) return personalRequest<T>(path, init)
  const token = window.sessionStorage.getItem('evo_access_token')
  const scriptMutation = init?.method && init.method !== 'GET' && (/^\/runs\//.test(path) || /\/retry-selected$/.test(path))
  const local = scriptMutation ? await localSession() : undefined
  const response = await fetch(`/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-EVO-Token': token } : {}), ...(local ? { 'X-EVO-Local-Token': local.token } : {}), ...(init?.headers || {}) } })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(`${response.status} ${typeof body?.detail === 'string' ? body.detail : '请求失败，请检查字段和服务状态'}`)
  }
  return readJson<T>(response)
}
