/** Test helper: a PriceQuery (order + range + await) over an async executor. */
import type { PriceQuery, QueryResult } from './repository';

export interface QuerySpec {
  order: string[];
  from: number;
  to: number;
}

export function makeQuery(exec: (spec: QuerySpec) => Promise<QueryResult>): PriceQuery {
  const spec: QuerySpec = { order: [], from: 0, to: Number.MAX_SAFE_INTEGER };
  const q: PriceQuery = {
    order(column) {
      spec.order.push(column);
      return q;
    },
    range(from, to) {
      spec.from = from;
      spec.to = to;
      return q;
    },
    then(ok, fail) {
      return exec(spec).then(ok, fail);
    },
  };
  return q;
}
