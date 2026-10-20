/* The site-down switch (Oct 19, 2026). While SITE_DOWN is true the website
   shows only the down page and the Claude connector answers every tool call
   with the same news. Nothing is deleted: the budget stays in Supabase,
   /api/budget still works, and flipping this back to false and deploying
   brings everything back exactly as it was.

   Plain TypeScript with no imports, so both the React app and api/mcp.ts
   read the one value. */

export const SITE_DOWN = true

export const DOWN_TITLE = "Laken's Finance is down."

export const DOWN_MESSAGE =
  "Laken's Finance is down indefinitely. Not for maintenance, not for an update. It's just down, and there's no date for it coming back. " +
  'Nothing was deleted: every paycheck, envelope and fund is still saved exactly where it was. ' +
  "It's just not available right now, and it's pretty sad about that."
