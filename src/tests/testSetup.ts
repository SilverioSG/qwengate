// Test-only setup (loaded via bunfig.toml [test] preload).
// Production default PARSE_PACING_MS is intentionally slow (35s between real
// upstream parses). Integration/unit tests reuse the parseGuard singleton and
// must not inherit that wait — keep a small but nonzero budget so pacing logic
// stays exercised without slowing the suite.
process.env.PARSE_PACING_MS ??= '50';
