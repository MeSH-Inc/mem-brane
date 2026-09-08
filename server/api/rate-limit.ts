// Single-process, actor-scoped abuse guard. Replace the policy here when sharing or edge limits arrive.
export function createRateLimit(limit = 240, windowMs = 60000) {
  const buckets = new Map<string, { count: number; reset: number }>();
  return (actor: string, time = Date.now()) => {
    if (buckets.size > 10000)
      for (const [id, bucket] of buckets) if (bucket.reset <= time) buckets.delete(id);
    let bucket = buckets.get(actor);
    if (!bucket || bucket.reset <= time) {
      bucket = { count: 0, reset: time + windowMs };
      buckets.set(actor, bucket);
    }
    return ++bucket.count <= limit;
  };
}
