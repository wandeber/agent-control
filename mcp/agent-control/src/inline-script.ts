/** Keep bundled JavaScript in the HTML script-data state without changing
 * string values. Libraries can contain HTML fragments, including sanitizers'
 * opening script tags and comments, as well as closing script tags. */
export function escapeInlineScript(source: string): string {
  return source
    .replace(/<(script|!--)/gi, "\\x3c$1")
    .replace(/<\/(script)/gi, "<\\/$1");
}
