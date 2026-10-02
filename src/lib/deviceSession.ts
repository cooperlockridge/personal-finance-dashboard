import type { FetchLike } from './budgetApi'

/* Oct 2, 2026: the browser's side of /api/device, "remember this device".
   Clerk's own session lasts a week at most here, and Laken opens the app
   every other Friday, so she was signing in on every visit. After one Clerk
   sign-in the server sets a year-long cookie that no script can read; these
   three calls are all the browser ever does with it. No React and no window,
   so it is tested in bun with a fake fetch. */

export type RememberedUser = { userId: string; name: string | null }

export type DeviceApi = {
  /** Who this device is remembered as, or null. Null too when the answer never came. */
  check(): Promise<RememberedUser | null>
  /** Trade a fresh Clerk token for the device cookie. Null if the server declined. */
  remember(token: string): Promise<RememberedUser | null>
  /** Clear the cookie. False if the request never got through, so she is still remembered. */
  forget(): Promise<boolean>
}

function asUser(body: unknown): RememberedUser | null {
  if (typeof body !== 'object' || body === null) return null
  const { userId, name } = body as Record<string, unknown>
  if (typeof userId !== 'string' || !userId) return null
  return { userId, name: typeof name === 'string' ? name : null }
}

export function createDeviceApi({ fetch, url = '/api/device' }: { fetch: FetchLike; url?: string }): DeviceApi {
  async function send(method: string, token?: string): Promise<Response | null> {
    try {
      return await fetch(url, {
        method,
        cache: 'no-store',
        headers: {
          /* Asking for JSON keeps a dev server's HTML fallback from answering 200. */
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
    } catch {
      return null
    }
  }

  async function userFrom(response: Response | null): Promise<RememberedUser | null> {
    if (!response || response.status !== 200) return null
    try {
      return asUser(await response.json())
    } catch {
      return null
    }
  }

  return {
    check: async () => userFrom(await send('GET')),
    remember: async (token) => userFrom(await send('POST', token)),
    forget: async () => (await send('DELETE'))?.ok ?? false,
  }
}
