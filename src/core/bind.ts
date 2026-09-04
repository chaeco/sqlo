/**
 * Parameter binding normalization.
 *
 * node:sqlite rejects `boolean` values ("Provided value cannot be bound..."),
 * but `BOOLEAN` is a documented column type in this ORM (stored as INTEGER
 * per SQLite type affinity). Coerce at the binding boundary so `true`/`false`
 * work everywhere — inserts, updates, where clauses — instead of surfacing an
 * opaque driver error. All other values pass through untouched.
 */

export function toBindable(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export function toBindables(params: readonly unknown[]): unknown[] {
  return params.map(toBindable);
}
