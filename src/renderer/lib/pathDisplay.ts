// Shorten absolute paths for display in tool-call rows. Two problems this
// solves, both visible in long agent runs:
//   1. `/Users/<me>/…` prefixes eat horizontal space and repeat on every row.
//   2. CSS ellipsis truncates from the *right*, so a column of
//      `ls -la /Users/.../example-app-repo/src/example_app_re…` rows all clip
//      at the same point — hiding the one segment that differs between them.
// The fix: collapse the home prefix to `~`, then middle-elide over-long path
// tokens so the meaningful *tail* survives.

const HOME_PREFIX = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

// Past this length a path token is collapsed; below it, paths read fine as-is.
const MAX_PATH_LEN = 40;

function collapseHome(path: string): string {
  return path.replace(HOME_PREFIX, "~");
}

function isPathToken(token: string): boolean {
  return token.includes("/") && /^(?:~|\.{0,2})?\//.test(token);
}

// Collapse a single path's middle, keeping the leading anchor (`~` or `/<dir>`)
// and the final two segments — the part that disambiguates sibling rows.
function shortenPathToken(token: string): string {
  // Peel a leading quote and any trailing quote/punctuation so we transform the
  // path core and re-attach the wrappers untouched.
  const lead = token.match(/^['"`]*/)?.[0] ?? "";
  const trail = token.match(/['"`,;:]*$/)?.[0] ?? "";
  const core = token.slice(lead.length, token.length - trail.length);
  if (!isPathToken(core)) return token;

  const collapsed = collapseHome(core);
  if (collapsed.length <= MAX_PATH_LEN) return `${lead}${collapsed}${trail}`;

  const segs = collapsed.split("/");
  if (segs.length < 4) return `${lead}${collapsed}${trail}`;

  // Anchor: "~" for home, "/<first>" for an absolute root, else the first seg.
  const anchor = segs[0] === "~" ? "~" : segs[0] === "" ? `/${segs[1] ?? ""}` : segs[0];
  const tail = segs.slice(-2).join("/");
  return `${lead}${anchor}/…/${tail}${trail}`;
}

// Shorten every path-looking token in a free-form string (e.g. a shell command
// like `ls -la /Users/me/dev/repo/src/pkg/commands`), leaving flags, quotes,
// and non-path words untouched.
export function shortenPathsInText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((segment) => (/\s/.test(segment) ? segment : shortenPathToken(segment)))
    .join("");
}
