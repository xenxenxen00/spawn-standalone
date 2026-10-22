/** Authored game state may use any keys; runtime-owned contracts use the package namespace. */
export function publicNamespaceIssue(text: string): boolean {
  return /\b(?:__PP_|PP_|__pp[A-Z]|pp[A-Z]|pp[-_])|['"`]pp[:.]/.test(text);
}
