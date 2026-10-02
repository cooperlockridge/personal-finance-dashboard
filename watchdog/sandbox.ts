/* The gates run code an agent wrote. `bun test` runs its tests, `vite build`
   runs whatever its modules do at import, and both would otherwise run as
   Cooper: with his GitHub, Vercel and Supabase logins in the keychain, every
   other repository on this Mac in reach, and a network to send them over.
   The agent itself has no way to run a program; this is the one place its
   writing becomes one.

   So each gate runs under macOS's own sandbox. Inside it there is no network,
   no keychain, and no home folder apart from the clone, the shared
   node_modules and bun. Checked on Oct 2, 2026: all four gates pass under
   this profile, and reading ~/.zshrc, listing another project, a curl and a
   keychain lookup all fail. */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

export type SandboxPaths = {
  /** The user's home folder: everything under it is closed unless opened below. */
  home: string
  /** The clone, by its real path. */
  repo: string
  /** Where the clone's node_modules symlink really points. */
  nodeModules: string
  /** bun's own folder (~/.bun). */
  bun: string
}

/* A path goes into the profile inside a quoted string. One holding a quote
   or a backslash could close that string and add rules of its own, so it is
   refused rather than escaped. */
function quoted(path: string): string {
  if (!path.startsWith('/') || /["\\\n\r\u0000]/.test(path)) {
    throw new Error('A sandbox path must be absolute and hold no quote, backslash or line break')
  }
  return `"${path}"`
}

/* Later rules win, so each `deny` of the whole home folder is followed by the
   few folders that are opened again. The three node_modules folders that may
   be written are the caches tsc and vite keep there. */
export function sandboxProfile(paths: SandboxPaths): string {
  const home = quoted(paths.home)
  const repo = quoted(paths.repo)
  const modules = quoted(paths.nodeModules)
  const caches = ['.tmp', '.vite', '.vite-temp'].map((name) => `(subpath ${quoted(`${paths.nodeModules}/${name}`)})`)
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.secd") (global-name "com.apple.securityd.xpc"))',
    `(deny file-read* (subpath ${home}))`,
    `(allow file-read* (subpath ${repo}) (subpath ${modules}) (subpath ${quoted(paths.bun)}))`,
    /* Resolving a path stats every folder above it. */
    `(allow file-read-metadata (subpath ${home}))`,
    `(deny file-write* (subpath ${home}))`,
    `(allow file-write* (subpath ${repo}) ${caches.join(' ')})`,
  ].join('')
}

export type Wrap = (command: string, args: string[]) => { command: string, args: string[] }

export function sandboxed(paths: SandboxPaths): Wrap {
  const profile = sandboxProfile(paths)
  return (command, args) => ({ command: SANDBOX_EXEC, args: ['-p', profile, command, ...args] })
}
