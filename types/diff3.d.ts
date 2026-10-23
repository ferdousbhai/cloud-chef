/** The three-way line merge isomorphic-git uses, which CloudChef's merges of project branches share. */
declare module 'diff3' {
  type Diff3Block = { ok: string[] } | { conflict: { a: string[]; o: string[]; b: string[] } };
  export default function diff3Merge(a: string[], o: string[], b: string[]): Diff3Block[];
}
