import { ConsoleJev } from './console-jev.js';
import { HttpJev } from './http-jev.js';
import { loadJevConfig } from './jev-config.js';
import { StubJev } from './stub-jev.js';
import type { JevAdvisor } from './types.js';

/** HttpJev when API token is set; otherwise StubJev. `-v` wraps with ConsoleJev. */
export function createJev(verbose: boolean): JevAdvisor {
  const jevConfig = loadJevConfig();
  const base = jevConfig ? new HttpJev(jevConfig) : new StubJev();
  return verbose ? new ConsoleJev(base) : base;
}
