import { ConsoleJev } from './console-jev.js';
import { HttpJev } from './http-jev.js';
import { LoggingJev } from './logging-jev.js';
import { loadJevConfig } from './jev-config.js';
import { ProgressiveStubJev } from './progressive-stub.js';
import type { SupervisorAdvisor } from './supervisor-advisor.js';

/** HttpJev when API token is set; otherwise ProgressiveStubJev. `-v` wraps with ConsoleJev. */
export function createSupervisor(verbose: boolean): SupervisorAdvisor {
  const jevConfig = loadJevConfig();
  const base: SupervisorAdvisor = jevConfig
    ? new HttpJev(jevConfig)
    : new LoggingJev(new ProgressiveStubJev(), 'ProgressiveStubJev');
  return verbose ? new ConsoleJev(base) : base;
}

/** @deprecated Use createSupervisor for autopilot; kept for CLI commands. */
export function createJev(verbose: boolean): SupervisorAdvisor {
  return createSupervisor(verbose);
}
