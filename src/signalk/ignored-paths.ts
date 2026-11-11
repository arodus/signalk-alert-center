export const DEFAULT_IGNORED_PATHS = ["navigation.closestApproach.*"];

/** Compile literal, whole-path patterns once per runtime start. Only * is special. */
export function ignoredPathMatcher(
  patterns: readonly string[] = DEFAULT_IGNORED_PATHS,
): (notificationPath: string) => boolean {
  const matchers = patterns.map((pattern) => {
    const path = pattern.trim().replace(/^notifications\./, "");
    return new RegExp(
      "^" +
        path
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".+") +
        "$",
    );
  });
  return (notificationPath) => {
    const path = notificationPath.replace(/^notifications\./, "");
    return matchers.some((matcher) => matcher.test(path));
  };
}
